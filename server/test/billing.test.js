// Pro subscriptions: what is sent to Stripe, what a webhook may change, and what happens to the
// connections of an account when its plan changes. Stripe is a fake; the real one is never called.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { withServer, connectApp, signIn, appLogin, makePro, signWebhook, subscription, announce, sleep, BASE, SESSION, BILLING_ENV } = require('./helpers');

const DAY = 86_400_000;
const MONTHLY = 'price_monthly_fs';
const YEARLY = 'price_yearly_fs';
const OPTIONS = { env: BILLING_ENV };
const stripeCalls = (h) => h.net.calling((c) => c.host === 'api.stripe.com');
const alerts = (h) => h.logs.filter((line) => line.startsWith('[billing] ALERT'));
const notices = (h) => h.logs.filter((line) => line.startsWith('[billing] NOTICE'));
const calls = (h) => stripeCalls(h).map((c) => `${c.method} ${c.path}`);
const nowSeconds = (h) => Math.floor(h.clock.t / 1000);
// the lines for a key that needs a person's approval before anything is cancelled
const NOTICE = (id, customer) =>
  `[billing] NOTICE subscription ${id} of customer ${customer} ends at its period end, because its immediate cancellation is waiting for approval in Stripe (Settings > Approvals).`;
const WAITING_ALERT = (id, customer, reason) =>
  `[billing] ALERT subscription ${id} of customer ${customer} could not be attached to an account (${reason}) and could not be cancelled yet: ` +
  "its cancellation is waiting for the owner's approval in Stripe (Settings > Approvals > Requests). Refund in Stripe dashboard: its first payment has to be given back by hand.";

// a signed event, delivered the way Stripe delivers it: no cookie, no Origin
function webhook(h, event, options = {}) {
  const { body, headers } = signWebhook(h.config, event, { t: nowSeconds(h), ...options.sign });
  return h.request('POST', '/api/billing/webhook', { body: options.body ?? body, headers: { ...headers, ...options.headers }, origin: null });
}

const checkoutEvent = (accountId, session = {}) => ({
  id: 'evt_checkout',
  type: 'checkout.session.completed',
  data: {
    object: {
      id: 'cs_test_1',
      object: 'checkout.session',
      mode: 'subscription',
      payment_status: 'paid',
      client_reference_id: `fs_${accountId}`,
      metadata: { app: 'friendsshare' },
      customer: 'cus_1',
      subscription: 'sub_1',
      ...session,
    },
  },
});
const subscriptionEvent = (type, sub) => ({ id: `evt_${type}`, type, data: { object: sub } });

// an account with a browser session, and the browser
async function member(h, person = {}) {
  const { b } = await signIn(h, person);
  return { b, accountId: h.accountId(person.email || 'ada@example.com') };
}

// Stripe's side: a running subscription of ours
function stripeHas(h, accountId, { price = MONTHLY, status = 'active', days = 30, ...rest } = {}) {
  const sub = subscription({ price, accountId, status, periodEnd: nowSeconds(h) + days * 86400, ...rest });
  h.net.stripe.subscriptions[sub.id] = sub;
  return sub;
}

// ---- starting a checkout ----

test('a checkout sends Stripe the price, the account reference and both metadata blocks, and returns the Stripe address', () =>
  withServer(OPTIONS, async (h) => {
    const { b, accountId } = await member(h);
    const res = await b.post('/api/billing/checkout', { interval: 'month' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { url: 'https://checkout.stripe.com/c/pay/cs_test_1' });

    const [call] = h.net.calling((c) => c.path === '/v1/checkout/sessions');
    assert.equal(call.method, 'POST');
    assert.equal(call.headers.authorization, 'Bearer sk_test_fakeKeyForTests');
    assert.equal(call.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.deepEqual(call.form, {
      mode: 'subscription',
      'line_items[0][price]': MONTHLY,
      'line_items[0][quantity]': '1',
      success_url: `${BASE}/account?billing=success`,
      cancel_url: `${BASE}/account?billing=cancelled`,
      client_reference_id: `fs_${accountId}`,
      'metadata[app]': 'friendsshare',
      'subscription_data[metadata][app]': 'friendsshare',
      'subscription_data[metadata][fs_account]': accountId,
      // the customer we made for this account a moment before, never an email address
      customer: 'cus_made_1',
    });
    // nothing that could be taken for the other product's markers
    assert.doesNotMatch(call.form.client_reference_id, /^\d+:\d+$/);
    assert.ok(!Object.keys(call.form).some((key) => key.includes('user_ref') || key === 'customer_email'));
    assert.ok(!('managed_payments[enabled]' in call.form));
    // the customer was made by us, for this account, and is the one that is remembered
    assert.deepEqual(stripeCalls(h).map((c) => `${c.method} ${c.path}`), ['POST /v1/customers', 'POST /v1/checkout/sessions']);
    const [made] = h.net.calling((c) => c.path === '/v1/customers');
    assert.deepEqual(made.form, { email: 'ada@example.com', name: 'Ada Lovelace', 'metadata[app]': 'friendsshare', 'metadata[fs_account]': accountId });
    assert.equal(made.headers.authorization, 'Bearer sk_test_fakeKeyForTests');
    assert.equal(h.db.get('SELECT stripe_customer_id AS c, checkout_session_id AS s FROM accounts').c, 'cus_made_1');
    assert.equal(h.db.get('SELECT checkout_session_id AS s FROM accounts').s, 'cs_test_1');
  }));

test('the yearly price is used for a yearly checkout', () =>
  withServer(OPTIONS, async (h) => {
    const { b } = await member(h);
    assert.equal((await b.post('/api/billing/checkout', { interval: 'year' })).status, 200);
    const [call] = h.net.calling((c) => c.path === '/v1/checkout/sessions');
    assert.equal(call.form['line_items[0][price]'], YEARLY);
  }));

test('managed payments are asked for only when switched on', () =>
  withServer({ env: { ...BILLING_ENV, STRIPE_MANAGED_PAYMENTS: '1' } }, async (h) => {
    const { b } = await member(h);
    await b.post('/api/billing/checkout', { interval: 'month' });
    const [call] = h.net.calling((c) => c.path === '/v1/checkout/sessions');
    assert.equal(call.form['managed_payments[enabled]'], 'true');
  }));

test('a later checkout reuses the customer Stripe created, instead of passing the email again', () =>
  withServer(OPTIONS, async (h) => {
    const { b, accountId } = await member(h);
    // a subscription that has ended: the customer stays on the account
    h.db.run(`UPDATE accounts SET stripe_customer_id = 'cus_old', stripe_subscription_id = 'sub_old', sub_status = 'canceled' WHERE id = ?`, accountId);
    assert.equal((await b.post('/api/billing/checkout', { interval: 'month' })).status, 200);
    const [call] = h.net.calling((c) => c.path === '/v1/checkout/sessions');
    assert.equal(call.form.customer, 'cus_old');
    assert.ok(!('customer_email' in call.form));
    // no second customer is made, ever
    assert.equal(h.net.calling((c) => c.path === '/v1/customers').length, 0);
  }));

test('every checkout of an account uses the one customer made for it', () =>
  withServer(OPTIONS, async (h) => {
    const { b } = await member(h);
    for (let n = 0; n < 3; n++) assert.equal((await b.post('/api/billing/checkout', { interval: n % 2 ? 'year' : 'month' })).status, 200);
    assert.equal(h.net.calling((c) => c.path === '/v1/customers').length, 1);
    const sessions = h.net.calling((c) => c.path === '/v1/checkout/sessions');
    assert.deepEqual(sessions.map((c) => c.form.customer), ['cus_made_1', 'cus_made_1', 'cus_made_1']);
    assert.ok(sessions.every((c) => !('customer_email' in c.form)));
    // another account gets a customer of its own
    const bob = await member(h, { id: 2, name: 'Bob', email: 'bob@example.com' });
    await bob.b.post('/api/billing/checkout', { interval: 'month' });
    assert.equal(h.net.calling((c) => c.path === '/v1/customers').length, 2);
    assert.equal(h.net.calling((c) => c.path === '/v1/checkout/sessions').at(-1).form.customer, 'cus_made_2');
  }));

test('a customer that cannot be made means no checkout, and nothing is remembered', () =>
  withServer(OPTIONS, async (h) => {
    const { b } = await member(h);
    h.net.stripe.fail['POST /customers'] = { status: 500, code: 'api_error' };
    const res = await b.post('/api/billing/checkout', { interval: 'month' });
    assert.equal(res.status, 502);
    assert.equal(res.json.error, 'billing_error');
    assert.equal(h.net.calling((c) => c.path === '/v1/checkout/sessions').length, 0);
    assert.deepEqual(h.db.get('SELECT stripe_customer_id AS c, checkout_session_id AS s FROM accounts'), { c: null, s: null });
    // and it works once Stripe does
    delete h.net.stripe.fail['POST /customers'];
    assert.equal((await b.post('/api/billing/checkout', { interval: 'month' })).status, 200);
  }));

test('two checkouts at the same moment make one customer and leave one session open', () =>
  withServer(OPTIONS, async (h) => {
    const { b, accountId } = await member(h);
    const [one, two] = await Promise.all([b.post('/api/billing/checkout', { interval: 'month' }), b.post('/api/billing/checkout', { interval: 'year' })]);
    assert.deepEqual([one.status, two.status], [200, 200]);
    assert.equal(h.net.calling((c) => c.path === '/v1/customers').length, 1);
    const sessions = Object.values(h.net.stripe.checkoutSessions);
    assert.equal(sessions.length, 2);
    assert.deepEqual(sessions.map((s) => s.status), ['expired', 'open'], 'the first was expired when the second was made');
    assert.equal(h.db.get('SELECT checkout_session_id AS s FROM accounts WHERE id = ?', accountId).s, sessions[1].id);
  }));

test('the app\'s token cannot start a checkout or open the portal: those are for the website', () =>
  withServer(OPTIONS, async (h) => {
    const { token } = await appLogin(h);
    const bearer = { authorization: `Bearer ${token}` };
    for (const [path, json] of [['/api/billing/checkout', { interval: 'year' }], ['/api/billing/portal', {}]]) {
      const res = await h.request('POST', path, { headers: bearer, json, origin: null });
      assert.equal(res.status, 403, path);
      assert.equal(res.json.error, 'forbidden');
      assert.match(res.json.message, /^[A-Z].*\.$/);
    }
    assert.equal(stripeCalls(h).length, 0);
  }));

test('a checkout needs a signed-in person and a valid interval', () =>
  withServer(OPTIONS, async (h) => {
    const out = await h.browser().post('/api/billing/checkout', { interval: 'month' });
    assert.equal(out.status, 401);
    assert.equal(out.json.error, 'signed_out');
    assert.match(out.json.message, /^[A-Z].*\.$/);

    const { b } = await member(h);
    for (const body of [{ interval: 'week' }, { interval: 'MONTH' }, { interval: 1 }, {}, { interval: null }]) {
      const res = await b.post('/api/billing/checkout', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.json.error, 'bad_request');
    }
    assert.equal((await b.request('POST', '/api/billing/checkout', { body: 'interval=month' })).status, 400);
    assert.equal(stripeCalls(h).length, 0);
  }));

test('a second checkout is refused while a subscription is running', () =>
  withServer(OPTIONS, async (h) => {
    const { b, accountId } = await member(h);
    makePro(h, accountId);
    const res = await b.post('/api/billing/checkout', { interval: 'year' });
    assert.equal(res.status, 409);
    assert.equal(res.json.error, 'already_pro');
    assert.match(res.json.message, /^[A-Z].*\.$/);
    assert.equal(stripeCalls(h).length, 0);
    // also while it is only past due: it is still a running subscription
    makePro(h, accountId, { status: 'past_due' });
    assert.equal((await b.post('/api/billing/checkout', { interval: 'year' })).json.error, 'already_pro');
  }));

test('without billing, checkout and portal answer billing_off and nothing is sent to Stripe', async () => {
  const cases = [
    { env: {} },
    { env: { ...BILLING_ENV, STRIPE_PRICE_YEARLY: '' } },
    { env: { ...BILLING_ENV, STRIPE_WEBHOOK_SECRET: '' } },
    { env: { ...BILLING_ENV, GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' } },
  ];
  for (const options of cases) {
    await withServer(options, async (h) => {
      const check = await h.browser().post('/api/billing/checkout', { interval: 'month' });
      assert.equal(check.status, 503, JSON.stringify(Object.keys(options.env)));
      assert.equal(check.json.error, 'billing_off');
      assert.match(check.json.message, /^[A-Z].*\.$/);
      assert.equal((await h.browser().post('/api/billing/portal')).json.error, 'billing_off');
      assert.equal(stripeCalls(h).length, 0);
      assert.equal((await h.request('GET', '/api/me')).json.billing, false);
    });
  }
});

test('a Stripe failure is a billing_error, and Stripe\'s own words, which may quote the key, never reach the person or the log', () =>
  withServer(OPTIONS, async (h) => {
    const { b } = await member(h);
    h.net.stripe.fail['POST /checkout/sessions'] = { status: 500, code: 'api_error' };
    const res = await b.post('/api/billing/checkout', { interval: 'month' });
    assert.equal(res.status, 502);
    assert.equal(res.json.error, 'billing_error');
    h.net.down = new Error('connect ECONNREFUSED, headers were Bearer sk_test_fakeKeyForTests');
    const unreachable = await b.post('/api/billing/checkout', { interval: 'month' });
    assert.equal(unreachable.status, 502);
    for (const text of [res.text, unreachable.text, h.logs.join('\n')]) assert.ok(!text.includes('sk_test_fakeKeyForTests'));
    assert.ok(h.logs.some((line) => line.startsWith('[billing] checkout failed')));
  }));

// ---- the customer portal ----

test('the portal is opened for the stored customer with FriendsShare\'s own portal configuration', () =>
  withServer(OPTIONS, async (h) => {
    const { b, accountId } = await member(h);
    assert.equal((await b.post('/api/billing/portal')).json.error, 'no_subscription');
    assert.equal((await b.post('/api/billing/portal')).status, 409);
    assert.equal(stripeCalls(h).length, 0);

    makePro(h, accountId);
    const res = await b.post('/api/billing/portal');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { url: 'https://billing.stripe.com/p/session/test_1' });
    const [call] = h.net.calling((c) => c.path === '/v1/billing_portal/sessions');
    assert.deepEqual(call.form, { customer: 'cus_1', return_url: `${BASE}/account`, configuration: 'bpc_friendsshare' });

    // without a configuration of ours nothing is passed, rather than something empty
    await withServer({ env: { ...BILLING_ENV, STRIPE_PORTAL_CONFIG: '' } }, async (plain) => {
      const member2 = await member(plain);
      makePro(plain, member2.accountId);
      await member2.b.post('/api/billing/portal');
      const [second] = plain.net.calling((c) => c.path === '/v1/billing_portal/sessions');
      assert.deepEqual(Object.keys(second.form).sort(), ['customer', 'return_url']);
    });

    assert.equal((await h.browser().post('/api/billing/portal')).json.error, 'signed_out');
    h.net.stripe.fail['POST /billing_portal/sessions'] = { status: 500 };
    assert.equal((await b.post('/api/billing/portal')).json.error, 'billing_error');
  }));

test('an account whose subscription ended can still open the portal for its invoices', () =>
  withServer(OPTIONS, async (h) => {
    const { b, accountId } = await member(h);
    makePro(h, accountId, { status: 'canceled' });
    assert.equal((await b.post('/api/billing/portal')).status, 200);
  }));

// ---- the webhook: who may call it ----

test('a webhook with a bad signature is refused and changes nothing', () =>
  withServer(OPTIONS, async (h) => {
    const { accountId } = await member(h);
    const event = checkoutEvent(accountId);
    const good = signWebhook(h.config, event, { t: nowSeconds(h) });
    const post = (body, headers) => h.request('POST', '/api/billing/webhook', { body, headers, origin: null });

    assert.equal((await post(good.body, {})).status, 400, 'no signature');
    assert.equal((await post(good.body, { 'stripe-signature': 'garbage' })).status, 400);
    assert.equal((await post(good.body, { 'stripe-signature': `t=${nowSeconds(h)},v1=${'0'.repeat(64)}` })).status, 400);
    const wrongSecret = signWebhook(h.config, event, { t: nowSeconds(h), secret: 'whsec_somebody_else' });
    assert.equal((await post(wrongSecret.body, wrongSecret.headers)).status, 400);
    // the body was changed after it was signed
    assert.equal((await post(good.body.replace('fs_', 'fs_0'), good.headers)).status, 400);
    // an old signature, replayed
    const stale = signWebhook(h.config, event, { t: nowSeconds(h) - 301 });
    assert.equal((await post(stale.body, stale.headers)).status, 400);
    const future = signWebhook(h.config, event, { t: nowSeconds(h) + 301 });
    assert.equal((await post(future.body, future.headers)).status, 400);
    // a signature over something that is not JSON
    const text = signWebhook(h.config, event, { t: nowSeconds(h) });
    const notJson = 'not json';
    const sig = require('node:crypto').createHmac('sha256', h.config.stripe.webhookSecret).update(`${nowSeconds(h)}.${notJson}`).digest('hex');
    assert.equal((await post(notJson, { 'stripe-signature': `t=${nowSeconds(h)},v1=${sig}` })).status, 400);
    assert.ok(text);

    const refused = await post(good.body, {});
    assert.equal(refused.json.error, 'bad_request');
    assert.equal(h.db.get('SELECT stripe_subscription_id AS id FROM accounts').id, null);
    assert.equal(stripeCalls(h).length, 0);
  }));

test('the webhook accepts the signature among several, as Stripe sends while a secret is being rotated', () =>
  withServer(OPTIONS, async (h) => {
    const { accountId } = await member(h);
    const body = JSON.stringify(checkoutEvent(accountId));
    const t = nowSeconds(h);
    const sign = (secret) => require('node:crypto').createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
    const header = `t=${t},v1=${sign('whsec_old')},v0=ignored,v1=${sign(h.config.stripe.webhookSecret)}`;
    const res = await h.request('POST', '/api/billing/webhook', { body, headers: { 'stripe-signature': header }, origin: null });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { received: true });
  }));

test('the webhook does not need to come from this site, and does not need a cookie', () =>
  withServer(OPTIONS, async (h) => {
    const { accountId } = await member(h);
    const res = await webhook(h, checkoutEvent(accountId), { headers: { origin: 'https://stripe.example', 'sec-fetch-site': 'cross-site' } });
    assert.equal(res.status, 200);
  }));

test('a webhook body over 1 MB is refused before it is read', () =>
  withServer(OPTIONS, async (h) => {
    const sig = signWebhook(h.config, {}, { t: nowSeconds(h) });
    // only the headers are sent, announcing 10 bytes more than the limit: the server must decide from them
    const res = await announce(h.port, 'POST', '/api/billing/webhook', sig.headers, 1024 * 1024 + 10);
    assert.equal(res.status, 413);
    assert.equal(res.json.error, 'too_large');
    assert.match(res.json.message, /^[A-Z].*\.$/);
    // exactly the limit is not too large (the signature is simply wrong for an empty body)
    const atLimit = await announce(h.port, 'POST', '/api/billing/webhook', sig.headers, 1024 * 1024, 'x'.repeat(1024 * 1024));
    assert.equal(atLimit.status, 400);
  }));

test('a webhook body over 1 MB that arrives in chunks is cut off too, never judged on its signature', () =>
  withServer(OPTIONS, async (h) => {
    const sig = signWebhook(h.config, {}, { t: nowSeconds(h) });
    const frame = `${(64 * 1024).toString(16)}\r\n${'x'.repeat(64 * 1024)}\r\n`;
    // 17 chunks of 64 KB, then the end of the body: without a limit this would be read to the end
    // and refused for its signature (400)
    const body = frame.repeat(17) + '0\r\n\r\n';
    const head = ['POST /api/billing/webhook HTTP/1.1', 'Host: 127.0.0.1', `Stripe-Signature: ${sig.headers['stripe-signature']}`, 'Transfer-Encoding: chunked', '', ''].join('\r\n');
    const { status } = await new Promise((resolve) => {
      const chunks = [];
      const socket = net.connect(h.port, '127.0.0.1', () => socket.write(head + body));
      socket.on('data', (chunk) => chunks.push(chunk));
      // the server may close on us while we are still writing; whatever it managed to say is enough
      socket.on('error', () => {});
      socket.on('close', () => resolve({ status: Number((/^HTTP\/1\.1 (\d{3})/.exec(Buffer.concat(chunks).toString('utf8')) || [])[1]) || null }));
      setTimeout(() => socket.destroy(), 3000).unref();
    });
    // a clean 413, or nothing at all because the connection was cut: never 400 and never 200
    assert.ok(status === 413 || status === null, `status ${status}`);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts WHERE stripe_subscription_id IS NOT NULL').n, 0);
  }));

test('ordinary API bodies over 64 KB are refused', () =>
  withServer(OPTIONS, async (h) => {
    const { b } = await member(h);
    const headers = { cookie: `${SESSION}=${b.cookie(SESSION)}`, origin: BASE, 'content-type': 'application/json' };
    const res = await announce(h.port, 'POST', '/api/billing/checkout', headers, 70 * 1024);
    assert.equal(res.status, 413);
    assert.equal(res.json.error, 'too_large');
    // just under the limit is read, and then it is the contents that are wrong
    const filler = JSON.stringify({ interval: 'week', filler: 'x'.repeat(60 * 1024) });
    const under = await announce(h.port, 'POST', '/api/billing/checkout', headers, Buffer.byteLength(filler), filler);
    assert.equal(under.status, 400);
    assert.equal(under.json.error, 'bad_request');
  }));

test('without a webhook secret the endpoint says billing_off, with one it answers even when billing is off', async () => {
  await withServer({}, async (h) => {
    const res = await h.request('POST', '/api/billing/webhook', { body: '{}', origin: null });
    assert.equal(res.status, 503);
    assert.equal(res.json.error, 'billing_off');
  });
  // Stripe is set up but there is no way to sign in: billing is off for people, the webhook keeps working
  const noLogin = { ...BILLING_ENV, GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' };
  await withServer({ env: noLogin }, async (h) => {
    assert.equal(h.config.billing, false);
    const now = h.clock.t;
    h.db.run(`INSERT INTO accounts (id, name, email, created_at) VALUES ('0123456789abcdef', 'Early customer', 'early@example.com', ?)`, now);
    const sub = stripeHas(h, '0123456789abcdef');
    const res = await webhook(h, checkoutEvent('0123456789abcdef'));
    assert.equal(res.status, 200);
    const row = h.db.get('SELECT stripe_customer_id, stripe_subscription_id, sub_status, sub_interval FROM accounts');
    assert.deepEqual(row, { stripe_customer_id: 'cus_1', stripe_subscription_id: sub.id, sub_status: 'active', sub_interval: 'month' });
    const bad = await h.request('POST', '/api/billing/webhook', { body: '{}', headers: { 'stripe-signature': 't=1,v1=00' }, origin: null });
    assert.equal(bad.status, 400);
  });
});

// ---- the webhook: what it does to an account ----

test('our checkout and subscription events make the account Pro and push the plan to its open connection', () =>
  withServer(OPTIONS, async (h) => {
    const { b, token } = await appLogin(h);
    const accountId = h.accountId('ada@example.com');
    const app = await connectApp(h, { hello: { token } });
    assert.equal(app.reply.plan, 'free');
    assert.equal(app.reply.limit, 5);

    // checkout completes; Stripe has the subscription
    const sub = stripeHas(h, accountId, { price: YEARLY, days: 365 });
    assert.equal((await webhook(h, checkoutEvent(accountId))).status, 200);
    assert.deepEqual(await app.next('plan'), { t: 'plan', plan: 'pro', limit: null });

    assert.equal((await webhook(h, subscriptionEvent('customer.subscription.created', sub))).status, 200);
    assert.equal((await webhook(h, subscriptionEvent('customer.subscription.updated', sub))).status, 200);
    // the plan did not change again, so nothing more is pushed
    assert.deepEqual(await app.quiet(80), []);

    const me = (await b.get('/api/me')).json;
    assert.equal(me.plan, 'pro');
    assert.deepEqual(me.subscription, { status: 'active', interval: 'year', renews_at: sub.current_period_end * 1000, cancel_at_period_end: false });
    // a connection made now is Pro from the start
    const fresh = await connectApp(h, { hello: { token } });
    assert.equal(fresh.reply.plan, 'pro');
    assert.equal(fresh.reply.limit, null);

    // what Stripe was asked: the checkout's subscription, read once per event
    assert.ok(stripeCalls(h).every((c) => c.method === 'GET' && c.path === '/v1/subscriptions/sub_1'));
  }));

test('every connection of the account hears about the change, and nobody else', () =>
  withServer(OPTIONS, async (h) => {
    const { token } = await appLogin(h);
    const accountId = h.accountId('ada@example.com');
    const other = await appLogin(h, { id: 2, name: 'Bob', email: 'bob@example.com' });
    const [one, two, bob, guest] = [
      await connectApp(h, { hello: { token } }),
      await connectApp(h, { hello: { token } }),
      await connectApp(h, { hello: { token: other.token } }),
      await connectApp(h),
    ];
    stripeHas(h, accountId);
    await webhook(h, checkoutEvent(accountId));
    assert.equal((await one.next('plan')).plan, 'pro');
    assert.equal((await two.next('plan')).plan, 'pro');
    assert.deepEqual(await bob.quiet(80), []);
    assert.deepEqual(await guest.quiet(10), []);
  }));

test('the checkout alone makes the account Pro for three days, until the subscription confirms it', () =>
  withServer(OPTIONS, async (h) => {
    const { b, token } = await appLogin(h);
    const accountId = h.accountId('ada@example.com');
    const app = await connectApp(h, { hello: { token } });
    // Stripe cannot be asked about the subscription yet (the fake does not know it)
    assert.equal((await webhook(h, checkoutEvent(accountId))).status, 200);
    assert.deepEqual(await app.next('plan'), { t: 'plan', plan: 'pro', limit: null });
    const me = (await b.get('/api/me')).json;
    assert.equal(me.plan, 'pro');
    assert.equal(me.subscription.status, 'active');

    h.clock.advance(3 * DAY - 1000);
    h.server.match.recheckPlans();
    assert.deepEqual(await app.quiet(60), []);
    h.clock.advance(2000);
    h.server.match.recheckPlans();
    assert.deepEqual(await app.next('plan'), { t: 'plan', plan: 'free', limit: 5 });
    assert.equal((await b.get('/api/me')).json.plan, 'free');
  }));

test('a checkout for a payment that is still pending does not grant Pro yet', () =>
  withServer(OPTIONS, async (h) => {
    const { b, accountId } = await member(h);
    await webhook(h, checkoutEvent(accountId, { payment_status: 'unpaid' }));
    assert.equal((await b.get('/api/me')).json.plan, 'free');
    // the subscription event that follows decides
    const sub = stripeHas(h, accountId);
    await webhook(h, subscriptionEvent('customer.subscription.updated', sub));
    assert.equal((await b.get('/api/me')).json.plan, 'pro');
  }));

test('the subscription is read from Stripe again, so what the event says does not matter and the order of events does not either', () =>
  withServer(OPTIONS, async (h) => {
    const { b, accountId } = await member(h);
    const sub = stripeHas(h, accountId);
    // the event body is stale and claims the subscription is gone; Stripe says it is active
    const stale = { ...sub, status: 'canceled' };
    await webhook(h, subscriptionEvent('customer.subscription.deleted', stale));
    assert.equal((await b.get('/api/me')).json.plan, 'pro');

    // now it really ended, and an old "updated" event arrives afterwards
    h.net.stripe.subscriptions.sub_1 = { ...sub, status: 'canceled' };
    await webhook(h, subscriptionEvent('customer.subscription.deleted', { ...sub, status: 'canceled' }));
    assert.equal((await b.get('/api/me')).json.plan, 'free');
    await webhook(h, subscriptionEvent('customer.subscription.updated', sub));
    assert.equal((await b.get('/api/me')).json.plan, 'free');
  }));

test('the period end is read from the subscription, or from its item on newer API versions', () =>
  withServer(OPTIONS, async (h) => {
    const { b, accountId } = await member(h);
    const end = nowSeconds(h) + 10 * 86400;
    h.net.stripe.subscriptions.sub_1 = subscription({ price: MONTHLY, accountId, periodEnd: end, newApi: true });
    await webhook(h, subscriptionEvent('customer.subscription.created', h.net.stripe.subscriptions.sub_1));
    assert.equal((await b.get('/api/me')).json.subscription.renews_at, end * 1000);
    h.net.stripe.subscriptions.sub_1 = subscription({ price: MONTHLY, accountId, periodEnd: end + 86400, newApi: false });
    await webhook(h, subscriptionEvent('customer.subscription.updated', h.net.stripe.subscriptions.sub_1));
    assert.equal((await b.get('/api/me')).json.subscription.renews_at, (end + 86400) * 1000);
  }));

test('cancelling at the end of the period keeps Pro until then, and the period ending makes the account free', () =>
  withServer(OPTIONS, async (h) => {
    const { b, token } = await appLogin(h);
    const accountId = h.accountId('ada@example.com');
    const app = await connectApp(h, { hello: { token } });
    const sub = stripeHas(h, accountId, { days: 30 });
    await webhook(h, subscriptionEvent('customer.subscription.created', sub));
    await app.next('plan');

    h.net.stripe.subscriptions.sub_1 = { ...sub, cancel_at_period_end: true };
    await webhook(h, subscriptionEvent('customer.subscription.updated', sub));
    let me = (await b.get('/api/me')).json;
    assert.equal(me.plan, 'pro');
    assert.deepEqual(me.subscription, { status: 'active', interval: 'month', renews_at: sub.current_period_end * 1000, cancel_at_period_end: true });
    assert.deepEqual(await app.quiet(60), []);

    // the end of the paid period, plus three days of grace for late payments and late webhooks
    h.clock.advance(30 * DAY + 3 * DAY - 1000);
    h.server.match.recheckPlans();
    assert.equal((await b.get('/api/me')).json.plan, 'pro');
    h.clock.advance(2000);
    h.server.match.recheckPlans();
    assert.deepEqual(await app.next('plan'), { t: 'plan', plan: 'free', limit: 5 });
    me = (await b.get('/api/me')).json;
    assert.equal(me.plan, 'free');

    // Stripe then reports the end, and a new checkout is possible
    h.net.stripe.subscriptions.sub_1 = { ...sub, status: 'canceled' };
    await webhook(h, subscriptionEvent('customer.subscription.deleted', sub));
    me = (await b.get('/api/me')).json;
    assert.equal(me.subscription, null);
    assert.equal((await b.post('/api/billing/checkout', { interval: 'month' })).status, 200);
  }));

test('a subscription that Stripe has ended makes the account free at once and tells its connections', () =>
  withServer(OPTIONS, async (h) => {
    const { b, token } = await appLogin(h);
    const accountId = h.accountId('ada@example.com');
    const sub = stripeHas(h, accountId);
    await webhook(h, subscriptionEvent('customer.subscription.created', sub));
    const app = await connectApp(h, { hello: { token } });
    assert.equal(app.reply.plan, 'pro');

    h.net.stripe.subscriptions.sub_1 = { ...sub, status: 'canceled' };
    await webhook(h, subscriptionEvent('customer.subscription.deleted', sub));
    assert.deepEqual(await app.next('plan'), { t: 'plan', plan: 'free', limit: 5 });
    assert.equal((await b.get('/api/me')).json.plan, 'free');
  }));

test('a subscription that no longer exists at Stripe counts as ended', () =>
  withServer(OPTIONS, async (h) => {
    const { b, accountId } = await member(h);
    const sub = stripeHas(h, accountId);
    await webhook(h, subscriptionEvent('customer.subscription.created', sub));
    assert.equal((await b.get('/api/me')).json.plan, 'pro');
    delete h.net.stripe.subscriptions.sub_1;
    assert.equal((await webhook(h, subscriptionEvent('customer.subscription.deleted', sub))).status, 200);
    assert.equal((await b.get('/api/me')).json.plan, 'free');
  }));

test('past due keeps Pro within the paid period, unpaid and the other end states do not', () =>
  withServer(OPTIONS, async (h) => {
    const { b, accountId } = await member(h);
    const plan = async () => (await b.get('/api/me')).json.plan;
    const state = async (status) => {
      h.net.stripe.subscriptions.sub_1 = subscription({ price: MONTHLY, accountId, status, periodEnd: nowSeconds(h) + 5 * 86400 });
      await webhook(h, subscriptionEvent('customer.subscription.updated', h.net.stripe.subscriptions.sub_1));
      return plan();
    };
    assert.equal(await state('trialing'), 'pro');
    assert.equal(await state('past_due'), 'pro');
    assert.equal(await state('active'), 'pro');
    for (const status of ['unpaid', 'canceled', 'incomplete', 'incomplete_expired', 'paused']) assert.equal(await state(status), 'free', status);
    assert.equal(await state('active'), 'pro');
  }));

test('a failed re-read makes the webhook answer with an error so Stripe delivers the event again, and nothing changes meanwhile', () =>
  withServer(OPTIONS, async (h) => {
    const { b, accountId } = await member(h);
    const sub = stripeHas(h, accountId);
    h.net.stripe.fail['GET /subscriptions/:id'] = { status: 500, code: 'api_error' };
    const failed = await webhook(h, subscriptionEvent('customer.subscription.created', sub));
    assert.equal(failed.status, 500);
    assert.equal((await b.get('/api/me')).json.plan, 'free');
    assert.ok(h.logs.some((line) => line.startsWith('[billing] could not process customer.subscription.created')));
    assert.ok(!h.logs.join('\n').includes('sk_test_fakeKeyForTests'));

    delete h.net.stripe.fail['GET /subscriptions/:id'];
    assert.equal((await webhook(h, subscriptionEvent('customer.subscription.created', sub))).status, 200);
    assert.equal((await b.get('/api/me')).json.plan, 'pro');
  }));

test('events for a subscription that is not the one the account has now do not end or replace it', () =>
  withServer(OPTIONS, async (h) => {
    const { b, accountId } = await member(h);
    const current = stripeHas(h, accountId, { id: 'sub_2' });
    await webhook(h, subscriptionEvent('customer.subscription.created', current));
    // an older subscription, ended long ago, reports its end now
    h.net.stripe.subscriptions.sub_1 = subscription({ id: 'sub_1', price: MONTHLY, accountId, status: 'canceled', periodEnd: nowSeconds(h) - 86400 });
    await webhook(h, subscriptionEvent('customer.subscription.deleted', h.net.stripe.subscriptions.sub_1));
    assert.equal((await b.get('/api/me')).json.plan, 'pro');
    assert.equal(h.db.get('SELECT stripe_subscription_id AS id FROM accounts').id, 'sub_2');
    // an ended subscription is nothing to cancel and nothing to raise an alarm about
    assert.deepEqual(stripeCalls(h).filter((c) => c.method === 'DELETE'), []);
    assert.deepEqual(alerts(h), []);
  }));

// ---- a subscription that cannot be attached is cancelled, and the operator is told ----

test('a second running subscription for an account is cancelled at once, and the operator is told to refund it', () =>
  withServer(OPTIONS, async (h) => {
    const { b, accountId } = await member(h);
    const first = stripeHas(h, accountId, { id: 'sub_2', customer: 'cus_1' });
    await webhook(h, subscriptionEvent('customer.subscription.created', first));
    const second = stripeHas(h, accountId, { id: 'sub_3', customer: 'cus_3', price: YEARLY, days: 365 });
    const before = stripeCalls(h).length;

    const res = await webhook(h, subscriptionEvent('customer.subscription.created', second));
    assert.equal(res.status, 200);
    // it asked about the second, then about the first (which might have ended), then cancelled the second
    assert.deepEqual(stripeCalls(h).slice(before).map((c) => `${c.method} ${c.path}`), ['GET /v1/subscriptions/sub_3', 'GET /v1/subscriptions/sub_2', 'DELETE /v1/subscriptions/sub_3']);
    assert.equal(h.net.stripe.subscriptions.sub_3.status, 'canceled');
    assert.equal(h.net.stripe.subscriptions.sub_2.status, 'active', 'the first one is left alone');
    // the account is as before
    assert.equal(h.db.get('SELECT stripe_subscription_id AS id FROM accounts').id, 'sub_2');
    assert.equal((await b.get('/api/me')).json.subscription.interval, 'month');
    // one line that cannot be missed, with the ids and what to do, and nothing personal
    assert.deepEqual(alerts(h), [
      '[billing] ALERT subscription sub_3 of customer cus_3 could not be attached to an account (the account already has another running subscription) and was cancelled. Refund in Stripe dashboard: its first payment has to be given back by hand.',
    ]);
    assert.ok(!alerts(h)[0].includes('ada@example.com') && !alerts(h)[0].includes(accountId));
  }));

test('the checkout of a second subscription is cancelled the same way', () =>
  withServer(OPTIONS, async (h) => {
    const { accountId } = await member(h);
    const first = stripeHas(h, accountId, { id: 'sub_2', customer: 'cus_1' });
    await webhook(h, subscriptionEvent('customer.subscription.created', first));
    stripeHas(h, accountId, { id: 'sub_3', customer: 'cus_3', price: YEARLY, days: 365 });

    assert.equal((await webhook(h, checkoutEvent(accountId, { subscription: 'sub_3', customer: 'cus_3' }))).status, 200);
    assert.equal(h.net.stripe.subscriptions.sub_3.status, 'canceled');
    assert.equal(h.db.get('SELECT stripe_subscription_id AS id, stripe_customer_id AS c FROM accounts').id, 'sub_2');
    assert.equal(alerts(h).length, 1);
    assert.match(alerts(h)[0], /^\[billing\] ALERT subscription sub_3 of customer cus_3 /);
  }));

test('a subscription that is paid for after its account was deleted is cancelled and reported', () =>
  withServer(OPTIONS, async (h) => {
    const { b, accountId } = await member(h);
    await b.post('/api/billing/checkout', { interval: 'month' });
    // the person pays at the very moment of deleting the account: the session is complete when the
    // deletion tries to expire it, and the webhook arrives after the account is gone
    const [sessionId] = Object.keys(h.net.stripe.checkoutSessions);
    h.net.stripe.checkoutSessions[sessionId].status = 'complete';
    assert.equal((await b.post('/api/account/delete')).status, 204);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts').n, 0);

    stripeHas(h, accountId, { id: 'sub_c', customer: 'cus_made_1' });
    assert.equal((await webhook(h, checkoutEvent(accountId, { id: sessionId, subscription: 'sub_c', customer: 'cus_made_1' }))).status, 200);
    assert.equal(h.net.stripe.subscriptions.sub_c.status, 'canceled');
    assert.deepEqual(alerts(h), [
      '[billing] ALERT subscription sub_c of customer cus_made_1 could not be attached to an account (the account does not exist (any more)) and was cancelled. Refund in Stripe dashboard: its first payment has to be given back by hand.',
    ]);
  }));

test('a subscription of ours that no account matches is cancelled when it is running, and only then', () =>
  withServer(OPTIONS, async (h) => {
    const ghost = (extra) => subscription({ id: 'sub_g', customer: 'cus_g', price: MONTHLY, accountId: 'ffffffffffffffff', periodEnd: nowSeconds(h) + 86400, ...extra });
    // running at Stripe: cancelled, whatever the event said
    h.net.stripe.subscriptions.sub_g = ghost({});
    assert.equal((await webhook(h, subscriptionEvent('customer.subscription.created', { ...ghost({}), status: 'incomplete' }))).status, 200);
    assert.equal(h.net.stripe.subscriptions.sub_g.status, 'canceled');
    assert.equal(alerts(h).length, 1);
    assert.match(alerts(h)[0], /subscription sub_g of customer cus_g could not be attached to an account \(no account matches\)/);

    // an account id that is no id at all, and one that matches no account: the same
    h.net.stripe.subscriptions.sub_g = ghost({});
    await webhook(h, subscriptionEvent('customer.subscription.updated', { ...ghost({}), metadata: { fs_account: '../../etc' } }));
    assert.equal(h.net.stripe.subscriptions.sub_g.status, 'canceled');
    assert.equal(alerts(h).length, 2);

    // already ended, or not known to Stripe: nothing to cancel, nothing to refund
    h.net.stripe.subscriptions.sub_g = ghost({ status: 'canceled' });
    await webhook(h, subscriptionEvent('customer.subscription.deleted', ghost({ status: 'canceled' })));
    delete h.net.stripe.subscriptions.sub_g;
    await webhook(h, subscriptionEvent('customer.subscription.created', ghost({})));
    assert.equal(alerts(h).length, 2);
    assert.equal(stripeCalls(h).filter((c) => c.method === 'DELETE').length, 2);
    assert.ok(h.logs.some((line) => line.includes('could not be matched to an account')));
  }));

test('a new subscription is not cancelled for a ghost: when the stored one has ended at Stripe, the new one is taken', () =>
  withServer(OPTIONS, async (h) => {
    const { b, accountId } = await member(h);
    const first = stripeHas(h, accountId, { id: 'sub_2' });
    await webhook(h, subscriptionEvent('customer.subscription.created', first));
    // the person cancelled right away and bought again; the first one's "deleted" has not arrived, the new one's "created" has
    h.net.stripe.subscriptions.sub_2 = { ...first, status: 'canceled' };
    const second = stripeHas(h, accountId, { id: 'sub_4', price: YEARLY, days: 365 });
    assert.equal((await webhook(h, subscriptionEvent('customer.subscription.created', second))).status, 200);
    assert.equal(h.db.get('SELECT stripe_subscription_id AS id FROM accounts').id, 'sub_4');
    const me = (await b.get('/api/me')).json;
    assert.deepEqual([me.plan, me.subscription.interval], ['pro', 'year']);
    assert.deepEqual(stripeCalls(h).filter((c) => c.method === 'DELETE'), []);
    assert.deepEqual(alerts(h), []);

    // and the same when it is the checkout that arrives first
    const { accountId: bobId } = await member(h, { id: 2, name: 'Bob', email: 'bob@example.com' });
    const bobFirst = stripeHas(h, bobId, { id: 'sub_5' });
    await webhook(h, subscriptionEvent('customer.subscription.created', bobFirst));
    h.net.stripe.subscriptions.sub_5 = { ...bobFirst, status: 'canceled' };
    stripeHas(h, bobId, { id: 'sub_6', customer: 'cus_6' });
    assert.equal((await webhook(h, checkoutEvent(bobId, { subscription: 'sub_6', customer: 'cus_6' }))).status, 200);
    assert.equal(h.db.get('SELECT stripe_subscription_id AS id FROM accounts WHERE id = ?', bobId).id, 'sub_6');
    assert.deepEqual(alerts(h), []);
  }));

test('if Stripe will not cancel the subscription the webhook answers with an error so that Stripe tries again, and no alert claims it was cancelled', () =>
  withServer(OPTIONS, async (h) => {
    const { accountId } = await member(h);
    stripeHas(h, accountId, { id: 'sub_2' });
    await webhook(h, subscriptionEvent('customer.subscription.created', h.net.stripe.subscriptions.sub_2));
    const second = stripeHas(h, accountId, { id: 'sub_3', customer: 'cus_3' });

    h.net.stripe.fail['DELETE /subscriptions/:id'] = { status: 500, code: 'api_error' };
    const failed = await webhook(h, subscriptionEvent('customer.subscription.created', second));
    assert.equal(failed.status, 500);
    assert.deepEqual(alerts(h), []);
    assert.equal(h.net.stripe.subscriptions.sub_3.status, 'active');
    assert.ok(!h.logs.join('\n').includes('sk_test_fakeKeyForTests'));
    // Stripe's second attempt, once it works again
    delete h.net.stripe.fail['DELETE /subscriptions/:id'];
    assert.equal((await webhook(h, subscriptionEvent('customer.subscription.created', second))).status, 200);
    assert.equal(h.net.stripe.subscriptions.sub_3.status, 'canceled');
    assert.equal(alerts(h).length, 1);

    // the same for a subscription whose account is gone
    h.net.stripe.fail['DELETE /subscriptions/:id'] = { status: 500, code: 'api_error' };
    stripeHas(h, 'ffffffffffffffff', { id: 'sub_x', customer: 'cus_x' });
    assert.equal((await webhook(h, checkoutEvent('ffffffffffffffff', { subscription: 'sub_x', customer: 'cus_x' }))).status, 500);
    assert.equal(alerts(h).length, 1);
  }));

test('when Stripe wants approval to cancel a subscription that no account matches, the owner is told once, the webhook is answered, and nothing is asked again', () =>
  withServer(OPTIONS, async (h) => {
    h.net.stripe.approval.cancel = true;
    const ghost = () => subscription({ id: 'sub_g', customer: 'cus_g', price: MONTHLY, accountId: 'ffffffffffffffff', periodEnd: nowSeconds(h) + 86400 });
    h.net.stripe.subscriptions.sub_g = ghost();

    const first = await webhook(h, subscriptionEvent('customer.subscription.created', ghost()));
    assert.equal(first.status, 200, 'no failure for Stripe to deliver the event again for');
    // one line that cannot be missed: the ids, that it waits for the owner and where, and that the money has to be given back by hand
    assert.deepEqual(alerts(h), [WAITING_ALERT('sub_g', 'cus_g', 'no account matches')]);
    assert.ok(!alerts(h)[0].includes('was cancelled'));
    assert.equal(h.net.stripe.subscriptions.sub_g.status, 'active', 'it waits for the owner');
    assert.deepEqual(h.net.stripe.approvals, [{ kind: 'cancel', subscription: 'sub_g' }]);

    // later events about the same subscription, however they come: no call, no line
    const before = stripeCalls(h).length;
    for (const event of [
      subscriptionEvent('customer.subscription.updated', ghost()),
      subscriptionEvent('customer.subscription.created', ghost()),
      checkoutEvent('ffffffffffffffff', { subscription: 'sub_g', customer: 'cus_g' }),
    ]) {
      assert.equal((await webhook(h, event)).status, 200);
    }
    assert.equal(stripeCalls(h).length, before, 'Stripe was asked nothing');
    assert.equal(alerts(h).length, 1);
    assert.equal(h.net.stripe.approvals.length, 1);

    // another subscription is another matter, and is told about as well
    h.net.stripe.subscriptions.sub_h = { ...ghost(), id: 'sub_h', customer: 'cus_h' };
    assert.equal((await webhook(h, subscriptionEvent('customer.subscription.created', h.net.stripe.subscriptions.sub_h))).status, 200);
    assert.deepEqual(alerts(h).map((line) => line.slice(0, 50)), [WAITING_ALERT('sub_g', 'cus_g', 'no account matches').slice(0, 50), WAITING_ALERT('sub_h', 'cus_h', 'no account matches').slice(0, 50)]);
    assert.deepEqual(h.net.stripe.approvals.map((a) => a.subscription), ['sub_g', 'sub_h']);
  }));

test('when Stripe wants approval to cancel a second running subscription, the account keeps the first and the owner is told once', () =>
  withServer(OPTIONS, async (h) => {
    const { b, accountId } = await member(h);
    const first = stripeHas(h, accountId, { id: 'sub_2', customer: 'cus_1' });
    await webhook(h, subscriptionEvent('customer.subscription.created', first));
    const second = stripeHas(h, accountId, { id: 'sub_3', customer: 'cus_3', price: YEARLY, days: 365 });
    h.net.stripe.approval.cancel = new Set(['sub_3']);

    assert.equal((await webhook(h, subscriptionEvent('customer.subscription.created', second))).status, 200);
    assert.deepEqual(alerts(h), [WAITING_ALERT('sub_3', 'cus_3', 'the account already has another running subscription')]);
    assert.equal(h.db.get('SELECT stripe_subscription_id AS id FROM accounts').id, 'sub_2');
    assert.equal((await b.get('/api/me')).json.subscription.interval, 'month');
    assert.equal(h.net.stripe.subscriptions.sub_3.status, 'active', 'it waits for the owner');

    // the same subscription again, by its own event and by its checkout: nothing more is asked or said
    const deletes = () => stripeCalls(h).filter((c) => c.method === 'DELETE').length;
    assert.equal(deletes(), 1);
    assert.equal((await webhook(h, subscriptionEvent('customer.subscription.updated', second))).status, 200);
    assert.equal((await webhook(h, checkoutEvent(accountId, { subscription: 'sub_3', customer: 'cus_3' }))).status, 200);
    assert.equal(deletes(), 1);
    assert.equal(alerts(h).length, 1);
    assert.deepEqual(h.net.stripe.approvals.map((a) => a.subscription), ['sub_3']);
    assert.equal(h.db.get('SELECT stripe_subscription_id AS id FROM accounts').id, 'sub_2');
  }));

test('the checkout of a second subscription that waits for approval is answered as handled as well', () =>
  withServer(OPTIONS, async (h) => {
    const { accountId } = await member(h);
    const first = stripeHas(h, accountId, { id: 'sub_2', customer: 'cus_1' });
    await webhook(h, subscriptionEvent('customer.subscription.created', first));
    stripeHas(h, accountId, { id: 'sub_3', customer: 'cus_3', price: YEARLY, days: 365 });
    h.net.stripe.approval.cancel = true;

    assert.equal((await webhook(h, checkoutEvent(accountId, { subscription: 'sub_3', customer: 'cus_3' }))).status, 200);
    assert.deepEqual(alerts(h), [WAITING_ALERT('sub_3', 'cus_3', 'the account already has another running subscription')]);
    assert.equal(h.db.get('SELECT stripe_subscription_id AS id, stripe_customer_id AS c FROM accounts').id, 'sub_2');
    // and a purchase after the account was deleted
    assert.equal((await webhook(h, checkoutEvent('ffffffffffffffff', { subscription: 'sub_x', customer: 'cus_x' }))).status, 200);
    assert.equal(alerts(h).length, 2);
    assert.match(alerts(h)[1], /^\[billing\] ALERT subscription sub_x of customer cus_x could not be attached to an account \(the account does not exist \(any more\)\) and could not be cancelled yet: its cancellation is waiting for the owner's approval in Stripe \(Settings > Approvals > Requests\)\./);
  }));

test('a subscription that is over, or ends with its paid period, is never cancelled: no call and no alert', () =>
  withServer(OPTIONS, async (h) => {
    h.net.stripe.approval.cancel = true; // a cancel call would show up as a request for the owner
    const ghost = (extra) => ({ ...subscription({ id: 'sub_g', customer: 'cus_g', price: MONTHLY, accountId: 'ffffffffffffffff', periodEnd: nowSeconds(h) + 86400 }), ...extra });
    for (const [what, extra] of Object.entries({
      'set to end with the period': { cancel_at_period_end: true },
      'set to end at a date': { cancel_at: nowSeconds(h) + 86400 },
      cancelled: { status: 'canceled' },
      'expired before it was paid': { status: 'incomplete_expired' },
    })) {
      h.net.stripe.subscriptions.sub_g = ghost(extra);
      for (const type of ['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted']) {
        assert.equal((await webhook(h, subscriptionEvent(type, ghost(extra)))).status, 200, `${what}: ${type}`);
      }
    }
    // what Stripe says now is what counts, not what the event said
    h.net.stripe.subscriptions.sub_g = ghost({ cancel_at_period_end: true });
    assert.equal((await webhook(h, subscriptionEvent('customer.subscription.updated', ghost({})))).status, 200);
    assert.equal(stripeCalls(h).filter((c) => c.method !== 'GET').length, 0, 'nothing was cancelled or changed');
    assert.deepEqual(h.net.stripe.approvals, []);
    assert.deepEqual(alerts(h), []);
    assert.ok(h.logs.some((line) => line.includes('could not be matched to an account')));

    // the same when it is the checkout that tells of such a subscription, for an account that is gone
    for (const extra of [{ cancel_at_period_end: true }, { status: 'canceled' }]) {
      h.net.stripe.subscriptions.sub_g = ghost(extra);
      assert.equal((await webhook(h, checkoutEvent('ffffffffffffffff', { subscription: 'sub_g', customer: 'cus_g' }))).status, 200);
    }
    assert.equal(stripeCalls(h).filter((c) => c.method !== 'GET').length, 0);
    assert.equal(h.logs.filter((line) => line.includes('subscription sub_g of ours is not attached to an account, but it is over or ends with its paid period')).length, 2);

    // nor is a second subscription of an account when it ends by itself anyway, by its own event or by its checkout
    const { accountId } = await member(h);
    const first = stripeHas(h, accountId, { id: 'sub_2', customer: 'cus_1' });
    await webhook(h, subscriptionEvent('customer.subscription.created', first));
    const second = stripeHas(h, accountId, { id: 'sub_3', customer: 'cus_3', cancelAtPeriodEnd: true });
    assert.equal((await webhook(h, subscriptionEvent('customer.subscription.created', second))).status, 200);
    stripeHas(h, accountId, { id: 'sub_4', customer: 'cus_4', cancelAtPeriodEnd: true });
    assert.equal((await webhook(h, checkoutEvent(accountId, { subscription: 'sub_4', customer: 'cus_4' }))).status, 200);
    assert.equal(stripeCalls(h).filter((c) => c.method !== 'GET').length, 0);
    assert.equal(h.db.get('SELECT stripe_subscription_id AS id FROM accounts').id, 'sub_2', 'the account keeps what it had');
    assert.deepEqual(alerts(h), []);
    assert.deepEqual(h.net.stripe.approvals, []);
  }));

test('a subscription that Stripe no longer knows is still reported when it has to be cancelled', () =>
  withServer(OPTIONS, async (h) => {
    // not in the fake: DELETE answers "No such subscription", as Stripe does for one that ended already
    assert.equal((await webhook(h, checkoutEvent('ffffffffffffffff', { subscription: 'sub_gone', customer: 'cus_gone' }))).status, 200);
    assert.equal(alerts(h).length, 1);
    assert.match(alerts(h)[0], /subscription sub_gone of customer cus_gone /);
  }));

test('the other product\'s events never lead to a cancellation or an alert', () =>
  withServer(OPTIONS, async (h) => {
    const foreign = {
      id: 'sub_other',
      customer: 'cus_other',
      status: 'active',
      current_period_end: nowSeconds(h) + 86400,
      items: { data: [{ price: { id: 'price_other_product' } }] },
      metadata: { user_ref: '12:34' },
    };
    h.net.stripe.subscriptions.sub_other = foreign;
    await webhook(h, subscriptionEvent('customer.subscription.created', foreign));
    await webhook(h, checkoutEvent('ffffffffffffffff', { client_reference_id: '12:34', metadata: {}, subscription: 'sub_other', customer: 'cus_other' }));
    await webhook(h, checkoutEvent('ffffffffffffffff', { metadata: { app: 'repoeasy' }, subscription: 'sub_other' }));
    assert.equal(h.net.stripe.subscriptions.sub_other.status, 'active');
    assert.deepEqual(alerts(h), []);
    assert.equal(stripeCalls(h).length, 0);
  }));

test('a checkout event that is delivered again after the subscription ended does not bring Pro back', () =>
  withServer(OPTIONS, async (h) => {
    const { b, accountId } = await member(h);
    const sub = stripeHas(h, accountId);
    await webhook(h, checkoutEvent(accountId));
    await webhook(h, subscriptionEvent('customer.subscription.created', sub));
    h.net.stripe.subscriptions.sub_1 = { ...sub, status: 'canceled' };
    await webhook(h, subscriptionEvent('customer.subscription.deleted', sub));
    assert.equal((await b.get('/api/me')).json.plan, 'free');
    await webhook(h, checkoutEvent(accountId));
    assert.equal((await b.get('/api/me')).json.plan, 'free');
  }));

// ---- the other product's events ----

test('events of the other product on the same Stripe account are answered and ignored', () =>
  withServer(OPTIONS, async (h) => {
    const { b, accountId } = await member(h);
    const foreignSubscription = {
      id: 'sub_other',
      customer: 'cus_other',
      status: 'active',
      current_period_end: nowSeconds(h) + 86400 * 30,
      items: { data: [{ price: { id: 'price_other_product' }, current_period_end: nowSeconds(h) + 86400 * 30 }] },
      metadata: { user_ref: `${accountId}:34` },
    };
    const events = [
      // the other product's checkout: "<row id>:<github id>" and no app marker
      checkoutEvent(accountId, { client_reference_id: '12:34', metadata: {}, subscription: 'sub_other', customer: 'cus_other' }),
      checkoutEvent(accountId, { client_reference_id: '12:34', metadata: undefined }),
      // ours in every way but one
      checkoutEvent(accountId, { metadata: {} }),
      checkoutEvent(accountId, { metadata: { app: 'repoeasy' } }),
      checkoutEvent(accountId, { mode: 'payment' }),
      checkoutEvent(accountId, { client_reference_id: accountId }),
      checkoutEvent(accountId, { client_reference_id: `xx_${accountId}` }),
      // subscription events with a foreign price, even one that points at one of our accounts
      subscriptionEvent('customer.subscription.created', foreignSubscription),
      subscriptionEvent('customer.subscription.updated', foreignSubscription),
      subscriptionEvent('customer.subscription.deleted', foreignSubscription),
      subscriptionEvent('customer.subscription.updated', { ...foreignSubscription, metadata: { fs_account: accountId } }),
      subscriptionEvent('customer.subscription.updated', { id: 'sub_x', customer: 'cus_x', status: 'active', items: { data: [] }, metadata: { fs_account: accountId } }),
      { id: 'evt_x', type: 'invoice.paid', data: { object: { id: 'in_1', customer: 'cus_1' } } },
      { id: 'evt_y', type: 'customer.created', data: { object: { id: 'cus_1' } } },
      { id: 'evt_z', type: 'checkout.session.completed', data: { object: null } },
      { id: 'evt_w', data: {} },
    ];
    for (const event of events) {
      const res = await webhook(h, event);
      assert.equal(res.status, 200, JSON.stringify(event).slice(0, 80));
      assert.deepEqual(res.json, { received: true });
    }
    assert.equal((await b.get('/api/me')).json.plan, 'free');
    assert.deepEqual(h.db.get('SELECT stripe_customer_id AS c, stripe_subscription_id AS s, sub_status AS st FROM accounts'), { c: null, s: null, st: null });
    // ignoring them did not cost a single call to Stripe
    assert.equal(stripeCalls(h).length, 0);
  }));

test('without the account id in its metadata, a subscription is found by the customer Stripe gave the account', () =>
  withServer(OPTIONS, async (h) => {
    const { b, accountId } = await member(h);
    h.db.run(`UPDATE accounts SET stripe_customer_id = 'cus_known' WHERE id = ?`, accountId);
    const sub = subscription({ id: 'sub_9', customer: 'cus_known', price: YEARLY, accountId, periodEnd: nowSeconds(h) + 86400 * 5, metadata: {} });
    h.net.stripe.subscriptions.sub_9 = sub;
    await webhook(h, subscriptionEvent('customer.subscription.updated', sub));
    const me = (await b.get('/api/me')).json;
    assert.equal(me.plan, 'pro');
    assert.equal(me.subscription.interval, 'year');
  }));

// ---- deleting an account that pays ----

test('deleting an account cancels its subscription first, and then removes the account', () =>
  withServer(OPTIONS, async (h) => {
    const { b, accountId } = await member(h);
    makePro(h, accountId);
    h.net.stripe.subscriptions.sub_1 = { id: 'sub_1', status: 'active' };
    let accountStillThere;
    h.net.stripe.onDelete = () => (accountStillThere = h.db.get('SELECT COUNT(*) AS n FROM accounts').n === 1);

    const res = await b.post('/api/account/delete');
    assert.equal(res.status, 204);
    assert.equal(accountStillThere, true, 'Stripe was told before the account went away');
    assert.deepEqual(stripeCalls(h).map((c) => `${c.method} ${c.path}`), ['DELETE /v1/subscriptions/sub_1']);
    assert.equal(h.net.stripe.subscriptions.sub_1.status, 'canceled');
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts').n, 0);
  }));

test('if Stripe refuses to cancel, the account is not deleted and the person is told', () =>
  withServer(OPTIONS, async (h) => {
    const { b, accountId } = await member(h);
    makePro(h, accountId);
    h.net.stripe.subscriptions.sub_1 = { id: 'sub_1', status: 'active' };
    h.net.stripe.fail['DELETE /subscriptions/:id'] = { status: 500, code: 'api_error' };
    const res = await b.post('/api/account/delete');
    assert.equal(res.status, 502);
    assert.equal(res.json.error, 'billing_error');
    assert.match(res.json.message, /^[A-Z].*\.$/);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts').n, 1);
    assert.equal((await b.get('/api/me')).json.plan, 'pro', 'still signed in, still Pro');
    assert.ok(!res.text.includes('sk_test_fakeKeyForTests') && !h.logs.join('\n').includes('sk_test_fakeKeyForTests'));

    // a failure of another kind, such as a refused key, also stops it
    h.net.stripe.fail['DELETE /subscriptions/:id'] = { status: 403, code: 'secret_key_required' };
    assert.equal((await b.post('/api/account/delete')).status, 502);
    h.net.stripe.fail = {};
    h.net.down = new Error('unreachable');
    assert.equal((await b.post('/api/account/delete')).status, 502);
    h.net.down = null;
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts').n, 1);
    assert.equal((await b.post('/api/account/delete')).status, 204);
  }));

test('a subscription that Stripe does not know any more does not stop the deletion', () =>
  withServer(OPTIONS, async (h) => {
    const { b, accountId } = await member(h);
    makePro(h, accountId);
    // not in the fake's list: "No such subscription"
    assert.equal((await b.post('/api/account/delete')).status, 204);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts').n, 0);
  }));

test('an account without a running subscription is deleted without calling Stripe', () =>
  withServer(OPTIONS, async (h) => {
    const free = await member(h, { id: 1 });
    assert.equal((await free.b.post('/api/account/delete')).status, 204);
    const ended = await member(h, { id: 2, name: 'Bob', email: 'bob@example.com' });
    makePro(h, ended.accountId, { status: 'canceled' });
    assert.equal((await ended.b.post('/api/account/delete')).status, 204);
    assert.equal(stripeCalls(h).length, 0);
  }));

// ---- a key that needs a person's approval before anything is cancelled ----

test('a subscription that is set to end already, or is over, is not cancelled again: the account is deleted without a call', () =>
  withServer(OPTIONS, async (h) => {
    // had a call been made, it would have made a request for the owner
    h.net.stripe.approval = { cancel: true, update: true };
    const ending = await member(h, { id: 1 });
    makePro(h, ending.accountId, { cancelAtPeriodEnd: 1 });
    h.net.stripe.subscriptions.sub_1 = { id: 'sub_1', status: 'active', cancel_at_period_end: true };
    assert.equal((await ending.b.post('/api/account/delete')).status, 204);

    const over = await member(h, { id: 2, name: 'Bob', email: 'bob@example.com' });
    makePro(h, over.accountId, { status: 'canceled' });
    assert.equal((await over.b.post('/api/account/delete')).status, 204);
    const expired = await member(h, { id: 3, name: 'Cy', email: 'cy@example.com' });
    makePro(h, expired.accountId, { status: 'incomplete_expired' });
    assert.equal((await expired.b.post('/api/account/delete')).status, 204);
    const free = await member(h, { id: 4, name: 'Di', email: 'di@example.com' });
    assert.equal((await free.b.post('/api/account/delete')).status, 204);

    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts').n, 0);
    assert.deepEqual(calls(h), [], 'Stripe was asked nothing');
    assert.deepEqual(h.net.stripe.approvals, []);
    assert.deepEqual(notices(h), []);
  }));

test('when Stripe wants a person to approve the cancellation, the subscription is set to end with the paid period and the account is deleted', () =>
  withServer(OPTIONS, async (h) => {
    const { b, accountId } = await member(h);
    stripeHas(h, accountId);
    makePro(h, accountId);
    h.net.stripe.approval.cancel = true;

    const res = await b.post('/api/account/delete');
    assert.equal(res.status, 204);
    // the cancellation first, as always; then, because it waits for a person, ending it with the paid period
    assert.deepEqual(calls(h), ['DELETE /v1/subscriptions/sub_1', 'POST /v1/subscriptions/sub_1']);
    assert.deepEqual(stripeCalls(h)[1].form, { cancel_at_period_end: 'true' });
    assert.equal(h.net.stripe.subscriptions.sub_1.status, 'active', 'it runs until the paid period is over');
    assert.equal(h.net.stripe.subscriptions.sub_1.cancel_at_period_end, true, 'and then it does not renew');
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts').n, 0);
    // one request waits for the owner, and one line says so, with nothing personal in it
    assert.deepEqual(h.net.stripe.approvals, [{ kind: 'cancel', subscription: 'sub_1' }]);
    assert.deepEqual(notices(h), [NOTICE('sub_1', 'cus_1')]);
    assert.ok(!notices(h)[0].includes('ada@example.com') && !notices(h)[0].includes(accountId) && !notices(h)[0].includes('Ada'));
    assert.deepEqual(alerts(h), []);

    // Stripe then reports on the subscription of an account that is gone, and later its end: no reason to cancel it again
    const before = stripeCalls(h).length;
    assert.equal((await webhook(h, subscriptionEvent('customer.subscription.updated', h.net.stripe.subscriptions.sub_1))).status, 200);
    assert.equal((await webhook(h, subscriptionEvent('customer.subscription.deleted', { ...h.net.stripe.subscriptions.sub_1, status: 'canceled' }))).status, 200);
    assert.equal(stripeCalls(h).length, before);
    assert.equal(h.net.stripe.approvals.length, 1);
    assert.deepEqual(alerts(h), []);
  }));

test('if Stripe does not know the subscription when it is asked to end it, nothing is left to end and the account goes', () =>
  withServer(OPTIONS, async (h) => {
    const { b, accountId } = await member(h);
    makePro(h, accountId); // not in the fake's list: "No such subscription"
    h.net.stripe.approval.cancel = true;
    assert.equal((await b.post('/api/account/delete')).status, 204);
    assert.deepEqual(calls(h), ['DELETE /v1/subscriptions/sub_1', 'POST /v1/subscriptions/sub_1']);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts').n, 0);
    assert.deepEqual(notices(h), [], 'nothing is ending, so there is nothing to say');
  }));

test('when Stripe wants approval for ending it too, the account stays and the person is asked to end the subscription first', () =>
  withServer(OPTIONS, async (h) => {
    const { b, accountId } = await member(h);
    stripeHas(h, accountId);
    makePro(h, accountId);
    h.net.stripe.approval = { cancel: true, update: true };

    const res = await b.post('/api/account/delete');
    assert.equal(res.status, 409);
    assert.equal(res.json.error, 'cancel_first');
    assert.deepEqual(Object.keys(res.json).sort(), ['error', 'message']);
    // a message that the website can show as it is
    assert.match(res.json.message, /^[A-Z][^!]*\.$/);
    assert.match(res.json.message, /could not be ended automatically/);
    assert.match(res.json.message, /"Manage subscription"/);
    assert.match(res.json.message, /not deleted/);
    // nothing else changed: the account, its sign-in and its subscription are as they were
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts').n, 1);
    assert.deepEqual(h.db.get('SELECT stripe_subscription_id AS id, sub_status AS status, sub_cancel_at_period_end AS ends FROM accounts'), { id: 'sub_1', status: 'active', ends: 0 });
    assert.equal((await b.get('/api/me')).json.plan, 'pro', 'still signed in, still Pro');
    assert.equal(h.net.stripe.subscriptions.sub_1.status, 'active');
    assert.equal(h.net.stripe.subscriptions.sub_1.cancel_at_period_end, false);
    assert.deepEqual(notices(h), []);
    // the cause is in the log, in Stripe's codes and not in its words
    assert.ok(h.logs.some((line) => line.includes('status=0 code=cancel_first after status=403 code=approval_required')));
    assert.ok(!h.logs.join('\n').includes('human approval'));

    // trying again asks Stripe for nothing more: one cancellation and one request to end it are all that were ever made
    assert.equal((await b.post('/api/account/delete')).status, 409);
    assert.equal((await b.post('/api/account/delete')).status, 409);
    assert.deepEqual(calls(h), ['DELETE /v1/subscriptions/sub_1', 'POST /v1/subscriptions/sub_1']);
    assert.deepEqual(h.net.stripe.approvals.map((a) => a.kind), ['cancel', 'update']);

    // the person ends it in the portal and Stripe tells us: then there is nothing left to ask, and the account goes
    h.net.stripe.subscriptions.sub_1.cancel_at_period_end = true;
    assert.equal((await webhook(h, subscriptionEvent('customer.subscription.updated', h.net.stripe.subscriptions.sub_1))).status, 200);
    assert.equal(h.db.get('SELECT sub_cancel_at_period_end AS ends FROM accounts').ends, 1);
    const before = stripeCalls(h).length;
    assert.equal((await b.post('/api/account/delete')).status, 204);
    assert.equal(stripeCalls(h).length, before);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts').n, 0);
  }));

test('once Stripe has asked for approval to cancel a subscription it is not asked again: a retry goes straight to ending it with the paid period', () =>
  withServer(OPTIONS, async (h) => {
    const { b, accountId } = await member(h);
    stripeHas(h, accountId);
    makePro(h, accountId);
    h.net.stripe.approval.cancel = true;
    // Stripe has a bad moment when it is asked to end it, whatever the failure is: the account stays
    h.net.stripe.fail['POST /subscriptions/:id'] = { status: 500, code: 'api_error' };
    const failed = await b.post('/api/account/delete');
    assert.equal(failed.status, 409);
    assert.equal(failed.json.error, 'cancel_first');
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts').n, 1);
    assert.deepEqual(notices(h), []);

    // the second try does not cancel again
    delete h.net.stripe.fail['POST /subscriptions/:id'];
    assert.equal((await b.post('/api/account/delete')).status, 204);
    assert.deepEqual(calls(h), ['DELETE /v1/subscriptions/sub_1', 'POST /v1/subscriptions/sub_1', 'POST /v1/subscriptions/sub_1']);
    assert.equal(h.net.stripe.approvals.length, 1, 'one request for the owner, not one for every try');
    assert.equal(h.net.stripe.subscriptions.sub_1.cancel_at_period_end, true);
    assert.deepEqual(notices(h), [NOTICE('sub_1', 'cus_1')]);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts').n, 0);
  }));

test('a cancellation that fails for any other reason than approval is still for the person to try again', () =>
  withServer(OPTIONS, async (h) => {
    const { b, accountId } = await member(h);
    stripeHas(h, accountId);
    makePro(h, accountId);
    // a refused key is not a request for approval, with or without Stripe's wording
    for (const failure of [{ status: 403, code: 'secret_key_required' }, { status: 500, code: 'api_error' }, { status: 429, code: 'rate_limit' }]) {
      h.net.stripe.fail['DELETE /subscriptions/:id'] = failure;
      const res = await b.post('/api/account/delete');
      assert.equal(res.status, 502, JSON.stringify(failure));
      assert.equal(res.json.error, 'billing_error');
    }
    // nothing was ended, nothing was asked for, and nothing is remembered as waiting: it works when Stripe does
    assert.deepEqual(calls(h), ['DELETE /v1/subscriptions/sub_1', 'DELETE /v1/subscriptions/sub_1', 'DELETE /v1/subscriptions/sub_1']);
    assert.deepEqual(h.net.stripe.approvals, []);
    delete h.net.stripe.fail['DELETE /subscriptions/:id'];
    assert.equal((await b.post('/api/account/delete')).status, 204);
    assert.equal(h.net.stripe.subscriptions.sub_1.status, 'canceled');
  }));

test('a subscription that stops being set to end while the account is being deleted is looked at again, not taken for ending', () =>
  withServer(OPTIONS, async (h) => {
    const { b, accountId } = await member(h);
    // an open checkout, so that the deletion has something to wait for at Stripe
    assert.equal((await b.post('/api/billing/checkout', { interval: 'month' })).status, 200);
    makePro(h, accountId, { cancelAtPeriodEnd: 1 });
    h.net.stripe.subscriptions.sub_1 = { id: 'sub_1', status: 'active', cancel_at_period_end: true };
    // the person takes the subscription up again in the portal at that very moment, and Stripe's webhook says so
    let resumed = false;
    h.net.stripe.onExpire = () => {
      if (resumed) return;
      resumed = true;
      h.db.run('UPDATE accounts SET sub_cancel_at_period_end = 0 WHERE id = ?', accountId);
    };
    assert.equal((await b.post('/api/account/delete')).status, 204);
    assert.ok(calls(h).includes('DELETE /v1/subscriptions/sub_1'), calls(h).join(', '));
    assert.equal(h.net.stripe.subscriptions.sub_1.status, 'canceled', 'it would have kept renewing for an account that is gone');
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts').n, 0);
  }));

test('an answer of 403 that says nothing else is taken for a request for approval', () =>
  withServer(OPTIONS, async (h) => {
    const { b, accountId } = await member(h);
    stripeHas(h, accountId);
    makePro(h, accountId);
    h.net.stripe.fail['DELETE /subscriptions/:id'] = { status: 403 };
    assert.equal((await b.post('/api/account/delete')).status, 204);
    assert.deepEqual(calls(h), ['DELETE /v1/subscriptions/sub_1', 'POST /v1/subscriptions/sub_1']);
    assert.equal(h.net.stripe.subscriptions.sub_1.cancel_at_period_end, true);
  }));

test('an account with a running subscription cannot be deleted while Stripe is not configured here', () =>
  withServer({ env: LOGIN_ONLY() }, async (h) => {
    const { b, accountId } = await member(h);
    makePro(h, accountId);
    const res = await b.post('/api/account/delete');
    assert.equal(res.status, 503);
    assert.equal(res.json.error, 'billing_off');
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts').n, 1);
  }));

function LOGIN_ONLY() {
  return { GITHUB_CLIENT_ID: 'gh-client', GITHUB_CLIENT_SECRET: 'gh-secret' };
}

// ---- one open checkout per account ----

test('a new checkout expires the one that was still open, so only one can ever be paid', () =>
  withServer(OPTIONS, async (h) => {
    const { b, accountId } = await member(h);
    await b.post('/api/billing/checkout', { interval: 'month' });
    const [first] = Object.keys(h.net.stripe.checkoutSessions);
    assert.equal(h.net.stripe.checkoutSessions[first].status, 'open');
    assert.equal(h.net.calling((c) => c.path.endsWith('/expire')).length, 0, 'nothing to expire the first time');

    await b.post('/api/billing/checkout', { interval: 'year' });
    const [, second] = Object.keys(h.net.stripe.checkoutSessions);
    // the old one is expired before the new one is made
    const calls = stripeCalls(h).map((c) => `${c.method} ${c.path}`);
    assert.deepEqual(calls.slice(-2), [`POST /v1/checkout/sessions/${first}/expire`, 'POST /v1/checkout/sessions']);
    assert.deepEqual([h.net.stripe.checkoutSessions[first].status, h.net.stripe.checkoutSessions[second].status], ['expired', 'open']);
    assert.equal(h.db.get('SELECT checkout_session_id AS s FROM accounts WHERE id = ?', accountId).s, second);

    // somebody else's sessions are not touched
    const bob = await member(h, { id: 2, name: 'Bob', email: 'bob@example.com' });
    await bob.b.post('/api/billing/checkout', { interval: 'month' });
    assert.equal(h.net.stripe.checkoutSessions[second].status, 'open');
  }));

test('a session that was already paid or expired is not a problem when a new checkout is made', () =>
  withServer(OPTIONS, async (h) => {
    const { b } = await member(h);
    await b.post('/api/billing/checkout', { interval: 'month' });
    const [first] = Object.keys(h.net.stripe.checkoutSessions);
    // the person paid, the webhook has not arrived yet: Stripe refuses to expire it and that is fine
    h.net.stripe.checkoutSessions[first].status = 'complete';
    assert.equal((await b.post('/api/billing/checkout', { interval: 'year' })).status, 200);
    // one Stripe has forgotten about altogether
    h.net.stripe.checkoutSessions = {};
    assert.equal((await b.post('/api/billing/checkout', { interval: 'year' })).status, 200);
  }));

test('if the open session cannot be expired, no new one is made', () =>
  withServer(OPTIONS, async (h) => {
    const { b, accountId } = await member(h);
    await b.post('/api/billing/checkout', { interval: 'month' });
    const [first] = Object.keys(h.net.stripe.checkoutSessions);
    for (const failure of [{ status: 500, code: 'api_error' }, { status: 429, code: 'rate_limit' }, { status: 403, code: 'secret_key_required' }]) {
      h.net.stripe.fail['POST /checkout/sessions/:id/expire'] = failure;
      const res = await b.post('/api/billing/checkout', { interval: 'year' });
      assert.equal(res.status, 502, JSON.stringify(failure));
      assert.equal(res.json.error, 'billing_error');
    }
    assert.equal(Object.keys(h.net.stripe.checkoutSessions).length, 1, 'no second session');
    assert.equal(h.db.get('SELECT checkout_session_id AS s FROM accounts WHERE id = ?', accountId).s, first);
    delete h.net.stripe.fail['POST /checkout/sessions/:id/expire'];
    assert.equal((await b.post('/api/billing/checkout', { interval: 'year' })).status, 200);
    assert.equal(h.net.stripe.checkoutSessions[first].status, 'expired');
  }));

test('deleting an account expires its open checkout first, then cancels the subscription, then deletes', () =>
  withServer(OPTIONS, async (h) => {
    const { b, accountId } = await member(h);
    await b.post('/api/billing/checkout', { interval: 'month' });
    const [session] = Object.keys(h.net.stripe.checkoutSessions);
    makePro(h, accountId);
    h.db.run('UPDATE accounts SET stripe_customer_id = ? WHERE id = ?', 'cus_made_1', accountId);
    h.net.stripe.subscriptions.sub_1 = { id: 'sub_1', status: 'active' };
    const order = [];
    h.net.stripe.onDelete = () => order.push(`cancel (account there: ${h.db.get('SELECT COUNT(*) AS n FROM accounts').n === 1})`);

    assert.equal((await b.post('/api/account/delete')).status, 204);
    assert.deepEqual(stripeCalls(h).slice(-2).map((c) => `${c.method} ${c.path}`), [`POST /v1/checkout/sessions/${session}/expire`, 'DELETE /v1/subscriptions/sub_1']);
    assert.deepEqual(order, ['cancel (account there: true)']);
    assert.equal(h.net.stripe.checkoutSessions[session].status, 'expired');
    assert.equal(h.net.stripe.subscriptions.sub_1.status, 'canceled');
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts').n, 0);
  }));

test('an account that only has an open checkout, no subscription, is deleted after the checkout is expired', () =>
  withServer(OPTIONS, async (h) => {
    const { b } = await member(h);
    await b.post('/api/billing/checkout', { interval: 'month' });
    const [session] = Object.keys(h.net.stripe.checkoutSessions);
    assert.equal((await b.post('/api/account/delete')).status, 204);
    assert.equal(h.net.stripe.checkoutSessions[session].status, 'expired');
    assert.equal(stripeCalls(h).filter((c) => c.method === 'DELETE').length, 0);
  }));

test('if the open checkout cannot be expired, the account is not deleted', () =>
  withServer(OPTIONS, async (h) => {
    const { b } = await member(h);
    await b.post('/api/billing/checkout', { interval: 'month' });
    h.net.stripe.fail['POST /checkout/sessions/:id/expire'] = { status: 500, code: 'api_error' };
    const res = await b.post('/api/account/delete');
    assert.equal(res.status, 502);
    assert.equal(res.json.error, 'billing_error');
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts').n, 1);
    assert.equal((await b.get('/api/me')).json.account.email, 'ada@example.com', 'still signed in');
    delete h.net.stripe.fail['POST /checkout/sessions/:id/expire'];
    assert.equal((await b.post('/api/account/delete')).status, 204);
  }));

test('a purchase that goes through while an account is being deleted is cancelled too, before the account goes', () =>
  withServer(OPTIONS, async (h) => {
    const { b, accountId } = await member(h);
    h.db.run('UPDATE accounts SET stripe_customer_id = ? WHERE id = ?', 'cus_made_1', accountId);
    // while the deletion waits for Stripe's answer about the expiry, the payment completes and the webhook is processed
    await b.post('/api/billing/checkout', { interval: 'month' });
    stripeHas(h, accountId, { id: 'sub_late', customer: 'cus_made_1' });
    h.net.stripe.onExpire = async () => {
      await webhook(h, checkoutEvent(accountId, { subscription: 'sub_late', customer: 'cus_made_1' }));
    };
    assert.equal((await b.post('/api/account/delete')).status, 204);
    assert.equal(h.net.stripe.subscriptions.sub_late.status, 'canceled', 'the late subscription did not survive the account');
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts').n, 0);
  }));

test('an account that keeps changing while it is closed is not deleted', () =>
  withServer(OPTIONS, async (h) => {
    const { b, accountId } = await member(h);
    h.db.run('UPDATE accounts SET stripe_customer_id = ? WHERE id = ?', 'cus_made_1', accountId);
    await b.post('/api/billing/checkout', { interval: 'month' });
    let n = 0;
    // every look at Stripe is followed by a new subscription on the account
    h.net.stripe.onExpire = async () => {
      const id = `sub_busy_${++n}`;
      stripeHas(h, accountId, { id, customer: 'cus_made_1' });
      h.db.run(`UPDATE accounts SET stripe_subscription_id = ?, sub_status = 'active', sub_period_end = ? WHERE id = ?`, id, h.clock.t, accountId);
    };
    const res = await b.post('/api/account/delete');
    assert.equal(res.status, 502);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts').n, 1);
  }));

// ---- limits for signed-in writes ----

test('a checkout is limited to 10 an hour per account, and only what reaches Stripe is counted', () =>
  withServer(OPTIONS, async (h) => {
    const { b } = await member(h);
    // refused before it costs anything: not counted
    for (let n = 0; n < 15; n++) assert.equal((await b.post('/api/billing/checkout', { interval: 'week' })).status, 400);
    for (let n = 1; n <= 10; n++) assert.equal((await b.post('/api/billing/checkout', { interval: 'month' })).status, 200, `checkout ${n}`);

    const callsBefore = stripeCalls(h).length;
    const refused = await b.post('/api/billing/checkout', { interval: 'month' });
    assert.equal(refused.status, 429);
    assert.equal(refused.json.error, 'rate_limited');
    assert.match(refused.json.message, /^[A-Z].*\.$/);
    assert.equal(refused.headers['retry-after'], '3600');
    assert.equal(stripeCalls(h).length, callsBefore, 'nothing was sent to Stripe');

    // the account's own count: another account is unaffected
    const bob = await member(h, { id: 2, name: 'Bob', email: 'bob@example.com' });
    assert.equal((await bob.b.post('/api/billing/checkout', { interval: 'month' })).status, 200);
    // an hour later it is back
    h.clock.advance(3_600_001);
    assert.equal((await b.post('/api/billing/checkout', { interval: 'month' })).status, 200);
  }));

test('opening the portal is limited to 20 an hour per account', () =>
  withServer(OPTIONS, async (h) => {
    const { b, accountId } = await member(h);
    // nothing to manage: refused without being counted
    for (let n = 0; n < 25; n++) assert.equal((await b.post('/api/billing/portal')).status, 409);
    makePro(h, accountId);
    for (let n = 1; n <= 20; n++) assert.equal((await b.post('/api/billing/portal')).status, 200, `portal ${n}`);
    const refused = await b.post('/api/billing/portal');
    assert.equal(refused.status, 429);
    assert.equal(refused.json.error, 'rate_limited');
    assert.equal(refused.headers['retry-after'], '3600');
    h.clock.advance(3_600_001);
    assert.equal((await b.post('/api/billing/portal')).status, 200);
  }));

test('a checkout that is refused because the account has Pro already does not use up the account\'s share', () =>
  withServer(OPTIONS, async (h) => {
    const { b, accountId } = await member(h);
    for (let n = 1; n <= 9; n++) assert.equal((await b.post('/api/billing/checkout', { interval: 'month' })).status, 200, `checkout ${n}`);
    makePro(h, accountId);
    for (let n = 0; n < 25; n++) assert.equal((await b.post('/api/billing/checkout', { interval: 'month' })).json.error, 'already_pro');
    // the subscription ended: the tenth is still there, the eleventh is not
    makePro(h, accountId, { status: 'canceled' });
    assert.equal((await b.post('/api/billing/checkout', { interval: 'month' })).status, 200);
    assert.equal((await b.post('/api/billing/checkout', { interval: 'month' })).status, 429);
  }));

test('the limits of checkout and portal are separate, and a refused checkout does not use up the portal', () =>
  withServer(OPTIONS, async (h) => {
    const { b, accountId } = await member(h);
    makePro(h, accountId, { status: 'canceled' });
    for (let n = 1; n <= 10; n++) assert.equal((await b.post('/api/billing/checkout', { interval: 'month' })).status, 200);
    assert.equal((await b.post('/api/billing/checkout', { interval: 'month' })).status, 429);
    assert.equal((await b.post('/api/billing/portal')).status, 200);
  }));

// ---- the webhook ----

test('a webhook request without a signature is refused before its body is read', () =>
  withServer(OPTIONS, async (h) => {
    // announced as 5 MB and never sent: the answer has to come from the headers alone, and it is
    // about the missing signature, not about the size
    const res = await announce(h.port, 'POST', '/api/billing/webhook', {}, 5 * 1024 * 1024);
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'bad_request');
    assert.equal(res.json.message, 'The request has no signature.');
    assert.match(res.raw, /connection: close/i, 'and the connection is not kept for the rest of the upload');
    // an empty header is no signature either
    const empty = await announce(h.port, 'POST', '/api/billing/webhook', { 'stripe-signature': '' }, 5 * 1024 * 1024);
    assert.equal(empty.status, 400);
    assert.equal(empty.json.message, 'The request has no signature.');
    // with a signature header, the size is what gets it refused
    const sized = await announce(h.port, 'POST', '/api/billing/webhook', { 'stripe-signature': 't=1,v1=00' }, 5 * 1024 * 1024);
    assert.equal(sized.status, 413);
    // and a complete request without the header changes nothing
    const plain = await h.request('POST', '/api/billing/webhook', { body: JSON.stringify(checkoutEvent('ffffffffffffffff')), origin: null });
    assert.equal(plain.status, 400);
    assert.equal(stripeCalls(h).length, 0);
  }));

test('events are handled one after the other', () =>
  withServer(OPTIONS, async (h) => {
    const { b, accountId } = await member(h);
    const sub = stripeHas(h, accountId);
    // three deliveries at once for the same subscription: all are answered, the result is one coherent state
    const results = await Promise.all([
      webhook(h, subscriptionEvent('customer.subscription.created', sub)),
      webhook(h, subscriptionEvent('customer.subscription.updated', sub)),
      webhook(h, checkoutEvent(accountId)),
    ]);
    assert.deepEqual(results.map((r) => r.status), [200, 200, 200]);
    await sleep(20);
    const me = (await b.get('/api/me')).json;
    assert.equal(me.plan, 'pro');
    assert.equal(me.subscription.interval, 'month');
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts').n, 1);
  }));
