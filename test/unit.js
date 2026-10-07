// The parts of the main process that do not need a window: the decisions of official builds, the
// proof, the addresses, and the whole sign-in hand-over, played against the real server in-process.
//   node test/unit.js
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const t = require('./lib');
const build = require('../app/build');
const { createAccount, deriveSite, normalizeSignalUrl, cleanWelcome, sameSite } = require('../app/account');
const { buildKey, makeProof } = require('../server/lib/builds');
const tree = require('../app/tree');
const folder = require('../app/folder');
const { createRemoteStore } = require('../app/remote');
const { createUpdater, homeOf, isNewer, swapCommand } = require('../app/update');

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (list) => [...list].sort();
const sameSet = (a, b) => same(sorted(a), sorted(b));

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

// ---- names, the list of excluded paths, and the tree (app/tree.js) ----

await t.scenario('Names that Windows cannot store are refused, whatever the other side sends', async () => {
  const fine = ['a.txt', 'dir/sub/file.name.ext', 'my file.txt', 'é/ü.txt', 'console.txt', 'COM10', 'communication.log', 'nullable', 'lpt', 'a.b.c', '.hidden', 'x/.gitignore', 'a b/c d.e', 'COM0.txt'];
  const wrong = fine.filter((p) => tree.unsafePath(p) !== null);
  t.check(!wrong.length, `ordinary names are fine, also ones that only look like device names${wrong.length ? ` (refused: ${wrong})` : ''}`);

  const refused = [
    // device names, with or without an extension, in any folder
    'CON', 'con.txt', 'Nul', 'nul.tar.gz', 'COM1', 'com9.txt', 'LPT1', 'lpt9.log', 'AUX', 'PRN.txt', 'sub/CON/x.txt', 'sub/aux.c', 'CON .txt',
    // characters Windows does not allow; ":" would write an alternate data stream
    'a:b.txt', 'a.txt:stream', 'a.txt::$DATA', 'x<y', 'x>y', 'a"b', 'a|b', 'a?b', 'a*b', 'a\u0001b', 'tab\tname', 'sub/new\nline',
    // names Windows would change by itself
    'name.', 'name ', 'dir /x.txt', 'a./b', '...',
    // not a path inside a folder
    '', '.', '..', 'a/../b', 'a/./b', 'a//b', '/abs', '/', 'a/', 'C:/x', 'C:x', 'a\\b', '..\\x', '\\\\server\\share',
    // other trouble
    'x'.repeat(256), 'file.fspart', 'a/b.5-6.fspart',
  ];
  const accepted = refused.filter((p) => tree.unsafePath(p) === null);
  t.check(!accepted.length, `${refused.length} names that are trouble on Windows are refused${accepted.length ? ` (accepted: ${JSON.stringify(accepted)})` : ''}`);
  t.check([undefined, null, 5, {}, ['a']].every((p) => typeof tree.unsafePath(p) === 'string'), 'anything that is not a path is refused too');
  t.check(/reserved/.test(tree.unsafePath('NUL.txt')) && /character/.test(tree.unsafePath('a:b')) && /dot or a space/.test(tree.unsafePath('a.')) && /absolute/.test(tree.unsafePath('/etc/passwd')), 'and the reason is said in words');

  const entries = tree.validEntries([
    { path: 'a', size: 1, mtime: 2 }, { path: 'a', size: 9, mtime: 9 }, { path: 'b', size: -1, mtime: 1 }, { path: 'c', size: 1.5, mtime: 1 }, { path: 'd', size: 1, mtime: NaN },
    { path: 5, size: 1, mtime: 1 }, null, 'x', { path: 'e', size: 2 ** 60, mtime: 1 }, { path: 'f', size: 1, mtime: 1e30 }, { path: 'g', size: 0, mtime: 0, extra: 'x' },
  ]);
  t.check(same(entries, [{ path: 'a', size: 1, mtime: 2 }, { path: 'g', size: 0, mtime: 0 }]), 'a list from the other side keeps only entries with a path, a size and a time, and a path only once');
  t.check(same(tree.validEntries('nonsense'), []) && same(tree.validEntries(undefined), []), 'and a list that is no list is empty');
  t.check(tree.upToDate({ size: 5, mtime: 10000 }, { size: 5, mtime: 11999 }) && !tree.upToDate({ size: 5, mtime: 10000 }, { size: 5, mtime: 12001 }) && !tree.upToDate({ size: 5, mtime: 1 }, { size: 6, mtime: 1 }) && !tree.upToDate({ size: 5, mtime: 1 }, undefined), 'a file is up to date with the same size and a modified time within 2 seconds');
});

await t.scenario('The list of excluded paths: files, whole folders, and old plain lists', async () => {
  const set = (...entries) => new Set(entries);
  t.check(tree.isExcluded(set('a/b.txt'), 'a/b.txt') && !tree.isExcluded(set('a/b.txt'), 'a/b.txt.bak') && !tree.isExcluded(set('a/b.txt'), 'a/c.txt'), 'a file entry excludes that file only (an old config is a plain list of these)');
  t.check(tree.isExcluded(set('a/'), 'a/b.txt') && tree.isExcluded(set('a/'), 'a/b/c/d.txt') && !tree.isExcluded(set('a/'), 'ab.txt') && !tree.isExcluded(set('a/'), 'a.txt') && !tree.isExcluded(set('a/b/'), 'a/bc.txt') && !tree.isExcluded(set('a/b/'), 'a/c/b/x.txt'), 'a folder entry (with "/" at the end) excludes everything inside it, at any depth, and nothing that merely starts like it');
  t.check(!tree.isExcluded(set(), 'a/b.txt') && !tree.isExcluded(set('x/', 'y.txt'), 'new/file.txt'), 'everything else is wanted, files that appear later included');

  const files = [
    ['games/a/1.txt', 10], ['games/a/2.txt', 20], ['games/b/3.txt', 30], ['games/c.txt', 40], ['other.txt', 5],
  ].map(([path, size]) => ({ path, size, mtime: 1000 }));
  const built = tree.build(files);
  const node = (key) => tree.find(built.root, key);
  const choose = (...entries) => tree.choose(built.root, new Set(entries));

  // the example of the brief: tick one file in an excluded folder
  let list = tree.setWanted(['games/'], node('games/a/1.txt'), true);
  t.check(sameSet(list, ['games/b/', 'games/c.txt', 'games/a/2.txt']), `ticking one file in an excluded folder replaces the folder by entries for the rest, level by level (${JSON.stringify(list)})`);
  choose(...list);
  t.check(node('games/').state === 'mixed' && node('games/a/').state === 'mixed' && node('games/b/').state === 'none' && node('games/a/1.txt').wanted && !node('games/a/2.txt').wanted && node('other.txt').wanted, 'and the folders say mixed, none and all as they should');
  t.check(tree.isExcluded(new Set(list), 'games/b/new.txt') && tree.isExcluded(new Set(list), 'games/c.txt') && !tree.isExcluded(new Set(list), 'games/new.txt'), 'files that appear later in a folder that stays excluded stay excluded');

  t.check(sameSet(tree.setWanted(['other.txt'], node('games/b/'), false), ['other.txt', 'games/b/']), 'unticking a folder excludes the folder as a whole');
  t.check(sameSet(tree.setWanted(['games/a/1.txt', 'games/b/3.txt', 'x'], node('games/'), false), ['x', 'games/']), 'and takes out the entries that are inside it');
  t.check(sameSet(tree.setWanted(['games/a/1.txt', 'games/b/', 'x'], node('games/'), true), ['x']), 'ticking a folder takes out everything inside it, and leaves the rest of the list alone');
  const already = ['games/'];
  t.check(tree.setWanted(already, node('games/a/2.txt'), false) === already, 'unticking what is excluded already changes nothing');
  t.check(sameSet(tree.setWanted([], node('games/a/2.txt'), false), ['games/a/2.txt']) && sameSet(tree.setWanted(['games/a/2.txt'], node('games/a/2.txt'), true), []), 'a file is excluded and wanted again by its own entry');

  t.check(sameSet(tree.selectNone(['games/a/1.txt', 'gone.txt', 'gone/x.txt', 'games/gone.txt'], built.root), ['games/', 'other.txt', 'gone.txt', 'gone/x.txt']), 'select none is one entry for each top-level folder and file, and keeps the entries for what is no longer there');
  t.check(sameSet(tree.selectAll(['games/', 'other.txt', 'gone.txt', 'gone/', 'games/a/1.txt'], built.root), ['gone.txt', 'gone/']), 'select all takes out what is in the tree, and keeps the entries for what is no longer there');

  tree.choose(built.root, new Set(['games/a/1.txt', 'other.txt']));
  t.check(built.root.count === 5 && built.root.wantedCount === 3 && built.root.wantedSize === 90 && built.root.size === 105 && node('games/').wantedCount === 3 && node('games/a/').state === 'mixed', 'an old plain list of files works as before: counts and sizes of what is wanted');
  const local = new Map([['games/a/1.txt', { size: 10, mtime: 1500 }], ['games/a/2.txt', { size: 21, mtime: 1000 }], ['games/c.txt', { size: 40, mtime: 99999 }]]);
  tree.markDone(built.root, local);
  t.check(node('games/a/1.txt').done && !node('games/a/2.txt').done && !node('games/c.txt').done && node('games/a/').done === 1 && node('games/').done === 1 && built.root.done === 1, 'the "downloaded" marks count what is on this disk with the right size and time, per folder');
});

await t.scenario('The list of excluded paths always means what the person ticked (randomized)', async () => {
  // a small deterministic generator, so that a failure can be played again
  const rng = (seed) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const problems = [];
  let operations = 0;
  for (let seed = 1; seed <= 300 && problems.length < 5; seed++) {
    const rand = rng(seed);
    const pick = (list) => list[Math.floor(rand() * list.length)];
    const files = [];
    const grow = (prefix, depth) => {
      for (let k = 0, n = 1 + Math.floor(rand() * 4); k < n; k++) {
        if (depth < 3 && rand() < 0.45) grow(`${prefix}d${k}/`, depth + 1);
        else files.push({ path: `${prefix}f${k}.txt`, size: 1 + Math.floor(rand() * 100), mtime: 1 });
      }
    };
    grow('', 0);
    const built = tree.build(files);
    const nodes = [];
    (function visit(dir) {
      for (const kid of dir.kids.values()) {
        nodes.push(kid);
        if (kid.dir) visit(kid);
      }
    })(built.root);
    const dirs = nodes.filter((n) => n.dir);
    // where the person starts: some folders and files excluded, an entry for a file that is gone
    let list = nodes.filter(() => rand() < 0.25).map(tree.entryOf).concat(rand() < 0.5 ? ['gone/x.txt'] : []);
    const under = (n, p) => p.path === n.path || p.path.startsWith(`${n.path}/`);
    const wantedMap = () => new Map(files.map((f) => [f.path, !tree.isExcluded(new Set(list), f.path)]));
    const newFileWanted = () => new Map(dirs.map((d) => [d.path, !tree.isExcluded(new Set(list), `${d.path}/zz-new.txt`)]));
    let model = wantedMap();
    for (let step = 0; step < 25; step++) {
      const before = newFileWanted();
      const beforeList = list;
      const roll = rand();
      let label;
      let target = null;
      let on = false;
      if (roll < 0.1) {
        on = roll < 0.05;
        label = on ? 'select all' : 'select none';
        list = on ? tree.selectAll(list, built.root) : tree.selectNone(list, built.root);
        for (const f of files) model.set(f.path, on);
      } else {
        target = pick(nodes);
        on = rand() < 0.5;
        label = `${on ? 'tick' : 'untick'} ${tree.entryOf(target)}`;
        list = tree.setWanted(list, target, on);
        for (const f of files) if (under(target, f)) model.set(f.path, on);
      }
      operations++;
      const where = `seed ${seed}, step ${step}: ${label} on ${JSON.stringify(beforeList)} gives ${JSON.stringify(list)}`;
      const now = wantedMap();
      if ([...model].some(([path, wanted]) => now.get(path) !== wanted)) problems.push(`files differ, ${where}`);
      if (new Set(list).size !== list.length || list.some((e) => typeof e !== 'string' || e === '')) problems.push(`bad list, ${where}`);
      // what appears later: unchanged outside the ticked node and its parents, and as ticked inside it
      const after = newFileWanted();
      for (const d of dirs) {
        const expected = !target ? (roll < 0.05 ? true : false) : under(target, d) ? on : target.path.startsWith(`${d.path}/`) ? null : before.get(d.path);
        if (expected !== null && after.get(d.path) !== expected) problems.push(`a new file in ${d.path}/ is ${after.get(d.path) ? 'wanted' : 'excluded'}, ${where}`);
      }
      tree.choose(built.root, new Set(list));
      for (const d of dirs) {
        const count = files.filter((f) => under(d, f) && model.get(f.path)).length;
        const all = files.filter((f) => under(d, f)).length;
        if (d.wantedCount !== count || d.state !== (count === 0 ? 'none' : count === all ? 'all' : 'mixed')) problems.push(`state of ${d.path}/ is ${d.state} (${d.wantedCount}), ${where}`);
      }
      // the model must also hold when the same list is read again from nothing
      model = wantedMap();
      if (problems.length >= 5) break;
    }
  }
  t.check(!problems.length, `${operations} random ticks and unticks on 300 random trees: what is wanted is what was ticked, new files follow the folder, folder states are right${problems.length ? `\n      ${problems.join('\n      ')}` : ''}`);
});

await t.scenario('The tree: totals, bad names, paging of big folders, order', async () => {
  const f = (path, size = 1) => ({ path, size, mtime: 1 });
  const built = tree.build([f('games/a/1.txt', 10), f('games/b.txt', 20), f('CON/x.txt'), f('ok/aux.txt'), f('a'), f('a/b.txt'), f('x:y'), f('dup', 5), f('top.txt', 7)]);
  t.check(built.root.count === 5 && built.root.size === 10 + 20 + 1 + 5 + 7 && built.root.kids.get('games').count === 2, 'the tree counts the files and sizes of every folder');
  t.check(sameSet(built.bad.map((b) => b.path), ['CON/x.txt', 'ok/aux.txt', 'x:y', 'a/b.txt']) && built.bad.every((b) => typeof b.why === 'string' && b.why.length > 5), 'files with names that cannot be written (and one that is in the way of a folder) are kept out of it, with the reason');

  const names = ['file10.txt', 'File1.txt', 'file2.txt', 'Zeta', 'alpha'].map((n) => f(`dir/${n}`));
  const order = tree.sortedKids(tree.build([...names, f('dir/sub/x.txt')]).root.kids.get('dir')).map((n) => n.name);
  t.check(same(order, ['sub', 'alpha', 'File1.txt', 'file2.txt', 'file10.txt', 'Zeta']), `folders come first, then names in natural order (${order})`);

  // 650 files in one folder and in the top level: never more than 300 rows at once
  const many = Array.from({ length: 650 }, (_, i) => f(`big/file${i}.bin`));
  const big = tree.build([...many, ...Array.from({ length: 650 }, (_, i) => f(`top${i}.bin`))]);
  const row = (open = [], shown = []) => tree.rows(big, new Set(open), new Map(shown));
  const top = row();
  t.check(top.length === 301 && top[0].node.name === 'big' && top[300].more === big.root && top[300].hidden === 351, 'a folder shows its first 300 entries and then one "more" row that says how many are left');
  const open = row(['big']);
  t.check(open.length === 301 + 300 + 1 && open[1].depth === 1 && open[301].more.path === 'big' && open[301].hidden === 350, 'an open folder is the same one level down');
  t.check(row(['big'], [['big', 600]]).filter((r) => r.depth === 1).length === 601 && row(['big'], [['big', 900]]).filter((r) => r.more && r.more.path === 'big').length === 0, '"Show more" adds 300 at a time, and the "more" row goes when everything is shown');
  t.check(tree.rowKey(top[300]) !== tree.rowKey(open[301]) && tree.rowKey(top[0]) === 'big/' && tree.rowKey(top[1]) === 'top0.bin', 'every row has its own key, a folder with "/" at the end');

  // a big tree is built, chosen and listed in a blink
  const huge = Array.from({ length: 30000 }, (_, i) => f(`d${i % 40}/s${i % 7}/file${i}.dat`, i));
  const t0 = process.hrtime.bigint();
  const hugeBuilt = tree.build(huge);
  tree.choose(hugeBuilt.root, new Set(['d3/', 'd5/s2/']));
  tree.markDone(hugeBuilt.root, new Map());
  const list = tree.rows(hugeBuilt, new Set(['d0', 'd0/s0']), new Map());
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  t.check(hugeBuilt.root.count === 30000 && list.length > 40 && ms < 1500, `30,000 files: tree built, chosen and the rows made in ${ms.toFixed(0)} ms`);
});

// ---- folders on disk (app/folder.js) and the owner's file lists (app/remote.js) ----

await t.scenario('Listing, counting, links, and what may be shared', async () => {
  const base = t.resetDir(path.join(t.tmpRoot, 'unit-folder'));
  const share = path.join(base, 'share');
  const outside = path.join(base, 'outside');
  const put = (file, text = 'x') => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  put(path.join(share, 'a.txt'), 'aaa');
  put(path.join(share, 'sub', 'b.txt'), 'bb');
  put(path.join(share, 'sub', 'deeper', 'c.txt'), 'c');
  put(path.join(share, 'part.5-6.fspart'), 'half');
  fs.mkdirSync(path.join(share, 'empty'));
  put(path.join(outside, 'secret.txt'), 'secret');
  // a junction needs no rights; a symlink to a file needs developer mode, so it is tried
  fs.symlinkSync(outside, path.join(share, 'link'), 'junction');
  let fileLink = false;
  try {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(share, 'secret-link.txt'), 'file');
    fileLink = true;
  } catch {}

  const listed = await folder.listFiles(share);
  t.check(same(listed.files.map((x) => x.path), ['a.txt', 'sub/b.txt', 'sub/deeper/c.txt']) && listed.missing === null, `the listing has the files, sorted, with "/" in the paths, and skips unfinished downloads, empty folders, a junction${fileLink ? ' and a symlink' : ''}`);
  t.check(listed.files[0].size === 3 && Math.abs(listed.files[0].mtime - fs.statSync(path.join(share, 'a.txt')).mtimeMs) < 1000, 'with size and modified time');
  t.check(same(await folder.listFiles(path.join(base, 'nothing-here')), { files: [], missing: 'missing' }), 'a folder that is not there is "missing", which is not an empty folder');
  t.check((await folder.listFiles(path.join(share, 'empty'))).missing === null && same(await folder.listFiles(null), { files: [], missing: null }), 'an empty folder is empty, and a folder that does not exist yet is nothing');
  t.check((await folder.listFiles(path.join(share, 'a.txt'))).missing === 'missing', 'and a file is no folder');

  // reused for a few seconds; one walk for requests that come together
  const lister = folder.createLister(150);
  const first = lister.list('k', share);
  t.check(first === lister.list('k', share), 'a listing that is running is the answer to everybody who asks meanwhile');
  await first;
  put(path.join(share, 'new.txt'));
  t.check((await lister.list('k', share)).files.length === 3, 'a listing is reused for a few seconds');
  t.check((await lister.list('k', share, { fresh: true })).files.length === 4, 'unless a new one is asked for');
  t.check((await lister.list('k', path.join(share, 'sub'))).files.length === 2, 'another folder under the same key starts over');
  await lister.list('k', share, { fresh: true });
  fs.rmSync(path.join(share, 'new.txt'));
  t.check((await lister.list('k', share)).files.length === 4, 'a file that is gone is still in the listing for those few seconds');
  lister.invalidate('k');
  t.check((await lister.list('k', share)).files.length === 3, 'and a folder that changed through the app is listed again at once');
  put(path.join(share, 'later.txt'));
  await t.sleep(200);
  t.check((await lister.list('k', share)).files.length === 4, 'as it is when the time is up');
  fs.rmSync(path.join(share, 'later.txt'));

  for (let i = 0; i < 40; i++) put(path.join(share, 'many', `f${i}.txt`));
  t.check((await folder.countFiles(share, 10)) === 11 && (await folder.countFiles(share, 1000)) === 43, 'counting stops above the limit, and counts everything below it, links skipped');
  t.check((await folder.countFiles(share, 43)) === 43 && (await folder.countFiles(share, 42)) === 43 && folder.MANY_FILES === 20000, 'a folder with as many files as the limit is not over it, one more is; the limit is 20,000');

  // what may be shared
  const places = { home: 'C:\\Users\\ada', windir: 'C:\\Windows', userData: 'C:\\Users\\ada\\AppData\\Roaming\\FriendsShare', baseDir: 'C:\\Users\\ada\\Documents\\FriendsShare' };
  const why = (dir) => folder.unsafeToShare(dir, places);
  t.check(/Windows/.test(why('C:\\Windows')) && /Windows/.test(why('c:\\windows\\System32')) && why('C:\\WindowsApps') === null, 'the Windows folder, and what is in it, is refused (and a folder that only starts with the same letters is not)');
  t.check(/user folder/.test(why('C:\\Users\\ada')) && /user folder/.test(why('c:\\users\\ADA')), 'so is the user\'s own folder, whatever the case of the letters');
  t.check([why('C:\\Users\\ada\\AppData\\Roaming\\FriendsShare'), why('C:\\Users\\ada\\AppData\\Roaming'), why('C:\\Users\\ada\\AppData'), why('C:\\Users')].every((m) => /own settings/.test(m)), 'a folder that contains the settings of this app is refused, and says why');
  t.check(/own settings/.test(why('C:\\Users\\ada\\AppData\\Roaming\\FriendsShare\\remote')), 'and one inside them');
  t.check(/friends are stored/.test(why('C:\\Users\\ada\\Documents')) && /friends are stored/.test(why('C:\\Users\\ada\\Documents\\FriendsShare')), 'a folder that contains the folder where friends\' downloads are stored is refused, and says why');
  t.check(why('C:\\Users\\ada\\Documents\\Photos') === null && why('D:\\Games') === null && why('C:\\Users\\ada\\Documents\\FriendsShare\\Holiday') === null && why('C:\\Users\\ada\\Desktop') === null, 'other folders are fine, a folder from a friend included');

  // a request for a file has to lead to a real file inside the folder
  const real = (rel) => folder.realFile(share, rel).then((p) => p, (err) => err);
  const ok = await real('sub/b.txt');
  t.check(typeof ok === 'string' && ok.toLowerCase() === path.join(fs.realpathSync(share), 'sub', 'b.txt').toLowerCase(), 'a file in the folder is served');
  const through = await real('link/secret.txt');
  t.check(through instanceof Error && through.tag === 'read' && /not inside/.test(through.message), 'a file behind a junction in the folder is not (it is outside, and the text of the path would not tell)');
  if (fileLink) t.check((await real('secret-link.txt')).tag === 'read', 'nor is a file that is a symlink to something outside');
  const tags = await Promise.all(['../outside/secret.txt', 'sub/../../outside/secret.txt', 'a.txt:stream', 'NUL', 'sub/con.txt', '/etc/passwd', 'C:/Windows/win.ini', 'sub\\b.txt', '', 'nothing.txt', 'sub/', 'sub/nothing/x', 5].map((r) => real(r).then((e) => e.tag)));
  t.check(tags.every((tag) => tag === 'read'), `".." and "name:stream", device names, absolute paths, a missing file: every one is refused as a problem with that file only (${tags})`);
  fs.renameSync(share, path.join(base, 'moved'));
  t.check((await real('a.txt')).tag === 'gone', 'a folder that is not there any more is "gone", which is not a problem with one file');
  fs.renameSync(path.join(base, 'moved'), share);
  fs.rmSync(path.join(share, 'link'), { force: true });
  fs.rmSync(path.join(share, 'secret-link.txt'), { force: true });
  t.check(fs.existsSync(path.join(outside, 'secret.txt')), 'removing the junction left what it pointed to alone');
});

await t.scenario('The owner\'s file list is stored apart from the settings, safely', async () => {
  const dir = t.resetDir(path.join(t.tmpRoot, 'unit-remote'));
  const store = createRemoteStore(path.join(dir, 'remote'));
  const list = Array.from({ length: 2000 }, (_, i) => ({ path: `d${i % 9}/file ${i}.bin`, size: i, mtime: 1700000000000 + i }));
  t.check((await store.read('g1')) === null, 'a folder that has no list has none');
  await store.write('g1', [...list, { path: 'bad' }, null]);
  const back = await store.read('g1');
  t.check(back.files.length === 2000 && same(back.files[1999], list[1999]) && back.at > 0, 'a list is written and read back, without the entries that make no sense');
  t.check(fs.readdirSync(path.join(dir, 'remote')).join() === 'g1.json', 'it is one file per folder, and no temporary file is left');
  // writes that come together: every one finishes, and the last is the one that stays
  await Promise.all([1, 2, 3, 4, 5].map((n) => store.write('g1', list.slice(0, n * 10))));
  t.check((await store.read('g1')).files.length === 50 && fs.readdirSync(path.join(dir, 'remote')).join() === 'g1.json', 'writes that come together do not trample each other');
  fs.writeFileSync(path.join(dir, 'remote', 'g2.json'), '{"files": [{"path":');
  t.check((await store.read('g2')) === null, 'a damaged file is no list');
  fs.writeFileSync(path.join(dir, 'remote', 'old.json.123-4.tmp'), 'x');
  await store.tidy();
  t.check(!fs.existsSync(path.join(dir, 'remote', 'old.json.123-4.tmp')), 'a temporary file from a write that was cut short is cleaned up');
  await store.write('..\\..\\evil', list.slice(0, 1));
  t.check(fs.readdirSync(dir).join() === 'remote' && (await store.read('..\\..\\evil')).files.length === 1, 'the id of a folder cannot make the file go anywhere else');
  await store.remove('g1');
  t.check((await store.read('g1')) === null && !fs.existsSync(path.join(dir, 'remote', 'g1.json')), 'removing a folder removes its list');

  // what config.json held until now
  const shares = [{ id: 'a', remote: list.slice(0, 5), chosen: true }, { id: 'b' }, { id: 'c', remote: 'garbage' }, { id: 'd', remote: [] }];
  t.check((await store.migrate(shares)) === true && shares.every((s) => !('remote' in s)) && shares[0].chosen === true, 'lists in the old place are taken out of the shares');
  t.check((await store.read('a')).files.length === 5 && (await store.read('d')).files.length === 0 && (await store.read('c')) === null, 'and are in files of their own');
  t.check((await store.migrate(shares)) === false, 'which is done once');
});

// ---- self-update ----

await t.scenario('Self-update: no administrator rights needed, and nobody is left without the app', async (cleanup) => {
  const base = t.resetDir(path.join(t.tmpRoot, 'unit-update'));
  cleanup(() => t.resetRights(base));
  const NEW = crypto.randomBytes(300 * 1024);
  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file) : null);
  const isNew = (file) => Boolean(read(file)) && read(file).equals(NEW);

  // GitHub, as far as an update needs it
  const release = { version: '1.3.0', size: NEW.length };
  const fetchFn = async (url) => {
    if (!url.startsWith('https://api.github.com/')) return new Response(NEW);
    const asset = { name: 'FriendsShare.exe', size: release.size, browser_download_url: `https://github.com/Siekwie/FriendsShare/releases/download/v${release.version}/FriendsShare.exe` };
    return new Response(JSON.stringify({ tag_name: `v${release.version}`, assets: [asset] }));
  };
  // Nothing is started here: what would be is noted. started: whether Windows starts it.
  const spawner = (started) => {
    const calls = [];
    const spawn = (cmd, args, options) => {
      const child = new EventEmitter();
      child.unref = () => {};
      calls.push({ cmd, args, options });
      setImmediate(() => (started ? child.emit('spawn') : child.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }))));
      return child;
    };
    return { calls, spawn };
  };
  // A PC: the folder where the person keeps the exe (place), and the profile. exe: false is the app
  // run from source, a name is another exe than the one in `place` (a copy in the profile).
  const pc = (name, { version = '1.2.1', started = true, exe, argv = [] } = {}) => {
    const dir = t.resetDir(path.join(base, name));
    const place = path.join(dir, 'place');
    const profile = path.join(dir, 'profile', 'update');
    fs.mkdirSync(place);
    fs.mkdirSync(profile, { recursive: true });
    const placed = path.join(place, 'FriendsShare.exe');
    fs.writeFileSync(placed, 'the old exe');
    const running = exe === false ? null : exe ? path.join(profile, exe) : placed;
    const { calls, spawn } = spawner(started);
    const progress = [];
    const updater = createUpdater({ fetch: fetchFn, spawn, exe: running, home: homeOf(argv, running, profile), dir: () => profile, version, onProgress: (pct) => progress.push(pct) });
    return { place, placed, profile, calls, progress, updater, copy: (v) => path.join(profile, `FriendsShare-${v}.exe`) };
  };

  t.check(isNewer('1.2.1', '1.2.0') && isNewer('v1.10.0', '1.9.9') && !isNewer('1.2.0', '1.2.0') && !isNewer('1.2', '1.2.0') && !isNewer('1.1.9', '1.2.0'), 'versions are compared number by number');

  // ---- the usual case: the exe is in a folder of the person's own ----
  const usual = pc('usual');
  t.check(same(await usual.updater.check(), { status: 'available', current: '1.2.1', latest: '1.3.0' }), 'a newer release is found');
  t.check(same(await usual.updater.install(), { restarting: true }), 'and installed');
  t.check(isNew(`${usual.placed}.new`) && read(usual.placed).toString() === 'the old exe', 'the new exe is downloaded next to the old one, which is still in use');
  const helper = usual.calls[0];
  t.check(usual.calls.length === 1 && helper.cmd === 'cmd.exe' && helper.options.detached && helper.options.windowsHide && same(helper.args, ['/d', '/s', '/c', `"${swapCommand()}"`]), 'a hidden helper that outlives the app puts it in place');
  t.check(helper.options.env.FS_UPDATE_NEW === `${usual.placed}.new` && helper.options.env.FS_UPDATE_EXE === usual.placed && helper.options.env.FS_UPDATE_COPY === usual.copy('1.3.0'), 'it is told the new exe, the old one, and where the new one goes if it cannot take the old one\'s place');
  t.check(usual.progress.at(-1) === 100 && fs.readdirSync(usual.profile).length === 0, 'the window hears how far the download is, and nothing is put into the profile');

  // ---- what the helper does, in a real cmd. Only what it would start is written down instead. ----
  const helperDir = t.resetDir(path.join(base, 'helper'));
  const note = path.join(helperDir, 'note.cmd');
  fs.writeFileSync(note, '@echo %*>>"%FS_TEST_LOG%"\r\n');
  const runHelper = (name, { locked = false, noProfile = false } = {}) => {
    const dir = t.resetDir(path.join(helperDir, name));
    const files = { next: path.join(dir, 'FriendsShare.exe.new'), exe: path.join(dir, 'place', 'FriendsShare.exe'), copy: path.join(dir, noProfile ? 'missing' : 'profile', 'FriendsShare-1.3.0.exe'), log: path.join(dir, 'started.log') };
    fs.mkdirSync(path.dirname(files.exe));
    fs.mkdirSync(path.join(dir, 'profile'));
    fs.writeFileSync(files.next, NEW);
    fs.writeFileSync(files.exe, 'the old exe');
    if (locked) t.denyWrite(path.dirname(files.exe));
    const line = swapCommand(2).replaceAll('start ""', 'call "%FS_TEST_START%"');
    const res = spawnSync('cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
      windowsVerbatimArguments: true,
      windowsHide: true,
      stdio: 'ignore',
      timeout: 60000,
      env: { ...process.env, FS_UPDATE_NEW: files.next, FS_UPDATE_EXE: files.exe, FS_UPDATE_COPY: files.copy, FS_TEST_START: note, FS_TEST_LOG: files.log },
    });
    return { ...files, error: res.error, started: (read(files.log) || '').toString().split(/\r?\n/).map((l) => l.trim()).filter(Boolean) };
  };
  t.check(swapCommand().split('start ""').length === 4, '(the helper starts an exe in three places, which is what the next checks follow)');
  const swapped = runHelper('swapped');
  t.check(!swapped.error && isNew(swapped.exe) && !fs.existsSync(swapped.next) && same(swapped.started, [`"${swapped.exe}"`]), 'the helper puts the new exe in the place of the old one and starts it, once');
  const kept = runHelper('kept', { locked: true });
  t.check(!kept.error && read(kept.exe).toString() === 'the old exe' && isNew(kept.copy) && !fs.existsSync(kept.next), 'an exe that cannot be replaced stays, and the new one goes into the profile');
  t.check(same(kept.started, [`"${kept.copy}" "--update-home=${kept.exe}"`]), 'and is started from there, told which exe it stands in for');
  const stuck = runHelper('stuck', { locked: true, noProfile: true });
  t.check(!stuck.error && same(stuck.started, [`"${stuck.exe}"`]) && read(stuck.exe).toString() === 'the old exe', 'when even that cannot be done, the old exe is started again');

  // ---- the exe is where only an administrator may write (C:\Program Files, say) ----
  const guarded = pc('guarded');
  t.denyWrite(guarded.place);
  let denied = null;
  try {
    fs.writeFileSync(path.join(guarded.place, 'probe'), 'x');
  } catch (err) {
    denied = err.code;
  }
  t.check(denied === 'EPERM' || denied === 'EACCES', `(a file cannot be made next to that exe: ${denied})`);
  await guarded.updater.check();
  t.check(same(await guarded.updater.install(), { restarting: true }), 'the update is installed all the same, without asking for administrator rights');
  t.check(isNew(guarded.copy('1.3.0')) && same(fs.readdirSync(guarded.profile), ['FriendsShare-1.3.0.exe']) && same(fs.readdirSync(guarded.place), ['FriendsShare.exe']), 'the new exe is kept in the profile, complete, and nothing is left half done');
  t.check(guarded.calls.length === 1 && guarded.calls[0].cmd === guarded.copy('1.3.0') && same(guarded.calls[0].args, [`--update-home=${guarded.placed}`]) && guarded.calls[0].options.detached, 'and it is started from there, told which exe it stands in for');

  // the old exe is what the person starts the next time: it hands over to the copy
  const next = pc('handover', { argv: ['--hidden'] });
  fs.writeFileSync(next.copy('1.3.0'), NEW);
  fs.writeFileSync(next.copy('1.2.9'), 'older');
  fs.writeFileSync(next.copy('1.2.1'), 'this version');
  fs.writeFileSync(path.join(next.profile, 'FriendsShare-9.9.9.exe.part'), 'half a download');
  fs.writeFileSync(path.join(next.profile, 'FriendsShare-9.9.exe'), 'not a copy of ours');
  t.check(next.updater.newerCopy() === next.copy('1.3.0'), 'the newest complete copy that is newer than the exe is the one to run');
  t.check((await next.updater.handOver(['--hidden', '--update-home=C:\\somewhere\\else.exe'])) === true, 'the old exe hands over to it');
  t.check(next.calls.length === 1 && next.calls[0].cmd === next.copy('1.3.0') && same(next.calls[0].args, ['--hidden', `--update-home=${next.placed}`]), 'with what it was started with, and its own place');

  // the copy, running: it knows the exe it stands in for, which is what the next update goes for first
  const standIn = pc('stand-in', { version: '1.2.5', exe: 'FriendsShare-1.2.5.exe' });
  const standInArgs = ['--hidden', `--update-home=${standIn.placed}`];
  const homeFor = (args, exe = standIn.copy('1.2.5')) => homeOf(args, exe, standIn.profile);
  t.check(homeFor(standInArgs) === standIn.placed, 'a copy takes the exe it stands in for from its arguments');
  t.check([[], ['--update-home=relative.exe'], [`--update-home=${standIn.place}`], [`--update-home=${path.join(standIn.place, 'gone.exe')}`]].every((args) => homeFor(args) === standIn.copy('1.2.5')), 'only an exe that is there counts: otherwise the copy is its own');
  fs.writeFileSync(path.join(standIn.place, 'Other.exe'), 'another exe');
  t.check(homeFor([`--update-home=${path.join(standIn.place, 'Other.exe')}`], standIn.placed) === standIn.placed, 'an exe that is not a copy in the profile cannot be told to stand in for another');
  t.check(homeFor(standInArgs, null) === null, 'run from source there is no exe at all');
  const healing = pc('healing', { version: '1.2.5', exe: 'FriendsShare-1.2.5.exe', argv: [] });
  const healer = createUpdater({ fetch: fetchFn, spawn: spawner(true).spawn, exe: healing.copy('1.2.5'), home: homeOf([`--update-home=${healing.placed}`], healing.copy('1.2.5'), healing.profile), dir: () => healing.profile, version: '1.2.5' });
  fs.writeFileSync(healing.copy('1.2.5'), 'the running copy');
  t.check(healer.newerCopy() === null, 'a copy does not hand over to itself');
  await healer.check();
  await healer.install();
  t.check(isNew(`${healing.placed}.new`) && same(fs.readdirSync(healing.profile), ['FriendsShare-1.2.5.exe']), 'once the old exe can be replaced (it was moved, say), the next update goes next to it again');

  // ---- things that go wrong ----
  const unstarted = pc('unstarted', { started: false });
  t.denyWrite(unstarted.place);
  await unstarted.updater.check();
  const refused = await unstarted.updater.install().then(() => null, (err) => err.message);
  t.check(refused === 'Update failed: the new version could not be started' && fs.readdirSync(unstarted.profile).length === 0, `a copy that Windows does not start is an error the person sees, and it is removed (${refused})`);
  const again = await unstarted.updater.install().then(() => null, (err) => err.message);
  t.check(again === refused, 'and the update can be tried again');

  const short = pc('short');
  release.size = NEW.length + 1;
  await short.updater.check();
  const cut = await short.updater.install().then(() => null, (err) => err.message);
  release.size = NEW.length;
  t.check(cut === 'Update failed: Downloaded file has the wrong size' && same(fs.readdirSync(short.place), ['FriendsShare.exe']) && short.calls.length === 0, 'a download of the wrong size is not installed and not kept');

  const broken = pc('broken', { started: false });
  fs.writeFileSync(broken.copy('1.3.0'), 'a copy that does not start');
  fs.writeFileSync(broken.copy('1.2.9'), 'older');
  t.check((await broken.updater.handOver([])) === false && !fs.existsSync(broken.copy('1.3.0')), 'a copy that Windows does not start is not handed over to: the exe runs itself, and the copy is removed');

  const source = pc('source', { exe: false });
  fs.writeFileSync(source.copy('1.3.0'), NEW);
  await source.updater.check();
  t.check(source.updater.newerCopy() === null && same(await source.updater.install(), { page: 'https://github.com/Siekwie/FriendsShare/releases/tag/v1.3.0' }) && source.calls.length === 0, 'run from source nothing is replaced or handed over: the release page is all there is');

  // ---- cleaning up ----
  const tidy = pc('tidy', { version: '1.3.0' });
  for (const v of ['1.2.9', '1.3.0', '1.4.0']) fs.writeFileSync(tidy.copy(v), v);
  fs.writeFileSync(`${tidy.copy('1.4.0')}.part`, 'half a download');
  fs.writeFileSync(`${tidy.placed}.new`, 'a download that was not installed');
  fs.writeFileSync(path.join(tidy.profile, 'notes.txt'), 'not ours');
  await tidy.updater.cleanup();
  t.check(sameSet(fs.readdirSync(tidy.profile), ['FriendsShare-1.4.0.exe', 'notes.txt']) && same(fs.readdirSync(tidy.place), ['FriendsShare.exe']), 'at a start, downloads that were not installed and the copies of this version or older are removed');
  const selfTidy = pc('self-tidy', { version: '1.3.0', exe: 'FriendsShare-1.3.0.exe' });
  for (const v of ['1.2.9', '1.3.0']) fs.writeFileSync(selfTidy.copy(v), v);
  await selfTidy.updater.cleanup();
  t.check(same(fs.readdirSync(selfTidy.profile), ['FriendsShare-1.3.0.exe']), 'but never the copy that is running');
});

t.finish();
})();
