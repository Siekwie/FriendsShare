// The operator's admin interface: who it answers, that it changes nothing, and what its pages
// show. It runs next to a real server here, on the same database, the way the two containers do.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { withServer, signIn, appLogin, connectApp, makePro, rawRequest, dumpDatabase, sha256, until, START, LOGIN_ENV, BILLING_ENV } = require('./helpers');
const { createAdminServer, isLocalHost } = require('../lib/admin-web');
const { accountStats, searchAccounts, accountDetail } = require('../lib/admin-data');
const { relative } = require('../lib/admin-pages');
const { planOf, PRO_SQL, GRACE_MS } = require('../lib/plan');
const { bump } = require('../lib/stats');

const DAY = 86_400_000;

// the server of the helpers, with the admin interface next to it
function withAdmin(options, fn) {
  return withServer(options, async (h) => {
    const logs = [];
    const server = createAdminServer({ config: h.config, db: h.db, now: () => h.clock.t, log: (line) => logs.push(line) });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const admin = { port, logs, get: (urlPath, headers) => rawRequest(port, 'GET', urlPath, headers), request: (method, urlPath, headers, body) => rawRequest(port, method, urlPath, headers, body) };
    try {
      await fn(h, admin);
    } finally {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    }
  });
}

const people = [
  { id: 1, name: 'Ada Lovelace', email: 'ada@example.com' },
  { id: 2, name: 'Bea 100% <b>Bold</b>', email: 'bea_b@example.com' },
  { id: 3, name: 'Cy', email: 'cy@example.org', provider: 'google' },
];

// three accounts made a day apart, the first of them Pro
async function populate(h) {
  for (const person of people) {
    await signIn(h, person);
    h.clock.advance(DAY);
  }
  const ids = Object.fromEntries(people.map((p) => [p.name.split(' ')[0], h.accountId(p.email)]));
  makePro(h, ids.Ada);
  return ids;
}

const tile = (page, label) => new RegExp(`<span class="tile-label">${label}</span><span class="tile-value">([^<]*)</span><span class="tile-sub">([^<]*)</span>`).exec(page);

// ---- who it answers ----

test('the pages carry strict headers, and nothing in them is inline', () =>
  withAdmin({ env: LOGIN_ENV }, async (h, admin) => {
    await populate(h);
    for (const urlPath of ['/', '/accounts', '/traffic', `/accounts/${h.accountId('ada@example.com')}`, '/no-such-page']) {
      const res = await admin.get(urlPath);
      assert.equal(res.status, urlPath === '/no-such-page' ? 404 : 200, urlPath);
      const csp = res.headers['content-security-policy'];
      assert.match(csp, /default-src 'none'/, urlPath);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.doesNotMatch(csp, /unsafe-inline|https:|\*/);
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.equal(res.headers['x-frame-options'], 'DENY');
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      assert.equal(res.headers['referrer-policy'], 'same-origin');
      assert.match(res.headers['x-robots-tag'], /noindex/);
      assert.match(res.text, / – FriendsShare admin<\/title>/);
      assert.doesNotMatch(res.text, /<script>|<script [^>]*>[^<]|<style/, 'no inline scripts or styles');
      assert.doesNotMatch(res.text, / style="| on[a-z]+="/, 'no inline styles or handlers');
      // no pictures from GitHub or Google either: the page asks nobody else for anything
      assert.doesNotMatch(res.text, /(?:src|href)="https?:\/\/(?!friendsshare\.test|dashboard\.stripe\.com)/, urlPath);
    }
  }));

test('every file the pages point at is there, and is kept by the browser for as long as it does not change', () =>
  withAdmin({}, async (h, admin) => {
    const page = (await admin.get('/')).text;
    const assets = [...page.matchAll(/(?:src|href)="(\/static\/[^"]+)"/g)].map((m) => m[1].replaceAll('&amp;', '&'));
    for (const name of ['site.css', 'admin.css', 'admin.js', 'logo.svg']) assert.ok(assets.some((a) => a.startsWith(`/static/${name}?v=`)), name);
    for (const asset of new Set(assets)) {
      const res = await admin.get(asset);
      assert.equal(res.status, 200, asset);
      assert.match(res.headers['cache-control'], /immutable/, asset);
      assert.equal((await admin.get(asset, { 'if-none-match': res.headers.etag })).status, 304);
    }
    assert.match((await admin.get('/static/admin.css')).headers['cache-control'], /max-age=3600/);
    assert.match((await admin.get('/static/admin.css')).headers['content-type'], /^text\/css/);
    assert.equal((await admin.get('/static/nope.css')).status, 404);
    // only what it was given: nothing else of the website, and nothing outside it
    for (const urlPath of ['/static/index.html', '/static/js/app.js', '/static/..%2Fserver.js', '/static/%2e%2e/admin.js', '/static/']) assert.equal((await admin.get(urlPath)).status, 404, urlPath);
    const favicon = await admin.get('/favicon.ico');
    assert.equal(favicon.status, 301);
    assert.equal((await admin.get(favicon.headers.location)).status, 200);
    assert.equal((await admin.get('/healthz')).text, 'ok');
  }));

test('it only answers requests addressed to localhost', () =>
  withAdmin({ env: LOGIN_ENV }, async (h, admin) => {
    for (const ok of ['localhost', 'localhost:8792', 'LOCALHOST:1', '127.0.0.1:8792', '[::1]:8792']) assert.equal(isLocalHost(ok), true, ok);
    for (const bad of [undefined, '', 'evil.example', 'localhost.evil.example', 'evil.example:8792', '127.0.0.1.evil.example', '192.168.1.5:8792', 'friendsshare-admin:8792', 'localhost:8792@evil.example', 'friendsshare.test']) {
      assert.equal(isLocalHost(bad), false, String(bad));
    }
    await populate(h);
    // a page on another domain that resolves to 127.0.0.1 (DNS rebinding) sends its own name
    for (const urlPath of ['/', '/accounts', '/healthz', '/static/admin.css']) {
      const rebound = await admin.get(urlPath, { host: `evil.example:${admin.port}` });
      assert.equal(rebound.status, 403, urlPath);
      assert.doesNotMatch(rebound.text, /ada@example\.com|Lovelace|<html/);
    }
    assert.equal((await admin.get('/', { host: `localhost:${admin.port}` })).status, 200);
  }));

test('it changes nothing: there is no request that does anything but read', () =>
  withAdmin({ env: BILLING_ENV }, async (h, admin) => {
    const ids = await populate(h);
    h.db.run('INSERT INTO blocked_rooms (room, created_at, note) VALUES (?, ?, ?)', sha256('a code'), h.clock.t, 'report 7');
    const before = dumpDatabase(h);
    const form = 'action=delete&id=1';
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const urlPath of ['/', '/accounts', `/accounts/${ids.Ada}`, `/accounts/${ids.Ada}/delete`, '/traffic', '/blocked', '/internal/block', '/static/admin.css']) {
        const res = await admin.request(method, urlPath, { 'content-type': 'application/x-www-form-urlencoded', 'content-length': form.length }, form);
        assert.equal(res.status, 405, `${method} ${urlPath}`);
        assert.equal(res.headers.allow, 'GET, HEAD');
      }
    }
    for (const urlPath of ['/', '/accounts?q=ada', '/accounts?plan=pro', `/accounts/${ids.Ada}`, '/traffic']) await admin.get(urlPath);
    assert.equal(dumpDatabase(h), before);
    assert.deepEqual(admin.logs, []);
    // and the public server knows nothing of these pages
    for (const urlPath of ['/accounts', `/accounts/${ids.Ada}`, '/traffic', '/static/admin.css', '/admin', '/admin.js']) assert.equal((await h.request('GET', urlPath)).status, 404, urlPath);
  }));

test('a request that fails says so without its details, and the log does not repeat what was searched for', () =>
  withAdmin({ env: LOGIN_ENV }, async (h, admin) => {
    // the table is gone under the pages' feet
    h.db.raw.exec('ALTER TABLE blocked_rooms RENAME TO blocked_rooms_gone');
    const res = await admin.get('/?q=secret-name');
    assert.equal(res.status, 500);
    assert.match(res.text, /docker logs friendsshare-admin/);
    assert.doesNotMatch(res.text, /blocked_rooms|SQLITE|\n\s+at /);
    assert.equal(admin.logs.length, 1);
    assert.match(admin.logs[0], /^\[admin\] GET \/ failed: /);
    assert.doesNotMatch(admin.logs[0], /secret-name/);
    h.db.raw.exec('ALTER TABLE blocked_rooms_gone RENAME TO blocked_rooms');
    assert.equal((await admin.get('/')).status, 200);
  }));

// ---- the overview ----

test('the overview has the numbers, the newest accounts and what is set up', () =>
  withAdmin({ env: { ...BILLING_ENV, REQUIRE_OFFICIAL: '1', BUILD_SECRET: 'b'.repeat(40), OPERATOR_NAME: 'Ada', OPERATOR_ADDRESS: 'Main Street 1' } }, async (h, admin) => {
    const ids = await populate(h);
    await appLogin(h, { id: 1, email: 'ada@example.com' });
    h.db.run('UPDATE accounts SET sub_cancel_at_period_end = 1 WHERE id = ?', ids.Ada);
    h.db.run("INSERT INTO meta (key, value) VALUES ('latest_version', '1.2.1') ON CONFLICT(key) DO UPDATE SET value = excluded.value");

    const page = (await admin.get('/')).text;
    assert.match(page, /<title>Overview – FriendsShare admin<\/title>/);
    assert.deepEqual(tile(page, 'Accounts').slice(1), ['3', '1 Pro · 2 free']);
    assert.deepEqual(tile(page, 'Pro subscriptions').slice(1), ['1', '1 monthly · 0 yearly · 1 ending']);
    assert.deepEqual(tile(page, 'New in 7 days').slice(1), ['3', '3 in 30 days']);
    assert.deepEqual(tile(page, 'Signed-in apps').slice(1), ['1', '1 used in 30 days · 1 account']);
    // newest first, each a link to its page, and what a stranger called themselves is text, not markup
    const order = ['Cy', 'Bea', 'Ada'].map((name) => page.indexOf(`<a class="row-link" href="/accounts/${ids[name]}">`));
    assert.ok(order.every((at) => at > 0) && order[0] < order[1] && order[1] < order[2], String(order));
    assert.ok(page.includes('Bea 100% &lt;b&gt;Bold&lt;/b&gt;'));
    assert.ok(!page.includes('<b>Bold</b>'));
    assert.match(page, /<span class="pill pill-ok">Pro<\/span> <span class="pill pill-plain">ending<\/span>/);

    assert.match(page, /<a href="https:\/\/friendsshare\.test\/" target="_blank" rel="noreferrer">friendsshare\.test<\/a>/);
    assert.match(page, /GitHub and Google/);
    assert.match(page, /On, Stripe test mode, €1\.99 a month or €11\.88 a year shown/);
    assert.match(page, /FriendsShare&#39;s own settings/);
    assert.match(page, /5 folders at a time/);
    assert.match(page, /Official builds only, from version 1\.2\.0/);
    assert.match(page, /<dt>Newest release<\/dt><dd><span class="state state-ok">.*?<\/span><span>1\.2\.1<\/span>/);
    assert.match(page, /Imprint, privacy and terms/);
    assert.match(page, /Off: BACKUP_INTERVAL_HOURS is 0/);
    assert.match(page, /class="test-banner"/);
    // secrets are settings too, and none of them is on the page
    for (const secret of [h.config.stripe.secretKey, h.config.stripe.webhookSecret, h.config.appSecret, h.config.buildSecret, h.config.github.clientSecret, h.config.google.clientSecret]) {
      assert.ok(secret && !page.includes(secret));
    }
    assert.doesNotMatch(page, /Blocked share codes<\/h2>/);
  }));

test('the overview says what is missing in the setup', () =>
  withAdmin({ env: { STRIPE_SECRET_KEY: 'sk_live_x', BACKUP_INTERVAL_HOURS: '24' } }, async (h, admin) => {
    // the newest release is asked for at the start, and the answer is there a moment later
    await until(() => h.db.get("SELECT 1 AS known FROM meta WHERE key = 'latest_version'"));
    const page = (await admin.get('/')).text;
    assert.deepEqual(tile(page, 'Accounts').slice(1), ['0', '0 Pro · 0 free']);
    assert.match(page, /No accounts yet\./);
    assert.match(page, /Off: neither GitHub nor Google is set up/);
    assert.match(page, /Off: STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_MONTHLY, STRIPE_PRICE_YEARLY are not set/);
    assert.doesNotMatch(page, /Customer portal|test-banner/);
    assert.match(page, /No folder limit/);
    assert.match(page, /Any build, official or not, from version 1\.2\.0/);
    assert.match(page, /<dt>Newest release<\/dt><dd><span class="state state-ok">.*?<\/span><span>1\.2\.0<\/span>/);
    assert.match(page, /Off: OPERATOR_NAME and OPERATOR_ADDRESS are not both set/);
    // the server wrote its first snapshot when it started
    assert.match(page, /Newest <time [^>]*>just now<\/time>, 1 snapshot kept/);
    assert.equal((page.match(/state-todo/g) || []).length, 4, 'sign-in, Pro, builds, legal pages');
  }));

test('the overview shows who is connected as the server last counted it, and says when that is too long ago', () =>
  withAdmin({ env: LOGIN_ENV }, async (h, admin) => {
    const app = await connectApp(h);
    const other = await connectApp(h, { hello: { version: '1.3.0' } });
    const room = sha256('a code');
    app.send({ t: 'host', room, key: 'k', exp: h.clock.t + DAY });
    await app.next('hosted');
    h.db.run('INSERT INTO blocked_rooms (room, created_at, note) VALUES (?, ?, ?)', sha256('bad code'), h.clock.t - DAY, 'report <7>');
    h.server.writeLive();
    h.clock.advance(30_000);

    let page = (await admin.get('/')).text;
    assert.match(page, /<dt>Apps connected<\/dt><dd><strong>2<\/strong> <span class="muted">0 Pro · 2 free<\/span>/);
    assert.match(page, /<dt>App versions<\/dt><dd>1\.3\.0 × 1, 1\.2\.0 × 1<\/dd>/);
    assert.match(page, /<dt>Folders online<\/dt><dd>1 /);
    assert.match(page, /<dt>Share codes<\/dt><dd>1 /);
    assert.match(page, /<dt>Blocked codes<\/dt><dd>1<\/dd>/);
    assert.match(page, /Counted by the server <time [^>]*>just now<\/time>/);
    assert.doesNotMatch(page, /It may be down/);
    // the block list: a piece of the fingerprint, and the note as text
    assert.match(page, /Blocked share codes<\/h2>/);
    assert.ok(page.includes(`<code title="${sha256('bad code')}">${sha256('bad code').slice(0, 12)}…</code>`));
    assert.ok(page.includes('report &lt;7&gt;'));

    h.clock.advance(10 * 60_000);
    page = (await admin.get('/')).text;
    assert.match(page, /The server last reported <time [^>]*>10 minutes ago<\/time>\. It may be down/);
    assert.doesNotMatch(page, /Counted by the server/);

    h.db.run("DELETE FROM meta WHERE key = 'live'");
    page = (await admin.get('/')).text;
    assert.match(page, /The server has not left its counts yet/);
    await h.disconnect(app);
    await h.disconnect(other);
  }));

// ---- accounts ----

test('the list finds accounts by name, address, id and Stripe id, and filters by plan', () =>
  withAdmin({ env: BILLING_ENV }, async (h, admin) => {
    const ids = await populate(h);
    const names = (page) => [...page.matchAll(/<a class="row-link" href="\/accounts\/([0-9a-f]{16})">/g)].map((m) => Object.keys(ids).find((name) => ids[name] === m[1]));

    let res = await admin.get('/accounts');
    assert.equal(res.status, 200);
    assert.deepEqual(names(res.text), ['Cy', 'Bea', 'Ada']);
    assert.match(res.text, /3 accounts/);
    assert.match(res.text, /<td>Google<\/td>/);
    assert.deepEqual(names((await admin.get('/accounts?plan=pro')).text), ['Ada']);
    assert.deepEqual(names((await admin.get('/accounts?plan=free')).text), ['Cy', 'Bea']);
    assert.deepEqual(names((await admin.get('/accounts?plan=bogus')).text), ['Cy', 'Bea', 'Ada']);

    // part of an address, in any case; several hits stay a list
    res = await admin.get('/accounts?q=EXAMPLE.com');
    assert.deepEqual(names(res.text), ['Bea', 'Ada']);
    assert.match(res.text, /Accounts matching <q>EXAMPLE\.com<\/q>/);
    assert.match(res.text, /name="q" value="EXAMPLE\.com"/);
    assert.deepEqual(names((await admin.get('/accounts?q=example.com&plan=free')).text), ['Bea']);

    // exactly one hit goes straight to the account
    for (const [query, name] of [['lovelace', 'Ada'], ['cy@', 'Cy'], [ids.Bea, 'Bea'], ['sub_1', 'Ada'], ['cus_1', 'Ada']]) {
      res = await admin.get(`/accounts?q=${encodeURIComponent(query)}`);
      assert.equal(res.status, 302, query);
      assert.equal(res.headers.location, `/accounts/${ids[name]}`, query);
    }
    // an address the account is signed in to with, even when it is not the account's own
    h.db.run("UPDATE identities SET email = 'countess@example.net' WHERE account_id = ?", ids.Ada);
    assert.equal((await admin.get('/accounts?q=countess')).headers.location, `/accounts/${ids.Ada}`);

    // % and _ are characters like any other, not wildcards
    assert.deepEqual(names((await admin.get('/accounts?q=%25')).text), []);
    assert.equal((await admin.get('/accounts?q=100%25')).headers.location, `/accounts/${ids.Bea}`);
    assert.equal((await admin.get('/accounts?q=bea_b')).headers.location, `/accounts/${ids.Bea}`);
    assert.deepEqual(names((await admin.get('/accounts?q=a_a')).text), []);

    res = await admin.get('/accounts?q=nobody');
    assert.equal(res.status, 200);
    assert.match(res.text, /Nothing found\./);
    assert.match(res.text, /0 accounts/);
    // what was typed comes back as text
    res = await admin.get(`/accounts?q=${encodeURIComponent('"><script>alert(1)</script>')}`);
    assert.ok(!res.text.includes('<script>alert'));
    assert.ok(res.text.includes('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;'));
    // SQL in the search box is searched for, not run
    res = await admin.get(`/accounts?q=${encodeURIComponent("' OR 1=1 --")}`);
    assert.deepEqual(names(res.text), []);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts').n, 3);
  }));

test('a long list comes in pages, newest first', () =>
  withAdmin({ env: LOGIN_ENV }, async (h, admin) => {
    h.db.tx(() => {
      for (let i = 0; i < 120; i++) {
        h.db.run('INSERT INTO accounts (id, name, email, created_at) VALUES (?, ?, ?, ?)', i.toString(16).padStart(16, '0'), `Person ${i}`, `p${i}@example.com`, START + i * 1000);
      }
    });
    const rows = (page) => [...page.matchAll(/class="row-link"[^>]*>Person (\d+)</g)].map((m) => Number(m[1]));
    let res = await admin.get('/accounts');
    assert.deepEqual(rows(res.text), Array.from({ length: 50 }, (_, i) => 119 - i));
    assert.match(res.text, /120 accounts · page 1 of 3/);
    assert.match(res.text, /href="\/accounts\?page=2" rel="next">Older</);
    assert.doesNotMatch(res.text, /rel="prev"/);
    res = await admin.get('/accounts?page=3&q=person');
    assert.deepEqual(rows(res.text), Array.from({ length: 20 }, (_, i) => 19 - i));
    assert.match(res.text, /href="\/accounts\?q=person&amp;page=2" rel="prev">Newer</);
    assert.doesNotMatch(res.text, /rel="next"/);
    for (const odd of ['0', '-4', 'abc', '99999999999999999999']) assert.equal((await admin.get(`/accounts?page=${odd}`)).status, 200, odd);
    assert.deepEqual(rows((await admin.get('/accounts?page=9')).text), []);
  }));

test('the page of an account shows what is stored about it, and never a token or its hash', () =>
  withAdmin({ env: BILLING_ENV }, async (h, admin) => {
    const ids = await populate(h);
    const { token } = await appLogin(h, { id: 1, email: 'ada@example.com' });
    h.db.run("UPDATE accounts SET sub_interval = 'year', checkout_session_id = 'cs_test_9' WHERE id = ?", ids.Ada);
    const periodEnd = h.db.get('SELECT sub_period_end AS t FROM accounts WHERE id = ?', ids.Ada).t;

    let res = await admin.get(`/accounts/${ids.Ada}`);
    assert.equal(res.status, 200);
    let page = res.text;
    assert.match(page, /<title>Ada Lovelace – FriendsShare admin<\/title>/);
    assert.match(page, /<h1>Ada Lovelace<\/h1><span class="pill pill-ok">Pro<\/span>/);
    assert.match(page, /<a class="wrap-any" href="mailto:ada@example\.com">ada@example\.com<\/a>/);
    assert.ok(page.includes(`<code>${ids.Ada}</code>`));
    assert.match(page, /<dt>Stripe says<\/dt><dd>active<\/dd>/);
    assert.match(page, /<dt>Billing<\/dt><dd>Yearly<\/dd>/);
    assert.ok(page.includes(`<dt>Renews</dt><dd>${new Date(periodEnd).toISOString().slice(0, 16).replace('T', ' ')} UTC`));
    // the key is a test key, so the links go to Stripe's test data
    assert.match(page, /href="https:\/\/dashboard\.stripe\.com\/test\/customers\/cus_1" target="_blank" rel="noreferrer">cus_1 /);
    assert.match(page, /href="https:\/\/dashboard\.stripe\.com\/test\/subscriptions\/sub_1"/);
    assert.match(page, /cs_test_9/);
    assert.match(page, /<td>GitHub<\/td>\s*<td class="wrap-any">ada@example\.com<\/td>\s*<td><code>1<\/code><\/td>/);
    // a browser (from signing in) and the app
    assert.match(page, /Signed in <span class="muted">3<\/span>/);
    assert.match(page, /The app on a PC/);
    assert.match(page, /A browser/);
    const hashes = h.db.all('SELECT token_hash FROM sessions').map((s) => s.token_hash);
    assert.ok(hashes.length >= 3);
    for (const secret of [token, ...hashes]) assert.ok(!page.includes(secret));

    // somebody who never paid, with a name that would like to be markup
    page = (await admin.get(`/accounts/${ids.Bea}`)).text;
    assert.match(page, /<h1>Bea 100% &lt;b&gt;Bold&lt;\/b&gt;<\/h1><span class="pill pill-plain">Free<\/span>/);
    assert.match(page, /None\. This account has never started a checkout\./);
    assert.doesNotMatch(page, /dashboard\.stripe\.com/);
    assert.match(page, /<td>GitHub<\/td>/);

    // a subscription that is over, and one that is in its days of grace
    h.db.run("UPDATE accounts SET sub_status = 'canceled' WHERE id = ?", ids.Ada);
    page = (await admin.get(`/accounts/${ids.Ada}`)).text;
    assert.match(page, /<h1>Ada Lovelace<\/h1><span class="pill pill-plain">Free<\/span>/);
    assert.match(page, /<dt>Stripe says<\/dt><dd>canceled<\/dd>/);
    assert.match(page, /<dt>Paid until<\/dt>/);
    h.db.run("UPDATE accounts SET sub_status = 'past_due', sub_period_end = ? WHERE id = ?", h.clock.t - DAY, ids.Ada);
    page = (await admin.get(`/accounts/${ids.Ada}`)).text;
    assert.match(page, /<span class="pill pill-ok">Pro<\/span> <span class="pill pill-warn">payment overdue<\/span>/);
    assert.match(page, /The paid period is over\. The account stays Pro for 3 days after it/);

    for (const urlPath of ['/accounts/0000000000000000', '/accounts/nobody', `/accounts/${ids.Ada.toUpperCase()}x`, `/accounts/${ids.Ada}/`, '/accounts/']) {
      assert.equal((await admin.get(urlPath)).status, 404, urlPath);
    }
  }));

test('with a live key the links go to the live Stripe dashboard, and there is no banner', () =>
  withAdmin({ env: { ...BILLING_ENV, STRIPE_SECRET_KEY: 'rk_live_fakeKeyForTests' } }, async (h, admin) => {
    const ids = await populate(h);
    const page = (await admin.get(`/accounts/${ids.Ada}`)).text;
    assert.match(page, /href="https:\/\/dashboard\.stripe\.com\/customers\/cus_1"/);
    assert.doesNotMatch(page, /test-banner|dashboard\.stripe\.com\/test\//);
    assert.match((await admin.get('/')).text, /On, Stripe live mode/);
  }));

// ---- what the pages read ----

test('counting Pro accounts in the database agrees with the plan the server gives each of them', () =>
  withServer({}, async (h) => {
    const now = h.clock.t;
    const statuses = [null, 'active', 'trialing', 'past_due', 'canceled', 'incomplete', 'incomplete_expired', 'unpaid'];
    const ends = [null, 0, now - GRACE_MS - 1, now - GRACE_MS, now - GRACE_MS + 1, now - 1, now, now + DAY];
    let n = 0;
    for (const subscription of [null, 'sub_x']) {
      for (const status of statuses) {
        for (const end of ends) {
          h.db.run(
            'INSERT INTO accounts (id, name, created_at, stripe_subscription_id, sub_status, sub_period_end) VALUES (?, ?, ?, ?, ?, ?)',
            (n++).toString(16).padStart(16, '0'), 'x', now, subscription, status, end,
          );
        }
      }
    }
    const all = h.db.all('SELECT * FROM accounts');
    assert.equal(all.length, 2 * statuses.length * ends.length);
    const expected = all.filter((a) => planOf(a, now) === 'pro').map((a) => a.id).sort();
    assert.ok(expected.length > 0 && expected.length < all.length);
    assert.deepEqual(h.db.all(`SELECT id FROM accounts WHERE ${PRO_SQL} ORDER BY id`, now).map((a) => a.id), expected);
    assert.equal(h.db.all(`SELECT id FROM accounts WHERE NOT ${PRO_SQL}`, now).length, all.length - expected.length, 'every account is one or the other');
    assert.equal(accountStats(h.db, now).pro, expected.length);
    assert.equal(accountStats(h.db, now).free, all.length - expected.length);
    assert.equal(searchAccounts(h.db, { plan: 'pro', limit: 1000 }, now).total, expected.length);
    assert.equal(searchAccounts(h.db, { plan: 'free', limit: 1000 }, now).total, all.length - expected.length);
    assert.ok(searchAccounts(h.db, { limit: 1000 }, now).rows.every((row) => row.plan === planOf(row, now)));
  }));

test('sessions that have run out are neither counted nor shown', () =>
  withServer({ env: LOGIN_ENV }, async (h) => {
    await appLogin(h);
    const id = h.accountId('ada@example.com');
    assert.equal(accountStats(h.db, h.clock.t).apps, 1);
    assert.deepEqual(accountDetail(h.db, id, h.clock.t).sessions.map((s) => s.kind).sort(), ['app', 'web']);
    assert.deepEqual(Object.keys(accountDetail(h.db, id, h.clock.t).sessions[0]).sort(), ['created_at', 'expires_at', 'kind', 'last_used_at']);
    // 61 days on, the browser's session is over and the app's is not
    const later = h.clock.t + 61 * DAY;
    assert.deepEqual(accountDetail(h.db, id, later).sessions.map((s) => s.kind), ['app']);
    assert.deepEqual(accountStats(h.db, later), { ...accountStats(h.db, later), apps: 1, appsUsed30Days: 0, accountsWithApp: 1, last7Days: 0, last30Days: 0 });
    assert.equal(accountStats(h.db, h.clock.t + 181 * DAY).apps, 0);
    assert.equal(accountDetail(h.db, 'nobody', h.clock.t), null);
    assert.equal(accountDetail(h.db, '0123456789abcdef', h.clock.t), null);
  }));

test('times read as how long ago, or how long from now', () => {
  const now = START;
  assert.equal(relative(now, now), 'just now');
  assert.equal(relative(now - 59_000, now), 'just now');
  assert.equal(relative(now - 60_000, now), '1 minute ago');
  assert.equal(relative(now - 3 * 3_600_000, now), '3 hours ago');
  assert.equal(relative(now - 45 * DAY, now), '1 month ago');
  assert.equal(relative(now - 800 * DAY, now), '2 years ago');
  assert.equal(relative(now + 30_000, now), 'in a moment');
  assert.equal(relative(now + DAY, now), 'in 1 day');
  assert.equal(relative(now + 29 * DAY, now), 'in 29 days');
});

// ---- traffic ----

test('the traffic page shows the totals, the charts and every day as numbers', () =>
  withAdmin({ env: BILLING_ENV }, async (h, admin) => {
    const ids = await populate(h);
    const now = h.clock.t;
    const add = (daysAgo, kind, name, times) => {
      for (let i = 0; i < times; i++) bump(h.db, now - daysAgo * DAY, kind, name);
    };
    add(0, 'visitor', '', 1234);
    add(0, 'view', '/', 2000);
    add(0, 'view', '/privacy', 5);
    add(2, 'visitor', '', 6);
    add(2, 'download', 'windows', 4);
    add(1, 'checkout', 'started', 2);
    add(1, 'subscription', 'live', 1);
    add(1, 'referrer', '<img src=x>.example', 3);
    add(1, 'system', 'Windows', 9);
    add(1, 'system', 'Linux', 1);
    h.server.writeLive();

    const res = await admin.get('/traffic');
    assert.equal(res.status, 200);
    const page = res.text;
    assert.deepEqual(tile(page, 'Visitors').slice(1), ['1,240', 'today 1,234 · 7 days 1,240 · ever 1,240']);
    assert.deepEqual(tile(page, 'Page views').slice(1), ['2,005', 'today 2,005 · 7 days 2,005 · ever 2,005']);
    assert.deepEqual(tile(page, 'Downloads').slice(1), ['4', 'today 0 · 7 days 4 · ever 4']);
    assert.deepEqual(tile(page, 'New accounts').slice(1), ['3', 'today 0 · 7 days 3 · ever 3']);
    assert.deepEqual(tile(page, 'Checkouts started').slice(1), ['2', 'today 0 · 7 days 2 · ever 2']);
    assert.deepEqual(tile(page, 'Pro bought').slice(1), ['1', 'today 0 · 7 days 1 · ever 1']);

    // two charts of 30 columns each, described for those who cannot see them
    assert.equal((page.match(/<svg class="chart"/g) || []).length, 2);
    assert.equal((page.match(/class="chart-col"/g) || []).length, 60);
    assert.match(page, /aria-label="1,240 visitors in the last 30 days, the most on Oct 8 \(1,234\)"/);
    assert.match(page, /data-tip="1,234 visitors" data-tip-sub="Today, Thu, Oct 8, 2026"/);
    assert.match(page, /aria-label="4 downloads in the last 30 days, the most on Oct 6 \(4\)"/);
    // the way from a visit to Pro, as a share of the visitors
    assert.match(page, /<td>Clicked the download<\/td><td class="num">4<\/td><td class="num muted">0\.3%<\/td>/);
    assert.match(page, /<td>Bought Pro<\/td><td class="num">1<\/td><td class="num muted">0\.1%<\/td>/);
    assert.match(page, /Paying right now: 1 Pro subscription\. 0 apps connected/);
    assert.match(page, /<td class="wrap-any">Start page {2}\/<\/td><td class="num">2,000<\/td><td class="num muted">100%<\/td>/);
    assert.match(page, /<td class="wrap-any">Windows<\/td><td class="num">9<\/td><td class="num muted">90%<\/td>/);
    // a made-up referrer is text
    assert.ok(page.includes('&lt;img src=x&gt;.example'));
    assert.ok(!page.includes('<img src=x>'));
    assert.match(page, /<td class="nowrap">Thu, Oct 8, 2026<\/td><td class="num">1,234<\/td><td class="num">2,005<\/td><td class="num">0<\/td><td class="num">0<\/td><td class="num">0<\/td><td class="num">0<\/td>/);
    assert.ok(ids.Ada);
  }));

test('the traffic page of a server nobody has visited yet is all zeros and says so', () =>
  withAdmin({}, async (h, admin) => {
    const page = (await admin.get('/traffic')).text;
    assert.deepEqual(tile(page, 'Visitors').slice(1), ['0', 'today 0 · 7 days 0 · ever 0']);
    assert.match(page, /aria-label="No visitors in the last 30 days"/);
    assert.doesNotMatch(page, /class="chart-bar"|NaN|Infinity|undefined/);
    assert.match(page, /No page views yet\./);
    assert.match(page, /No visits from other sites yet\./);
    assert.match(page, /<td>Visited the site<\/td><td class="num">0<\/td><td class="num muted">–<\/td>/);
  }));

// ---- the program itself ----

test('admin.js starts on the machine itself, answers, and says that its port must stay private', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'friendsshare-admin-'));
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'admin.js')], {
    env: { ...process.env, DATA_DIR: path.join(dir, 'data'), ADMIN_PORT: '0', ADMIN_HOST: '', BASE_URL: 'https://friendsshare.test', REQUIRE_OFFICIAL: '', BUILD_SECRET: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  try {
    let out = '';
    const line = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`admin.js did not start: ${out}`)), 15_000);
      const read = (chunk) => {
        out += chunk;
        const found = /FriendsShare admin on http:\/\/([\d.]+):(\d+) \(no login: this port must stay private\)/.exec(out);
        if (found) {
          clearTimeout(timer);
          resolve(found);
        }
      };
      child.stdout.on('data', read);
      child.stderr.on('data', read);
      child.on('exit', (code) => reject(new Error(`admin.js ended with code ${code}: ${out}`)));
    });
    assert.equal(line[1], '127.0.0.1');
    const port = Number(line[2]);
    assert.equal((await rawRequest(port, 'GET', '/healthz')).text, 'ok');
    const page = await rawRequest(port, 'GET', '/');
    assert.equal(page.status, 200);
    assert.match(page.text, /<title>Overview – FriendsShare admin<\/title>/);
    // with the real files of the website and of admin-site/
    for (const name of ['site.css', 'admin.css', 'admin.js', 'logo.svg']) assert.match(page.text, new RegExp(`/static/${name.replace('.', '\\.')}\\?v=[0-9a-f]{10}`), name);
    // on the machine only: not on its other addresses
    const outside = Object.values(os.networkInterfaces()).flat().find((address) => address.family === 'IPv4' && !address.internal);
    if (outside) {
      const refused = await new Promise((resolve) => {
        const req = http.request({ host: outside.address, port, path: '/healthz', timeout: 1500 }, () => resolve(false));
        req.on('error', () => resolve(true));
        req.on('timeout', () => {
          req.destroy();
          resolve(true);
        });
        req.end();
      });
      assert.equal(refused, true, `reachable on ${outside.address}`);
    }
  } finally {
    child.removeAllListeners('exit');
    child.kill();
    await new Promise((resolve) => (child.exitCode !== null || child.signalCode ? resolve() : child.once('exit', resolve)));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
