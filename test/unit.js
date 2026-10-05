// The parts of the main process that do not need a window: the decisions of official builds, the
// proof, the addresses, and the whole sign-in hand-over, played against the real server in-process.
//   node test/unit.js
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const t = require('./lib');
const build = require('../app/build');
const { createAccount, deriveSite, normalizeSignalUrl, cleanWelcome, sameSite } = require('../app/account');
const { buildKey, makeProof } = require('../server/lib/builds');

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
// ---- decisions of official builds ----

await t.scenario('Official builds: the key, the environment, the switches, the proof', async () => {
  const key = t.buildKeyFor('unit');
  const other = t.buildKeyFor('other');
  const { resolveKey, mayUseEnvOverrides, forbiddenSwitch } = build;

  t.check(resolveKey({ packaged: true, stamped: key, env: {} }) === key, 'the stamped key is the key');
  t.check(resolveKey({ packaged: false, stamped: null, env: { FS_BUILD_KEY: key } }) === key, 'from source, a test can give the key in FS_BUILD_KEY');
  t.check(resolveKey({ packaged: true, stamped: null, env: { FS_BUILD_KEY: key } }) === null, 'a packaged build without a stamped key has none: FS_BUILD_KEY is ignored');
  t.check(resolveKey({ packaged: true, stamped: key, env: { FS_BUILD_KEY: other } }) === key, 'and so is it when there is one');
  t.check(resolveKey({ packaged: false, stamped: null, env: { FS_BUILD_KEY: 'not hex' } }) === null && resolveKey({ packaged: false, stamped: null, env: {} }) === null, 'a key that is not 64 hex characters is no key');

  const env = (official, k, testKey) => mayUseEnvOverrides({ official, key: k, testKey });
  t.check(env(false, null, undefined) === true && env(false, key, 'whatever') === true, 'a development build honours FS_HOME and FS_SIGNAL');
  t.check(env(true, key, undefined) === false && env(true, key, '') === false, 'an official build does not');
  t.check(env(true, key, other) === false && env(true, key, key.slice(0, -1)) === false && env(true, key, key + '0') === false, 'not with another key as FS_TEST_KEY, nor a prefix of the key, nor the key and more');
  t.check(env(true, key, key) === true, 'only with its own key');

  const refused = (args) => forbiddenSwitch(['C:\\app\\FriendsShare.exe', ...args]);
  t.check(['--remote-debugging-port=9222', '--remote-debugging-pipe', '--inspect', '--inspect=9229', '--inspect-brk', '--inspect-brk=9229', '--user-data-dir=D:\\x', '-user-data-dir=D:\\x', '/user-data-dir=D:\\x', '--REMOTE-DEBUGGING-PORT=1'].every((a) => refused([a]) !== null), 'the debugging switches and --user-data-dir are refused, in every spelling Chromium takes');
  t.check(refused(['--hidden']) === null && refused([]) === null && refused(['--proxy-server=127.0.0.1:1', '--no-sandbox']) === null && refused(['--inspector-like', 'user-data-dir']) === null, 'other arguments are not');
  t.check(forbiddenSwitch(['x'], (name) => name === 'remote-debugging-port') === 'remote-debugging-port', 'and so is whatever Electron itself reports as a switch');

  const nonce = crypto.randomBytes(32).toString('hex');
  const hash = t.sha('an app.asar');
  t.check(build.makeProof(key, nonce, hash, '1.2.0') === makeProof(key, nonce, hash, '1.2.0'), 'the proof is the one the server computes');
  t.check(t.buildKeyFor('s', '1.2.0') === buildKey('s', '1.2.0'), 'and the build key is derived as the server does');
  const file = path.join(t.tmpRoot, 'unit', 'asar-stand-in');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = crypto.randomBytes(300000);
  fs.writeFileSync(file, bytes);
  t.check((await build.hashFile(file, fs)) === t.sha(bytes), 'the fingerprint is the SHA-256 of the file');
});

// ---- addresses and what the server tells us ----

await t.scenario('Addresses and welcomes', async () => {
  t.check(deriveSite('wss://friendsshare.wiest-lab.eu/ws') === 'https://friendsshare.wiest-lab.eu', 'the website is the matchmaking address over https, without /ws');
  t.check(deriveSite('ws://127.0.0.1:18080/ws') === 'http://127.0.0.1:18080', 'and over http for a local server');
  const fallback = 'wss://friendsshare.wiest-lab.eu/ws';
  t.check(normalizeSignalUrl('ws://127.0.0.1:8080/ws', fallback) === 'ws://127.0.0.1:8080/ws' && normalizeSignalUrl('ws://127.0.0.1:8080', fallback) === 'ws://127.0.0.1:8080/ws', 'a bare address means the matchmaking of that server');
  t.check(normalizeSignalUrl(undefined, fallback) === fallback && normalizeSignalUrl('http://x', fallback) === fallback && normalizeSignalUrl('nonsense', fallback) === fallback, 'anything else is the default');
  t.check(sameSite(new URL('https://friendsshare.wiest-lab.eu/auth/link'), 'https://friendsshare.wiest-lab.eu') && !sameSite(new URL('https://evil.example/auth/link'), 'https://friendsshare.wiest-lab.eu') && !sameSite(new URL('http://friendsshare.wiest-lab.eu/auth/link'), 'https://friendsshare.wiest-lab.eu'), 'links of the server count only when they are on its own site');
  t.check(sameSite(new URL('http://localhost:8080/auth/link'), 'http://127.0.0.1:8080') && !sameSite(new URL('http://localhost:9999/auth/link'), 'http://127.0.0.1:8080'), 'on a local development server localhost and 127.0.0.1 are the same site');

  t.check(same(cleanWelcome(undefined), { plan: 'free', limit: null, account: null, billing: false, prices: null }), 'before any welcome: signed out, free, no limit');
  const good = cleanWelcome({ t: 'welcome', id: 'x', plan: 'pro', limit: null, account: { name: ' Ada\u0000 ', email: 'a@b.c', avatar: 'https://avatars.githubusercontent.com/u/1' }, billing: true, prices: { monthly: '€1.99', yearly: '€11.88', yearly_per_month: '€0.99' }, signed_out: false });
  t.check(good.plan === 'pro' && good.limit === null && good.account.name === 'Ada' && good.billing === true && good.prices.monthly === '€1.99', 'a welcome is taken over, cleaned');
  t.check(cleanWelcome({ plan: 'platinum', limit: -3 }).plan === 'free' && cleanWelcome({ limit: 0 }).limit === null && cleanWelcome({ limit: 5.5 }).limit === null && cleanWelcome({ limit: 5 }).limit === 5, 'only a free or Pro plan, and a limit that is a whole number above 0');
  t.check(cleanWelcome({ account: { name: 'x', avatar: 'javascript:alert(1)' } }).account.avatar === null && cleanWelcome({ account: { name: 'x', avatar: 'http://insecure.example/a.png' } }).account.avatar === null, 'a picture is only ever an https address');
  t.check(cleanWelcome({ prices: { monthly: '€1.99' } }).prices === null, 'prices are all there or not at all');
});

// ---- the hand-over, without a window ----

await t.scenario('Sign-in hand-over, token, sign-out and the account page, without a window', async (cleanup) => {
  const server = await t.startInProcessServer('unit', { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x', STRIPE_PRICE_MONTHLY: 'pm', STRIPE_PRICE_YEARLY: 'py' });
  cleanup(() => server.close());
  server.github.users['gh-code'] = { id: 7, login: 'ada', name: 'Ada Lovelace', avatar_url: 'https://avatars.githubusercontent.com/u/7', emails: [{ email: 'ada@example.com', primary: true, verified: true }] };

  const config = {};
  const log = { opened: [], states: [], reconnects: 0, fronts: 0, saves: 0 };
  let encryption = true;
  const safeStorage = {
    isEncryptionAvailable: () => encryption,
    encryptString: (text) => Buffer.from(`enc:${text}`),
    decryptString: (buf) => {
      if (!buf.toString().startsWith('enc:')) throw new Error('not ours');
      return buf.toString().slice(4);
    },
  };
  let fetchOverride = null;
  const make = (extra = {}) =>
    createAccount({
      fetch: (url, init) => (fetchOverride && fetchOverride(url, init)) || fetch(url, init),
      safeStorage,
      openUrl: async (url) => void log.opened.push(url),
      config: () => config,
      save: () => log.saves++,
      siteUrl: () => server.siteUrl,
      notify: (state) => log.states.push(state),
      reconnect: () => log.reconnects++,
      bringToFront: () => log.fronts++,
      ...extra,
    });
  const account = make();
  const browser = t.makeBrowser();
  // the person's part: from the login page to the redirect to the app
  async function approve(url, { code = 'gh-code' } = {}) {
    const login = new URL(url);
    const query = ['app_port', 'app_state', 'app_challenge'].map((k) => `${k}=${login.searchParams.get(k)}`).join('&');
    const start = await browser.get(`${server.siteUrl}/auth/github?${query}`);
    const back = await browser.get(`${server.siteUrl}/auth/github/callback?code=${code}&state=${new URL(start.headers.location).searchParams.get('state')}`);
    return back.headers.location;
  }

  t.check(same(account.state(), { signedIn: false, account: null, plan: 'free', limit: null, billing: false, prices: null, signingIn: false, error: null }), 'to begin with: signed out, free, no limit');

  // a sign-in, with a visitor who knows nothing in between
  const first = await account.signIn();
  t.check(first.signingIn === true && log.opened.length === 1 && new URL(log.opened[0]).origin === server.siteUrl, 'signing in opens the login page of the site and waits');
  const again = await account.signIn();
  t.check(again.signingIn === true && log.opened.length === 2 && log.opened[1] === log.opened[0], 'a second click opens the same page again');
  const callback = await approve(log.opened[0]);
  const target = new URL(callback);
  const stranger = await browser.get(`http://127.0.0.1:${target.port}/elsewhere`);
  const wrongHost = await new Promise((resolve) => {
    require('http').get({ host: '127.0.0.1', port: target.port, path: `/callback?code=${target.searchParams.get('code')}&state=${target.searchParams.get('state')}`, headers: { host: 'attacker.example' } }, (res) => resolve(res.statusCode));
  });
  t.check(stranger.status === 404 && wrongHost === 404 && account.state().signingIn === true, 'the little server answers nothing but its own callback, under its own address');
  const page = await browser.get(callback);
  t.check(page.status === 200 && /You are signed in/.test(page.text), 'the callback is answered with the page that says to close the tab');
  const state = account.state();
  t.check(state.signedIn && state.account.name === 'Ada Lovelace' && state.signingIn === false && state.plan === 'free', 'and the account is signed in');
  t.check(log.reconnects === 1 && log.fronts === 1, 'the connection to the matchmaking starts over, and the window comes to the front');
  const token = account.token();
  t.check(/^fsa_[\w-]{40,}$/.test(token) && typeof config.token.enc === 'string' && !JSON.stringify(config).includes(token), 'the token is stored encrypted, not as it is');
  t.check(server.db.get("SELECT COUNT(*) AS n FROM sessions WHERE kind = 'app'").n === 1, 'the server has the session');
  await browser.get(callback).then(() => t.check(false, 'the little server is gone'), () => t.check(true, 'the little server is gone afterwards'));

  // the account page
  await account.openAccountPage();
  const link = new URL(log.opened[2]);
  t.check(link.origin === server.siteUrl && link.pathname === '/auth/link' && link.searchParams.get('next') === '/account', 'the account page opens through the one-time link of the server');
  fetchOverride = (url) => (String(url).endsWith('/api/app/weblink') ? new Response(JSON.stringify({ url: 'https://evil.example/auth/link?code=abc&next=/account' }), { status: 200 }) : null);
  const opened = log.opened.length;
  await account.openAccountPage().then(() => t.check(false, 'a link to another site is refused'), () => t.check(log.opened.length === opened, 'a link to another site is never opened, whatever the server says'));
  // the server ended this session (the person signed out elsewhere, say)
  server.db.run('DELETE FROM sessions');
  fetchOverride = null;
  await account.openAccountPage().then(() => t.check(false, 'a revoked sign-in says so'), (err) => t.check(/signed out/i.test(err.message) && account.state().signedIn === false && config.token === undefined && log.reconnects === 2, 'a sign-in the server does not know any more is forgotten, and the connection starts over'));
  fetchOverride = null;

  // sign in again, then out
  await account.signIn();
  await browser.get(await approve(log.opened[log.opened.length - 1]));
  t.check(account.state().signedIn, 'signed in again');
  const out = await account.signOut();
  t.check(out.signedIn === false && out.account === null && config.token === undefined && log.reconnects === 4, 'signing out forgets the token and the account, and the connection starts over');
  t.check(server.db.get("SELECT COUNT(*) AS n FROM sessions WHERE kind = 'app'").n === 0, 'and ends the session on the server');

  // "Upgrade to Pro" without a sign-in: sign in first, then the page opens
  const before = log.opened.length;
  await account.openAccountPage();
  t.check(log.opened.length === before + 1 && /\/login\?/.test(log.opened[before]), 'without a sign-in the account page waits: the login page opens first');
  await browser.get(await approve(log.opened[before]));
  await t.waitFor(() => log.opened.length === before + 2, 5000, 'the account page to open after signing in');
  t.check(/\/auth\/link\?/.test(log.opened[before + 1]), 'and when that is done, the account page opens');
  await account.signOut();

  // the end of a sign-in that goes nowhere
  const short = make({ timeoutMs: 400 });
  await short.signIn();
  const port = new URL(log.opened[log.opened.length - 1]).searchParams.get('app_port');
  await t.sleep(900);
  t.check(short.state().signingIn === false && /too long/.test(short.state().error), 'a sign-in nobody finishes ends by itself, with a message');
  await browser.get(`http://127.0.0.1:${port}/callback`).then(() => t.check(false, 'its little server is closed'), () => t.check(true, 'and its little server is closed'));
  await short.signIn();
  t.check(short.state().error === null, 'a new attempt starts clean');
  const cancelled = short.cancelSignIn();
  t.check(cancelled.signingIn === false && cancelled.error === null, 'Cancel ends it');

  // a code the server does not accept
  await account.signIn();
  const sign = new URL(log.opened[log.opened.length - 1]);
  const bad = await browser.get(`http://127.0.0.1:${sign.searchParams.get('app_port')}/callback?code=${'x'.repeat(43)}&state=${sign.searchParams.get('app_state')}`);
  t.check(bad.status === 400 && /did not work/.test(bad.text) && /no longer valid|not valid any more/.test(bad.text) && account.state().signedIn === false && account.state().signingIn === false && /not valid/.test(account.state().error), 'a code the server refuses ends the sign-in, in the browser and in the app, with the reason of the server');

  // storage without encryption, and moving to it later
  const plainConfig = { token: { plain: `fsa_${'q'.repeat(43)}` }, welcome: { plan: 'pro', limit: null, account: { name: 'Q', email: null, avatar: null }, billing: true, prices: null } };
  const migrating = createAccount({ fetch, safeStorage, openUrl: async () => {}, config: () => plainConfig, save: () => {}, siteUrl: () => server.siteUrl });
  migrating.init();
  t.check(typeof plainConfig.token.enc === 'string' && plainConfig.token.plain === undefined && migrating.token() === `fsa_${'q'.repeat(43)}`, 'a token that was stored plain moves into encrypted storage once that works');
  encryption = false;
  const noCrypt = {};
  const plain = createAccount({ fetch, safeStorage, openUrl: async (url) => void log.opened.push(url), config: () => noCrypt, save: () => {}, siteUrl: () => server.siteUrl });
  // (the only way a token gets stored is a sign-in, so play one)
  server.github.users['gh-code-2'] = server.github.users['gh-code'];
  await plain.signIn();
  await browser.get(await approve(log.opened[log.opened.length - 1], { code: 'gh-code-2' }));
  t.check(typeof noCrypt.token.plain === 'string' && plain.token() === noCrypt.token.plain, 'where the system cannot encrypt, the token is stored as it is');
  const unreadable = createAccount({ fetch, safeStorage, openUrl: async () => {}, config: () => ({ token: { enc: Buffer.from('foreign').toString('base64') } }), save: () => {}, siteUrl: () => server.siteUrl });
  t.check(unreadable.token() === null, 'a token encrypted for another PC is as good as gone');
  const welcomed = make();
  config.token = undefined;
  welcomed.welcome({ plan: 'pro', limit: null, account: { name: 'A', email: 'a@b.c', avatar: null }, billing: true, prices: null, signed_out: false });
  t.check(welcomed.state().signedIn === false && welcomed.state().account === null && welcomed.state().plan === 'pro', 'an account in a welcome is only shown while there is a token for it');
});

t.finish();
})();
