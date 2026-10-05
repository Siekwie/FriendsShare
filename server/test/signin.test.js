// How a person gets signed in and out, hardened: the link from the app (which needs a yes from the
// person), what the app's token may do, signing out everywhere, where a sign-in may lead, which
// addresses may join accounts, what a picture may be, the cookie names, and how sign-in requests
// are counted. Providers are fakes; nothing leaves this machine.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CSP } = require('../lib/site');
const { withServer, connectApp, signIn, appHandover, appLogin, makePro, dumpDatabase, rawRequest, BASE, SESSION, STATE, LOGIN_ENV, BILLING_ENV } = require('./helpers');

const LOGIN = { env: LOGIN_ENV };
const HOUR = 3_600_000;
const ada = { id: 1, name: 'Ada Lovelace', email: 'ada@example.com' };
const find = (res, name) => res.cookies.find((c) => c.startsWith(`${name}=`));
const bearerOf = (token) => ({ authorization: `Bearer ${token}` });

// the app asks for a link to open in the browser
async function weblink(h, token) {
  const res = await h.request('POST', '/api/app/weblink', { headers: bearerOf(token), origin: null });
  assert.equal(res.status, 200);
  const url = new URL(res.json.url);
  return { res, url: res.json.url, path: url.pathname + url.search, code: url.searchParams.get('code') };
}
const links = (h) => h.db.get("SELECT COUNT(*) AS n FROM codes WHERE purpose = 'weblink'").n;
// the form of the confirmation page, posted the way a browser posts it
const confirm = (b, values, options = {}) =>
  b.request('POST', '/auth/link', { body: new URLSearchParams(values).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', ...(options.headers || {}) }, ...options });
const field = (html, name) => (new RegExp(`name="${name}" value="([^"]*)"`).exec(html) || [])[1];

// ---- the link from the app ----

test('opening a link from the app shows who it would sign in and changes nothing', () =>
  withServer(LOGIN, async (h) => {
    const { token } = await appLogin(h);
    const link = await weblink(h, token);
    const stranger = h.browser();
    const page = await stranger.get(link.path);
    assert.equal(page.status, 200);
    assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(page.headers['cache-control'], 'no-store', 'it carries a code');
    assert.equal(page.headers['content-security-policy'], CSP);
    assert.match(page.text, /FIXTURE LINK PAGE/);
    assert.match(page.text, /<p id="who">Ada Lovelace\|ada@example\.com<\/p>/);
    assert.equal(field(page.text, 'code'), link.code);
    assert.equal(field(page.text, 'next'), '/account');
    assert.deepEqual(page.cookies, [], 'no cookie is set');
    assert.equal((await stranger.get('/api/me')).json.account, null, 'nobody is signed in');
    assert.equal(links(h), 1, 'the code is untouched');

    // looking again, a mail scanner, a prefetcher's HEAD: still nothing used up
    for (let n = 0; n < 3; n++) assert.equal((await stranger.get(link.path)).status, 200);
    const head = await h.request('HEAD', link.path);
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
    assert.equal(links(h), 1);

    // and it still works for the person
    assert.equal((await confirm(stranger, { code: link.code, next: '/account' })).status, 303);
  }));

test('a link from somebody else\'s app does not take over a browser that is signed in: only a yes does', () =>
  withServer(LOGIN, async (h) => {
    const victim = await signIn(h, { provider: 'github', id: 1, name: 'Victim', email: 'victim@example.com' });
    const before = victim.b.cookie(SESSION);
    const mallory = await appLogin(h, { provider: 'github', id: 2, name: 'Mallory', email: 'mallory@example.com' });
    const link = await weblink(h, mallory.token);

    // the victim's browser follows the link from another site: a navigation, an image, a script
    for (const dest of ['document', 'image', 'script', undefined]) {
      const res = await victim.b.get(link.path, { headers: { 'sec-fetch-site': 'cross-site', ...(dest ? { 'sec-fetch-dest': dest } : {}) } });
      assert.equal(res.status, 200, String(dest));
      assert.match(res.text, /Mallory\|mallory@example\.com/, 'the page says whose account this is');
      assert.deepEqual(res.cookies, []);
    }
    assert.equal(victim.b.cookie(SESSION), before);
    assert.equal((await victim.b.get('/api/me')).json.account.email, 'victim@example.com', 'still the victim');
    assert.equal(links(h), 1);

    // the person says yes: now the browser is the other account's, and the earlier session is gone
    const done = await confirm(victim.b, { code: link.code, next: '/account' });
    assert.equal(done.status, 303);
    assert.equal((await victim.b.get('/api/me')).json.account.email, 'mallory@example.com');
    assert.equal((await h.request('GET', '/api/me', { headers: { cookie: `${SESSION}=${before}` } })).json.account, null);
  }));

test('a link for the account the browser is signed in as needs no yes, and leaves the session as it is', () =>
  withServer(LOGIN, async (h) => {
    const web = await signIn(h, { provider: 'github', ...ada });
    const cookie = web.b.cookie(SESSION);
    const { token } = await appLogin(h, { provider: 'github', ...ada });
    const link = await weblink(h, token);

    // a HEAD would only have to say where it goes, and uses nothing up
    const head = await web.b.request('HEAD', link.path);
    assert.equal(head.status, 302);
    assert.equal(head.headers.location, '/account');
    assert.equal(links(h), 1);

    const res = await web.b.get(link.path);
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/account');
    assert.deepEqual(res.cookies, [], 'the session is not replaced');
    assert.equal(web.b.cookie(SESSION), cookie);
    assert.equal((await web.b.get('/api/me')).json.account.email, 'ada@example.com');
    assert.equal(links(h), 0, 'used up');
    assert.equal((await web.b.get(link.path)).headers.location, '/login?error=link');

    // where it goes is the same safe next as everywhere
    const go = async (next) => {
      const fresh = await weblink(h, token);
      const url = new URL(fresh.url);
      url.searchParams.set('next', next);
      return (await web.b.get(url.pathname + url.search)).headers.location;
    };
    assert.equal(await go('/privacy'), '/privacy');
    assert.equal(await go('//evil.example'), '/account');
    assert.equal(await go('/café'), '/account');
  }));

test('a link that is unknown, expired, used up or not a link at all goes to the sign-in page with link', () =>
  withServer(LOGIN, async (h) => {
    const { token } = await appLogin(h);
    const link = await weblink(h, token);
    const b = h.browser();
    for (const target of ['/auth/link', '/auth/link?code=', '/auth/link?code=nope', `/auth/link?code=${'a'.repeat(43)}`, `/auth/link?code=${'a'.repeat(300)}`, '/auth/link?code[]=x']) {
      for (const method of ['GET', 'HEAD']) {
        const res = await b.request(method, target);
        assert.equal(res.status, 302, `${method} ${target}`);
        assert.equal(res.headers.location, '/login?error=link');
      }
    }
    // expired
    h.clock.advance(61_000);
    assert.equal((await b.get(link.path)).headers.location, '/login?error=link');
    assert.equal((await confirm(b, { code: link.code, next: '/account' })).headers.location, '/login?error=link');
  }));

test('confirming a link signs the browser in once and answers with 303', () =>
  withServer(LOGIN, async (h) => {
    const { token } = await appLogin(h);
    const link = await weblink(h, token);
    const b = h.browser();
    const done = await confirm(b, { code: link.code, next: '/privacy' });
    assert.equal(done.status, 303);
    assert.equal(done.headers.location, '/privacy');
    const session = find(done, SESSION);
    for (const part of ['; HttpOnly', '; SameSite=Lax', '; Path=/;', '; Max-Age=5184000', '; Secure']) assert.ok(`${session};`.includes(part), part);
    assert.equal((await b.get('/api/me')).json.account.email, 'ada@example.com');
    assert.equal(links(h), 0);
    // single use
    const again = await confirm(h.browser(), { code: link.code, next: '/account' });
    assert.equal(again.status, 303);
    assert.equal(again.headers.location, '/login?error=link');
    assert.equal(find(again, SESSION), undefined);
  }));

test('confirming a link only goes where a sign-in may go', () =>
  withServer(LOGIN, async (h) => {
    const { token } = await appLogin(h);
    const where = async (next) => {
      const link = await weblink(h, token);
      return (await confirm(h.browser(), { code: link.code, ...(next === undefined ? {} : { next }) })).headers.location;
    };
    assert.equal(await where(undefined), '/account');
    assert.equal(await where('/login?x=1'), '/login?x=1');
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', '/café☕', '/a b', '/a\tb', '']) assert.equal(await where(bad), '/account', JSON.stringify(bad));
  }));

test('a link is confirmed from this site only, as a form, and not with the app\'s token', () =>
  withServer(LOGIN, async (h) => {
    const { token } = await appLogin(h);
    const link = await weblink(h, token);
    const b = h.browser();
    // another site posting the form: refused, and nothing is used up
    for (const options of [{ origin: 'https://evil.example' }, { origin: 'null' }, { origin: null, headers: { 'sec-fetch-site': 'cross-site' } }]) {
      const res = await confirm(b, { code: link.code, next: '/account' }, options);
      assert.equal(res.status, 403, JSON.stringify(options));
      assert.equal(res.json.error, 'forbidden');
    }
    // not a form: nothing is read, nothing is used up
    const json = await b.request('POST', '/auth/link', { json: { code: link.code } });
    assert.equal(json.status, 303);
    assert.equal(json.headers.location, '/login?error=link');
    const plain = await b.request('POST', '/auth/link', { body: `code=${link.code}`, headers: { 'content-type': 'text/plain' } });
    assert.equal(plain.headers.location, '/login?error=link');
    // the app's token is not a browser
    const bearer = await confirm(b, { code: link.code, next: '/account' }, { headers: bearerOf(token) });
    assert.equal(bearer.status, 403);
    assert.equal(links(h), 1, 'still there');
    assert.equal(find(await b.get('/api/me'), SESSION), undefined);
    assert.equal((await confirm(b, { code: link.code, next: '/account' })).status, 303);
  }));

test('what the confirmation page shows is escaped, and the form carries the code and the next', () =>
  withServer(LOGIN, async (h) => {
    const evil = '"><script>alert(1)</script>';
    const { token } = await appLogin(h, { id: 7, name: evil, email: 'mallory@example.com' });
    const link = await weblink(h, token);
    const url = new URL(link.url);
    url.searchParams.set('next', '/a"b<c>&d');
    const page = await h.browser().get(url.pathname + url.search);
    assert.equal(page.status, 200);
    assert.ok(!page.text.includes('<script>alert'), 'no markup from a name');
    assert.ok(page.text.includes('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;|mallory@example.com'));
    assert.ok(page.text.includes('name="next" value="/a&quot;b&lt;c&gt;&amp;d"'));
    assert.ok(page.text.includes(`name="code" value="${link.code}"`));
  }));

test('without a link.html of its own the server shows a plain form, and it works', () =>
  withServer(LOGIN, async (h) => {
    fs.rmSync(path.join(h.config.siteDir, 'link.html'));
    const { token } = await appLogin(h);
    const link = await weblink(h, token);
    const page = await h.browser().get(link.path);
    assert.equal(page.status, 200);
    assert.match(page.text, /<form method="post" action="\/auth\/link">/);
    assert.match(page.text, /Ada Lovelace \(ada@example\.com\)/);
    assert.equal(field(page.text, 'code'), link.code);
    assert.equal(field(page.text, 'next'), '/account');
    assert.ok(!/<script|style=|\son[a-z]+=/i.test(page.text), 'nothing the policy would block');
    assert.equal(page.headers['content-security-policy'], CSP);
  }));

test('/link and /link.html are not pages of the site, whatever the case', () =>
  withServer(LOGIN, async (h) => {
    for (const urlPath of ['/link', '/link.html', '/LINK.HTML', '/Link.html', '/link.HTML', '/link.html.', '/link.html%20', '/link.html::$DATA', '/%6Cink.html']) {
      let res;
      try {
        res = await rawRequest(h.port, 'GET', urlPath, {});
      } catch {
        continue;
      }
      assert.equal(res.status, 404, urlPath);
      assert.ok(!res.text.includes('FIXTURE LINK PAGE'), urlPath);
    }
  }));

test('an account has one live link at a time and may ask for 20 an hour', () =>
  withServer(LOGIN, async (h) => {
    const { token } = await appLogin(h);
    const first = await weblink(h, token);
    const second = await weblink(h, token);
    assert.equal(links(h), 1, 'the older one that was never used is gone');
    assert.equal((await h.browser().get(first.path)).headers.location, '/login?error=link');
    assert.equal((await h.browser().get(second.path)).status, 200);

    // somebody else's link is not touched
    const bob = await appLogin(h, { id: 2, name: 'Bob', email: 'bob@example.com' });
    const bobsLink = await weblink(h, bob.token);
    await weblink(h, token);
    assert.equal(links(h), 2);
    assert.equal((await h.browser().get(bobsLink.path)).status, 200);

    // 3 asked so far; 17 more are fine
    for (let n = 4; n <= 20; n++) assert.equal((await h.request('POST', '/api/app/weblink', { headers: bearerOf(token), origin: null })).status, 200, `link ${n}`);
    const refused = await h.request('POST', '/api/app/weblink', { headers: bearerOf(token), origin: null });
    assert.equal(refused.status, 429);
    assert.equal(refused.json.error, 'rate_limited');
    assert.match(refused.json.message, /^[A-Z].*\.$/);
    assert.equal(refused.headers['retry-after'], '3600');
    assert.equal((await h.request('POST', '/api/app/weblink', { headers: bearerOf(bob.token), origin: null })).status, 200, 'another account is not affected');
    h.clock.advance(HOUR + 1000);
    assert.equal((await h.request('POST', '/api/app/weblink', { headers: bearerOf(token), origin: null })).status, 200);
  }));

// ---- what the app's token may do ----

test('the app\'s token is good for /api/me, the web link and logout, and for nothing else', () =>
  withServer({ env: BILLING_ENV }, async (h) => {
    const { token } = await appLogin(h);
    const bearer = bearerOf(token);
    assert.equal((await h.request('GET', '/api/me', { headers: bearer })).json.account.email, 'ada@example.com');
    assert.equal((await h.request('POST', '/api/app/weblink', { headers: bearer, origin: null })).status, 200);
    assert.equal((await h.request('GET', '/healthz', { headers: bearer })).status, 200);
    const code = (await weblink(h, token)).code;

    const exchange = await appHandover(h);
    const refused = [
      ['POST', '/api/billing/checkout', { interval: 'month' }],
      ['POST', '/api/billing/portal', {}],
      ['POST', '/api/billing/webhook', {}],
      ['POST', '/api/account/delete', undefined],
      ['POST', '/auth/app/continue', { app_port: 52000, app_state: exchange.state, app_challenge: exchange.challenge }],
      ['POST', '/auth/link', undefined],
      ['GET', `/auth/link?code=${code}`, undefined],
      ['GET', '/auth/github', undefined],
      ['GET', '/auth/github/callback?code=x&state=y', undefined],
      ['POST', '/api/app/session', { code: exchange.code, verifier: exchange.verifier }],
      ['GET', '/internal/stats', undefined],
    ];
    for (const [method, urlPath, json] of refused) {
      const res = await h.request(method, urlPath, { headers: bearer, json, origin: null });
      assert.equal(res.status, 403, `${method} ${urlPath}`);
      assert.equal(res.json.error, 'forbidden');
      assert.match(res.json.message, /^[A-Z].*\.$/);
    }
    // none of it did anything
    assert.equal(links(h), 1, 'the link was not used');
    assert.equal(h.net.calling((c) => c.host === 'api.stripe.com').length, 0);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts').n, 1, 'no account was touched');
    assert.equal((await h.request('POST', '/api/app/session', { json: { code: exchange.code, verifier: exchange.verifier }, origin: null })).status, 200, 'the code was not used');
    // a Bearer header that is not even a token is just as unwelcome
    assert.equal((await h.request('POST', '/api/billing/checkout', { headers: { authorization: 'Bearer nonsense' }, json: { interval: 'month' }, origin: null })).status, 403);
    // other schemes are not Bearer
    assert.equal((await h.request('POST', '/api/billing/checkout', { headers: { authorization: 'Basic abc' }, json: { interval: 'month' }, origin: null })).status, 401);
  }));

test('the pages and files of the site do not mind an Authorization header', () =>
  withServer(LOGIN, async (h) => {
    assert.equal((await h.request('GET', '/', { headers: { authorization: 'Bearer whatever' } })).status, 200);
    assert.equal((await h.request('GET', '/site.css', { headers: { authorization: 'Bearer whatever' } })).status, 200);
  }));

// ---- signing out everywhere ----

test('logging out everywhere ends every session of the account: browsers, app tokens and links', () =>
  withServer({ env: BILLING_ENV }, async (h) => {
    const one = await signIn(h, { provider: 'github', ...ada });
    const two = await signIn(h, { provider: 'google', id: 'g-1', email: 'ada@example.com' });
    const app1 = await appLogin(h, { provider: 'github', ...ada });
    const app2 = await appLogin(h, { provider: 'github', ...ada });
    const bob = await signIn(h, { provider: 'github', id: 2, name: 'Bob', email: 'bob@example.com' });
    const bobApp = await appLogin(h, { provider: 'github', id: 2, name: 'Bob', email: 'bob@example.com' });
    makePro(h, h.accountId('ada@example.com'));
    const socket = await connectApp(h, { hello: { token: app1.token } });
    assert.equal(socket.reply.plan, 'pro');
    const pending = await weblink(h, app2.token);
    const adaSessions = () => h.db.get('SELECT COUNT(*) AS n FROM sessions WHERE account_id = ?', h.accountId('ada@example.com')).n;
    assert.equal(adaSessions(), 6, 'two browsers, and two app logins that signed their browsers in as well');

    const res = await one.b.post('/api/logout', { everywhere: true });
    assert.equal(res.status, 204);
    assert.ok(find(res, SESSION).includes('Max-Age=0'), 'this browser forgets its cookie');
    assert.equal(adaSessions(), 0);
    for (const b of [one.b, two.b]) assert.equal((await b.get('/api/me')).json.account, null);
    for (const t of [app1.token, app2.token]) assert.equal((await h.request('GET', '/api/me', { headers: bearerOf(t) })).json.account, null);
    assert.equal(links(h), 0, 'a link that was not used yet is gone too');
    assert.equal((await h.browser().get(pending.path)).headers.location, '/login?error=link');
    // a connection that was working with a token is back on the free plan
    assert.deepEqual(await socket.next('plan'), { t: 'plan', plan: 'free', limit: 5 });
    assert.equal((await connectApp(h, { hello: { token: app1.token } })).reply.signed_out, true);
    // the account itself is still there, and somebody else's sessions are untouched
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts WHERE email = ?', 'ada@example.com').n, 1);
    assert.equal((await bob.b.get('/api/me')).json.account.email, 'bob@example.com');
    assert.equal((await h.request('GET', '/api/me', { headers: bearerOf(bobApp.token) })).json.account.email, 'bob@example.com');
    // and she can sign in again
    assert.equal((await (await signIn(h, { provider: 'github', ...ada })).b.get('/api/me')).json.account.email, 'ada@example.com');
  }));

test('without everywhere, logging out ends only the session that made the call', () =>
  withServer(LOGIN, async (h) => {
    const one = await signIn(h, { provider: 'github', ...ada });
    const two = await signIn(h, { provider: 'github', ...ada });
    const app = await appLogin(h, { provider: 'github', ...ada });
    for (const body of [undefined, {}, { everywhere: false }, { everywhere: 'true' }, { everywhere: 1 }, { other: true }]) {
      const fresh = await signIn(h, { provider: 'github', ...ada });
      assert.equal((await fresh.b.post('/api/logout', body)).status, 204, JSON.stringify(body));
      assert.equal((await fresh.b.get('/api/me')).json.account, null);
    }
    for (const b of [one.b, two.b]) assert.ok((await b.get('/api/me')).json.account, 'the others are still signed in');
    assert.ok((await h.request('GET', '/api/me', { headers: bearerOf(app.token) })).json.account);
  }));

test('only a browser can sign out everywhere; the app\'s token and other sites cannot', () =>
  withServer(LOGIN, async (h) => {
    const web = await signIn(h, { provider: 'github', ...ada });
    const app = await appLogin(h, { provider: 'github', ...ada });
    const refused = await h.request('POST', '/api/logout', { headers: bearerOf(app.token), json: { everywhere: true }, origin: null });
    assert.equal(refused.status, 403);
    assert.equal(refused.json.error, 'forbidden');
    assert.match(refused.json.message, /^[A-Z].*\.$/);
    const foreign = await web.b.post('/api/logout', { everywhere: true }, { origin: 'https://evil.example' });
    assert.equal(foreign.status, 403);
    for (const check of [(await web.b.get('/api/me')).json.account, (await h.request('GET', '/api/me', { headers: bearerOf(app.token) })).json.account]) assert.ok(check, 'nothing was ended');
    // not signed in: nothing to end, and nothing wrong with asking
    assert.equal((await h.browser().post('/api/logout', { everywhere: true })).status, 204);
    // not JSON
    assert.equal((await web.b.request('POST', '/api/logout', { body: 'everywhere=true', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 400);
    assert.ok((await web.b.get('/api/me')).json.account);
  }));

// ---- where a sign-in may lead ----

test('a next with anything but printable ASCII is not followed, and a sign-in with one still works', () =>
  withServer(LOGIN, async (h) => {
    // the reviewer's case: the session used to be created and then the answer was a 500
    const odd = await signIn(h, { provider: 'github', ...ada, query: `?next=${encodeURIComponent('/café☕')}` });
    assert.equal(odd.done.status, 302);
    assert.equal(odd.done.headers.location, '/account');
    assert.equal((await odd.b.get('/api/me')).json.account.email, 'ada@example.com');
    assert.deepEqual(h.logs.filter((line) => line.startsWith('[http]')), []);

    const after = async (next) => (await signIn(h, { provider: 'github', ...ada, query: `?next=${encodeURIComponent(next)}` })).done.headers.location;
    for (const ok of ['/privacy', '/account?billing=success', '/a/b-c_d.e~f%C3%A9?x=1&y=%E2%98%95#top', '/' + 'a'.repeat(511), '/!"#$%&\'()*+,-./:;<=>?@[]^_`{|}~']) assert.equal(await after(ok), ok, ok.slice(0, 30));
    const bad = ['/' + 'a'.repeat(512), '/a b', '/a\tb', '/a\nb', '/a\u0000b', '/a\u007fb', '/a b', '/é', '/☕', '/Ā', '/😀', '/ ', '/‮', '/a\\b', '\\/evil', 'https://evil.example', '//evil.example', '/\\evil.example', '/ /evil.example'];
    for (const next of bad) assert.equal(await after(next), '/account', JSON.stringify(next).slice(0, 30));
  }));

// ---- which addresses may join accounts ----

test('an address that only looks like another is not that address: no account is joined', () =>
  withServer(LOGIN, async (h) => {
    const plain = await signIn(h, { provider: 'github', id: 10, name: 'Kev', email: 'kevin@example.com' });
    const kelvin = 'Kevin@example.com'; // KELVIN SIGN, which toLowerCase() turns into "k"
    const impostor = await signIn(h, { provider: 'google', id: 'g-kelvin', name: 'Other', email: kelvin });
    assert.equal(impostor.done.headers.location, '/account', 'a verified address still signs in');
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts').n, 2, 'but to an account of its own');
    assert.notEqual(
      h.db.get("SELECT account_id FROM identities WHERE provider = 'google'").account_id,
      h.db.get("SELECT account_id FROM identities WHERE provider = 'github'").account_id,
    );
    assert.equal((await impostor.b.get('/api/me')).json.account.email, kelvin, 'kept as it came, only A to Z lowercased');
    assert.equal((await plain.b.get('/api/me')).json.account.providers.join(), 'github', 'the real kevin did not gain a login');

    // other look-alikes
    for (const [email, n] of [['k̇evin@example.com', 1], ['kevin@example.com​', 2], ['kevin@еxample.com', 3], ['ｋevin@example.com', 4]]) {
      await signIn(h, { provider: 'google', id: `g-${n}`, name: 'X', email });
    }
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts').n, 6);
    assert.equal((await plain.b.get('/api/me')).json.account.providers.join(), 'github');
  }));

test('an address that is not plain ASCII works for its own account and never joins another', () =>
  withServer(LOGIN, async (h) => {
    const address = 'jürgen@example.com';
    const github = await signIn(h, { provider: 'github', id: 1, name: 'Juergen', email: address });
    const again = await signIn(h, { provider: 'github', id: 1, name: 'Juergen', email: address });
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts').n, 1, 'the same login is the same account');
    assert.equal((await again.b.get('/api/me')).json.account.email, address);
    // the same address on the other provider: not joined, however verified
    const google = await signIn(h, { provider: 'google', id: 'g-1', name: 'Juergen', email: address });
    assert.equal(google.done.headers.location, '/account');
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts').n, 2);
    assert.equal((await google.b.get('/api/me')).json.account.providers.join(), 'google');
    assert.equal((await github.b.get('/api/me')).json.account.providers.join(), 'github');
    // linking on purpose still works
    const linked = await signIn(h, { provider: 'google', id: 'g-2', name: 'J', email: address, query: '?link=1', browser: github.b });
    assert.equal(linked.done.headers.location, '/account');
    assert.equal((await github.b.get('/api/me')).json.account.providers.join(), 'github,google');
  }));

test('plain addresses still join by their letters, in any case', () =>
  withServer(LOGIN, async (h) => {
    await signIn(h, { provider: 'github', id: 1, email: 'Ada.Lovelace+tag@Example.COM' });
    const g = await signIn(h, { provider: 'google', id: 'g-1', email: 'ada.lovelace+tag@example.com' });
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts').n, 1);
    assert.equal((await g.b.get('/api/me')).json.account.providers.join(), 'github,google');
  }));

// ---- pictures ----

test('a picture is kept only when it is one of the providers\' own', () =>
  withServer(LOGIN, async (h) => {
    const avatarOf = async (avatar_url, n) => {
      const { b } = await signIn(h, {
        provider: 'github',
        userinfo: { id: 100 + n, login: `u${n}`, name: `U${n}`, avatar_url, emails: [{ email: `u${n}@example.com`, primary: true, verified: true }] },
      });
      return (await b.get('/api/me')).json.account.avatar;
    };
    const kept = ['https://avatars.githubusercontent.com/u/1?v=4', 'https://lh3.googleusercontent.com/a/abc', 'https://a.b.googleusercontent.com/x.png'];
    for (const [n, url] of kept.entries()) assert.equal(await avatarOf(url, n), url, url);
    const dropped = [
      'http://avatars.githubusercontent.com/u/1', 'https://evil.example/u/1.png', 'https://evil.example/avatars.githubusercontent.com/u/1',
      'https://avatars.githubusercontent.com@evil.example/u/1', 'https://user:pw@avatars.githubusercontent.com/u/1', 'https://avatars.githubusercontent.com.evil.example/u/1',
      'https://avatars.githubusercontent.com:8443/u/1', 'https://evilgoogleusercontent.com/x', 'https://googleusercontent.com/x', 'https://xgoogleusercontent.com/x',
      'https://lh3.googleusercontent.com.evil.example/x', '//avatars.githubusercontent.com/u/1', 'avatars.githubusercontent.com/u/1', 'javascript:alert(1)',
      'data:image/png;base64,AAAA', 'ftp://avatars.githubusercontent.com/u/1', 'https://avatars.githubusercontent.com/' + 'a'.repeat(500), '', null, 42, { href: 'x' },
    ];
    for (const [n, url] of dropped.entries()) assert.equal(await avatarOf(url, 10 + n), null, String(url).slice(0, 40));
  }));

// ---- the names of the cookies ----

test('over https the cookies carry the __Host- prefix, Path=/, Secure and no Domain, and only those are read', () =>
  withServer(LOGIN, async (h) => {
    assert.deepEqual(h.config.cookies, { session: '__Host-fs_session', state: '__Host-fs_oauth_state', statePath: '/' });
    const b = h.browser();
    const start = await b.get('/auth/github');
    const state = find(start, '__Host-fs_oauth_state');
    for (const part of ['; HttpOnly', '; SameSite=Lax', '; Path=/;', '; Max-Age=600', '; Secure']) assert.ok(`${state};`.includes(part), part);
    assert.ok(!/domain=/i.test(state));
    assert.equal(find(start, 'fs_oauth_state'), undefined, 'the plain name is not used');

    const signedIn = await signIn(h, { provider: 'github', ...ada, browser: b });
    const session = find(signedIn.done, '__Host-fs_session');
    for (const part of ['; HttpOnly', '; SameSite=Lax', '; Path=/;', '; Max-Age=5184000', '; Secure']) assert.ok(`${session};`.includes(part), part);
    assert.ok(!/domain=/i.test(session));
    assert.equal(find(signedIn.done, 'fs_session'), undefined);
    assert.ok(find(signedIn.done, '__Host-fs_oauth_state').includes('Max-Age=0'), 'the state is used up, under its own name');

    // a cookie of the plain name, such as a sibling subdomain could plant, is not a session
    const token = b.cookie('__Host-fs_session');
    const planted = await h.request('GET', '/api/me', { headers: { cookie: `fs_session=${token}` } });
    assert.equal(planted.json.account, null);
    assert.equal((await h.request('GET', '/api/me', { headers: { cookie: `__Host-fs_session=${token}` } })).json.account.email, 'ada@example.com');
    // nor is it a sign-in state: the callback finds no state of its own
    const other = h.browser();
    const startedElsewhere = await other.get('/auth/github');
    const realState = new URL(startedElsewhere.headers.location).searchParams.get('state');
    h.net.github.users.c = { id: 5, login: 'x', name: 'X', avatar_url: null, emails: [{ email: 'x@example.com', primary: true, verified: true }] };
    const forged = await h.request('GET', `/auth/github/callback?code=c&state=${realState}`, { headers: { cookie: `fs_oauth_state=${realState}` } });
    assert.equal(forged.headers.location, '/login?error=state');

    // logging out clears the cookie under the name and path it was set with
    const out = await b.post('/api/logout');
    const cleared = find(out, '__Host-fs_session');
    for (const part of ['; Path=/;', '; Max-Age=0', '; Secure', '; HttpOnly']) assert.ok(`${cleared};`.includes(part), part);
  }));

test('over plain http (development) the cookies keep their plain names, and only those are read', () =>
  withServer({ env: { ...LOGIN_ENV, BASE_URL: 'http://localhost:8080' } }, async (h) => {
    assert.deepEqual(h.config.cookies, { session: 'fs_session', state: 'fs_oauth_state', statePath: '/auth' });
    const origin = 'http://localhost:8080';
    const b = h.browser();
    const start = await b.get('/auth/github');
    const state = find(start, 'fs_oauth_state');
    for (const part of ['; HttpOnly', '; SameSite=Lax', '; Path=/auth;', '; Max-Age=600']) assert.ok(`${state};`.includes(part), part);
    assert.ok(!state.includes('Secure'));
    assert.equal(find(start, '__Host-fs_oauth_state'), undefined);

    const signedIn = await signIn(h, { provider: 'github', ...ada, browser: b });
    const session = find(signedIn.done, 'fs_session');
    for (const part of ['; HttpOnly', '; SameSite=Lax', '; Path=/;', '; Max-Age=5184000']) assert.ok(`${session};`.includes(part), part);
    assert.ok(!session.includes('Secure'));
    assert.equal(find(signedIn.done, '__Host-fs_session'), undefined);
    assert.equal((await b.get('/api/me')).json.account.email, 'ada@example.com');

    const token = b.cookie('fs_session');
    assert.equal((await h.request('GET', '/api/me', { headers: { cookie: `__Host-fs_session=${token}` } })).json.account, null, 'the https name is not read here');
    assert.equal((await h.request('GET', '/api/me', { headers: { cookie: `fs_session=${token}` } })).json.account.email, 'ada@example.com');
    const out = await b.post('/api/logout', undefined, { origin });
    assert.ok(find(out, 'fs_session').includes('Max-Age=0'));
  }));
