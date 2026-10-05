// Pro subscriptions through Stripe Checkout. Stripe is called over plain HTTPS (form-encoded, no
// SDK): a handful of endpoints do not justify a dependency.
//
// The Stripe account is shared with another, unrelated product whose events arrive at our webhook
// too, and ours reach its webhook. Everything below keeps the two apart:
//   - our Checkout Sessions carry client_reference_id "fs_<account id>" and metadata app=friendsshare
//   - an event is ours only when it carries those markers, or (subscription events) one of our prices
//   - customers are never looked up or reused by email: each account gets a customer of its own,
//     made by us, so everything it buys sits on one customer that the portal reaches
//
// Money must never end up attached to nothing. An account has at most one open Checkout Session,
// and a subscription of ours that no account can take is cancelled at once and shouted about.
const crypto = require('node:crypto');
const { fail, readBody, createLimiter } = require('./http');
const { safeEqual } = require('./util');
const { isRunning, planOf } = require('./plan');

const ACCOUNT_ID_RE = /^[0-9a-f]{16}$/;
const STRIPE_ID_RE = /^[\w-]{1,100}$/;
const SIGNATURE_TOLERANCE_S = 300;

class StripeError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const isGone = (err) => err instanceof StripeError && (err.status === 404 || err.code === 'resource_missing');

function createBilling({ config, db, fetchFn, now, log, hooks }) {
  const stripeCfg = config.stripe;
  const accountById = (id) => (typeof id === 'string' && ACCOUNT_ID_RE.test(id) ? db.get('SELECT * FROM accounts WHERE id = ?', id) : undefined);
  const accountByCustomer = (customer) => (customer ? db.get('SELECT * FROM accounts WHERE stripe_customer_id = ? ORDER BY created_at LIMIT 1', customer) : undefined);
  const idOf = (value) => (typeof value === 'string' ? value : value && typeof value.id === 'string' ? value.id : null);

  async function stripe(method, path, form) {
    if (!stripeCfg.secretKey) throw new StripeError('Stripe is not configured.', 0, 'not_configured');
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(form || {})) if (value !== undefined && value !== null) params.set(key, String(value));
    let res;
    try {
      res = await fetchFn(`https://api.stripe.com/v1${path}`, {
        method,
        headers: { Authorization: `Bearer ${stripeCfg.secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: method === 'POST' ? params.toString() : undefined,
        signal: AbortSignal.timeout(config.tuning.fetchTimeoutMs),
      });
    } catch {
      throw new StripeError('Stripe could not be reached.', 0, 'unreachable');
    }
    let data = null;
    try {
      data = await res.json();
    } catch {}
    // Stripe's own message can quote part of the API key, so it is kept out of errors and logs
    if (!res.ok) throw new StripeError(`Stripe answered ${res.status}.`, res.status, data && data.error && data.error.code);
    return data;
  }

  const describe = (err) => (err instanceof StripeError ? `status=${err.status} code=${err.code || 'none'}` : 'unexpected error');

  // One at a time per key. Two requests about the same account (two checkouts, a checkout and the
  // deletion of the account) must not run through each other.
  const tails = new Map();
  function serial(key, task) {
    const run = (tails.get(key) || Promise.resolve()).then(task);
    const tail = run.catch(() => {});
    tails.set(key, tail);
    tail.then(() => tails.get(key) === tail && tails.delete(key));
    return run;
  }

  // what a signed-in person may ask of Stripe, per account
  const limiters = {
    checkout: createLimiter(config.tuning.accountRates.checkout, now),
    portal: createLimiter(config.tuning.accountRates.portal, now),
  };
  function limit(name, account) {
    if (limiters[name].allow(account.id)) return;
    fail(429, 'rate_limited', 'You have done this too often. Please wait a while and try again.', {
      'Retry-After': String(Math.ceil(config.tuning.accountRates[name].windowMs / 1000)),
    });
  }

  // ---- what the web API shows and what checkout needs ----

  // The customer of an account: made by us the first time, remembered, and the only one ever used.
  async function customerOf(account) {
    if (account.stripe_customer_id) return account.stripe_customer_id;
    const made = await stripe('POST', '/customers', {
      email: account.email,
      name: account.name,
      'metadata[app]': 'friendsshare',
      'metadata[fs_account]': account.id,
    });
    const id = idOf(made);
    if (!id || !STRIPE_ID_RE.test(id)) throw new StripeError('Stripe answered without a customer.', 0, 'no_customer');
    db.run('UPDATE accounts SET stripe_customer_id = ? WHERE id = ?', id, account.id);
    return id;
  }

  // An open session that is not wanted any more. "Already completed" and "already expired" are
  // answers too, and fine; anything else (Stripe down) means it may still be open, so it throws.
  async function expireSession(id) {
    if (!stripeCfg.secretKey || !STRIPE_ID_RE.test(id)) return;
    try {
      await stripe('POST', `/checkout/sessions/${encodeURIComponent(id)}/expire`, {});
    } catch (err) {
      if (err instanceof StripeError && (err.status === 400 || err.status === 404)) return;
      throw err;
    }
  }

  // Everything for one checkout, one account at a time: a customer, the previous session expired,
  // a new session. Only one session is ever open for an account, so only one can ever be paid.
  function startCheckout(accountId, interval) {
    return serial(accountId, async () => {
      // looked at again here: the account may have changed while this waited for its turn
      const account = db.get('SELECT * FROM accounts WHERE id = ?', accountId);
      if (!account) fail(401, 'signed_out', 'Sign in to continue.');
      if (account.stripe_subscription_id && isRunning(account.sub_status)) alreadyPro();
      const customer = await customerOf(account);
      if (account.checkout_session_id) await expireSession(account.checkout_session_id);
      const form = {
        mode: 'subscription',
        'line_items[0][price]': interval === 'year' ? stripeCfg.priceYearly : stripeCfg.priceMonthly,
        'line_items[0][quantity]': 1,
        // the account page reacts to ?billing=success by refreshing the plan
        success_url: `${config.baseUrl}/account?billing=success`,
        cancel_url: `${config.baseUrl}/account?billing=cancelled`,
        client_reference_id: `fs_${account.id}`,
        'metadata[app]': 'friendsshare',
        'subscription_data[metadata][app]': 'friendsshare',
        'subscription_data[metadata][fs_account]': account.id,
        customer,
      };
      if (stripeCfg.managedPayments) form['managed_payments[enabled]'] = 'true';
      const session = await stripe('POST', '/checkout/sessions', form);
      if (!session || typeof session.url !== 'string' || !session.url.startsWith('https://')) {
        throw new StripeError('Stripe answered without a checkout address.', 0, 'no_url');
      }
      db.run('UPDATE accounts SET checkout_session_id = ? WHERE id = ?', typeof session.id === 'string' && STRIPE_ID_RE.test(session.id) ? session.id : null, account.id);
      return session.url;
    });
  }

  async function portal(account) {
    const session = await stripe('POST', '/billing_portal/sessions', {
      customer: account.stripe_customer_id,
      return_url: `${config.baseUrl}/account`,
      // FriendsShare has its own portal settings; the other product's must not be used
      configuration: stripeCfg.portalConfig || undefined,
    });
    if (!session || typeof session.url !== 'string' || !session.url.startsWith('https://')) {
      throw new StripeError('Stripe answered without a portal address.', 0, 'no_url');
    }
    return session.url;
  }

  // Ends the subscription at once, for an account that is being deleted. A subscription Stripe
  // does not know any more is fine; anything else means it may still be billing, so it throws.
  async function cancelForDeletion(account) {
    const id = account.stripe_subscription_id;
    if (!id || ['canceled', 'incomplete_expired'].includes(account.sub_status)) return;
    if (!STRIPE_ID_RE.test(id)) throw new StripeError('The stored subscription id is not valid.', 0, 'bad_id');
    try {
      await stripe('DELETE', `/subscriptions/${encodeURIComponent(id)}`);
    } catch (err) {
      if (isGone(err)) return;
      throw err;
    }
  }

  // Everything with Stripe that has to be over before an account goes: its open checkout expired,
  // so nothing can be bought for it any more, and its subscription cancelled. finish() then removes
  // the account in the same turn. If a purchase went through while this was running, the row says
  // so, and it is looked at again; better to refuse than to leave a subscription behind.
  function settleForDeletion(accountId, finish) {
    return serial(accountId, async () => {
      for (let round = 0; round < 3; round++) {
        const account = db.get('SELECT * FROM accounts WHERE id = ?', accountId);
        if (!account) return;
        if (account.checkout_session_id) await expireSession(account.checkout_session_id);
        await cancelForDeletion(account);
        const after = db.get('SELECT stripe_subscription_id AS subscription, sub_status AS status FROM accounts WHERE id = ?', accountId);
        if (!after) return;
        if (after.subscription === account.stripe_subscription_id && after.status === account.sub_status) return finish();
      }
      throw new StripeError('The account kept changing while it was being closed.', 0, 'busy');
    });
  }

  // ---- events ----

  const ourPrices = () => [stripeCfg.priceMonthly, stripeCfg.priceYearly].filter(Boolean);
  const isOurSubscription = (sub) =>
    Boolean(sub) && Array.isArray(sub.items && sub.items.data) && sub.items.data.some((item) => item && item.price && ourPrices().includes(item.price.id));

  function verifySignature(rawBody, header) {
    let timestamp = null;
    const signatures = [];
    for (const piece of String(header || '').split(',')) {
      const at = piece.indexOf('=');
      if (at < 1) continue;
      const key = piece.slice(0, at).trim();
      const value = piece.slice(at + 1).trim();
      if (key === 't') timestamp = value;
      else if (key === 'v1') signatures.push(value);
    }
    if (!timestamp || !/^\d{1,12}$/.test(timestamp) || !signatures.length) return false;
    if (Math.abs(now() / 1000 - Number(timestamp)) > SIGNATURE_TOLERANCE_S) return false;
    const expected = crypto.createHmac('sha256', stripeCfg.webhookSecret).update(`${timestamp}.`).update(rawBody).digest('hex');
    return signatures.some((signature) => safeEqual(signature, expected));
  }

  // A subscription of ours that no account can take would bill somebody for nothing: the account
  // is gone, or already pays for another subscription. It is cancelled at once, and the operator is
  // told in a line that cannot be missed, because the first payment has to be given back by hand.
  // If Stripe will not cancel it this throws, and the webhook answers with an error so that Stripe
  // delivers the event again.
  async function cancelUnattachable(subscriptionId, customerId, reason) {
    if (!STRIPE_ID_RE.test(subscriptionId)) return;
    try {
      await stripe('DELETE', `/subscriptions/${encodeURIComponent(subscriptionId)}`);
    } catch (err) {
      // already gone: the payment may still have been taken, so the operator is told all the same
      if (!isGone(err)) throw err;
    }
    log(
      `[billing] ALERT subscription ${subscriptionId} of customer ${customerId || 'unknown'} could not be attached to an account (${reason}) ` +
        'and was cancelled. Refund in Stripe dashboard: its first payment has to be given back by hand.',
    );
  }

  // Writes what Stripe says about a subscription onto its account.
  function applySubscription(account, sub) {
    const items = sub.items.data;
    const item = items.find((i) => i && i.price && ourPrices().includes(i.price.id));
    const current = account.stripe_subscription_id;
    // an older subscription ending must not take over from the one that counts
    if (current && current !== sub.id && isRunning(account.sub_status)) return;
    // newer API versions keep the period on the item
    const seconds = [sub.current_period_end, item.current_period_end, items[0] && items[0].current_period_end].find((n) => typeof n === 'number');
    if (seconds === undefined) log(`[billing] subscription ${sub.id} has no period end, giving it the grace period only`);
    db.run(
      `UPDATE accounts SET stripe_customer_id = ?, stripe_subscription_id = ?, sub_status = ?, sub_interval = ?,
         sub_period_end = ?, sub_cancel_at_period_end = ? WHERE id = ?`,
      idOf(sub.customer) || account.stripe_customer_id,
      sub.id,
      typeof sub.status === 'string' ? sub.status : 'unknown',
      item.price.id === stripeCfg.priceYearly ? 'year' : 'month',
      seconds === undefined ? now() : seconds * 1000,
      sub.cancel_at_period_end === true || (typeof sub.cancel_at === 'number' && sub.cancel_at > 0) ? 1 : 0,
      account.id,
    );
    log(`[billing] subscription ${sub.id} is ${sub.status} for account ${account.id}`);
  }

  // The subscription as Stripe has it now, or null when Stripe does not know it.
  async function readSubscription(id) {
    if (!STRIPE_ID_RE.test(id)) return null;
    try {
      return await stripe('GET', `/subscriptions/${encodeURIComponent(id)}`);
    } catch (err) {
      if (isGone(err)) return null;
      throw err;
    }
  }

  // Another running subscription next to the one the account has stored.
  const clashes = (account, sub) =>
    Boolean(account.stripe_subscription_id) && account.stripe_subscription_id !== sub.id && isRunning(account.sub_status) && isRunning(sub.status);

  // What a subscription, as Stripe describes it, means for an account.
  async function settleSubscription(account, sub) {
    if (!isOurSubscription(sub) || typeof sub.id !== 'string') return;
    let current = db.get('SELECT * FROM accounts WHERE id = ?', account.id) || account;
    if (clashes(current, sub)) {
      // The stored one may have ended without us hearing yet (events come in any order): ask Stripe
      // about it before judging the new one, so a real purchase is never cancelled for a ghost.
      await refreshSubscription(current, current.stripe_subscription_id, { missingMeansEnded: true });
      current = db.get('SELECT * FROM accounts WHERE id = ?', account.id) || current;
      if (clashes(current, sub)) {
        await cancelUnattachable(sub.id, idOf(sub.customer), 'the account already has another running subscription');
        return;
      }
    }
    applySubscription(current, sub);
  }

  // Stripe does not promise to deliver events in order, so an event only says "look again": the
  // subscription is read from Stripe and what it says now is what counts.
  async function refreshSubscription(account, subscriptionId, { missingMeansEnded }) {
    const sub = await readSubscription(subscriptionId);
    if (!sub) {
      if (missingMeansEnded) {
        db.run(`UPDATE accounts SET sub_status = 'canceled', sub_cancel_at_period_end = 0 WHERE id = ? AND stripe_subscription_id = ?`, account.id, subscriptionId);
        log(`[billing] subscription ${subscriptionId} no longer exists at Stripe, account ${account.id} is on the free plan`);
      }
      return;
    }
    await settleSubscription(account, sub);
  }

  async function onCheckoutCompleted(session) {
    // ours only with all three markers; the other product's sessions look different
    if (session.mode !== 'subscription' || !session.metadata || session.metadata.app !== 'friendsshare') return;
    const reference = session.client_reference_id;
    if (typeof reference !== 'string' || !reference.startsWith('fs_')) return;
    const account = accountById(reference.slice(3));
    const subscriptionId = idOf(session.subscription);
    const customerId = idOf(session.customer);
    if (!subscriptionId) {
      log('[billing] a checkout of ours came without a subscription');
      return;
    }
    if (!account) {
      // paid for after the account was deleted, say
      await cancelUnattachable(subscriptionId, customerId, 'the account does not exist (any more)');
      return;
    }
    if (!customerId) {
      log('[billing] a checkout of ours came without a customer');
      return;
    }

    let current = account;
    if (current.stripe_subscription_id && current.stripe_subscription_id !== subscriptionId && isRunning(current.sub_status)) {
      // a second subscription for an account that has one: unless the first one ended meanwhile
      await refreshSubscription(current, current.stripe_subscription_id, { missingMeansEnded: true });
      current = db.get('SELECT * FROM accounts WHERE id = ?', account.id) || current;
      if (current.stripe_subscription_id !== subscriptionId && isRunning(current.sub_status)) {
        await cancelUnattachable(subscriptionId, customerId, 'the account already has another running subscription');
        return;
      }
    }

    const known = current.stripe_subscription_id === subscriptionId;
    if (known && current.sub_status && !isRunning(current.sub_status)) return; // an old event, replayed after the end
    if (known) {
      db.run('UPDATE accounts SET stripe_customer_id = ? WHERE id = ?', customerId, account.id);
    } else {
      // Pro for the grace period on the strength of the checkout alone; the subscription's own
      // data (paid-through date, interval) follows from Stripe. Not for a payment still pending.
      const pending = session.payment_status === 'unpaid';
      db.run(
        `UPDATE accounts SET stripe_customer_id = ?, stripe_subscription_id = ?, sub_status = ?, sub_interval = NULL,
           sub_period_end = ?, sub_cancel_at_period_end = 0 WHERE id = ?`,
        customerId,
        subscriptionId,
        pending ? 'incomplete' : 'active',
        now(),
        account.id,
      );
      log(`[billing] checkout completed for account ${account.id}`);
    }
    // Not being able to look yet is not a failure (the grant above stands, the subscription's own
    // events confirm it); cancelling something that cannot be attached is, and is Stripe's to retry.
    let sub = null;
    try {
      sub = await readSubscription(subscriptionId);
    } catch (err) {
      log(`[billing] could not confirm the new subscription yet (${describe(err)})`);
    }
    if (sub) await settleSubscription(account, sub);
    hooks.planChanged(account.id);
  }

  async function onSubscriptionEvent(sub) {
    if (!isOurSubscription(sub) || typeof sub.id !== 'string') return; // the other product's
    const account = accountById(sub.metadata && sub.metadata.fs_account) || accountByCustomer(idOf(sub.customer));
    if (!account) {
      // What the event says may be old, so Stripe is asked what the subscription is like now.
      const fresh = await readSubscription(sub.id);
      if (fresh && isOurSubscription(fresh) && isRunning(fresh.status)) {
        await cancelUnattachable(sub.id, idOf(fresh.customer) || idOf(sub.customer), 'no account matches');
      } else {
        log('[billing] a subscription event of ours could not be matched to an account');
      }
      return;
    }
    await refreshSubscription(account, sub.id, { missingMeansEnded: true });
    hooks.planChanged(account.id);
  }

  // Serialised, so two events about one subscription cannot overwrite each other's reading.
  let queue = Promise.resolve();
  function handleEvent(event) {
    const run = async () => {
      const object = event && event.data && event.data.object;
      if (!object || typeof object !== 'object' || typeof event.type !== 'string') return;
      if (event.type === 'checkout.session.completed') await onCheckoutCompleted(object);
      else if (event.type.startsWith('customer.subscription.')) {
        // without the API key there is nothing to read the subscription with
        if (!stripeCfg.secretKey) log('[billing] a subscription event arrived but STRIPE_SECRET_KEY is not set');
        else await onSubscriptionEvent(object);
      }
    };
    const result = queue.then(run);
    queue = result.catch(() => {});
    return result;
  }

  // ---- routes ----

  const requireAccount = (ctx) => {
    const auth = ctx.auth();
    if (!auth) fail(401, 'signed_out', 'Sign in to continue.');
    return auth.account;
  };
  const billingOff = () => fail(503, 'billing_off', 'Subscriptions are not available on this server.');
  const alreadyPro = () => fail(409, 'already_pro', 'This account already has a Pro subscription. Use "Manage subscription" to change or cancel it.');
  const providerDown = (action, err) => {
    log(`[billing] ${action} failed (${describe(err)})`);
    return fail(502, 'billing_error', 'We could not reach our payment provider. Please try again in a moment.');
  };

  function register(router) {
    router.add('POST', '/api/billing/checkout', async (ctx) => {
      if (!config.billing) billingOff();
      const account = requireAccount(ctx);
      const { interval } = await ctx.body();
      if (interval !== 'month' && interval !== 'year') fail(400, 'bad_request', 'Choose a monthly or a yearly subscription.');
      if (account.stripe_subscription_id && isRunning(account.sub_status)) alreadyPro();
      // only what goes on to cost a call to Stripe is counted
      limit('checkout', account);
      let url;
      try {
        url = await startCheckout(account.id, interval);
      } catch (err) {
        if (err instanceof StripeError) providerDown('checkout', err);
        throw err;
      }
      ctx.json(200, { url });
    });

    router.add('POST', '/api/billing/portal', async (ctx) => {
      if (!config.billing) billingOff();
      const account = requireAccount(ctx);
      if (!account.stripe_customer_id) fail(409, 'no_subscription', 'This account has no subscription to manage.');
      limit('portal', account);
      let url;
      try {
        url = await portal(account);
      } catch (err) {
        providerDown('portal', err);
      }
      ctx.json(200, { url });
    });

    // Signed by Stripe, so it sits outside the same-site check. It keeps answering as long as the
    // webhook secret is set, even when billing is switched off, so Stripe does not see failures.
    router.add(
      'POST',
      '/api/billing/webhook',
      async (ctx) => {
        if (!stripeCfg.webhookSecret) billingOff();
        const signature = ctx.req.headers['stripe-signature'];
        // Before a byte of the body is read: whoever does not even claim to be Stripe is not worth it.
        if (typeof signature !== 'string' || !signature) fail(400, 'bad_request', 'The request has no signature.', { Connection: 'close' });
        const raw = await readBody(ctx.req, config.tuning.webhookBodyBytes);
        if (!verifySignature(raw, signature)) fail(400, 'bad_request', 'The signature of this event is not valid.');
        let event;
        try {
          event = JSON.parse(raw.toString('utf8'));
        } catch {
          fail(400, 'bad_request', 'The event is not valid JSON.');
        }
        try {
          await handleEvent(event);
        } catch (err) {
          // a failure here is Stripe's cue to deliver the event again later
          log(`[billing] could not process ${typeof (event && event.type) === 'string' ? event.type : 'an event'} (${describe(err)})`);
          fail(500, 'internal', 'The event could not be processed yet.');
        }
        ctx.json(200, { received: true });
      },
      { webhook: true },
    );
  }

  return { register, settleForDeletion, StripeError, describe, planOf: (account) => planOf(account, now()) };
}

module.exports = { createBilling, StripeError };
