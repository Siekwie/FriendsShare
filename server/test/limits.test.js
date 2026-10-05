// How sign-in requests are counted per address. Each kind has its own count, and only what has
// passed the cheap checks is counted at all, so that nobody can use up another person's share by
// sending them requests (an image tag on a page is enough to make a browser send one).
const test = require('node:test');
const assert = require('node:assert/strict');
const { withServer, signIn, appHandover, STATE, LOGIN_ENV } = require('./helpers');

// two of each kind per window, and everything arrives "through the proxy" from the address it names
const OPTIONS = { env: { ...LOGIN_ENV, TRUST_PROXY: '1' }, tune: (config) => (config.tuning.authRate = { max: 2, windowMs: 60_000 }) };
const at = (address, extra = {}) => ({ headers: { 'x-forwarded-for': address, ...extra } });
const stateOf = (res) => new URL(res.headers.location).searchParams.get('state');
const APP = { app_port: 52000, app_state: 'a'.repeat(22), app_challenge: 'b'.repeat(43) };

// a signed-in browser, from an address that is not the one being counted
async function member(h) {
  return (await signIn(h, { provider: 'github', id: 1, name: 'Ada', email: 'ada@example.com' })).b;
}

test('starting a sign-in is limited per address, and an image tag cannot use up anybody\'s share', () =>
  withServer(OPTIONS, async (h) => {
    // requests that say they are not a page are refused, and cost nothing
    for (const dest of ['image', 'script', 'style', 'iframe', 'frame', 'embed', 'object', 'empty', 'font', 'audio', 'video', 'worker', 'manifest', 'report', 'track', 'xslt', 'nonsense', '']) {
      for (const provider of ['github', 'google']) {
        const res = await h.request('GET', `/auth/${provider}`, at('198.51.100.1', { 'sec-fetch-dest': dest }));
        assert.equal(res.status, 400, `${provider} ${JSON.stringify(dest)}`);
        assert.equal(res.json.error, 'bad_request');
        assert.match(res.json.message, /^[A-Z].*\.$/);
        assert.ok(!res.cookies.some((c) => c.startsWith(STATE)), 'no state cookie');
      }
    }
    assert.equal(h.db.get("SELECT COUNT(*) AS n FROM codes WHERE purpose = 'oauth'").n, 0, 'nothing was started');
    // all of that cost the address nothing: two real sign-ins are allowed, the third is not
    assert.equal((await h.request('GET', '/auth/github', at('198.51.100.1', { 'sec-fetch-dest': 'document' }))).status, 302);
    assert.equal((await h.request('GET', '/auth/google', at('198.51.100.1'))).status, 302);
    const limited = await h.request('GET', '/auth/github', at('198.51.100.1', { 'sec-fetch-dest': 'document' }));
    assert.equal(limited.status, 429);
    assert.equal(limited.json.error, 'rate_limited');
    assert.equal(limited.headers['retry-after'], '60');
    // and an address of its own has a share of its own
    assert.equal((await h.request('GET', '/auth/github', at('198.51.100.2'))).status, 302);
    // the sub-resource refusal still comes first, even for an address that is out of its share
    assert.equal((await h.request('GET', '/auth/github', at('198.51.100.1', { 'sec-fetch-dest': 'image' }))).status, 400);
  }));

test('each kind of sign-in request has its own count', () =>
  withServer(OPTIONS, async (h) => {
    const web = await member(h);
    const here = '203.0.113.50';

    // the starts of this address are used up ...
    const first = h.browser();
    const second = h.browser();
    const s1 = stateOf(await first.get('/auth/github', at(here)));
    const s2 = stateOf(await second.get('/auth/github', at(here)));
    assert.equal((await h.request('GET', '/auth/github', at(here))).status, 429);

    // ... and coming back from the provider is another count
    h.net.github.users.c1 = { id: 11, login: 'a', name: 'A', avatar_url: null, emails: [{ email: 'a@example.com', primary: true, verified: true }] };
    h.net.github.users.c2 = { id: 12, login: 'b', name: 'B', avatar_url: null, emails: [{ email: 'b@example.com', primary: true, verified: true }] };
    assert.equal((await first.get(`/auth/github/callback?code=c1&state=${s1}`, at(here))).headers.location, '/account');
    assert.equal((await second.get(`/auth/github/callback?code=c2&state=${s2}`, at(here))).headers.location, '/account');
    // that is its two as well
    const third = h.browser();
    third.jar.set(STATE, { value: 'x'.repeat(30), path: '/' });
    assert.equal((await third.get(`/auth/github/callback?code=c1&state=${'x'.repeat(30)}`, at(here))).status, 429);

    // a link from the app is a count of its own
    const link = (code) => h.request('GET', `/auth/link?code=${code}`, at(here));
    assert.equal((await link('a'.repeat(43))).headers.location, '/login?error=link');
    assert.equal((await link('b'.repeat(43))).headers.location, '/login?error=link');
    assert.equal((await link('c'.repeat(43))).status, 429);
    assert.equal((await h.request('POST', '/auth/link', { ...at(here), body: `code=${'d'.repeat(43)}`, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': here }, origin: null })).status, 429);

    // so is handing a signed-in browser over to the app ...
    const handOver = () => web.post('/auth/app/continue', APP, at(here));
    assert.equal((await handOver()).status, 200);
    assert.equal((await handOver()).status, 200);
    assert.equal((await handOver()).status, 429);

    // ... and trading a code for a token
    const exchange = () => h.request('POST', '/api/app/session', { ...at(here), json: { code: 'a'.repeat(43), verifier: 'b'.repeat(43) }, origin: null });
    assert.equal((await exchange()).json.error, 'bad_code');
    assert.equal((await exchange()).json.error, 'bad_code');
    assert.equal((await exchange()).status, 429);

    // none of that touched another address
    assert.equal((await h.request('GET', '/auth/github', at('203.0.113.51'))).status, 302);
    assert.equal((await h.request('GET', '/api/me', at(here))).status, 200, 'and nothing else is counted');
  }));

test('what can be refused for nothing is not counted: forged callbacks, malformed exchanges, bad starts and hand-overs', () =>
  withServer(OPTIONS, async (h) => {
    const web = await member(h);
    const here = '203.0.113.60';
    // a callback without the cookie of the browser that started the sign-in: nothing is looked up, nothing counted
    for (let n = 0; n < 30; n++) {
      assert.equal((await h.request('GET', `/auth/github/callback?code=x&state=${'s'.repeat(30)}`, at(here))).headers.location, '/login?error=state');
      assert.equal((await h.request('GET', '/auth/google/callback?error=access_denied', at(here))).headers.location, '/login?error=denied');
      assert.equal((await h.request('GET', '/auth/github/callback', at(here))).headers.location, '/login?error=state');
    }
    // an exchange that cannot be one
    for (let n = 0; n < 10; n++) {
      for (const body of [{}, { code: 5, verifier: 'v' }, { code: 'x', verifier: 'y' }, { code: 'a'.repeat(43) }, { verifier: 'v'.repeat(43) }, { code: 'a'.repeat(43), verifier: 'short' }]) {
        const res = await h.request('POST', '/api/app/session', { ...at(here), json: body, origin: null });
        assert.equal(res.status, 400);
        assert.equal(res.json.error, 'bad_code');
      }
    }
    assert.equal((await h.request('POST', '/api/app/session', { ...at(here), body: 'not json', origin: null })).status, 400);
    // starts that are wrong in themselves
    for (let n = 0; n < 10; n++) {
      assert.equal((await h.request('GET', '/auth/github?app_port=80&app_state=short&app_challenge=x', at(here))).status, 400);
      assert.equal((await h.request('GET', '/auth/github?app_port=51234', at(here))).status, 400);
    }
    // hand-overs with nothing to hand over, or from nobody
    for (let n = 0; n < 10; n++) {
      assert.equal((await web.post('/auth/app/continue', { app_port: 80 }, at(here))).status, 400);
      assert.equal((await h.browser().post('/auth/app/continue', APP, at(here))).status, 401);
    }
    // links that cannot be links
    for (let n = 0; n < 10; n++) {
      assert.equal((await h.request('GET', '/auth/link?code=nope', at(here))).headers.location, '/login?error=link');
      assert.equal((await h.request('GET', '/auth/link', at(here))).headers.location, '/login?error=link');
    }

    // so the whole share of this address is still there for the real thing
    const hand = await appHandover(h, { provider: 'github', id: 9, name: 'Z', email: 'z@example.com', port: 52001 });
    assert.ok(hand.code);
    assert.equal((await h.request('GET', '/auth/github', at(here))).status, 302);
    assert.equal((await h.request('GET', '/auth/github', at(here))).status, 302);
    assert.equal((await h.request('GET', '/auth/github', at(here))).status, 429);
  }));

test('a callback that has its own cookie is counted, whatever it brings', () =>
  withServer(OPTIONS, async (h) => {
    const here = '203.0.113.70';
    const forged = (n) => {
      const b = h.browser();
      const state = `${String(n).repeat(30)}`.slice(0, 30);
      b.jar.set(STATE, { value: state, path: '/' });
      return b.get(`/auth/github/callback?code=c&state=${state}`, at(here));
    };
    // the cookie and the state agree, so somebody started this: it costs a count, and then fails for the state it does not know
    assert.equal((await forged(1)).headers.location, '/login?error=state');
    assert.equal((await forged(2)).headers.location, '/login?error=state');
    assert.equal((await forged(3)).status, 429);
    // an error from the provider is counted the same way
    const b = h.browser();
    b.jar.set(STATE, { value: 'e'.repeat(30), path: '/' });
    assert.equal((await b.get(`/auth/github/callback?error=access_denied&state=${'e'.repeat(30)}`, at(here))).status, 429);
  }));

test('a window that is over starts again', () =>
  withServer(OPTIONS, async (h) => {
    const here = '203.0.113.80';
    assert.equal((await h.request('GET', '/auth/github', at(here))).status, 302);
    assert.equal((await h.request('GET', '/auth/github', at(here))).status, 302);
    assert.equal((await h.request('GET', '/auth/github', at(here))).status, 429);
    h.clock.advance(61_000);
    assert.equal((await h.request('GET', '/auth/github', at(here))).status, 302);
  }));
