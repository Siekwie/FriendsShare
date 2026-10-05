// Which plan an account is on. Pure functions of a database row and the clock, so the web API, the
// matchmaking and the billing code cannot disagree.

// Stripe retries failed payments for a while and may deliver webhooks late; a few days of slack
// after the paid period keep a paying customer from being cut off by a hiccup.
const GRACE_MS = 3 * 86_400_000;

const RUNNING = new Set(['active', 'trialing', 'past_due']);
const isRunning = (status) => RUNNING.has(status);

// Pro while Stripe says the subscription is running and its paid period (plus grace) has not passed.
function planOf(account, now) {
  if (!account || !account.stripe_subscription_id || !isRunning(account.sub_status)) return 'free';
  return Number(account.sub_period_end) + GRACE_MS > now ? 'pro' : 'free';
}

// Folders at a time for a connection of this plan; null is no limit.
const limitFor = (plan, config) => (plan === 'pro' || !config.enforceLimit ? null : config.freeLimit);

const subscriptionView = (account) =>
  account.stripe_subscription_id && isRunning(account.sub_status)
    ? {
        status: account.sub_status,
        interval: account.sub_interval,
        renews_at: account.sub_period_end,
        cancel_at_period_end: Boolean(account.sub_cancel_at_period_end),
      }
    : null;

const accountView = (account) => ({ name: account.name, email: account.email, avatar: account.avatar });

module.exports = { GRACE_MS, isRunning, planOf, limitFor, subscriptionView, accountView };
