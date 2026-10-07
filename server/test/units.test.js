// Smaller pieces on their own: configuration, versions, secrets, cookies, addresses, the
// database and its snapshots.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { loadConfig, describeConfig, ConfigError } = require('../lib/config');
const { compareVersions, isVersion, safeEqual, escapeHtml, logSafe } = require('../lib/util');
const { parseCookies, serializeCookie, addressKey, createLimiter, crossSite } = require('../lib/http');
const { safeNext, parseApp, cleanEmail, cleanAvatar, isPlainAscii } = require('../lib/auth');
const { planOf, limitFor, subscriptionView, GRACE_MS } = require('../lib/plan');
const { openDb, cleanup, MIGRATIONS } = require('../lib/db');
const { listBackups, backupDue, takeBackup } = require('../lib/backup');
const { startServer, withServer, sleep, BILLING_ENV, START } = require('./helpers');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'friendsshare-unit-'));
const HASH = 'a'.repeat(64);

// ---- configuration ----

test('the defaults are the ones the contract names', () => {
  const config = loadConfig({});
  assert.equal(config.port, 8080);
  assert.equal(config.baseUrl, 'http://localhost:8080');
  assert.equal(config.dataDir, path.resolve(__dirname, '..', 'data'));
  assert.equal(config.dbPath, path.join(config.dataDir, 'friendsshare.db'));
  assert.equal(config.appSecret, null);
  assert.equal(config.trustProxy, false);
  assert.equal(config.billing, false);
  assert.equal(config.freeLimit, 5);
  assert.equal(config.enforceLimit, false);
  assert.equal(config.requireOfficial, false);
  assert.equal(config.minVersion, '1.2.0');
  assert.equal(config.releaseRepo, 'Siekwie/FriendsShare');
  assert.equal(config.repoUrl, 'https://github.com/Siekwie/FriendsShare');
  assert.deepEqual(config.prices, { monthly: '€1.99', yearly: '€11.88', yearlyPerMonth: '€0.99' });
  assert.equal(config.backup.intervalHours, 24);
  assert.equal(config.backup.keep, 7);
  assert.equal(config.backup.dir, path.join(config.dataDir, 'backups'));
  assert.equal(config.operator.enabled, false);
  assert.equal(config.tuning.maxPayload, 64 * 1024);
  assert.equal(config.tuning.helloTimeoutMs, 15_000);
  assert.equal(config.tuning.pingIntervalMs, 30_000);
  assert.equal(config.tuning.proDevices, 5);
  // against whoever opens sockets and registers rooms
  assert.equal(config.wsMaxPerAddress, 40);
  assert.equal(config.wsUpgradesPerMinute, 120);
  assert.equal(config.roomsPerAddressHour, 60);
  assert.equal(config.maxRooms, 200_000);
  assert.equal(config.tuning.helloBytes, 4096);
  assert.equal(config.tuning.roomMaxAgeMs, 400 * 86_400_000);
  // a slow request is not waited for for long
  assert.equal(config.tuning.requestTimeoutMs, 30_000);
  assert.equal(config.tuning.headersTimeoutMs, 15_000);
  assert.deepEqual(config.tuning.accountRates, {
    checkout: { max: 10, windowMs: 3_600_000 },
    portal: { max: 20, windowMs: 3_600_000 },
    weblink: { max: 20, windowMs: 3_600_000 },
  });
});

test('the limits against abuse can be set, and nonsense falls back to the default', () => {
  const config = loadConfig({ WS_MAX_PER_ADDRESS: '5', WS_UPGRADES_PER_MINUTE: '7', ROOMS_PER_ADDRESS_HOUR: '9', MAX_ROOMS: '1234' });
  assert.equal(config.wsMaxPerAddress, 5);
  assert.equal(config.wsUpgradesPerMinute, 7);
  assert.equal(config.roomsPerAddressHour, 9);
  assert.equal(config.maxRooms, 1234);
  for (const [name, key, fallback] of [
    ['WS_MAX_PER_ADDRESS', 'wsMaxPerAddress', 40],
    ['WS_UPGRADES_PER_MINUTE', 'wsUpgradesPerMinute', 120],
    ['ROOMS_PER_ADDRESS_HOUR', 'roomsPerAddressHour', 60],
    ['MAX_ROOMS', 'maxRooms', 200_000],
  ]) {
    // a limit of nothing would lock everybody out, so it is not one
    for (const bad of ['0', '-3', 'many', '', ' ']) assert.equal(loadConfig({ [name]: bad })[key], fallback, `${name}=${JSON.stringify(bad)}`);
    assert.equal(loadConfig({ [name]: '2.9' })[key], 2, `${name} is a whole number`);
  }
});

test('the cookies are called by their __Host- names on https, and by plain ones on http', () => {
  assert.deepEqual(loadConfig({ BASE_URL: 'https://friendsshare.example.com' }).cookies, { session: '__Host-fs_session', state: '__Host-fs_oauth_state', statePath: '/' });
  assert.deepEqual(loadConfig({ BASE_URL: 'http://localhost:8080' }).cookies, { session: 'fs_session', state: 'fs_oauth_state', statePath: '/auth' });
  assert.deepEqual(loadConfig({}).cookies, { session: 'fs_session', state: 'fs_oauth_state', statePath: '/auth' });
});

test('PORT, DATA_DIR and BASE_URL are read, and the base address is reduced to its origin', () => {
  const dir = tmp();
  const config = loadConfig({ PORT: '9000', DATA_DIR: dir, BASE_URL: 'https://friendsshare.example.com/some/path/?x=1' });
  assert.equal(config.port, 9000);
  assert.equal(config.dataDir, dir);
  assert.equal(config.baseUrl, 'https://friendsshare.example.com');
  assert.equal(config.secureCookies, true);
  assert.equal(loadConfig({ PORT: '9000' }).baseUrl, 'http://localhost:9000');
  assert.equal(loadConfig({ BASE_URL: 'http://localhost:8080/' }).secureCookies, false);
  assert.equal(loadConfig({ PORT: 'not a number' }).port, 8080);
  for (const bad of ['friendsshare.example.com', 'ftp://example.com', 'https://']) assert.throws(() => loadConfig({ BASE_URL: bad }), ConfigError, bad);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('billing is on only with all four Stripe values and at least one way to sign in', () => {
  const stripe = { STRIPE_SECRET_KEY: 'sk', STRIPE_WEBHOOK_SECRET: 'wh', STRIPE_PRICE_MONTHLY: 'pm', STRIPE_PRICE_YEARLY: 'py' };
  const github = { GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' };
  const google = { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' };
  assert.equal(loadConfig({ ...stripe, ...github }).billing, true);
  assert.equal(loadConfig({ ...stripe, ...google }).billing, true);
  assert.equal(loadConfig({ ...stripe }).billing, false, 'nobody could sign in to buy');
  assert.equal(loadConfig({ ...stripe, GITHUB_CLIENT_ID: 'id' }).billing, false, 'half a pair is not a sign-in method');
  for (const missing of Object.keys(stripe)) {
    const partial = { ...stripe, ...github, [missing]: '' };
    assert.equal(loadConfig(partial).billing, false, missing);
    assert.deepEqual(loadConfig(partial).stripe.missing, [missing]);
  }
  assert.equal(loadConfig({}).billing, false);
  // the folder limit follows billing, or ENFORCE_LIMIT
  assert.equal(loadConfig({ ...stripe, ...github }).enforceLimit, true);
  assert.equal(loadConfig({ ...stripe }).enforceLimit, false);
  assert.equal(loadConfig({ ENFORCE_LIMIT: '1' }).enforceLimit, true);
  assert.equal(loadConfig({ ENFORCE_LIMIT: '0' }).enforceLimit, false);
  assert.equal(loadConfig({ FREE_LIMIT: '8' }).freeLimit, 8);
  assert.equal(loadConfig({ FREE_LIMIT: '0' }).freeLimit, 5);
  assert.equal(loadConfig({ FREE_LIMIT: 'many' }).freeLimit, 5);
});

test('official builds need a secret, and EXTRA_BUILDS, MIN_VERSION and RELEASE_REPO are checked', () => {
  assert.throws(() => loadConfig({ REQUIRE_OFFICIAL: '1' }), /BUILD_SECRET/);
  assert.equal(loadConfig({ REQUIRE_OFFICIAL: '1', BUILD_SECRET: 's' }).requireOfficial, true);
  assert.equal(loadConfig({ BUILD_SECRET: 's' }).requireOfficial, false);

  const extra = loadConfig({ EXTRA_BUILDS: `1.2.0:${HASH}, 1.2.1:${'B'.repeat(64)} ,1.2.0:${'c'.repeat(64)}` }).extraBuilds;
  assert.deepEqual([...extra.keys()], ['1.2.0', '1.2.1']);
  assert.deepEqual([...extra.get('1.2.0')], [HASH, 'c'.repeat(64)]);
  assert.deepEqual([...extra.get('1.2.1')], ['b'.repeat(64)], 'hashes are compared in lowercase');
  assert.equal(loadConfig({ EXTRA_BUILDS: '' }).extraBuilds.size, 0);
  assert.deepEqual([...loadConfig({ EXTRA_BUILDS: '1.2.0:dev' }).extraBuilds.get('1.2.0')], ['dev'], 'an app run from source can be admitted for tests');
  for (const bad of ['1.2.0', '1.2.0:abc', `1.2:${HASH}`, `:${HASH}`, `1.2.0:${'g'.repeat(64)}`, `1.2.0-beta:${HASH}`]) {
    assert.throws(() => loadConfig({ EXTRA_BUILDS: bad }), ConfigError, bad);
  }

  assert.equal(loadConfig({ MIN_VERSION: '2.0.1' }).minVersion, '2.0.1');
  for (const bad of ['2', '2.0', 'v2.0.0', '2.0.0-rc1']) assert.throws(() => loadConfig({ MIN_VERSION: bad }), /MIN_VERSION/, bad);
  assert.equal(loadConfig({ RELEASE_REPO: 'me/app' }).repoUrl, 'https://github.com/me/app');
  for (const bad of ['me', 'me/app/extra', '../x', 'me/ap p']) assert.throws(() => loadConfig({ RELEASE_REPO: bad }), /RELEASE_REPO/, bad);
});

test('the operator pages need a name and an address, lines are separated by semicolons', () => {
  assert.equal(loadConfig({ OPERATOR_NAME: 'Ada' }).operator.enabled, false);
  assert.equal(loadConfig({ OPERATOR_ADDRESS: 'x' }).operator.enabled, false);
  assert.equal(loadConfig({ OPERATOR_NAME: 'Ada', OPERATOR_ADDRESS: ' ; ' }).operator.enabled, false);
  const op = loadConfig({ OPERATOR_NAME: 'Ada', OPERATOR_ADDRESS: 'Main Street 1; 12345 Town;;Germany ', OPERATOR_EMAIL: 'a@example.com', OPERATOR_HOSTING: 'Hetzner' }).operator;
  assert.deepEqual(op, { name: 'Ada', address: ['Main Street 1', '12345 Town', 'Germany'], email: 'a@example.com', hosting: 'Hetzner', enabled: true });
});

test('what the operator is told at start names no secret and points out half-finished setups', () => {
  const lines = describeConfig(loadConfig({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'the-github-secret', STRIPE_SECRET_KEY: 'sk_live_secret', REQUIRE_OFFICIAL: '1', BUILD_SECRET: 'the-build-secret' })).join('\n');
  for (const value of ['the-github-secret', 'sk_live_secret', 'the-build-secret']) assert.ok(!lines.includes(value), value);
  assert.match(lines, /sign-in: github/);
  assert.match(lines, /billing: off/);
  assert.match(lines, /Stripe is only partly set up \(missing STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_MONTHLY, STRIPE_PRICE_YEARLY\)/);
  assert.match(lines, /official builds only: yes/);
  assert.match(lines, /OPERATOR_NAME and OPERATOR_ADDRESS/);
  const noLogin = describeConfig(loadConfig({ STRIPE_SECRET_KEY: 'a', STRIPE_WEBHOOK_SECRET: 'b', STRIPE_PRICE_MONTHLY: 'c', STRIPE_PRICE_YEARLY: 'd' })).join('\n');
  assert.match(noLogin, /no sign-in provider/);
});

test('with billing on and no portal configuration the operator is warned, with billing off nothing is said', () => {
  const stripe = { STRIPE_SECRET_KEY: 'sk_live_secret', STRIPE_WEBHOOK_SECRET: 'wh', STRIPE_PRICE_MONTHLY: 'pm', STRIPE_PRICE_YEARLY: 'py', GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' };
  const warnings = (env) => describeConfig(loadConfig(env)).filter((line) => line.includes('STRIPE_PORTAL_CONFIG'));

  const without = warnings(stripe);
  assert.equal(without.length, 1);
  assert.match(without[0], /^\[config\] WARNING /);
  assert.match(without[0], /bpc_/, 'it says what to set it to');
  assert.ok(!without[0].includes('sk_live_secret'));
  // set, or not blank, the warning goes away
  assert.deepEqual(warnings({ ...stripe, STRIPE_PORTAL_CONFIG: 'bpc_123' }), []);
  assert.equal(warnings({ ...stripe, STRIPE_PORTAL_CONFIG: '   ' }).length, 1, 'blank is not set');
  // without billing the portal is never used
  assert.deepEqual(warnings({}), []);
  assert.deepEqual(warnings({ ...stripe, GITHUB_CLIENT_ID: '' }), [], 'nobody could sign in, so billing is off');
  assert.deepEqual(warnings({ ...stripe, STRIPE_PRICE_YEARLY: '' }), [], 'half a Stripe setup is off as well');
});

// ---- small helpers ----

test('versions are compared as numbers, and only x.y.z is a version', () => {
  assert.equal(compareVersions('1.2.0', '1.2.0'), 0);
  assert.ok(compareVersions('1.2.0', '1.10.0') < 0);
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
  assert.ok(compareVersions('2.0.0', '1.99.99') > 0);
  assert.ok(compareVersions('1.2.3', '1.2.4') < 0);
  for (const good of ['0.0.1', '1.2.0', '10.20.30', '123456789.0.0']) assert.equal(isVersion(good), true, good);
  for (const bad of ['1.2', '1.2.3.4', 'v1.2.3', '01.2.3', '1.2.3-beta', '1.2.x', ' 1.2.3', '1.2.3 ', '', null, undefined, 123, '1234567890.0.0', '-1.0.0']) assert.equal(isVersion(bad), false, String(bad));
});

test('secrets are compared without caring about length or type', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), true);
  assert.equal(safeEqual('abc', undefined), false);
  assert.equal(safeEqual(null, null), false);
  assert.equal(safeEqual(123, 123), false);
  assert.equal(safeEqual('x'.repeat(10_000), 'x'.repeat(10_000)), true);
});

test('text from strangers is escaped for pages and made safe for log lines', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(logSafe('1.2.0'), '1.2.0');
  assert.equal(logSafe('1.2.0\n[auth] forged'), 'invalid');
  assert.equal(logSafe('x'.repeat(65)), 'invalid');
  assert.equal(logSafe(undefined), 'invalid');
  assert.equal(logSafe(5), 'invalid');
});

test('cookies are read leniently and written strictly', () => {
  assert.deepEqual(parseCookies('a=1; b=two%20words; c=; =x; broken; a=second'), { a: '1', b: 'two words', c: '' });
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies('a=%E0%A4%A'), { a: '%E0%A4%A' });
  assert.equal(serializeCookie('fs_session', 'tok', { maxAge: 100, secure: true }), 'fs_session=tok; Path=/; HttpOnly; SameSite=Lax; Max-Age=100; Secure');
  assert.equal(serializeCookie('fs_oauth_state', 's', { maxAge: 600, path: '/auth' }), 'fs_oauth_state=s; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=600');
  assert.equal(serializeCookie('x', '', { maxAge: 0 }), 'x=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
});

test('addresses are grouped the way one person is: IPv4 as it is, IPv6 by its /64', () => {
  assert.equal(addressKey('203.0.113.7'), '203.0.113.7');
  assert.equal(addressKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(addressKey('2001:db8:1:2::1'), '2001:db8:1:2');
  assert.equal(addressKey('2001:DB8:1:2:3:4:5:6'), '2001:db8:1:2');
  assert.equal(addressKey('2001:0db8:0001:0002:ffff:ffff:ffff:ffff'), '2001:db8:1:2');
  assert.equal(addressKey('::1'), '0:0:0:0');
  assert.equal(addressKey('fe80::1%eth0'), 'fe80:0:0:0');
  assert.equal(addressKey('unknown'), 'unknown');
});

test('the limiter counts a sliding window per key and forgets old keys', () => {
  let t = 0;
  const limiter = createLimiter({ max: 2, windowMs: 1000 }, () => t);
  assert.equal(limiter.allow('a'), true);
  assert.equal(limiter.allow('a'), true);
  assert.equal(limiter.allow('a'), false);
  assert.equal(limiter.allow('b'), true);
  t = 999;
  assert.equal(limiter.allow('a'), false);
  t = 1001;
  assert.equal(limiter.allow('a'), true);
  // a flood of different addresses cannot make it grow without end
  t = 5000;
  for (let n = 0; n < 12_000; n++) limiter.allow(`address-${n}`);
  assert.equal(limiter.allow('address-0'), true);
});

test('the cross-site check follows the contract', () => {
  const req = (headers) => ({ headers });
  const origin = 'https://friendsshare.example.com';
  assert.equal(crossSite(req({ origin }), origin), false);
  assert.equal(crossSite(req({ origin: 'https://evil.example' }), origin), true);
  assert.equal(crossSite(req({ origin: 'null' }), origin), true);
  assert.equal(crossSite(req({}), origin), false);
  assert.equal(crossSite(req({ 'sec-fetch-site': 'cross-site' }), origin), true);
  assert.equal(crossSite(req({ 'sec-fetch-site': 'same-origin' }), origin), false);
  assert.equal(crossSite(req({ origin, 'sec-fetch-site': 'cross-site' }), origin), false);
});

test('next and the app values are validated strictly', () => {
  for (const ok of ['/account', '/', '/a/b?c=d#e', '/login?error=link', '/a%20b', '/caf%C3%A9', '/~user', '/a;b=c', '/' + 'x'.repeat(511)]) assert.equal(safeNext(ok), ok, ok);
  for (const bad of [
    undefined, null, 5, {}, ['/a'], '', 'account', '//evil.example', '/\\evil.example', '/a\\b', 'https://evil.example', 'javascript:alert(1)', '///evil.example', '/\\/evil.example',
    '/a\nb', '/a\u0000b', '/a\tb', '/a\r\nSet-Cookie: x=y', '/a\u007fb',
    // a space, and everything beyond printable ASCII, cannot go into a header nor be read the same way everywhere
    '/a b', '/ a', '/a ', '/café', '/ ', '/‮a', '/／evil.example', '/ı', '/a b',
    '/' + 'x'.repeat(512), '/' + 'x'.repeat(600),
  ]) {
    assert.equal(safeNext(bad), '/account', String(JSON.stringify(bad)).slice(0, 40));
  }
  const state = 'a'.repeat(16);
  const challenge = 'B_-'.repeat(10);
  assert.deepEqual(parseApp('51234', state, challenge), { port: 51234, state, challenge });
  assert.deepEqual(parseApp(51234, state, challenge), { port: 51234, state, challenge });
  assert.equal(parseApp('1024', state, challenge).port, 1024);
  assert.equal(parseApp('65535', state, challenge).port, 65535);
  for (const bad of ['1023', '65536', '0', '-1', '1e4', '51234.0', '', ' 80', 51234.5, null, undefined, {}]) assert.equal(parseApp(bad, state, challenge), null, String(bad));
  assert.equal(parseApp('51234', 'a'.repeat(15), challenge), null);
  assert.equal(parseApp('51234', 'a'.repeat(129), challenge), null);
  assert.equal(parseApp('51234', state, 'a b'.padEnd(20, 'x')), null);
  assert.equal(parseApp('51234', undefined, challenge), null);
});

test('an email address is lowercased for A to Z only, and only plain ASCII ones can join another account', () => {
  assert.equal(cleanEmail('  Ada@Example.COM '), 'ada@example.com');
  assert.equal(cleanEmail('ada@example.com'), 'ada@example.com');
  for (const bad of [undefined, null, 5, '', 'no-at-sign', 'a b@example.com', '@example.com', 'ada@', 'a@b@c', 'x'.repeat(250) + '@e.com']) assert.equal(cleanEmail(bad), null, String(bad).slice(0, 20));
  assert.equal(cleanEmail('x'.repeat(248) + '@e.com').length, 254, 'the longest address there can be');
  assert.equal(cleanEmail('x'.repeat(249) + '@e.com'), null);
  // look-alikes are not folded into plain letters: the Kelvin sign is not a "k", the dotted capital I is not an "i"
  assert.equal(cleanEmail('Kim@example.com'), 'Kim@example.com');
  assert.notEqual(cleanEmail('Kim@example.com'), 'kim@example.com');
  assert.equal(cleanEmail('İvan@example.com'), 'İvan@example.com');
  assert.equal(cleanEmail('Kim@EXAMPLE.com'), 'kim@example.com');

  for (const plain of ['ada@example.com', 'a.b+c@sub.example.co.uk', "o'neil@example.com", '!#$%&*+-/=?^_`{|}~@e.io']) assert.equal(isPlainAscii(plain), true, plain);
  for (const other of ['Kim@example.com', 'café@example.com', 'ada@exaℭple.com', 'ada@über.example', 'a​da@example.com', '', 'a b@example.com', 'ada@example.com\n']) assert.equal(isPlainAscii(other), false, JSON.stringify(other));
});

test('a picture is only taken from the places the providers keep them', () => {
  for (const ok of [
    'https://avatars.githubusercontent.com/u/12345?v=4',
    'https://avatars.githubusercontent.com/u/12345',
    'https://lh3.googleusercontent.com/a/ACg8ocJ=s96-c',
    'https://lh3.googleusercontent.com/a-/AOh14Gg',
    'https://a.b.googleusercontent.com/x',
  ]) assert.equal(cleanAvatar(ok), new URL(ok).href, ok);
  // read the way a browser reads it
  assert.equal(cleanAvatar('HTTPS://AVATARS.GITHUBUSERCONTENT.COM/u/1'), 'https://avatars.githubusercontent.com/u/1');
  for (const bad of [
    undefined, null, 5, '', 'not a url', '/relative.png',
    'http://avatars.githubusercontent.com/u/1', 'ftp://avatars.githubusercontent.com/u/1', 'javascript:alert(1)', 'data:image/png;base64,AAAA',
    'https://evil.example/avatars.githubusercontent.com/u/1', 'https://avatars.githubusercontent.com.evil.example/u/1', 'https://evilavatars.githubusercontent.com/u/1',
    'https://avatars.githubusercontent.com@evil.example/u/1', 'https://evil.example@avatars.githubusercontent.com/u/1', 'https://user:pw@avatars.githubusercontent.com/u/1',
    'https://avatars.githubusercontent.com:8443/u/1', 'https://avatars.githubusercontent.com%2f@evil.example/u/1', 'https://evil.example\\@avatars.githubusercontent.com/u/1',
    'https://googleusercontent.com/x', 'https://.googleusercontent.com/x', 'https://evil.example/.googleusercontent.com/x', 'https://lh3.googleusercontent.com.evil.example/x',
    'https://x_y.googleusercontent.com/x', 'https://x..googleusercontent.com/x', 'https://lh3.googleusercontent.com:444/x', 'https://github.com/Ada.png', 'https://www.gravatar.com/avatar/1',
    'https://avatars.githubusercontent.com/' + 'x'.repeat(500),
  ]) assert.equal(cleanAvatar(bad), null, String(bad).slice(0, 60));
  // whatever is let through is the address a browser would read, with the provider's own host
  const odd = cleanAvatar('https://avatars.githubusercontent.com\\@evil.example/u/1');
  assert.equal(new URL(odd).hostname, 'avatars.githubusercontent.com');
});

test('the plan follows the subscription status and the paid period plus three days', () => {
  const now = 1_000_000_000_000;
  const sub = (status, end) => ({ stripe_subscription_id: 'sub_1', sub_status: status, sub_period_end: end });
  assert.equal(planOf(sub('active', now + 1), now), 'pro');
  assert.equal(planOf(sub('trialing', now + 1), now), 'pro');
  assert.equal(planOf(sub('past_due', now + 1), now), 'pro');
  assert.equal(planOf(sub('active', now - GRACE_MS + 1), now), 'pro');
  assert.equal(planOf(sub('active', now - GRACE_MS), now), 'free');
  assert.equal(planOf(sub('canceled', now + 1e9), now), 'free');
  assert.equal(planOf(sub('unpaid', now + 1e9), now), 'free');
  assert.equal(planOf(sub('active', null), now), 'free');
  assert.equal(planOf({ stripe_subscription_id: null, sub_status: 'active', sub_period_end: now + 1e9 }, now), 'free');
  assert.equal(planOf(undefined, now), 'free');
  assert.equal(GRACE_MS, 3 * 86_400_000);

  const config = { enforceLimit: true, freeLimit: 5 };
  assert.equal(limitFor('free', config), 5);
  assert.equal(limitFor('pro', config), null);
  assert.equal(limitFor('free', { enforceLimit: false, freeLimit: 5 }), null);
  assert.equal(subscriptionView({ ...sub('canceled', now), sub_interval: 'month', sub_cancel_at_period_end: 0 }), null);
  assert.deepEqual(subscriptionView({ ...sub('past_due', now), sub_interval: 'year', sub_cancel_at_period_end: 1 }), { status: 'past_due', interval: 'year', renews_at: now, cancel_at_period_end: true });
});

// ---- the database ----

test('the database is created with the schema, foreign keys and WAL, and opened again without harm', () => {
  const dir = tmp();
  const file = path.join(dir, 'nested', 'friendsshare.db');
  const db = openDb(file);
  try {
    assert.equal(db.get('PRAGMA user_version').user_version, MIGRATIONS.length);
    assert.equal(db.get('PRAGMA foreign_keys').foreign_keys, 1);
    assert.equal(db.get('PRAGMA journal_mode').journal_mode, 'wal');
    const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((t) => t.name);
    assert.deepEqual(tables, ['accounts', 'blocked_rooms', 'builds', 'codes', 'identities', 'meta', 'rooms', 'sessions', 'stats_daily']);
    db.run('INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)', 'a1', 'Ada', 1);
    // rows are ordinary objects
    assert.deepEqual(db.get('SELECT id, name FROM accounts'), { id: 'a1', name: 'Ada' });
    assert.equal(db.get('SELECT * FROM accounts WHERE id = ?', 'nobody'), undefined);
    // children go with the account, and a child cannot exist without one
    db.run('INSERT INTO identities (provider, subject, account_id, created_at) VALUES (?, ?, ?, ?)', 'github', '1', 'a1', 1);
    assert.throws(() => db.run('INSERT INTO identities (provider, subject, account_id, created_at) VALUES (?, ?, ?, ?)', 'github', '2', 'nobody', 1), /FOREIGN KEY/);
    assert.throws(() => db.run('INSERT INTO identities (provider, subject, account_id, created_at) VALUES (?, ?, ?, ?)', 'gitlab', '3', 'a1', 1), /CHECK/);
    db.run('DELETE FROM accounts WHERE id = ?', 'a1');
    assert.equal(db.get('SELECT COUNT(*) AS n FROM identities').n, 0);
  } finally {
    db.close();
    db.close();
  }
  const again = openDb(file);
  try {
    assert.equal(again.get('PRAGMA user_version').user_version, MIGRATIONS.length);
  } finally {
    again.close();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a database written by a newer server is refused rather than damaged', () => {
  const dir = tmp();
  const file = path.join(dir, 'newer.db');
  const raw = new DatabaseSync(file);
  raw.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
  raw.close();
  assert.throws(() => openDb(file), /newer version/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a database from the first release is upgraded to the current version and keeps everything it had', () => {
  const dir = tmp();
  const file = path.join(dir, 'version1.db');
  // exactly what the first release of this server left behind
  const old = new DatabaseSync(file);
  old.exec(MIGRATIONS[0]);
  old.exec('PRAGMA user_version = 1');
  old.exec("INSERT INTO accounts (id, name, email, created_at) VALUES ('a1', 'Ada', 'ada@example.com', 1)");
  old.exec(`INSERT INTO rooms (room, key_hash, exp) VALUES ('${'a'.repeat(64)}', '${'b'.repeat(64)}', 5)`);
  old.exec("INSERT INTO meta (key, value) VALUES ('latest_version', '1.2.0')");
  assert.equal(old.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'blocked_rooms'").get().n, 0);
  old.close();

  assert.equal(MIGRATIONS.length, 4);
  const before = Date.now();
  const db = openDb(file);
  try {
    assert.equal(db.get('PRAGMA user_version').user_version, 4);
    assert.deepEqual(db.get('SELECT id, name, email, checkout_session_id FROM accounts'), { id: 'a1', name: 'Ada', email: 'ada@example.com', checkout_session_id: null });
    const room = db.get('SELECT room, key_hash, exp, last_seen FROM rooms');
    assert.deepEqual({ ...room, last_seen: undefined }, { room: 'a'.repeat(64), key_hash: 'b'.repeat(64), exp: 5, last_seen: undefined });
    // the rooms that exist count as seen when the upgrade ran, not as the oldest of all
    assert.ok(room.last_seen >= before - 2000 && room.last_seen <= Date.now() + 2000, `last_seen ${room.last_seen}`);
    assert.equal(db.get("SELECT value FROM meta WHERE key = 'latest_version'").value, '1.2.0');
    assert.equal(db.get('SELECT COUNT(*) AS n FROM blocked_rooms').n, 0);
    // and the table of daily totals is there, empty
    assert.equal(db.get('SELECT COUNT(*) AS n FROM stats_daily').n, 0);
    db.run('INSERT INTO blocked_rooms (room, created_at, note) VALUES (?, ?, ?)', 'c'.repeat(64), 7, 'after the upgrade');
  } finally {
    db.close();
  }
  // opening it again changes nothing, and the new row is still there
  const again = openDb(file);
  try {
    assert.equal(again.get('PRAGMA user_version').user_version, 4);
    assert.deepEqual(again.all('SELECT room, created_at, note FROM blocked_rooms'), [{ room: 'c'.repeat(64), created_at: 7, note: 'after the upgrade' }]);
  } finally {
    again.close();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a version 2 database (with blocked rooms) gets the room clock and the checkout column', () => {
  const dir = tmp();
  const file = path.join(dir, 'version2.db');
  const old = new DatabaseSync(file);
  old.exec(MIGRATIONS[0]);
  old.exec(MIGRATIONS[1]);
  old.exec('PRAGMA user_version = 2');
  old.exec(`INSERT INTO blocked_rooms (room, created_at, note) VALUES ('${'d'.repeat(64)}', 9, 'blocked before')`);
  old.exec("INSERT INTO accounts (id, name, stripe_customer_id, created_at) VALUES ('a2', 'Bea', 'cus_1', 1)");
  old.close();

  const db = openDb(file);
  try {
    assert.equal(db.get('PRAGMA user_version').user_version, 4);
    assert.deepEqual(db.all('SELECT room, created_at, note FROM blocked_rooms'), [{ room: 'd'.repeat(64), created_at: 9, note: 'blocked before' }]);
    assert.deepEqual(db.get('SELECT stripe_customer_id, checkout_session_id FROM accounts'), { stripe_customer_id: 'cus_1', checkout_session_id: null });
    // the clock column has an index, which is what makes forgetting the oldest cheap
    assert.equal(db.get("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'rooms_last_seen'").n, 1);
    db.run('INSERT INTO rooms (room, key_hash, exp) VALUES (?, ?, ?)', 'e'.repeat(64), 'f'.repeat(64), 1);
    assert.equal(db.get('SELECT last_seen FROM rooms').last_seen, 0, 'a row that does not say gets 0, which is what new code never leaves');
  } finally {
    db.close();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('only a room can be blocked: the table refuses anything else, and the same room twice', () => {
  const db = openDb(':memory:');
  try {
    const insert = (room) => db.run('INSERT INTO blocked_rooms (room, created_at) VALUES (?, ?)', room, 1);
    insert('ab'.repeat(32));
    for (const bad of ['', 'abc', 'AB'.repeat(32), 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), `${'a'.repeat(63)} `]) {
      assert.throws(() => insert(bad), /CHECK/, JSON.stringify(bad));
    }
    assert.throws(() => insert('ab'.repeat(32)), /UNIQUE|constraint/);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM blocked_rooms').n, 1);
    // the note is optional
    assert.equal(db.get('SELECT note FROM blocked_rooms').note, null);
  } finally {
    db.close();
  }
});

test('a transaction is undone as a whole when something in it fails, and they can be nested', () => {
  const db = openDb(':memory:');
  assert.throws(() =>
    db.tx(() => {
      db.run('INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)', 'a', 'A', 1);
      db.run('INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)', 'a', 'duplicate', 1);
    }),
  );
  assert.equal(db.get('SELECT COUNT(*) AS n FROM accounts').n, 0);
  const result = db.tx(() => {
    db.run('INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)', 'b', 'B', 1);
    return db.tx(() => db.get('SELECT COUNT(*) AS n FROM accounts').n);
  });
  assert.equal(result, 1);
  // values that cannot be bound are an error, not a silent null
  assert.throws(() => db.run('INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)', 'c', undefined, 1));
  db.close();
});

test('the cleanup removes sessions and codes that ran out and nothing else', () => {
  const db = openDb(':memory:');
  db.run('INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)', 'a', 'A', 1);
  for (const [hash, expires] of [['old', 100], ['edge', 200], ['new', 300]]) {
    db.run('INSERT INTO sessions (token_hash, account_id, kind, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', hash, 'a', 'web', 1, 1, expires);
    db.run('INSERT INTO codes (code_hash, purpose, account_id, data, expires_at) VALUES (?, ?, ?, ?, ?)', hash, 'app', 'a', '{}', expires);
  }
  assert.deepEqual(cleanup(db, 200), { sessions: 2, codes: 2 });
  assert.deepEqual(db.all('SELECT token_hash FROM sessions').map((r) => r.token_hash), ['new']);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM accounts').n, 1);
  db.close();
});

// ---- snapshots ----

test('snapshots are complete copies, named by time, and only the newest few are kept', () => {
  const dir = tmp();
  const db = openDb(path.join(dir, 'live.db'));
  db.run('INSERT INTO accounts (id, name, email, created_at) VALUES (?, ?, ?, ?)', 'a1', 'Ada', 'ada@example.com', 1);
  const backups = path.join(dir, 'backups');
  const hour = 3_600_000;
  const first = takeBackup(db, backups, 3, START);
  assert.equal(path.basename(first), 'friendsshare-20261005T120000Z.db');
  for (let n = 1; n <= 4; n++) takeBackup(db, backups, 3, START + n * 24 * hour);
  assert.deepEqual(listBackups(backups).map((b) => b.file), ['friendsshare-20261009T120000Z.db', 'friendsshare-20261008T120000Z.db', 'friendsshare-20261007T120000Z.db']);
  assert.deepEqual(listBackups(backups).map((b) => b.takenAt), [START + 4 * 24 * hour, START + 3 * 24 * hour, START + 2 * 24 * hour]);

  // a snapshot opens on its own and holds the data
  const copy = new DatabaseSync(path.join(backups, 'friendsshare-20261009T120000Z.db'), { readOnly: true });
  assert.deepEqual({ ...copy.prepare('SELECT id, email FROM accounts').get() }, { id: 'a1', email: 'ada@example.com' });
  copy.close();

  // what is not a snapshot is left alone, an unfinished one is removed
  fs.writeFileSync(path.join(backups, 'notes.txt'), 'x');
  fs.writeFileSync(path.join(backups, 'friendsshare-20260101T000000Z.db.partial'), 'x');
  takeBackup(db, backups, 3, START + 5 * 24 * hour);
  assert.ok(fs.existsSync(path.join(backups, 'notes.txt')));
  assert.ok(!fs.existsSync(path.join(backups, 'friendsshare-20260101T000000Z.db.partial')));
  assert.equal(listBackups(backups).length, 3);
  assert.deepEqual(listBackups(path.join(dir, 'nowhere')), []);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a snapshot is due when the newest one is older than the interval', () => {
  const dir = tmp();
  const db = openDb(':memory:');
  const backups = path.join(dir, 'backups');
  const hour = 3_600_000;
  assert.equal(backupDue(backups, 24, START), true, 'none yet');
  assert.equal(backupDue(backups, 0, START), false, 'switched off');
  takeBackup(db, backups, 7, START);
  assert.equal(backupDue(backups, 24, START + 23 * hour), false);
  assert.equal(backupDue(backups, 24, START + 24 * hour), true);
  assert.equal(backupDue(backups, 12, START + 13 * hour), true);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the server takes a snapshot at start and then every interval, keeping the newest few', async () => {
  const h = await startServer({ env: { BACKUP_INTERVAL_HOURS: '24', BACKUP_KEEP: '2' } });
  try {
    const dir = h.config.backup.dir;
    assert.equal(listBackups(dir).length, 1);
    assert.ok(h.logs.includes('[backup] snapshot written'));
    h.server.runBackup();
    assert.equal(listBackups(dir).length, 1, 'not before the interval is over');
    for (let day = 1; day <= 3; day++) {
      h.clock.advance(25 * 3_600_000);
      h.server.runBackup();
    }
    assert.equal(listBackups(dir).length, 2);
    assert.equal(listBackups(dir)[0].takenAt, START + 75 * 3_600_000);
  } finally {
    await h.close();
  }
});

test('a snapshot that fails is logged and the server carries on', async () => {
  const h = await startServer({ env: { BACKUP_INTERVAL_HOURS: '24' } });
  try {
    // the directory for snapshots is a file: nothing can be written there
    fs.rmSync(h.config.backup.dir, { recursive: true, force: true });
    fs.writeFileSync(h.config.backup.dir, 'in the way');
    h.clock.advance(25 * 3_600_000);
    h.server.runBackup();
    assert.ok(h.logs.some((line) => line.startsWith('[backup] failed')));
    assert.equal((await h.request('GET', '/healthz')).status, 200);
  } finally {
    await h.close();
  }
});

// ---- starting and stopping ----

test('without APP_SECRET a secret is created next to the database and kept', async () => {
  const dir = tmp();
  const env = { DATA_DIR: dir, BACKUP_INTERVAL_HOURS: '0' };
  const first = loadConfig({ ...env, BASE_URL: 'https://friendsshare.test' });
  const { createServer } = require('../lib/server');
  const a = createServer({ config: first, fetchFn: async () => { throw new Error('offline'); }, log: () => {} });
  const secret = fs.readFileSync(path.join(dir, 'secret.key'), 'utf8');
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.equal(first.appSecret, secret);
  await a.close();
  const second = loadConfig({ ...env, BASE_URL: 'https://friendsshare.test' });
  const b = createServer({ config: second, fetchFn: async () => { throw new Error('offline'); }, log: () => {} });
  assert.equal(second.appSecret, secret, 'the same secret again');
  await b.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('closing the server says goodbye to the apps and can be done twice', () =>
  withServer({}, async (h) => {
    const { connectApp } = require('./helpers');
    const app = await connectApp(h);
    const closing = h.server.close();
    assert.equal((await app.closed).code, 1001);
    await closing;
    await h.server.close();
    await sleep(10);
  }));

test('after a hello rejected as outdated, a hello for the same socket is not accepted later', () =>
  withServer({}, async (h) => {
    const { connectApp } = require('./helpers');
    const app = await connectApp(h, { hello: { version: '0.9.0' } });
    assert.equal(app.reply.code, 'outdated');
    app.send({ t: 'hello', proto: 2, version: '1.2.0', hash: 'dev', proof: '', token: null });
    await app.closed;
    assert.deepEqual(app.queue, []);
  }));

test('billing configuration reaches the welcome and /api/me the same way', () =>
  withServer({ env: BILLING_ENV }, async (h) => {
    const { connectApp } = require('./helpers');
    const app = await connectApp(h);
    const me = (await h.request('GET', '/api/me')).json;
    assert.equal(app.reply.billing, true);
    assert.equal(me.billing, true);
    assert.equal(app.reply.limit, me.free_limit);
    assert.deepEqual(app.reply.prices, me.prices);
  }));
