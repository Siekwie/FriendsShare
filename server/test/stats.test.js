// The anonymous daily totals: what is counted, what is not, that nothing about a visitor reaches
// the database, and the report the admin interface shows.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withServer, signIn, signWebhook, subscription, connectApp, until, START, BILLING_ENV, LOGIN_ENV } = require('./helpers');
const { openDb } = require('../lib/db');
const { bump, tally, Today, isBot, systemOf, referrerHost, recordRequest, trafficReport } = require('../lib/stats');
const { liveCounts } = require('../lib/admin-data');

const DAY = 86_400_000;
const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

// "kind:name" -> count, for all days together
const totals = (db) => {
  const out = {};
  for (const row of db.all('SELECT kind, name, SUM(count) AS n FROM stats_daily GROUP BY kind, name')) out[`${row.kind}:${row.name}`] = row.n;
  return out;
};

function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'friendsshare-stats-'));
  const db = openDb(path.join(dir, 'test.db'));
  try {
    return fn(db);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const hit = (over = {}) => ({ nowMs: START, method: 'GET', path: '/', status: 200, address: '203.0.113.7', userAgent: FIREFOX, referrer: undefined, ownHost: 'friendsshare.test', ...over });

// ---- the pieces ----

test('crawlers, previews and scripts are told apart from people, and a system is read from the browser', () => {
  for (const ua of ['', GOOGLEBOT, 'curl/8.5.0', 'Wget/1.21', 'node', 'python-requests/2.32', 'facebookexternalhit/1.1', 'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/140.0', 'UptimeRobot/2.0']) {
    assert.equal(isBot(ua), true, ua);
  }
  for (const ua of [FIREFOX, SAFARI]) assert.equal(isBot(ua), false, ua);
  assert.equal(systemOf(FIREFOX), 'Windows');
  assert.equal(systemOf(SAFARI), 'macOS');
  assert.equal(systemOf('Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/140.0 Mobile'), 'Android');
  assert.equal(systemOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1'), 'iOS');
  assert.equal(systemOf('Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0'), 'Linux');
  assert.equal(systemOf('Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) Chrome/140.0'), 'ChromeOS');
  assert.equal(systemOf('SomethingElse/1.0'), 'Other');
});

test('of the site a visitor came from only the host name is kept, and never our own', () => {
  assert.equal(referrerHost('https://github.com/Siekwie/FriendsShare?tab=readme#download', 'friendsshare.test'), 'github.com');
  assert.equal(referrerHost('https://WWW.Example.com/a/b', 'friendsshare.test'), 'example.com');
  assert.equal(referrerHost('https://friendsshare.test/privacy', 'friendsshare.test'), null);
  assert.equal(referrerHost('https://www.friendsshare.test/', 'friendsshare.test'), null);
  for (const bad of [undefined, '', 'not a url', 'about:blank', `https://${'a'.repeat(200)}.example/`, `https://example.com/${'x'.repeat(3000)}`, ['https://a.example/']]) {
    assert.equal(referrerHost(bad, 'friendsshare.test'), null, String(bad).slice(0, 40));
  }
});

test('a visitor counts once a day, and at midnight everything about the day is forgotten', () => {
  const today = new Today();
  assert.equal(today.first(START, '203.0.113.7', FIREFOX), true);
  assert.equal(today.first(START + 3_600_000, '203.0.113.7', FIREFOX), false);
  assert.equal(today.first(START, '203.0.113.7', SAFARI), true, 'another browser at the same address');
  assert.equal(today.first(START, '203.0.113.8', FIREFOX), true, 'another address');
  const salt = Buffer.from(today.salt);
  assert.equal(today.seen.size, 3);
  // what is remembered is a salted hash, not an address
  for (const id of today.seen) assert.match(id, /^[\w-]{16}$/);
  assert.ok(![...today.seen].some((id) => id.includes('203')));

  assert.equal(today.first(START + DAY, '203.0.113.7', FIREFOX), true, 'the next day');
  assert.equal(today.seen.size, 1);
  assert.notDeepEqual(today.salt, salt, 'a new salt every day: yesterday and today cannot be matched');
});

test('there is a limit to how many visitors and referring sites a day can hold in memory and in the table', () => {
  const today = new Today({ maxVisitors: 3, maxReferrers: 2 });
  for (let i = 0; i < 3; i++) assert.equal(today.first(START, `203.0.113.${i}`, FIREFOX), true);
  assert.equal(today.first(START, '203.0.113.99', FIREFOX), false);
  assert.equal(today.seen.size, 3);

  assert.equal(today.referrer(START, 'a.example'), 'a.example');
  assert.equal(today.referrer(START, 'b.example'), 'b.example');
  assert.equal(today.referrer(START, 'c.example'), '(other sites)');
  assert.equal(today.referrer(START, 'a.example'), 'a.example', 'one that is known keeps its name');
  assert.equal(today.referrer(START + DAY, 'c.example'), 'c.example', 'a new day');
});

test('a request is counted for what it is: a page, a download, a checkout, or nothing', () =>
  withDb((db) => {
    const today = new Today();
    recordRequest(db, today, hit({ referrer: 'https://github.com/Siekwie/FriendsShare' }));
    assert.deepEqual(totals(db), { 'view:/': 1, 'visitor:': 1, 'system:Windows': 1, 'referrer:github.com': 1 });
    // the same person again: a view, not a visitor
    recordRequest(db, today, hit({ path: '/privacy', referrer: 'https://friendsshare.test/' }));
    assert.deepEqual(totals(db), { 'view:/': 1, 'view:/privacy': 1, 'visitor:': 1, 'system:Windows': 1, 'referrer:github.com': 1 });
    // back from signing in at GitHub: a view, and GitHub is not where this visitor heard of us
    recordRequest(db, today, hit({ path: '/account', referrer: 'https://github.com/' }));
    assert.equal(totals(db)['view:/account'], 1);
    assert.equal(totals(db)['referrer:github.com'], 1);

    recordRequest(db, today, hit({ path: '/download', status: 302 }));
    recordRequest(db, today, hit({ method: 'POST', path: '/api/billing/checkout' }));
    assert.equal(totals(db)['download:windows'], 1);
    assert.equal(totals(db)['checkout:started'], 1);

    const before = totals(db);
    for (const nothing of [
      hit({ userAgent: GOOGLEBOT }),
      hit({ userAgent: '' }),
      hit({ userAgent: GOOGLEBOT, path: '/download', status: 302 }),
      hit({ status: 404, path: '/nothing' }),
      hit({ status: 500 }),
      hit({ path: '/site.css' }),
      hit({ path: '/api/me' }),
      hit({ path: '/index.html' }),
      hit({ method: 'HEAD' }),
      hit({ method: 'HEAD', path: '/download', status: 302 }),
      hit({ path: '/download', status: 200 }),
      hit({ method: 'POST', path: '/api/billing/checkout', status: 401 }),
      hit({ method: 'POST', path: '/api/billing/checkout', status: 502 }),
      hit({ method: 'POST', path: '/' }),
      hit({ method: 'POST', path: '/api/billing/portal' }),
    ]) {
      recordRequest(db, today, nothing);
    }
    assert.deepEqual(totals(db), before);

    // nothing in the table says who it was
    const dump = JSON.stringify(db.all('SELECT * FROM stats_daily'));
    assert.ok(!dump.includes('203.0.113') && !dump.includes('Firefox') && !dump.includes('Siekwie'), dump);
    assert.deepEqual([...new Set(db.all('SELECT day FROM stats_daily').map((r) => r.day))], ['2026-10-05']);
  }));

test('counting in passing never fails what it is part of', () =>
  withDb((db) => {
    const logs = [];
    tally({ db, now: () => START, log: (line) => logs.push(line) }, 'subscription', 'live');
    assert.deepEqual(totals(db), { 'subscription:live': 1 });
    const broken = { run() { throw new Error('disk full'); } };
    assert.doesNotThrow(() => tally({ db: broken, now: () => START, log: (line) => logs.push(line) }, 'subscription', 'live'));
    assert.deepEqual(logs, ['[stats] could not count a subscription: disk full']);
    // a long name is cut, not refused
    bump(db, START, 'referrer', 'x'.repeat(500));
    assert.equal(db.get("SELECT length(name) AS n FROM stats_daily WHERE kind = 'referrer'").n, 120);
  }));

// ---- the report ----

test('the report has every one of the last 30 days, sums for today, a week, a month and ever, and the top lists', () =>
  withDb((db) => {
    const add = (daysAgo, kind, name, times) => {
      for (let i = 0; i < times; i++) bump(db, START - daysAgo * DAY, kind, name);
    };
    add(0, 'visitor', '', 3);
    add(0, 'view', '/', 4);
    add(0, 'view', '/privacy', 1);
    add(0, 'download', 'windows', 2);
    add(0, 'checkout', 'started', 1);
    add(0, 'subscription', 'live', 1);
    add(0, 'subscription', 'test', 5);
    add(3, 'visitor', '', 10);
    add(3, 'view', '/', 12);
    add(3, 'referrer', 'github.com', 6);
    add(3, 'referrer', 'reddit.com', 2);
    add(3, 'system', 'Windows', 9);
    add(3, 'system', 'Linux', 1);
    add(29, 'visitor', '', 1);
    add(40, 'visitor', '', 100);
    add(40, 'download', 'windows', 7);
    add(40, 'subscription', 'live', 2);
    add(40, 'referrer', 'old.example', 50);
    const account = (id, daysAgo) => db.run('INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)', id, id, START - daysAgo * DAY);
    account('a1', 0);
    account('a2', 3);
    account('a3', 3);
    account('a4', 40);

    const r = trafficReport(db, START);
    assert.equal(r.days.length, 30);
    assert.equal(r.days[29].day, '2026-10-05');
    assert.equal(r.days[0].day, '2026-09-06');
    assert.deepEqual(r.days[29], { day: '2026-10-05', visitors: 3, views: 5, downloads: 2, signups: 1, checkouts: 1, bought: 1 });
    assert.deepEqual(r.days[26], { day: '2026-10-02', visitors: 10, views: 12, downloads: 0, signups: 2, checkouts: 0, bought: 0 });
    assert.deepEqual(r.days[28], { day: '2026-10-04', visitors: 0, views: 0, downloads: 0, signups: 0, checkouts: 0, bought: 0 });
    assert.deepEqual(r.today, { visitors: 3, views: 5, downloads: 2, signups: 1, checkouts: 1, bought: 1 });
    assert.deepEqual(r.week, { visitors: 13, views: 17, downloads: 2, signups: 3, checkouts: 1, bought: 1 });
    assert.deepEqual(r.month, { visitors: 14, views: 17, downloads: 2, signups: 3, checkouts: 1, bought: 1 });
    // what was bought with a test card is in neither sum
    assert.deepEqual(r.allTime, { visitors: 114, views: 17, downloads: 9, signups: 4, checkouts: 1, bought: 3 });
    assert.deepEqual(r.pages, [{ name: '/', count: 16 }, { name: '/privacy', count: 1 }]);
    assert.deepEqual(r.referrers, [{ name: 'github.com', count: 6 }, { name: 'reddit.com', count: 2 }]);
    assert.deepEqual(r.systems, [{ name: 'Windows', count: 9 }, { name: 'Linux', count: 1 }]);

    const empty = withDb((fresh) => trafficReport(fresh, START));
    assert.deepEqual(empty.month, { visitors: 0, views: 0, downloads: 0, signups: 0, checkouts: 0, bought: 0 });
    assert.deepEqual(empty.allTime, empty.month);
    assert.deepEqual([empty.pages, empty.referrers, empty.systems], [[], [], []]);
  }));

// ---- in the running server ----

const as = (userAgent, extra = {}) => ({ headers: { 'user-agent': userAgent, ...extra } });

test('the server counts page views, visitors and where they came from, and leaves crawlers and everything else out', () =>
  withServer({}, async (h) => {
    assert.equal((await h.request('GET', '/', as(FIREFOX, { referer: 'https://github.com/Siekwie/FriendsShare' }))).status, 200);
    await until(() => totals(h.db)['visitor:'] === 1);
    assert.deepEqual(totals(h.db), { 'view:/': 1, 'visitor:': 1, 'system:Windows': 1, 'referrer:github.com': 1 });

    // not counted: a crawler, a request without a browser's name, a file, a page that is not there, a HEAD
    await h.request('GET', '/', as(GOOGLEBOT));
    await h.request('GET', '/');
    await h.request('GET', '/site.css', as(FIREFOX));
    await h.request('GET', '/nothing-here', as(FIREFOX));
    await h.request('HEAD', '/', as(FIREFOX));
    await h.request('GET', '/api/me', as(FIREFOX));
    // counted: the same visitor on another page, and somebody else
    await h.request('GET', '/login', as(FIREFOX, { referer: 'https://accounts.google.com/' }));
    await h.request('GET', '/', as(SAFARI));
    await until(() => totals(h.db)['visitor:'] === 2);
    assert.deepEqual(totals(h.db), { 'view:/': 2, 'view:/login': 1, 'visitor:': 2, 'system:Windows': 1, 'system:macOS': 1, 'referrer:github.com': 1 });

    // nothing in the table says who it was
    const dump = JSON.stringify(h.db.all('SELECT * FROM stats_daily'));
    assert.ok(!dump.includes('127.0.0.1') && !dump.includes('Firefox'), dump);
    assert.ok(!h.logs.some((line) => line.startsWith('[stats]')), h.logs.join('\n'));
  }));

test('behind the proxy, visitors are told apart by the address the proxy reports', () =>
  withServer({ env: { TRUST_PROXY: '1' } }, async (h) => {
    await h.request('GET', '/', as(FIREFOX, { 'x-forwarded-for': '198.51.100.1' }));
    await h.request('GET', '/', as(FIREFOX, { 'x-forwarded-for': '198.51.100.2' }));
    await h.request('GET', '/', as(FIREFOX, { 'x-forwarded-for': '198.51.100.1' }));
    await until(() => totals(h.db)['view:/'] === 3);
    assert.equal(totals(h.db)['visitor:'], 2);
  }));

test('the download button goes to the release on GitHub, and the click is counted', () =>
  withServer({ env: { RELEASE_REPO: 'someone/else' } }, async (h) => {
    const res = await h.request('GET', '/download', as(FIREFOX));
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, 'https://github.com/someone/else/releases/latest/download/FriendsShare.exe');
    assert.equal(res.headers['cache-control'], 'no-store');
    await until(() => totals(h.db)['download:windows'] === 1);

    // a crawler following the link is sent on as well, and not counted; neither is a HEAD
    assert.equal((await h.request('GET', '/download', as(GOOGLEBOT))).status, 302);
    assert.equal((await h.request('HEAD', '/download', as(FIREFOX))).status, 302);
    assert.equal((await h.request('POST', '/download', as(FIREFOX))).status, 404);
    await h.request('GET', '/download', as(SAFARI));
    await until(() => totals(h.db)['download:windows'] === 2);
    assert.deepEqual(totals(h.db), { 'download:windows': 2 });
  }));

test('the real start page sends its download buttons through /download', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'site', 'index.html'), 'utf8');
  assert.equal((page.match(/href="\/download"/g) || []).length, 2);
  assert.doesNotMatch(page, /download_url/);
});

test('a checkout that is started is counted, one that is refused is not', () =>
  withServer({ env: BILLING_ENV }, async (h) => {
    const { b } = await signIn(h);
    assert.equal((await b.post('/api/billing/checkout', { interval: 'bogus' }, as(FIREFOX))).status, 400);
    assert.equal((await h.request('POST', '/api/billing/checkout', { json: { interval: 'month' }, ...as(FIREFOX) })).status, 401);
    assert.equal((await b.post('/api/billing/checkout', { interval: 'month' }, as(FIREFOX))).status, 200);
    await until(() => totals(h.db)['checkout:started'] === 1);
    h.net.stripe.fail['POST /checkout/sessions'] = { status: 500 };
    assert.equal((await b.post('/api/billing/checkout', { interval: 'year' }, as(FIREFOX))).status, 502);
    delete h.net.stripe.fail['POST /checkout/sessions'];
    assert.equal((await b.post('/api/billing/checkout', { interval: 'year' }, as(FIREFOX))).status, 200);
    await until(() => totals(h.db)['checkout:started'] === 2);
    assert.equal(totals(h.db)['checkout:started'], 2);
  }));

// a signed event, delivered the way Stripe delivers it
function webhook(h, event) {
  const { body, headers } = signWebhook(h.config, event, { t: Math.floor(h.clock.t / 1000) });
  return h.request('POST', '/api/billing/webhook', { body, headers, origin: null });
}
const checkoutEvent = (accountId, session = {}) => ({
  id: 'evt_checkout',
  type: 'checkout.session.completed',
  data: { object: { id: 'cs_live_1', object: 'checkout.session', mode: 'subscription', payment_status: 'paid', client_reference_id: `fs_${accountId}`, metadata: { app: 'friendsshare' }, customer: 'cus_1', subscription: 'sub_1', ...session } },
});
const stripeHas = (h, accountId, over = {}) => {
  const sub = subscription({ price: 'price_monthly_fs', accountId, periodEnd: Math.floor(h.clock.t / 1000) + 30 * 86400, ...over });
  h.net.stripe.subscriptions[sub.id] = sub;
  return sub;
};

test('a subscription is counted once, when an account takes it, whichever event arrives first and however often', () =>
  withServer({ env: BILLING_ENV }, async (h) => {
    await signIn(h);
    const ada = h.accountId('ada@example.com');
    const sub = stripeHas(h, ada);
    // the checkout first, then the subscription's own events, then everything again
    assert.equal((await webhook(h, checkoutEvent(ada))).status, 200);
    assert.deepEqual(totals(h.db), { 'subscription:live': 1 });
    for (const type of ['customer.subscription.created', 'customer.subscription.updated']) assert.equal((await webhook(h, { id: `evt_${type}`, type, data: { object: sub } })).status, 200);
    assert.equal((await webhook(h, checkoutEvent(ada))).status, 200);
    assert.deepEqual(totals(h.db), { 'subscription:live': 1 });

    // for somebody else the subscription's event comes before the checkout's
    await signIn(h, { id: 2, name: 'Bea', email: 'bea@example.com' });
    const bea = h.accountId('bea@example.com');
    const second = stripeHas(h, bea, { id: 'sub_2', customer: 'cus_2' });
    assert.equal((await webhook(h, { id: 'evt_created', type: 'customer.subscription.created', data: { object: second } })).status, 200);
    assert.deepEqual(totals(h.db), { 'subscription:live': 2 });
    assert.equal((await webhook(h, checkoutEvent(bea, { id: 'cs_live_2', customer: 'cus_2', subscription: 'sub_2' }))).status, 200);
    assert.deepEqual(totals(h.db), { 'subscription:live': 2 });

    // its end is not another one
    second.status = 'canceled';
    assert.equal((await webhook(h, { id: 'evt_deleted', type: 'customer.subscription.deleted', data: { object: second } })).status, 200);
    assert.deepEqual(totals(h.db), { 'subscription:live': 2 });
    assert.equal(h.db.get('SELECT sub_status FROM accounts WHERE id = ?', bea).sub_status, 'canceled');
  }));

test('what was bought with a Stripe test card is counted apart', () =>
  withServer({ env: BILLING_ENV }, async (h) => {
    await signIn(h);
    const ada = h.accountId('ada@example.com');
    stripeHas(h, ada);
    assert.equal((await webhook(h, checkoutEvent(ada, { id: 'cs_test_1', livemode: false }))).status, 200);
    assert.deepEqual(totals(h.db), { 'subscription:test': 1 });
    assert.equal(trafficReport(h.db, h.clock.t).allTime.bought, 0);
  }));

test('a checkout that cannot be attached to an account is not a subscription bought', () =>
  withServer({ env: BILLING_ENV }, async (h) => {
    stripeHas(h, '0123456789abcdef');
    assert.equal((await webhook(h, checkoutEvent('0123456789abcdef'))).status, 200);
    assert.deepEqual(totals(h.db), {});
  }));

// ---- the counts of right now ----

test('the server leaves the counts of right now in the database at its start and then again and again', () =>
  withServer({ env: LOGIN_ENV, tune: (config) => (config.tuning.liveIntervalMs = 40) }, async (h) => {
    const first = liveCounts(h.db);
    assert.deepEqual(first, { at: START, startedAt: START, connections: 0, byVersion: {}, byPlan: { free: 0, pro: 0 }, hostedRooms: 0, waiting: 0, rejected: { outdated: 0, unofficial: 0 } });

    const app = await connectApp(h);
    assert.equal(app.reply.t, 'welcome');
    h.clock.advance(60_000);
    await until(() => liveCounts(h.db).connections === 1 && liveCounts(h.db).at === START + 60_000);
    const live = liveCounts(h.db);
    assert.deepEqual({ ...live }, { at: START + 60_000, startedAt: START, connections: 1, byVersion: { '1.2.0': 1 }, byPlan: { free: 1, pro: 0 }, hostedRooms: 0, waiting: 0, rejected: { outdated: 0, unofficial: 0 } });
    // exactly what the operator's own endpoint says, and no more
    const stats = (await h.request('GET', '/internal/stats', { origin: null })).json;
    assert.equal(stats.connections, live.connections);
    assert.deepEqual(stats.by_version, live.byVersion);
    await h.disconnect(app);
  }));

test('counts that cannot be read are no counts, not an error', () =>
  withDb((db) => {
    assert.equal(liveCounts(db), null);
    const set = (value) => db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'live', value);
    for (const bad of ['', 'not json', 'null', '[]', '{"connections":3}', '{"at":"yesterday"}']) {
      set(bad);
      assert.equal(liveCounts(db), null, bad);
    }
    set(JSON.stringify({ at: 5, connections: 'many', by_version: { '1.2.0': 2, odd: 'x' }, by_plan: null, rejected: { outdated: 4 } }));
    assert.deepEqual(liveCounts(db), { at: 5, startedAt: 0, connections: 0, byVersion: { '1.2.0': 2, odd: 0 }, byPlan: { free: 0, pro: 0 }, hostedRooms: 0, waiting: 0, rejected: { outdated: 4, unofficial: 0 } });
  }));
