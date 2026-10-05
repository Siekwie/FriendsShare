// Signing in from the app, end to end: the server runs in-process with a fake GitHub (as in
// server/test/), an app instance talks to it, and this script plays the browser. The app does not open
// a browser in a test: with FS_OPEN_LOG set, the links it would open are written to that file.
//   node test/signin.js
//
// The real browser sign-in, with a real GitHub or Google, has not been run by anybody yet (the
// provider credentials do not exist); this is the evidence for the hand-over that comes before it.
const fs = require('fs');
const path = require('path');
const t = require('./lib');

const NAME = 'signin';
const BILLING = {
  STRIPE_SECRET_KEY: 'sk_test_fakeKeyForTests',
  STRIPE_WEBHOOK_SECRET: 'whsec_fakeSecretForTests',
  STRIPE_PRICE_MONTHLY: 'price_monthly_fs',
  STRIPE_PRICE_YEARLY: 'price_yearly_fs',
};
const ID = /^[A-Za-z0-9_-]{16,128}$/;
const ui = (app, expr) => app.eval(expr).catch((err) => `error: ${err.message}`);

t.scenario('The app signs in through the browser, goes Pro, signs out, and notices a revoked sign-in', async (cleanup) => {
  const openLog = path.join(t.tmpRoot, NAME, 'opened.log');
  t.resetDir(path.dirname(openLog));
  const opened = () => (fs.existsSync(openLog) ? fs.readFileSync(openLog, 'utf8').split('\n').filter(Boolean) : []);

  const server = await t.startInProcessServer(NAME, BILLING);
  cleanup(() => server.close());
  const { match } = server.server;
  const app = await t.startApp({ name: NAME, who: 'app', signal: server.signalUrl, env: { FS_OPEN_LOG: openLog } });
  cleanup(() => app.quit());
  await app.ready();
  await t.waitFor(async () => (await ui(app, "document.querySelector('#conn').dataset.state")) === 'online', 20000, 'the app to connect');
  t.check((await ui(app, "account.billing === true && account.limit === 5 && account.signedIn === false")) === true, 'before signing in: the welcome says billing is on, the limit is 5, nobody is signed in');
  t.check((await ui(app, "document.querySelector('#acct-name').textContent + ' | ' + document.querySelector('#acct-plan').textContent")) === 'Sign in | Free · 0 of 5 folders', 'the account row says Sign in, free, 0 of 5 folders');

  // ---- "Sign in": the dialog, then the browser page ----
  await ui(app, "document.querySelector('#btn-account').click()");
  t.check((await ui(app, "document.querySelector('#acct-price').textContent")) === 'Pro: unlimited folders for €0.99 a month, billed yearly, or €1.99 monthly.', 'the dialog offers Pro with the price from the welcome');
  await ui(app, "document.querySelector('#acct-signin').click()");
  await t.waitFor(() => opened().length >= 1, 10000, 'the app to open the sign-in page');
  const login = new URL(opened()[0]);
  const port = Number(login.searchParams.get('app_port'));
  const state = login.searchParams.get('app_state');
  const challenge = login.searchParams.get('app_challenge');
  t.check(login.origin === server.siteUrl && login.pathname === '/login', 'the browser is sent to <site>/login on the server the app talks to');
  t.check(Number.isInteger(port) && port >= 1024 && port <= 65535 && ID.test(state) && ID.test(challenge), 'with a loopback port, a state and a challenge of the shape the server accepts');
  t.check((await ui(app, "!!document.querySelector('#acct-waiting') && document.querySelector('#acct-waiting').textContent")) === 'Waiting for your browser…', 'the dialog says it is waiting for the browser');
  await ui(app, "document.querySelector('#acct-reopen').click()");
  await t.waitFor(() => opened().length >= 2, 10000, 'the second click');
  t.check(opened()[1] === opened()[0] && opened().length === 2, 'a second click opens the same page again, and starts nothing new');

  // ---- the person's browser ----
  const browser = t.makeBrowser();
  const page = await browser.get(opened()[0]);
  t.check(page.status === 200 && /text\/html/.test(page.headers['content-type']), 'the sign-in page of the website loads');
  const start = await browser.get(`${server.siteUrl}/auth/github?app_port=${port}&app_state=${state}&app_challenge=${challenge}`);
  t.check(start.status === 302 && start.headers.location.startsWith('https://github.com/login/oauth/authorize'), 'GitHub is where the browser goes first');
  const githubState = new URL(start.headers.location).searchParams.get('state');
  server.github.users['code-from-github'] = { id: 4242, login: 'ada-l', name: 'Ada Lovelace', avatar_url: 'https://avatars.githubusercontent.com/u/4242', emails: [{ email: 'ada@example.com', primary: true, verified: true }] };
  const back = await browser.get(`${server.siteUrl}/auth/github/callback?code=code-from-github&state=${githubState}`);
  const target = new URL(back.headers.location);
  t.check(back.status === 302 && target.origin === `http://127.0.0.1:${port}` && target.pathname === '/callback' && target.searchParams.get('state') === state, 'GitHub sends the browser back to the app on 127.0.0.1 with the state');

  // somebody else knocking on the app's little server does not end the sign-in
  const wrong = await browser.get(`http://127.0.0.1:${port}/callback?code=${target.searchParams.get('code')}&state=not-the-state-of-this-sign-in`);
  t.check(wrong.status === 400 && !/You are signed in/.test(wrong.text), 'a callback with another state is refused');
  t.check((await ui(app, "account.signedIn")) === false && (await ui(app, "!!document.querySelector('#acct-waiting')")) === true, 'and the app keeps waiting');
  const done = await browser.get(target.href);
  t.check(done.status === 200 && /You are signed in/.test(done.text) && /You can close this tab and go back to FriendsShare/.test(done.text), 'the real callback is answered with the page that says to close the tab');
  const csp = done.headers['content-security-policy'] || '';
  t.check(/default-src 'none'/.test(csp) && done.headers['referrer-policy'] === 'no-referrer', 'which is self-contained and keeps the code out of any Referer');
  const again = await browser.get(target.href).catch(() => ({ status: 0 }));
  t.check(again.status === 0, 'the app\'s little server is gone afterwards');

  await t.waitFor(async () => (await ui(app, "account.signedIn === true && document.querySelector('#acct-name').textContent")) === 'Ada Lovelace', 15000, 'the app to be signed in');
  t.check(true, 'the app is signed in as Ada Lovelace');
  const saved = app.config();
  const raw = fs.readFileSync(path.join(app.home, 'userdata', 'config.json'), 'utf8');
  t.check(typeof (saved.token && saved.token.enc) === 'string' && !/fsa_[\w-]{20,}/.test(raw), 'the token is stored encrypted: config.json holds no plain token');
  t.check(saved.welcome && saved.welcome.account && saved.welcome.account.email === 'ada@example.com' && saved.welcome.plan === 'free', 'config.json remembers the account and the plan');
  t.check(server.db.get("SELECT COUNT(*) AS n FROM sessions WHERE kind = 'app'").n === 1, 'the server has one app session, from the code exchange');
  await t.waitFor(() => match.snapshot().connections === 1, 10000, 'the old connection to go');
  await t.waitFor(async () => (await ui(app, "document.querySelector('#conn').dataset.state")) === 'online', 10000, 'the app to be back online');
  t.check((await ui(app, "document.querySelector('#acct-plan').textContent")) === 'Free · 0 of 5 folders', 'the matchmaking connection started over with the token: a welcome as a free account');
  t.check((await ui(app, "[...document.querySelectorAll('#dlg-account button')].map((b) => b.textContent).join()")) === 'Upgrade to Pro,Sign out,Close', 'the dialog now shows the account with Upgrade to Pro and Sign out');

  // ---- "Upgrade to Pro": the account page, already signed in ----
  const before = opened().length;
  await ui(app, "document.querySelector('#acct-upgrade').click()");
  await t.waitFor(() => opened().length > before, 10000, 'the app to open the account page');
  const weblink = new URL(opened()[before]);
  t.check(weblink.origin === server.siteUrl && weblink.pathname === '/auth/link' && weblink.searchParams.get('next') === '/account', 'the account page is opened through a one-time link of the server');
  // What the server does with the link is its own business and has changed: it signs the browser in
  // and goes to the account page, or first asks "Continue as <name>?". Either way the link is good.
  const account = await t.makeBrowser().get(weblink.href);
  const signedInAtOnce = account.status === 302 && account.headers.location === '/account' && /fs_session=/.test(JSON.stringify(account.headers['set-cookie']));
  const asksFirst = account.status === 200 && /Ada Lovelace/.test(account.text);
  t.check(signedInAtOnce || asksFirst, `the server accepts the link: it ${signedInAtOnce ? 'signs the browser in and lands on the account page' : 'asks the person to continue as Ada Lovelace'}`);

  // ---- the plan changes while connected ----
  const accountId = server.db.get("SELECT id FROM accounts WHERE email = 'ada@example.com'").id;
  server.db.run("UPDATE accounts SET stripe_customer_id = 'cus_1', stripe_subscription_id = 'sub_1', sub_status = 'active', sub_interval = 'month', sub_period_end = ?, sub_cancel_at_period_end = 0 WHERE id = ?", Date.now() + 30 * 86400000, accountId);
  match.assignPlans(accountId);
  await t.waitFor(async () => (await ui(app, "account.plan === 'pro' && account.limit === null")) === true, 15000, 'the app to learn it is Pro');
  await t.waitFor(() => match.snapshot().by_plan.pro === 1, 15000, 'the app to connect again as Pro');
  t.check(app.config().welcome.plan === 'pro' && app.config().welcome.limit === null, 'the plan from the server is stored, and the app reconnected under it');
  t.check((await ui(app, "document.querySelector('#acct-plan').textContent")) === 'Pro' && (await ui(app, "[...document.querySelectorAll('#dlg-account button')].map((b) => b.textContent).join()")) === 'Manage subscription,Sign out,Close', 'the row says Pro, and the dialog offers Manage subscription');

  // ---- sign out ----
  await ui(app, "document.querySelector('#acct-signout').click()");
  await t.waitFor(async () => (await ui(app, "account.signedIn === false && document.querySelector('#acct-name').textContent")) === 'Sign in', 10000, 'the app to be signed out');
  await t.waitFor(() => server.db.get("SELECT COUNT(*) AS n FROM sessions WHERE kind = 'app'").n === 0, 10000, 'the server to end the session');
  t.check(app.config().token === undefined && app.config().welcome.account === null, 'signing out forgets the token and the account in config.json, and ends the session on the server');
  await t.waitFor(async () => (await ui(app, "account.plan === 'free' && document.querySelector('#conn').dataset.state")) === 'online', 15000, 'the app to be back, signed out');
  t.check((await ui(app, "document.querySelector('#acct-plan').textContent")) === 'Free · 0 of 5 folders', 'and it is a free connection again, with the limit');

  // ---- a sign-in the server does not know any more is forgotten ----
  const signInAgain = async () => {
    const mark = opened().length;
    await ui(app, "api.signIn().then(applyAccount)");
    await t.waitFor(() => opened().length > mark, 10000, 'the sign-in page');
    const url = new URL(opened()[mark]);
    const b = t.makeBrowser();
    const s = await b.get(`${server.siteUrl}/auth/github?app_port=${url.searchParams.get('app_port')}&app_state=${url.searchParams.get('app_state')}&app_challenge=${url.searchParams.get('app_challenge')}`);
    const cb = await b.get(`${server.siteUrl}/auth/github/callback?code=code-from-github&state=${new URL(s.headers.location).searchParams.get('state')}`);
    await b.get(cb.headers.location);
    await t.waitFor(async () => (await ui(app, "account.signedIn")) === true, 15000, 'the app to be signed in again');
  };
  await signInAgain();
  await t.waitFor(async () => (await ui(app, "document.querySelector('#conn').dataset.state")) === 'online', 10000, 'online again');
  server.db.run('DELETE FROM sessions');
  await ui(app, 'p2p.reconnect()');
  await t.waitFor(async () => (await ui(app, "account.signedIn")) === false, 15000, 'the app to forget the sign-in');
  t.check(app.config().token === undefined, 'a token the server no longer accepts (signed_out in the welcome) is forgotten');
  t.check((await ui(app, "document.querySelector('#acct-name').textContent")) === 'Sign in', 'and the window shows signed out');
  t.check(app.dialogs.length === 0, 'no dialog was opened');
}).then(t.finish);
