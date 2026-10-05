// What the website asks about the signed-in person: who they are, which plan, and deleting the account.
const { fail } = require('./http');
const { accountView, planOf, subscriptionView } = require('./plan');

function createAccountApi({ config, db, auth, billing, now, log, hooks }) {
  function register(router) {
    // always 200: signed out is an answer too. One of the few routes the app's token is good for.
    router.add(
      'GET',
      '/api/me',
      (ctx) => {
        const found = ctx.auth();
        const account = found ? found.account : null;
        ctx.json(200, {
          account: account ? { ...accountView(account), providers: auth.providersOf(account.id) } : null,
          plan: planOf(account, now()),
          subscription: account ? subscriptionView(account) : null,
          billing: config.billing,
          free_limit: config.freeLimit,
          prices: { monthly: config.prices.monthly, yearly: config.prices.yearly, yearly_per_month: config.prices.yearlyPerMonth },
          providers: { github: config.github.enabled, google: config.google.enabled },
        });
      },
      { bearer: true },
    );

    // Stripe comes first: the checkout the account has open is expired and its subscription
    // cancelled (or, when Stripe wants a person's approval for that, set to end with the paid period;
    // one that is set to end already is left alone). Deleting the account while Stripe keeps
    // charging, or lets a payment through afterwards, would be the worst outcome, so a failure there
    // stops everything. Only then do the account, its logins, sessions and pending codes go, in the
    // same turn.
    router.add('POST', '/api/account/delete', async (ctx) => {
      const found = ctx.auth();
      if (!found) fail(401, 'signed_out', 'Sign in to continue.');
      const { account } = found;
      try {
        await billing.settleForDeletion(account.id, () => {
          db.run('DELETE FROM accounts WHERE id = ?', account.id);
          hooks.accountDeleted(account.id);
          log(`[auth] account ${account.id} deleted`);
        });
      } catch (err) {
        log(`[billing] could not close the Stripe side of account ${account.id} (${billing.describe(err)})`);
        if (err instanceof billing.StripeError && err.code === 'not_configured') {
          fail(503, 'billing_off', 'This account has a subscription, but subscriptions cannot be managed on this server right now, so it was not deleted.');
        }
        // Stripe will not let us end it without a person's approval, and not even set it to end with the
        // paid period: the person can, in the portal. The website shows this message as it is.
        if (err instanceof billing.StripeError && err.code === 'cancel_first') {
          fail(409, 'cancel_first', 'Your Pro subscription could not be ended automatically, so your account was not deleted. Please end it under "Manage subscription" first, and then delete your account.');
        }
        fail(502, 'billing_error', 'We could not cancel your subscription, so your account was not deleted. Please try again in a moment.');
      }
      ctx.clearCookie(config.cookies.session, '/');
      ctx.noContent();
    });
  }

  return { register };
}

module.exports = { createAccountApi };
