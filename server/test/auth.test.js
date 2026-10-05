// Signing in with GitHub and Google, sessions, the hand-over to the desktop app, web links,
// logout and deleting an account. The providers are fakes; nothing leaves this machine.
const test = require('node:test');
const assert = require('node:assert/strict');
const { withServer, connectApp, signIn, appHandover, appLogin, makePro, dumpDatabase, BASE, SESSION, STATE, LOGIN_ENV, BILLING_ENV } = require('./helpers');

const LOGIN = { env: LOGIN_ENV };
const DAY = 86_400_000;
const find = (res, name) => res.cookies.find((c) => c.startsWith(`${name}=`));
const ada = { id: 1, name: 'Ada Lovelace', email: 'ada@example.com' };

test('the whole GitHub sign-in ends with a session cookie and /api/me showing the account', () =>
  withServer(LOGIN, async (h) => {
    const b = h.browser();
    const start = await b.get('/auth/github');
    assert.equal(start.status, 302);
    const authorize = new URL(start.headers.location);
    assert.equal(authorize.origin + authorize.pathname, 'https://github.com/login/oauth/authorize');
    assert.equal(authorize.searchParams.get('client_id'), 'gh-client');
    assert.equal(authorize.searchParams.get('redirect_uri'), `${BASE}/auth/github/callback`);
    assert.equal(authorize.searchParams.get('scope'), 'read:user user:email');
    const state = authorize.searchParams.get('state');
    assert.match(state, /^[\w-]{20,}$/);

    // the same value is in a short-lived cookie that only the sign-in routes see
    const stateCookie = find(start, STATE);
    assert.ok(stateCookie.startsWith(`${STATE}=${state};`));
    for (const part of ['; HttpOnly', '; SameSite=Lax', '; Path=/;', '; Max-Age=600', '; Secure']) assert.ok(`${stateCookie};`.includes(part), part);
    assert.ok(!/domain=/i.test(stateCookie), 'no Domain');

    const code = 'the-code-github-sent-back';
    h.net.github.users[code] = {
      id: 4242,
      login: 'ada-l',
      name: 'Ada Lovelace',
      avatar_url: 'https://avatars.githubusercontent.com/u/4242',
      emails: [
        { email: 'ada.private@example.com', primary: false, verified: true },
        { email: 'Ada@Example.com', primary: true, verified: true },
      ],
    };
    const done = await b.get(`/auth/github/callback?code=${code}&state=${state}`);
    assert.equal(done.status, 302);
    assert.equal(done.headers.location, '/account');
    const session = find(done, SESSION);
    for (const part of ['; HttpOnly', '; SameSite=Lax', '; Path=/;', '; Max-Age=5184000', '; Secure']) assert.ok(`${session};`.includes(part), part);
    assert.ok(!/domain=/i.test(session), 'no Domain');
    assert.ok(find(done, STATE).includes('Max-Age=0'), 'the state cookie is used up');

    const me = await b.get('/api/me');
    assert.equal(me.status, 200);
    assert.deepEqual(me.json, {
      account: { name: 'Ada Lovelace', email: 'ada@example.com', avatar: 'https://avatars.githubusercontent.com/u/4242', providers: ['github'] },
      plan: 'free',
      subscription: null,
      billing: false,
      free_limit: 5,
      prices: { monthly: '€1.99', yearly: '€11.88', yearly_per_month: '€0.99' },
      providers: { github: true, google: true },
    });

    // what GitHub was asked, and with what
    const [exchange] = h.net.calling((c) => c.path === '/login/oauth/access_token');
    assert.deepEqual(exchange.json, { client_id: 'gh-client', client_secret: 'gh-secret', code, redirect_uri: `${BASE}/auth/github/callback` });
    const profile = h.net.calling((c) => c.host === 'api.github.com' && c.path.startsWith('/user'));
    assert.deepEqual(profile.map((c) => c.path), ['/user', '/user/emails']);
    assert.equal(profile[0].headers.authorization, `Bearer gho_${code}`);

    // GitHub's token was used once and is nowhere on our side; neither are our own tokens, in the clear
    const stored = dumpDatabase(h);
    for (const secret of [`gho_${code}`, code, state, b.cookie(SESSION), 'gh-secret']) assert.ok(!stored.includes(secret), `${secret} must not be stored`);
    const logged = h.logs.join('\n');
    for (const secret of [`gho_${code}`, 'ada@example.com', 'ada.private', b.cookie(SESSION), state]) assert.ok(!logged.includes(secret), `${secret} must not be logged`);
  }));

test('the whole Google sign-in ends with a session cookie and /api/me showing the account', () =>
  withServer(LOGIN, async (h) => {
    const b = h.browser();
    const start = await b.get('/auth/google');
    assert.equal(start.status, 302);
    const authorize = new URL(start.headers.location);
    assert.equal(authorize.origin + authorize.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(authorize.searchParams.get('client_id'), 'go-client');
    assert.equal(authorize.searchParams.get('redirect_uri'), `${BASE}/auth/google/callback`);
    assert.equal(authorize.searchParams.get('response_type'), 'code');
    assert.equal(authorize.searchParams.get('scope'), 'openid email profile');
    const state = authorize.searchParams.get('state');
    assert.ok(find(start, STATE).startsWith(`${STATE}=${state};`));

    const code = 'the-code-google-sent-back';
    h.net.google.users[code] = { sub: '117', name: 'Grace Hopper', picture: 'https://lh3.googleusercontent.com/a/117', email: 'grace@example.com', email_verified: true, hd: 'ignored' };
    const done = await b.get(`/auth/google/callback?code=${code}&state=${state}`);
    assert.equal(done.status, 302);
    assert.equal(done.headers.location, '/account');
    assert.ok(find(done, SESSION));

    const me = (await b.get('/api/me')).json;
    assert.deepEqual(me.account, { name: 'Grace Hopper', email: 'grace@example.com', avatar: 'https://lh3.googleusercontent.com/a/117', providers: ['google'] });

    const [token] = h.net.calling((c) => c.host === 'oauth2.googleapis.com');
    assert.deepEqual(token.form, {
      code,
      client_id: 'go-client',
      client_secret: 'go-secret',
      redirect_uri: `${BASE}/auth/google/callback`,
      grant_type: 'authorization_code',
    });
    const [userinfo] = h.net.calling((c) => c.host === 'openidconnect.googleapis.com');
    assert.equal(userinfo.path, '/v1/userinfo');
    assert.equal(userinfo.headers.authorization, `Bearer ya29.${code}`);
    const stored = dumpDatabase(h);
    for (const secret of [`ya29.${code}`, code, state, 'go-secret']) assert.ok(!stored.includes(secret), `${secret} must not be stored`);
  }));

test('a sign-in that comes back with a wrong, missing, reused or foreign state is refused before anything is fetched', () =>
  withServer(LOGIN, async (h) => {
    const fetchedToken = () => h.net.calling((c) => c.path === '/login/oauth/access_token' || c.host === 'oauth2.googleapis.com').length;
    const person = (code) => (h.net.github.users[code] = { id: 7, login: 'x', name: 'X', avatar_url: null, emails: [{ email: 'x@example.com', primary: true, verified: true }] });

    const wrong = h.browser();
    await wrong.get('/auth/github');
    person('c1');
    assert.equal((await wrong.get('/auth/github/callback?code=c1&state=forged')).headers.location, '/login?error=state');

    // no state cookie at all (another browser, or it expired)
    const start = await h.browser().get('/auth/github');
    const realState = new URL(start.headers.location).searchParams.get('state');
    assert.equal((await h.browser().get(`/auth/github/callback?code=c1&state=${realState}`)).headers.location, '/login?error=state');
    assert.equal((await h.browser().get('/auth/github/callback?code=c1')).headers.location, '/login?error=state');

    // a state that was started for the other provider
    const mixed = h.browser();
    const google = await mixed.get('/auth/google');
    const googleState = new URL(google.headers.location).searchParams.get('state');
    assert.equal((await mixed.get(`/auth/github/callback?code=c1&state=${googleState}`)).headers.location, '/login?error=state');

    assert.equal(fetchedToken(), 0);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts').n, 0);

    // success once, and the same callback again with the cookie put back is refused
    const replay = h.browser();
    const first = await replay.get('/auth/github');
    const state = new URL(first.headers.location).searchParams.get('state');
    assert.equal((await replay.get(`/auth/github/callback?code=c1&state=${state}`)).headers.location, '/account');
    replay.jar.set(STATE, { value: state, path: '/' });
    assert.equal((await replay.get(`/auth/github/callback?code=c1&state=${state}`)).headers.location, '/login?error=state');
    assert.equal(fetchedToken(), 1);
  }));

test('cancelling at the provider and a provider that fails send the person back to the sign-in page with a reason', () =>
  withServer(LOGIN, async (h) => {
    const flow = async (provider, query) => {
      const b = h.browser();
      const start = await b.get(`/auth/${provider}`);
      const state = new URL(start.headers.location).searchParams.get('state');
      return b.get(`/auth/${provider}/callback?${query}&state=${state}`);
    };
    assert.equal((await flow('github', 'error=access_denied')).headers.location, '/login?error=denied');
    assert.equal((await flow('google', 'error=access_denied')).headers.location, '/login?error=denied');
    assert.equal((await flow('google', 'error=server_error')).headers.location, '/login?error=provider');
    // the code is not one the provider knows
    assert.equal((await flow('github', 'code=unknown-code')).headers.location, '/login?error=provider');
    assert.equal((await flow('google', 'code=unknown-code')).headers.location, '/login?error=provider');
    // the callback without a code
    assert.equal((await flow('github', 'x=1')).headers.location, '/login?error=provider');
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts').n, 0);
    assert.ok(h.logs.some((line) => line.startsWith('[auth] github sign-in failed')));
  }));

test('a provider that cannot be reached is a provider error, and what the failure says is kept out of the log', () =>
  withServer(LOGIN, async (h) => {
    const b = h.browser();
    const start = await b.get('/auth/github');
    const state = new URL(start.headers.location).searchParams.get('state');
    h.net.github.users.c = { id: 1, login: 'x', name: 'X', avatar_url: null, emails: [] };
    h.net.down = new Error('connect ECONNREFUSED, request was sent with client_secret=gh-secret');
    const done = await b.get(`/auth/github/callback?code=c&state=${state}`);
    assert.equal(done.status, 302);
    assert.equal(done.headers.location, '/login?error=provider');
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts').n, 0);
    assert.ok(h.logs.some((line) => line.startsWith('[auth] github sign-in failed')));
    assert.ok(!h.logs.join('\n').includes('gh-secret'));
  }));

test('an email that is not verified is not used: no account is created for it', () =>
  withServer(LOGIN, async (h) => {
    const gh = await signIn(h, { provider: 'github', id: 1, email: 'ada@example.com', verified: false });
    assert.equal(gh.done.headers.location, '/login?error=email_unverified');
    assert.equal(find(gh.done, SESSION), undefined);
    const go = await signIn(h, { provider: 'google', id: 2, email: 'ada@example.com', verified: false });
    assert.equal(go.done.headers.location, '/login?error=email_unverified');
    // a verified address that is not the primary one is not "the primary verified address"
    const secondary = await signIn(h, {
      provider: 'github',
      id: 3,
      userinfo: { id: 3, login: 'x', name: 'X', avatar_url: null, emails: [{ email: 'a@example.com', primary: true, verified: false }, { email: 'b@example.com', primary: false, verified: true }] },
    });
    assert.equal(secondary.done.headers.location, '/login?error=email_unverified');
    // Google can leave the flag out altogether
    const silent = await signIn(h, { provider: 'google', id: 4, userinfo: { sub: '4', name: 'S', email: 'silent@example.com' } });
    assert.equal(silent.done.headers.location, '/login?error=email_unverified');
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts').n, 0);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM identities').n, 0);
  }));

test('an unverified email cannot be used to get into somebody else\'s account', () =>
  withServer(LOGIN, async (h) => {
    await signIn(h, { provider: 'github', ...ada });
    const attacker = await signIn(h, { provider: 'google', id: 666, name: 'Mallory', email: 'ada@example.com', verified: false });
    assert.equal(attacker.done.headers.location, '/login?error=email_unverified');
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM identities').n, 1);
    assert.equal((await attacker.b.get('/api/me')).json.account, null);
  }));

test('a returning login whose email is not verified any more still signs in and keeps the stored address', () =>
  withServer(LOGIN, async (h) => {
    await signIn(h, { provider: 'github', ...ada });
    const again = await signIn(h, { provider: 'github', ...ada, verified: false });
    assert.equal(again.done.headers.location, '/account');
    assert.equal((await again.b.get('/api/me')).json.account.email, 'ada@example.com');
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts').n, 1);
  }));

test('a second provider with the same verified email lands on the same account', () =>
  withServer(LOGIN, async (h) => {
    const first = await signIn(h, { provider: 'github', id: 1, name: 'ada-l', email: 'Ada@Example.com' });
    const second = await signIn(h, { provider: 'google', id: 'g-1', name: 'Ada Lovelace', email: 'ada@example.COM' });
    assert.equal(second.done.headers.location, '/account');
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts').n, 1);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM identities').n, 2);
    const me = (await second.b.get('/api/me')).json.account;
    assert.deepEqual(me.providers, ['github', 'google']);
    assert.equal(me.email, 'ada@example.com');
    // both browsers are the same person now, with their own sessions
    assert.deepEqual((await first.b.get('/api/me')).json.account.providers, ['github', 'google']);
    assert.notEqual(first.b.cookie(SESSION), second.b.cookie(SESSION));
  }));

test('a login with a different email is a different account', () =>
  withServer(LOGIN, async (h) => {
    await signIn(h, { provider: 'github', id: 1, email: 'a@example.com' });
    await signIn(h, { provider: 'google', id: 'g-2', email: 'b@example.com' });
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts').n, 2);
  }));

test('signing in again with the same login uses the same account and refreshes the profile', () =>
  withServer(LOGIN, async (h) => {
    await signIn(h, { provider: 'github', ...ada, name: 'Ada' });
    const again = await signIn(h, { provider: 'github', ...ada, name: 'Ada King' });
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts').n, 1);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM identities').n, 1);
    assert.equal((await again.b.get('/api/me')).json.account.name, 'Ada King');
  }));

test('link=1 adds a login to the account that is signed in, even with another email', () =>
  withServer(LOGIN, async (h) => {
    const { b } = await signIn(h, { provider: 'github', ...ada });
    const before = b.cookie(SESSION);
    const linked = await signIn(h, { provider: 'google', id: 'g-9', name: 'Ada at work', email: 'ada@work.example', query: '?link=1', browser: b });
    assert.equal(linked.done.headers.location, '/account');
    assert.equal(find(linked.done, SESSION), undefined, 'the browser keeps its session');
    assert.equal(b.cookie(SESSION), before);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts').n, 1);
    const me = (await b.get('/api/me')).json.account;
    assert.deepEqual(me.providers, ['github', 'google']);
    assert.equal(me.email, 'ada@example.com', 'the account keeps its own address');
    // and the new login now signs in to the same account
    const viaGoogle = await signIn(h, { provider: 'google', id: 'g-9', email: 'ada@work.example' });
    assert.equal((await viaGoogle.b.get('/api/me')).json.account.email, 'ada@example.com');
  }));

test('link=1 for a login that belongs to another account is refused with linked_elsewhere', () =>
  withServer(LOGIN, async (h) => {
    await signIn(h, { provider: 'google', id: 'g-5', name: 'Other', email: 'other@example.com' });
    const { b } = await signIn(h, { provider: 'github', ...ada });
    const refused = await signIn(h, { provider: 'google', id: 'g-5', email: 'other@example.com', query: '?link=1', browser: b });
    assert.equal(refused.done.headers.location, '/login?error=linked_elsewhere');
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts').n, 2);
    assert.deepEqual((await b.get('/api/me')).json.account.providers, ['github']);
  }));

test('link=1 without a signed-in browser is an ordinary sign-in', () =>
  withServer(LOGIN, async (h) => {
    const { b, done } = await signIn(h, { provider: 'github', ...ada, query: '?link=1' });
    assert.equal(done.headers.location, '/account');
    assert.equal((await b.get('/api/me')).json.account.email, 'ada@example.com');
  }));

test('a link started by one account cannot be finished in the session of another', () =>
  withServer(LOGIN, async (h) => {
    const a = (await signIn(h, { provider: 'github', ...ada })).b;
    const other = (await signIn(h, { provider: 'github', id: 2, name: 'Bob', email: 'bob@example.com' })).b;
    const start = await a.get('/auth/google?link=1');
    const state = new URL(start.headers.location).searchParams.get('state');
    h.net.google.users.c = { sub: 'g-1', name: 'G', email: 'g@example.com', email_verified: true };
    // the state cookie travels to bob's browser, who is signed in as somebody else
    other.jar.set(STATE, { value: state, path: '/' });
    const done = await other.get(`/auth/google/callback?code=c&state=${state}`);
    assert.equal(done.headers.location, '/login?error=state');
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM identities WHERE provider = ?', 'google').n, 0);
  }));

test('a sign-in method that is not set up sends the person back with not_configured', () =>
  withServer({ env: { GITHUB_CLIENT_ID: 'only', GITHUB_CLIENT_SECRET: 'github' } }, async (h) => {
    assert.equal((await h.request('GET', '/auth/google')).headers.location, '/login?error=not_configured');
    assert.equal((await h.request('GET', '/auth/google/callback?code=x&state=y')).headers.location, '/login?error=not_configured');
    assert.equal((await h.request('GET', '/auth/github')).status, 302);
    const me = (await h.request('GET', '/api/me')).json;
    assert.deepEqual(me.providers, { github: true, google: false });
    // half a pair is not a sign-in method either
    await withServer({ env: { GITHUB_CLIENT_ID: 'id only' } }, async (half) => {
      assert.equal((await half.request('GET', '/auth/github')).headers.location, '/login?error=not_configured');
    });
  }));

test('the profile from a provider is cleaned before it is stored', () =>
  withServer(LOGIN, async (h) => {
    const { b } = await signIn(h, {
      provider: 'github',
      userinfo: {
        id: 9,
        login: 'login-name',
        name: '  Ada\u0000 \n Lovelace\u001b  '.padEnd(300, 'x'),
        avatar_url: 'javascript:alert(1)',
        emails: [{ email: ' Ada@Example.com ', primary: true, verified: true }],
      },
    });
    const account = (await b.get('/api/me')).json.account;
    assert.equal(account.avatar, null);
    assert.ok(account.name.length <= 100);
    assert.match(account.name, /^Ada Lovelace/);
    assert.ok(!/[\u0000-\u001f]/.test(account.name));
    assert.equal(account.email, 'ada@example.com');

    // no name at all: the login stands in
    const nameless = await signIn(h, { provider: 'github', userinfo: { id: 10, login: 'octocat', name: null, avatar_url: null, emails: [{ email: 'octo@example.com', primary: true, verified: true }] } });
    assert.equal((await nameless.b.get('/api/me')).json.account.name, 'octocat');
  }));

// ---- where to go afterwards ----

test('next is followed only when it is a path on this site', () =>
  withServer(LOGIN, async (h) => {
    const after = async (next) => (await signIn(h, { provider: 'github', ...ada, query: `?next=${encodeURIComponent(next)}` })).done.headers.location;
    assert.equal(await after('/account'), '/account');
    assert.equal(await after('/login?x=1#top'), '/login?x=1#top');
    assert.equal(await after('/privacy'), '/privacy');
    for (const bad of ['https://evil.example/', '//evil.example', '/\\evil.example', '\\\\evil.example', 'evil.example', 'javascript:alert(1)', '/ok\r\nSet-Cookie: x=y', '/ok\nLocation: https://evil.example', '', '/' + 'a'.repeat(600)]) {
      assert.equal(await after(bad), '/account', JSON.stringify(bad.slice(0, 40)));
    }
    // and without any
    assert.equal((await signIn(h, { provider: 'github', ...ada })).done.headers.location, '/account');
  }));

// ---- the desktop app ----

test('after signing in for the app, the browser is sent to 127.0.0.1 with a one-time code and the app trades it for a token', () =>
  withServer(LOGIN, async (h) => {
    const hand = await appHandover(h, { port: 51234 });
    assert.equal(hand.done.status, 302);
    assert.equal(hand.target.protocol, 'http:');
    assert.equal(hand.target.hostname, '127.0.0.1');
    assert.equal(hand.target.port, '51234');
    assert.equal(hand.target.pathname, '/callback');
    assert.deepEqual([...hand.target.searchParams.keys()].sort(), ['code', 'state']);
    assert.equal(hand.target.searchParams.get('state'), hand.state);
    assert.ok(hand.code.length >= 40);

    const exchange = await h.request('POST', '/api/app/session', { json: { code: hand.code, verifier: hand.verifier }, origin: null });
    assert.equal(exchange.status, 200);
    assert.match(exchange.json.token, /^fsa_[\w-]{40,}$/);
    assert.deepEqual(exchange.json.account, { name: 'Ada Lovelace', email: 'ada@example.com', avatar: 'https://avatars.githubusercontent.com/u/1' });
    assert.equal(exchange.json.plan, 'free');

    // the token works as a Bearer token
    const me = (await h.request('GET', '/api/me', { headers: { authorization: `Bearer ${exchange.json.token}` } })).json;
    assert.equal(me.account.email, 'ada@example.com');
    // the browser that did the sign-in is signed in too
    assert.equal((await hand.b.get('/api/me')).json.account.email, 'ada@example.com');
    // only hashes are stored
    const stored = dumpDatabase(h);
    for (const secret of [exchange.json.token, hand.code, hand.verifier]) assert.ok(!stored.includes(secret));
  }));

test('the same hand-over works for Google, and a pro account is told so', () =>
  withServer({ env: BILLING_ENV }, async (h) => {
    const first = await appHandover(h, { provider: 'google', id: 'g-1' });
    const exchange = await h.request('POST', '/api/app/session', { json: { code: first.code, verifier: first.verifier } });
    assert.equal(exchange.json.plan, 'free');
    makePro(h, h.accountId('ada@example.com'));
    const again = await appLogin(h, { provider: 'google', id: 'g-1' });
    assert.equal(again.exchange.json.plan, 'pro');
  }));

test('a wrong verifier is refused and the code is spent, a reused code is refused, a late one too', () =>
  withServer(LOGIN, async (h) => {
    const exchange = (hand, verifier) => h.request('POST', '/api/app/session', { json: { code: hand.code, verifier }, origin: null });

    const wrong = await appHandover(h);
    const refused = await exchange(wrong, 'x'.repeat(43));
    assert.equal(refused.status, 400);
    assert.equal(refused.json.error, 'bad_code');
    assert.match(refused.json.message, /^[A-Z].*\.$/);
    // the right verifier comes too late: guessing is not worth trying
    assert.equal((await exchange(wrong, wrong.verifier)).status, 400);

    const once = await appHandover(h);
    assert.equal((await exchange(once, once.verifier)).status, 200);
    assert.equal((await exchange(once, once.verifier)).json.error, 'bad_code');

    const late = await appHandover(h);
    h.clock.advance(121_000);
    assert.equal((await exchange(late, late.verifier)).json.error, 'bad_code');

    // just in time
    const inTime = await appHandover(h);
    h.clock.advance(119_000);
    assert.equal((await exchange(inTime, inTime.verifier)).status, 200);

    // other nonsense
    for (const body of [{}, { code: 5, verifier: 'v' }, { code: 'x', verifier: 'y' }, { verifier: 'v'.repeat(43) }, { code: wrong.code }]) {
      assert.equal((await h.request('POST', '/api/app/session', { json: body, origin: null })).json.error, 'bad_code', JSON.stringify(body));
    }
    assert.equal((await h.request('POST', '/api/app/session', { body: 'not json', origin: null })).json.error, 'bad_request');
  }));

test('a code is bound to the challenge it was issued for', () =>
  withServer(LOGIN, async (h) => {
    const a = await appHandover(h);
    const b = await appHandover(h, { id: 2, name: 'Bob', email: 'bob@example.com' });
    // a's code with b's verifier
    const mixed = await h.request('POST', '/api/app/session', { json: { code: a.code, verifier: b.verifier }, origin: null });
    assert.equal(mixed.json.error, 'bad_code');
  }));

test('only a loopback target the app could really have opened is ever redirected to', () =>
  withServer(LOGIN, async (h) => {
    const good = { app_port: '51234', app_state: 'a'.repeat(22), app_challenge: 'b'.repeat(43) };
    const start = (values) => h.request('GET', `/auth/github?${new URLSearchParams({ ...good, ...values })}`);
    assert.equal((await start({})).status, 302);

    const bad = [
      { app_port: '80' }, { app_port: '1023' }, { app_port: '65536' }, { app_port: '0' }, { app_port: '-51234' }, { app_port: 'abc' },
      { app_port: '51234.5' }, { app_port: '0x4000' }, { app_port: '' }, { app_port: '51234@evil.example' }, { app_port: '51234/../x' },
      { app_port: '5123456' }, { app_port: ' 51234' },
      { app_state: 'short' }, { app_state: 'a'.repeat(129) }, { app_state: 'bad state with spaces' }, { app_state: 'x&y=z'.padEnd(20, 'x') },
      { app_state: 'a'.repeat(22) + '\n' }, { app_state: '' },
      { app_challenge: 'b'.repeat(15) }, { app_challenge: '../../etc/passwd' }, { app_challenge: 'b'.repeat(42) + '/' }, { app_challenge: '' },
    ];
    for (const values of bad) {
      const res = await start(values);
      assert.equal(res.status, 400, JSON.stringify(values));
      assert.equal(res.json.error, 'bad_request');
      assert.equal(find(res, STATE), undefined);
    }
    // the edges are fine
    assert.equal((await start({ app_port: '1024', app_state: 'a'.repeat(16), app_challenge: 'b'.repeat(16) })).status, 302);
    assert.equal((await start({ app_port: '65535', app_state: 'a'.repeat(128), app_challenge: 'b'.repeat(128) })).status, 302);
    // some of the three is not enough, and neither is only some of them being valid
    for (const only of ['app_port', 'app_state', 'app_challenge']) {
      assert.equal((await h.request('GET', `/auth/github?${only}=${good[only]}`)).status, 400, only);
    }
    // nothing was started for the refused ones
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM codes').n, 3);
  }));

test('a failed sign-in for the app keeps the app values, so the sign-in page can offer the buttons again', () =>
  withServer(LOGIN, async (h) => {
    const good = { app_port: '51234', app_state: 'a'.repeat(22), app_challenge: 'b'.repeat(43) };
    const b = h.browser();
    const start = await b.get(`/auth/github?${new URLSearchParams(good)}`);
    const state = new URL(start.headers.location).searchParams.get('state');
    const denied = await b.get(`/auth/github/callback?error=access_denied&state=${state}`);
    assert.deepEqual(Object.fromEntries(new URL(denied.headers.location, BASE).searchParams), { error: 'denied', ...good });
    assert.ok(denied.headers.location.startsWith('/login?error=denied&'));

    // an ordinary sign-in has nothing extra
    const plain = h.browser();
    const plainStart = await plain.get('/auth/github');
    const plainState = new URL(plainStart.headers.location).searchParams.get('state');
    assert.equal((await plain.get(`/auth/github/callback?error=access_denied&state=${plainState}`)).headers.location, '/login?error=denied');
  }));

test('Continue as: a signed-in browser hands over to the app without signing in again', () =>
  withServer(LOGIN, async (h) => {
    const { b } = await signIn(h, { provider: 'github', ...ada });
    const hand = await appHandover(h, { provider: 'github', id: 99, name: 'Someone else', email: 'else@example.com' });
    const challenge = hand.challenge;
    const res = await b.post('/auth/app/continue', { app_port: 52000, app_state: hand.state, app_challenge: challenge });
    assert.equal(res.status, 200);
    const target = new URL(res.json.redirect);
    assert.equal(target.origin, 'http://127.0.0.1:52000');
    assert.equal(target.pathname, '/callback');
    assert.equal(target.searchParams.get('state'), hand.state);
    const exchange = await h.request('POST', '/api/app/session', { json: { code: target.searchParams.get('code'), verifier: hand.verifier }, origin: null });
    assert.equal(exchange.status, 200);
    assert.equal(exchange.json.account.email, 'ada@example.com', 'the account of the browser, not of the other sign-in');

    // refused: invalid values, nobody signed in, the app's own token (a browser call), another site
    assert.equal((await b.post('/auth/app/continue', { app_port: 80, app_state: hand.state, app_challenge: challenge })).status, 400);
    assert.equal((await b.post('/auth/app/continue', { app_port: '52000', app_state: 'x', app_challenge: challenge })).status, 400);
    assert.equal((await b.post('/auth/app/continue', [])).status, 400);
    assert.equal((await h.browser().post('/auth/app/continue', { app_port: 52000, app_state: hand.state, app_challenge: challenge })).json.error, 'signed_out');
    const bearer = await h.request('POST', '/auth/app/continue', { headers: { authorization: `Bearer ${exchange.json.token}` }, json: { app_port: 52000, app_state: hand.state, app_challenge: challenge } });
    assert.equal(bearer.status, 403, 'the app token is not a browser session');
    assert.equal(bearer.json.error, 'forbidden');
    const foreign = await b.post('/auth/app/continue', { app_port: 52000, app_state: hand.state, app_challenge: challenge }, { origin: 'https://evil.example' });
    assert.equal(foreign.status, 403);
  }));

test('the app can ask for a web link: a one-time address on this site, valid for a minute', () =>
  withServer(LOGIN, async (h) => {
    const { token } = await appLogin(h);
    const link = await h.request('POST', '/api/app/weblink', { headers: { authorization: `Bearer ${token}` }, origin: null });
    assert.equal(link.status, 200);
    assert.match(link.json.url, new RegExp(`^${BASE}/auth/link\\?code=[\\w-]{40,}&next=/account$`));
    // what is stored of it is a hash, with a minute to live
    const row = h.db.get("SELECT code_hash, expires_at FROM codes WHERE purpose = 'weblink'");
    assert.equal(row.expires_at, h.clock.t + 60_000);
    assert.ok(!link.json.url.includes(row.code_hash));
    // nonsense, and the code of another purpose, is no web link
    assert.equal((await h.browser().get('/auth/link?code=nope')).headers.location, '/login?error=link');
    assert.equal((await h.browser().get('/auth/link')).headers.location, '/login?error=link');
    const hand = await appHandover(h);
    assert.equal((await h.browser().get(`/auth/link?code=${hand.code}`)).headers.location, '/login?error=link');
    assert.equal((await h.request('POST', '/api/app/session', { json: { code: hand.code, verifier: hand.verifier } })).status, 200, 'and that code is untouched');
  }));

test('the web link is for the app only: no token, a wrong token or just a cookie get signed_out', () =>
  withServer(LOGIN, async (h) => {
    const { b } = await signIn(h, { provider: 'github', ...ada });
    assert.equal((await b.post('/api/app/weblink')).json.error, 'signed_out');
    assert.equal((await h.request('POST', '/api/app/weblink', { headers: { authorization: 'Bearer fsa_nope' } })).status, 401);
    assert.equal((await h.request('POST', '/api/app/weblink')).status, 401);
  }));

// ---- sessions ----

test('logging out ends the browser session and clears the cookie', () =>
  withServer(LOGIN, async (h) => {
    const { b } = await signIn(h, { provider: 'github', ...ada });
    const cookie = b.cookie(SESSION);
    const out = await b.post('/api/logout');
    assert.equal(out.status, 204);
    assert.equal(out.text, '');
    assert.ok(find(out, SESSION).includes('Max-Age=0'));
    assert.equal((await b.get('/api/me')).json.account, null);
    // the old cookie is dead even if somebody kept a copy
    const copy = await h.request('GET', '/api/me', { headers: { cookie: `${SESSION}=${cookie}` } });
    assert.equal(copy.json.account, null);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM sessions').n, 0);
    // logging out when nobody is signed in is fine
    assert.equal((await b.post('/api/logout')).status, 204);
  }));

test('logging out with the app token ends only that token, and the app is signed out at the next hello', () =>
  withServer(LOGIN, async (h) => {
    const one = await appLogin(h);
    const two = await appLogin(h);
    const out = await h.request('POST', '/api/logout', { headers: { authorization: `Bearer ${one.token}` }, origin: null });
    assert.equal(out.status, 204);
    assert.equal((await h.request('GET', '/api/me', { headers: { authorization: `Bearer ${one.token}` } })).json.account, null);
    assert.equal((await h.request('GET', '/api/me', { headers: { authorization: `Bearer ${two.token}` } })).json.account.email, 'ada@example.com');
    assert.equal((await one.b.get('/api/me')).json.account.email, 'ada@example.com', 'the browser session is a different one');
    const app = await connectApp(h, { hello: { token: one.token } });
    assert.equal(app.reply.signed_out, true);
    assert.equal(app.reply.account, null);
  }));

test('a connection of an app that logs out is moved to the free plan and told so', () =>
  withServer({ env: BILLING_ENV }, async (h) => {
    const { token } = await appLogin(h);
    makePro(h, h.accountId('ada@example.com'));
    const app = await connectApp(h, { hello: { token } });
    assert.equal(app.reply.plan, 'pro');
    await h.request('POST', '/api/logout', { headers: { authorization: `Bearer ${token}` }, origin: null });
    assert.deepEqual(await app.next('plan'), { t: 'plan', plan: 'free', limit: 5 });
  }));

test('cookie and token are not interchangeable', () =>
  withServer(LOGIN, async (h) => {
    const { b, token } = await appLogin(h);
    const cookie = b.cookie(SESSION);
    // a browser session presented as a token, and an app token presented as a cookie
    assert.equal((await h.request('GET', '/api/me', { headers: { authorization: `Bearer ${cookie}` } })).json.account, null);
    assert.equal((await h.request('GET', '/api/me', { headers: { cookie: `${SESSION}=${token}` } })).json.account, null);
    // a Bearer header means the app is calling: a valid cookie next to a bad token does not help
    assert.equal((await b.get('/api/me', { headers: { authorization: 'Bearer fsa_bad' } })).json.account, null);
    assert.equal((await b.get('/api/me', { headers: { authorization: `Bearer ${token}` } })).json.account.email, 'ada@example.com');
    // other schemes are not Bearer
    assert.equal((await b.get('/api/me', { headers: { authorization: 'Basic abc' } })).json.account.email, 'ada@example.com');
  }));

test('a browser session lasts 60 days, an app token lasts as long as it is used within 180 days', () =>
  withServer(LOGIN, async (h) => {
    const { b, token } = await appLogin(h);
    const web = async () => (await b.get('/api/me')).json.account;
    const app = async () => (await h.request('GET', '/api/me', { headers: { authorization: `Bearer ${token}` } })).json.account;

    h.clock.advance(59 * DAY);
    assert.ok(await web());
    h.clock.advance(2 * DAY);
    assert.equal(await web(), null, 'the browser session is over after 60 days');

    // the app was not used for 61 days, uses the token, and again 100 days later, and again
    assert.ok(await app());
    h.clock.advance(100 * DAY);
    assert.ok(await app());
    h.clock.advance(150 * DAY);
    assert.ok(await app());
    // 181 days of silence is too much
    h.clock.advance(181 * DAY);
    assert.equal(await app(), null);
    // and the cleanup removes what ran out
    h.server.runCleanup();
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM sessions').n, 0);
  }));

test('the regular cleanup removes expired sessions and codes only', () =>
  withServer(LOGIN, async (h) => {
    await appHandover(h);
    const { token } = await appLogin(h);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM codes').n, 1);
    h.clock.advance(3 * 60_000);
    h.server.runCleanup();
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM codes').n, 0);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM sessions').n, 3, 'the live sessions are untouched: two browsers and the app');
    assert.ok((await h.request('GET', '/api/me', { headers: { authorization: `Bearer ${token}` } })).json.account);
  }));

test('GET /api/me when signed out answers 200 with the plain facts', () =>
  withServer({ env: { ...LOGIN_ENV, PRICE_DISPLAY_MONTHLY: '$2', FREE_LIMIT: '3' } }, async (h) => {
    const res = await h.request('GET', '/api/me');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^application\/json/);
    assert.deepEqual(res.json, {
      account: null,
      plan: 'free',
      subscription: null,
      billing: false,
      free_limit: 3,
      prices: { monthly: '$2', yearly: '€11.88', yearly_per_month: '€0.99' },
      providers: { github: true, google: true },
    });
    // an unknown token is the same answer
    assert.equal((await h.request('GET', '/api/me', { headers: { authorization: 'Bearer fsa_whatever' } })).json.account, null);
  }));

// ---- deleting an account ----

test('deleting an account removes it with its logins and sessions, and signs it out everywhere', () =>
  withServer(LOGIN, async (h) => {
    const { b, token } = await appLogin(h);
    const oldId = h.accountId('ada@example.com');
    await signIn(h, { provider: 'google', id: 'g-1', email: 'ada@example.com' });
    const bystander = await signIn(h, { provider: 'github', id: 2, name: 'Bob', email: 'bob@example.com' });
    const app = await connectApp(h, { hello: { token } });
    assert.equal(app.reply.account.email, 'ada@example.com');

    const res = await b.post('/api/account/delete');
    assert.equal(res.status, 204);
    assert.ok(find(res, SESSION).includes('Max-Age=0'));
    assert.equal((await b.get('/api/me')).json.account, null);
    assert.equal((await h.request('GET', '/api/me', { headers: { authorization: `Bearer ${token}` } })).json.account, null);
    assert.equal(h.db.get("SELECT COUNT(*) AS n FROM accounts WHERE email = 'ada@example.com'").n, 0);
    assert.equal(h.db.get("SELECT COUNT(*) AS n FROM identities WHERE provider IN ('github', 'google') AND subject IN ('1', 'g-1')").n, 0);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM sessions').n, 1, 'only bob is left');
    assert.equal((await bystander.b.get('/api/me')).json.account.email, 'bob@example.com');
    // and the same login starts over as a new account
    const fresh = await signIn(h, { provider: 'github', ...ada });
    assert.equal(fresh.done.headers.location, '/account');
    assert.notEqual(h.accountId('ada@example.com'), oldId, 'a new account, never the old id again');
    // nobody is signed in: nothing to delete
    assert.equal((await h.browser().post('/api/account/delete')).json.error, 'signed_out');
  }));

test('the app\'s token cannot delete the account: that is for the website', () =>
  withServer(LOGIN, async (h) => {
    const { token } = await appLogin(h);
    const res = await h.request('POST', '/api/account/delete', { headers: { authorization: `Bearer ${token}` }, origin: null });
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'forbidden');
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts').n, 1);
  }));

test('open connections of a deleted account are moved to the free plan', () =>
  withServer({ env: BILLING_ENV }, async (h) => {
    const { b, token } = await appLogin(h);
    makePro(h, h.accountId('ada@example.com'));
    // the account has a running subscription, which Stripe knows
    h.net.stripe.subscriptions.sub_1 = { id: 'sub_1', status: 'active' };
    const app = await connectApp(h, { hello: { token } });
    assert.equal(app.reply.plan, 'pro');
    assert.equal((await b.post('/api/account/delete')).status, 204);
    assert.deepEqual(await app.next('plan'), { t: 'plan', plan: 'free', limit: 5 });
  }));

// ---- requests from other sites ----

test('cookie-authenticated posts from another site are refused, the app\'s calls are not', () =>
  withServer(LOGIN, async (h) => {
    const { b, token } = await appLogin(h);
    const bearer = { authorization: `Bearer ${token}` };

    // a browser on another site: the Origin says so, a sandboxed page says "null", and an old
    // browser may send only Sec-Fetch-Site
    for (const headers of [{ origin: 'https://evil.example' }, { origin: 'null' }, { origin: 'http://friendsshare.test' }, { origin: `${BASE}.evil.example` }, { 'sec-fetch-site': 'cross-site' }]) {
      const res = await b.post('/api/logout', undefined, { origin: null, headers });
      assert.equal(res.status, 403, JSON.stringify(headers));
      assert.equal(res.json.error, 'forbidden');
      assert.match(res.json.message, /^[A-Z].*\.$/);
    }
    assert.ok((await b.get('/api/me')).json.account, 'the session survived all of them');
    for (const path of ['/api/billing/checkout', '/api/billing/portal', '/api/account/delete', '/auth/app/continue']) {
      const res = await b.post(path, {}, { origin: 'https://evil.example' });
      assert.equal(res.status, 403, path);
    }
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts').n, 1);

    // from this site, or from no browser at all: fine
    const sameSite = await b.post('/api/logout', undefined, { origin: null, headers: { 'sec-fetch-site': 'same-origin' } });
    assert.equal(sameSite.status, 204);

    // the app: Electron may send "Origin: null" or nothing, and carries no cookie to be abused
    for (const headers of [{ origin: 'null' }, {}]) {
      const fresh = await appHandover(h);
      const session = await h.request('POST', '/api/app/session', { json: { code: fresh.code, verifier: fresh.verifier }, origin: null, headers });
      assert.equal(session.status, 200, `/api/app/session with ${JSON.stringify(headers)}`);
    }
    const weblink = await h.request('POST', '/api/app/weblink', { headers: { ...bearer, origin: 'null' }, origin: null });
    assert.equal(weblink.status, 200, 'a Bearer call with Origin: null');
    const crossBearer = await h.request('POST', '/api/app/weblink', { headers: { ...bearer, origin: 'https://evil.example' }, origin: null });
    assert.equal(crossBearer.status, 200, 'a Bearer call is not a cookie being abused, whatever the Origin');
    const logout = await h.request('POST', '/api/logout', { headers: { ...bearer, origin: 'null' }, origin: null });
    assert.equal(logout.status, 204);
    // and with a Bearer token the cookie is not used: this call is signed out, not "forged"
    const withBoth = await b.post('/api/logout', undefined, { headers: { authorization: 'Bearer fsa_whatever', origin: 'null' }, origin: null });
    assert.equal(withBoth.status, 204);
  }));

test('a cookie session is not touched by a Bearer call that happens to carry its cookie', () =>
  withServer(LOGIN, async (h) => {
    const { b } = await signIn(h, { provider: 'github', ...ada });
    // a logout with a (bad) Bearer token and the browser's cookie ends nothing of the browser's
    await b.post('/api/logout', undefined, { headers: { authorization: 'Bearer fsa_bad' } });
    assert.ok((await b.get('/api/me')).json.account);
  }));

// ---- limits on the sign-in routes ----

test('starting a sign-in is limited per address, other routes are not', () =>
  withServer({ env: LOGIN_ENV, tune: (config) => (config.tuning.authRate = { max: 3, windowMs: 60_000 }) }, async (h) => {
    for (let n = 0; n < 3; n++) assert.equal((await h.request('GET', '/auth/github')).status, 302);
    const limited = await h.request('GET', '/auth/google');
    assert.equal(limited.status, 429);
    assert.equal(limited.json.error, 'rate_limited');
    assert.match(limited.json.message, /^[A-Z].*\.$/);
    assert.equal(limited.headers['retry-after'], '60');
    // everything else carries on
    assert.equal((await h.request('GET', '/api/me')).status, 200);
    assert.equal((await h.request('GET', '/')).status, 200);
    assert.equal((await h.request('GET', '/healthz')).status, 200);
    // and the window passes
    h.clock.advance(61_000);
    assert.equal((await h.request('GET', '/auth/github')).status, 302);
  }));

test('behind the proxy the limit counts the address the proxy saw, not what the client claims', () =>
  withServer({ env: { ...LOGIN_ENV, TRUST_PROXY: '1' }, tune: (config) => (config.tuning.authRate = { max: 2, windowMs: 60_000 }) }, async (h) => {
    const as = (forwarded) => h.request('GET', '/auth/github', { headers: { 'x-forwarded-for': forwarded } });
    assert.equal((await as('203.0.113.7')).status, 302);
    // the client writes its own first entry, the proxy appends the real one
    assert.equal((await as('1.1.1.1, 203.0.113.7')).status, 302);
    assert.equal((await as('2.2.2.2, 203.0.113.7')).status, 429);
    // somebody else is somebody else
    assert.equal((await as('198.51.100.9')).status, 302);
    // one IPv6 customer owns the whole /64
    assert.equal((await as('2001:db8:1:2::1')).status, 302);
    assert.equal((await as('2001:db8:1:2:ffff::9')).status, 302);
    assert.equal((await as('2001:db8:1:2:aaaa::5')).status, 429);
    assert.equal((await as('2001:db8:1:3::1')).status, 302);
  }));

test('without a proxy the forwarded header is not believed', () =>
  withServer({ env: LOGIN_ENV, tune: (config) => (config.tuning.authRate = { max: 2, windowMs: 60_000 }) }, async (h) => {
    const as = (forwarded) => h.request('GET', '/auth/github', { headers: { 'x-forwarded-for': forwarded } });
    assert.equal((await as('1.1.1.1')).status, 302);
    assert.equal((await as('2.2.2.2')).status, 302);
    assert.equal((await as('3.3.3.3')).status, 429);
  }));

test('the callback state is accepted only once, even when two callbacks race', () =>
  withServer(LOGIN, async (h) => {
    const b = h.browser();
    const start = await b.get('/auth/github');
    const state = new URL(start.headers.location).searchParams.get('state');
    h.net.github.users.c = { id: 1, login: 'x', name: 'X', avatar_url: null, emails: [{ email: 'x@example.com', primary: true, verified: true }] };
    const results = await Promise.all([b.get(`/auth/github/callback?code=c&state=${state}`), b.get(`/auth/github/callback?code=c&state=${state}`)]);
    assert.deepEqual(results.map((r) => r.headers.location).sort(), ['/account', '/login?error=state']);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM accounts').n, 1);
  }));
