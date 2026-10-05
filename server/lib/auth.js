// Sign-in with GitHub or Google, browser sessions, app tokens and the hand-over to the desktop app.
//
// Sessions, app tokens, one-time codes and the sign-in state are random values; only a keyed hash
// (HMAC with APP_SECRET) is stored. The provider's own access token is used once to read the
// profile and then dropped.
//
// A browser session and an app token are different things: the cookie belongs to the website, the
// token to the app, and the token is good for a few routes only (see the `bearer` option of the
// routes below and the check in server.js).
const crypto = require('node:crypto');
const { fail, parseCookies, hasBody, readForm, isSubresource, createLimiter } = require('./http');
const { hmac, randomToken, randomHex, safeEqual } = require('./util');
const { accountView, planOf } = require('./plan');

const WEB_SESSION_MS = 60 * 86_400_000;
// an app token lives as long as it is used at least this often
const APP_SESSION_MS = 180 * 86_400_000;
const STATE_MS = 10 * 60_000;
const APP_CODE_MS = 2 * 60_000;
const WEBLINK_MS = 60_000;
const TOKEN_RE = /^[\w-]{20,120}$/;
const APP_VALUE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const BEARER_RE = /^Bearer\s+(\S+)\s*$/i;

class ProviderError extends Error {}

// ---- what a stranger sends us, cleaned up before it goes anywhere ----

const cleanName = (value, fallback) => {
  const name = typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) : '';
  return name || fallback;
};

// Only the places the providers keep their pictures, and nothing that could be somebody else's
// address in disguise: the host is read the way a browser reads it.
function cleanAvatar(value) {
  if (typeof value !== 'string' || value.length > 500) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname;
  const ours = host === 'avatars.githubusercontent.com' || (host.endsWith('.googleusercontent.com') && /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host.slice(0, -'.googleusercontent.com'.length)));
  return ours ? url.href : null;
}

// Lowercase for the letters A to Z only. toLowerCase() would fold look-alikes into plain letters
// as well (the Kelvin sign into "k"), and an address that merely looks the same is not the same.
const cleanEmail = (value) => {
  const email = typeof value === 'string' ? value.trim().replace(/[A-Z]/g, (c) => c.toLowerCase()) : '';
  return email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(email) ? email : null;
};
// Only plain ASCII addresses are matched against other accounts. Any other address works for its
// own account, and never joins another one.
const isPlainAscii = (email) => /^[\x21-\x7e]+$/.test(email);

// Where to go after signing in: a path on this site and nothing else, in printable ASCII (a
// space, a control character or anything beyond cannot be part of a header, nor of an address a
// browser reads the way we do). "//host" and "/\host" are addresses on other sites, so only a
// single leading slash passes.
function safeNext(value) {
  const fallback = '/account';
  if (typeof value !== 'string' || value.length > 512 || !/^\/(?![/\\])[\x21-\x5b\x5d-\x7e]*$/.test(value)) return fallback;
  try {
    return new URL(value, 'http://site.invalid').origin === 'http://site.invalid' ? value : fallback;
  } catch {
    return fallback;
  }
}

// The loopback address the desktop app listens on. Only 127.0.0.1, a port the app could have
// opened as a normal user, and values that cannot carry anything else.
function parseApp(port, state, challenge) {
  const n = typeof port === 'number' ? port : /^\d{1,5}$/.test(port) ? Number(port) : NaN;
  if (!Number.isInteger(n) || n < 1024 || n > 65535 || !APP_VALUE_RE.test(state) || !APP_VALUE_RE.test(challenge)) return null;
  return { port: n, state, challenge };
}

const hasBearer = (req) => BEARER_RE.test(req.headers.authorization || '');

function createAuth({ config, db, fetchFn, now, log, hooks, site }) {
  // Different purposes never share a hash, so a value from one place is useless in another.
  const hashOf = (purpose, value) => hmac(config.appSecret, `${purpose}:${value}`);
  const cookies = config.cookies;

  // what one account may ask for, counted per account
  const weblinkLimiter = createLimiter(config.tuning.accountRates.weblink, now);

  // ---- sessions ----

  function createSession(accountId, kind) {
    const token = (kind === 'app' ? 'fsa_' : '') + randomToken(32);
    const t = now();
    db.run(
      'INSERT INTO sessions (token_hash, account_id, kind, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      hashOf(kind, token),
      accountId,
      kind,
      t,
      t,
      t + (kind === 'app' ? APP_SESSION_MS : WEB_SESSION_MS),
    );
    return token;
  }

  function lookup(kind, token) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
    const t = now();
    const tokenHash = hashOf(kind, token);
    const row = db.get(
      `SELECT a.*, s.last_used_at AS session_used FROM sessions s JOIN accounts a ON a.id = s.account_id
       WHERE s.token_hash = ? AND s.kind = ? AND s.expires_at > ?`,
      tokenHash,
      kind,
      t,
    );
    if (!row) return null;
    const { session_used: used, ...account } = row;
    // slide the expiry of an app token, but not on every call
    if (kind === 'app' && t - used > 3_600_000) {
      db.run('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE token_hash = ?', t, t + APP_SESSION_MS, tokenHash);
    }
    return { account, tokenHash };
  }

  // Who is calling: the app (Bearer) or a browser (cookie). A Bearer header means the app is
  // calling, and the cookie is not looked at then. Only the cookie that belongs to this mode is read.
  function authenticate(req) {
    const bearer = BEARER_RE.exec(req.headers.authorization || '');
    if (bearer) {
      const found = lookup('app', bearer[1]);
      return found && { ...found, via: 'bearer' };
    }
    const found = lookup('web', parseCookies(req.headers.cookie)[cookies.session]);
    return found && { ...found, via: 'cookie' };
  }

  // For the matchmaking: an app token seen in a hello.
  const accountForToken = (token) => lookup('app', token);

  // ---- one-time codes ----

  function issueCode(purpose, accountId, data, ttlMs) {
    const code = randomToken(32);
    db.run(
      'INSERT INTO codes (code_hash, purpose, account_id, data, expires_at) VALUES (?, ?, ?, ?, ?)',
      hashOf(purpose, code),
      purpose,
      accountId,
      JSON.stringify(data),
      now() + ttlMs,
    );
    return code;
  }

  // Looks at a code without using it up.
  function peekCode(purpose, code) {
    if (typeof code !== 'string' || !TOKEN_RE.test(code)) return null;
    const row = db.get('SELECT account_id, data, expires_at FROM codes WHERE code_hash = ? AND purpose = ?', hashOf(purpose, code), purpose);
    if (!row || row.expires_at <= now()) return null;
    return { accountId: row.account_id, data: JSON.parse(row.data) };
  }

  // Single use: the row is gone after the first look, right or wrong, expired or not.
  function consumeCode(purpose, code) {
    if (typeof code !== 'string' || !TOKEN_RE.test(code)) return null;
    const row = db.get(
      'DELETE FROM codes WHERE code_hash = ? AND purpose = ? RETURNING account_id, data, expires_at',
      hashOf(purpose, code),
      purpose,
    );
    if (!row || row.expires_at <= now()) return null;
    return { accountId: row.account_id, data: JSON.parse(row.data) };
  }

  // ---- providers ----

  const redirectUri = (provider) => `${config.baseUrl}/auth/${provider}/callback`;

  async function request(url, options = {}) {
    let res;
    try {
      res = await fetchFn(url, { ...options, signal: AbortSignal.timeout(config.tuning.fetchTimeoutMs) });
    } catch {
      throw new ProviderError('the request could not be made');
    }
    if (!res.ok) throw new ProviderError(`answered ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new ProviderError('answered with something that is not JSON');
    }
  }

  const PROVIDERS = {
    github: {
      enabled: () => config.github.enabled,
      authorize(state) {
        const url = new URL('https://github.com/login/oauth/authorize');
        url.searchParams.set('client_id', config.github.clientId);
        url.searchParams.set('redirect_uri', redirectUri('github'));
        url.searchParams.set('scope', 'read:user user:email');
        url.searchParams.set('state', state);
        return url.toString();
      },
      async profile(code) {
        const grant = await request('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'FriendsShare' },
          body: JSON.stringify({
            client_id: config.github.clientId,
            client_secret: config.github.clientSecret,
            code,
            redirect_uri: redirectUri('github'),
          }),
        });
        // GitHub answers 200 even when the code is wrong
        if (typeof grant.access_token !== 'string' || !grant.access_token) throw new ProviderError('gave no access token');
        const headers = {
          Authorization: `Bearer ${grant.access_token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'FriendsShare',
          'X-GitHub-Api-Version': '2022-11-28',
        };
        const user = await request('https://api.github.com/user', { headers });
        const emails = await request('https://api.github.com/user/emails', { headers });
        if (!user || (typeof user.id !== 'number' && typeof user.id !== 'string') || !Array.isArray(emails)) {
          throw new ProviderError('answered with an unexpected profile');
        }
        // the primary address, and only when GitHub says it is verified
        const primary = emails.find((e) => e && e.primary === true && e.verified === true);
        return {
          subject: String(user.id),
          name: cleanName(user.name, cleanName(user.login, 'GitHub user')),
          avatar: cleanAvatar(user.avatar_url),
          email: primary ? cleanEmail(primary.email) : null,
        };
      },
    },

    google: {
      enabled: () => config.google.enabled,
      authorize(state) {
        const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        url.searchParams.set('client_id', config.google.clientId);
        url.searchParams.set('redirect_uri', redirectUri('google'));
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('scope', 'openid email profile');
        url.searchParams.set('state', state);
        // people often have several Google accounts
        url.searchParams.set('prompt', 'select_account');
        return url.toString();
      },
      async profile(code) {
        const grant = await request('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id: config.google.clientId,
            client_secret: config.google.clientSecret,
            redirect_uri: redirectUri('google'),
            grant_type: 'authorization_code',
          }).toString(),
        });
        if (typeof grant.access_token !== 'string' || !grant.access_token) throw new ProviderError('gave no access token');
        const info = await request('https://openidconnect.googleapis.com/v1/userinfo', {
          headers: { Authorization: `Bearer ${grant.access_token}`, Accept: 'application/json' },
        });
        if (!info || typeof info.sub !== 'string' || !info.sub) throw new ProviderError('answered with an unexpected profile');
        const email = info.email_verified === true || info.email_verified === 'true' ? cleanEmail(info.email) : null;
        return {
          subject: info.sub,
          name: cleanName(info.name, cleanName(email && email.split('@')[0], 'Google user')),
          avatar: cleanAvatar(info.picture),
          email,
        };
      },
    },
  };

  // ---- accounts ----

  // Turns a verified provider profile into an account and returns its id, or { error }.
  function resolveLogin(provider, profile, linkTo) {
    return db.tx(() => {
      const t = now();
      const known = db.get('SELECT account_id, email FROM identities WHERE provider = ? AND subject = ?', provider, profile.subject);

      if (linkTo) {
        if (known && known.account_id !== linkTo) return { error: 'linked_elsewhere' };
        if (!db.get('SELECT 1 AS present FROM accounts WHERE id = ?', linkTo)) return { error: 'state' };
        if (known) {
          db.run('UPDATE identities SET email = COALESCE(?, email), last_login_at = ? WHERE provider = ? AND subject = ?', profile.email, t, provider, profile.subject);
        } else {
          db.run('INSERT INTO identities (provider, subject, account_id, email, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)', provider, profile.subject, linkTo, profile.email, t, t);
        }
        // fill gaps in the account, never overwrite what the person already has
        db.run('UPDATE accounts SET email = COALESCE(email, ?), avatar = COALESCE(avatar, ?) WHERE id = ?', profile.email, profile.avatar, linkTo);
        return { accountId: linkTo };
      }

      if (known) {
        db.run('UPDATE identities SET email = COALESCE(?, email), last_login_at = ? WHERE provider = ? AND subject = ?', profile.email, t, provider, profile.subject);
        db.run('UPDATE accounts SET name = ?, avatar = COALESCE(?, avatar), last_login_at = ? WHERE id = ?', profile.name, profile.avatar, t, known.account_id);
        // The account's address follows the login it came from when that address changes, but a
        // login with another address (linked later) does not take it over.
        if (profile.email) db.run('UPDATE accounts SET email = ? WHERE id = ? AND (email IS NULL OR email = ?)', profile.email, known.account_id, known.email);
        return { accountId: known.account_id };
      }

      // A login we have not seen before is only told apart from strangers by a verified address.
      if (!profile.email) return { error: 'email_unverified' };

      // The same verified address on another login means the same person: join their account. Only
      // for plain ASCII addresses: one that merely looks like another is not that address.
      const match = isPlainAscii(profile.email)
        ? db.get(
            `SELECT id, created_at FROM accounts WHERE email = ?
             UNION
             SELECT a.id, a.created_at FROM identities i JOIN accounts a ON a.id = i.account_id WHERE i.email = ?
             ORDER BY created_at LIMIT 1`,
            profile.email,
            profile.email,
          )
        : undefined;
      let accountId;
      if (match) {
        accountId = match.id;
        db.run('UPDATE accounts SET avatar = COALESCE(avatar, ?), last_login_at = ? WHERE id = ?', profile.avatar, t, accountId);
      } else {
        accountId = randomHex(8);
        db.run('INSERT INTO accounts (id, name, email, avatar, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)', accountId, profile.name, profile.email, profile.avatar, t, t);
      }
      db.run('INSERT INTO identities (provider, subject, account_id, email, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)', provider, profile.subject, accountId, profile.email, t, t);
      return { accountId };
    });
  }

  // ---- hand-over to the desktop app ----

  function appRedirect(app, accountId) {
    const code = issueCode('app', accountId, { challenge: app.challenge }, APP_CODE_MS);
    const url = new URL('http://127.0.0.1/callback');
    url.port = String(app.port);
    url.searchParams.set('code', code);
    url.searchParams.set('state', app.state);
    return url.toString();
  }

  // ---- routes ----

  function loginError(ctx, code, app) {
    const query = new URLSearchParams({ error: code });
    // keep the app's sign-in alive: the login page needs these to offer the buttons again
    if (app) {
      query.set('app_port', String(app.port));
      query.set('app_state', app.state);
      query.set('app_challenge', app.challenge);
    }
    ctx.redirect(`/login?${query}`);
  }

  function startLogin(ctx, provider) {
    // An image or a script on another page must not be able to start a sign-in, or to use up the
    // visitor's share of them: this address is for navigating to.
    if (isSubresource(ctx.req)) fail(400, 'bad_request', 'This address only works as a page of its own. Open it from the sign-in page.');
    const p = PROVIDERS[provider];
    if (!p.enabled()) return loginError(ctx, 'not_configured');
    const q = ctx.query;
    const hasApp = ['app_port', 'app_state', 'app_challenge'].some((k) => q.has(k));
    const app = hasApp ? parseApp(q.get('app_port'), q.get('app_state'), q.get('app_challenge')) : null;
    if (hasApp && !app) fail(400, 'bad_request', 'The sign-in link from the app is not valid. Start the sign-in again from the app.');
    // counted only now: everything above is refused for free
    ctx.rateLimit('start');
    // linking only makes sense for a browser that is signed in already
    let linkTo = null;
    if (!app && q.get('link') === '1') {
      const auth = ctx.auth();
      if (auth && auth.via === 'cookie') linkTo = auth.account.id;
    }
    const state = randomToken(24);
    db.run(
      'INSERT INTO codes (code_hash, purpose, account_id, data, expires_at) VALUES (?, ?, ?, ?, ?)',
      hashOf('oauth', state),
      'oauth',
      linkTo,
      JSON.stringify({ provider, next: safeNext(q.get('next')), app }),
      now() + STATE_MS,
    );
    ctx.setCookie(cookies.state, state, { maxAge: STATE_MS / 1000, path: cookies.statePath });
    ctx.redirect(p.authorize(state));
  }

  async function finishLogin(ctx, provider) {
    const p = PROVIDERS[provider];
    const q = ctx.query;
    const sent = q.get('state');
    const cookie = ctx.cookies[cookies.state];
    // the state is good for one attempt, whatever its outcome
    ctx.clearCookie(cookies.state, cookies.statePath);
    if (!p.enabled()) return loginError(ctx, 'not_configured');

    // Without the cookie of the browser that started this, nothing is looked up and nothing is
    // counted: that is all a request made by somebody else's page can ever be.
    let flow = null;
    if (typeof sent === 'string' && typeof cookie === 'string' && safeEqual(sent, cookie)) {
      ctx.rateLimit('callback');
      flow = consumeCode('oauth', sent);
      if (flow && flow.data.provider !== provider) flow = null;
    }
    const app = flow ? flow.data.app : null;

    if (q.has('error')) return loginError(ctx, q.get('error') === 'access_denied' ? 'denied' : 'provider', app);
    if (!flow) return loginError(ctx, 'state');
    const code = q.get('code');
    if (!code || code.length > 2048) return loginError(ctx, 'provider', app);

    // linking to the account that started it, and only while that account is still signed in here
    if (flow.accountId) {
      const auth = ctx.auth();
      if (!auth || auth.via !== 'cookie' || auth.account.id !== flow.accountId) return loginError(ctx, 'state');
    }

    let profile;
    try {
      profile = await p.profile(code);
    } catch (err) {
      log(`[auth] ${provider} sign-in failed: ${err instanceof ProviderError ? err.message : 'unexpected error'}`);
      return loginError(ctx, 'provider', app);
    }

    const result = resolveLogin(provider, profile, flow.accountId);
    if (result.error) return loginError(ctx, result.error, app);

    if (!flow.accountId) startWebSession(ctx, result.accountId);
    ctx.redirect(app ? appRedirect(app, result.accountId) : flow.data.next);
  }

  // A fresh token on every sign-in (never reuse one), and the one this browser had is retired.
  function startWebSession(ctx, accountId) {
    const previous = ctx.auth();
    if (previous && previous.via === 'cookie') db.run('DELETE FROM sessions WHERE token_hash = ?', previous.tokenHash);
    ctx.setCookie(cookies.session, createSession(accountId, 'web'), { maxAge: WEB_SESSION_MS / 1000 });
  }

  // Ends every session of an account, browsers' and the app's, and every code that could still become one.
  function endEverything(accountId) {
    const tokens = db.all("SELECT token_hash FROM sessions WHERE account_id = ? AND kind = 'app'", accountId);
    db.tx(() => {
      db.run('DELETE FROM sessions WHERE account_id = ?', accountId);
      db.run('DELETE FROM codes WHERE account_id = ?', accountId);
    });
    // connections that were using one of those tokens go back to the free plan
    for (const { token_hash: tokenHash } of tokens) hooks.sessionEnded(tokenHash);
  }

  const BAD_APP_LINK = 'The sign-in link from the app is not valid. Start the sign-in again from the app.';

  function register(router) {
    for (const provider of Object.keys(PROVIDERS)) {
      router.add('GET', `/auth/${provider}`, (ctx) => startLogin(ctx, provider));
      router.add('GET', `/auth/${provider}/callback`, (ctx) => finishLogin(ctx, provider));
    }

    // Opening a link from the app is no reason to sign a browser in: anybody can be sent such a link,
    // and a bare GET (a prefetch, a mail scanner, an <img>) would take the visitor's session away.
    // So a GET only ever shows who the link would sign in, and a form on that page, posted by the
    // person, does the signing in.
    router.add('GET', '/auth/link', async (ctx) => {
      const code = ctx.query.get('code');
      if (typeof code !== 'string' || !TOKEN_RE.test(code)) return ctx.redirect('/login?error=link');
      ctx.rateLimit('link');
      const link = peekCode('weblink', code);
      const account = link && db.get('SELECT * FROM accounts WHERE id = ?', link.accountId);
      if (!account) return ctx.redirect('/login?error=link');
      const next = safeNext(ctx.query.get('next'));
      const here = ctx.auth();
      if (here && here.via === 'cookie' && here.account.id === account.id) {
        // already this account: nothing to confirm, and the session stays exactly as it is
        if (ctx.req.method !== 'HEAD') consumeCode('weblink', code);
        return ctx.redirect(next);
      }
      await site.sendPage(ctx.res, 'link.html', { link_name: account.name, link_email: account.email || '', link_code: code, link_next: next });
    });

    router.add('POST', '/auth/link', async (ctx) => {
      const form = await ctx.form();
      const code = form && form.get('code');
      if (typeof code !== 'string' || !TOKEN_RE.test(code)) return ctx.redirect('/login?error=link', 303);
      ctx.rateLimit('link');
      const link = consumeCode('weblink', code);
      if (!link || !db.get('SELECT 1 AS present FROM accounts WHERE id = ?', link.accountId)) return ctx.redirect('/login?error=link', 303);
      startWebSession(ctx, link.accountId);
      // 303: the browser follows a POST with a GET, and the form is not sent again
      ctx.redirect(safeNext(form.get('next')), 303);
    });

    // "Continue as ..." on the login page: the browser is signed in already, so hand it to the app
    router.add('POST', '/auth/app/continue', async (ctx) => {
      const auth = ctx.auth();
      if (!auth || auth.via !== 'cookie') fail(401, 'signed_out', 'Sign in first.');
      const body = await ctx.body();
      const app = parseApp(body.app_port, body.app_state, body.app_challenge);
      if (!app) fail(400, 'bad_request', BAD_APP_LINK);
      ctx.rateLimit('continue');
      ctx.json(200, { redirect: appRedirect(app, auth.account.id) });
    });

    // the app trades the one-time code for its token; the verifier proves it is the app that asked
    router.add(
      'POST',
      '/api/app/session',
      async (ctx) => {
        const { code, verifier } = await ctx.body();
        const bad = () => fail(400, 'bad_code', 'This sign-in code is not valid any more. Start the sign-in again from the app.');
        // what cannot be a code and a verifier is refused for free
        if (typeof code !== 'string' || !TOKEN_RE.test(code) || typeof verifier !== 'string' || !APP_VALUE_RE.test(verifier)) bad();
        ctx.rateLimit('exchange');
        const link = consumeCode('app', code);
        const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
        if (!link || !safeEqual(challenge, link.data.challenge)) bad();
        const account = db.get('SELECT * FROM accounts WHERE id = ?', link.accountId);
        if (!account) bad();
        ctx.json(200, { token: createSession(account.id, 'app'), account: accountView(account), plan: planOf(account, now()) });
      },
      // no cookie is involved, so there is nothing for another site to forge
      { noOrigin: true },
    );

    router.add(
      'POST',
      '/api/app/weblink',
      (ctx) => {
        const auth = ctx.auth();
        if (!auth || auth.via !== 'bearer') fail(401, 'signed_out', 'Sign in to the app first.');
        if (!weblinkLimiter.allow(auth.account.id)) {
          fail(429, 'rate_limited', 'You have asked for too many links. Please wait a while and try again.', {
            'Retry-After': String(Math.ceil(config.tuning.accountRates.weblink.windowMs / 1000)),
          });
        }
        // one link at a time: an older one that was never used is of no use to anybody now
        db.run("DELETE FROM codes WHERE purpose = 'weblink' AND account_id = ?", auth.account.id);
        const code = issueCode('weblink', auth.account.id, {}, WEBLINK_MS);
        ctx.json(200, { url: `${config.baseUrl}/auth/link?code=${code}&next=/account` });
      },
      { bearer: true },
    );

    // Ends the session that made the call, a browser's or the app's. From a browser, with
    // { "everywhere": true }, it ends every session of the account.
    router.add(
      'POST',
      '/api/logout',
      async (ctx) => {
        const auth = ctx.auth();
        const body = hasBody(ctx.req) ? await ctx.body() : {};
        if (body.everywhere === true) {
          if (hasBearer(ctx.req)) fail(403, 'forbidden', 'Signing out everywhere is only possible from the website.');
          if (auth) endEverything(auth.account.id);
        } else if (auth) {
          db.run('DELETE FROM sessions WHERE token_hash = ?', auth.tokenHash);
          if (auth.via === 'bearer') hooks.sessionEnded(auth.tokenHash);
        }
        // with a Bearer token the cookie is not part of the call, so it is left alone
        if (!hasBearer(ctx.req)) ctx.clearCookie(cookies.session, '/');
        ctx.noContent();
      },
      { bearer: true },
    );
  }

  return {
    register,
    authenticate,
    accountForToken,
    hasBearer,
    providersOf: (accountId) => db.all('SELECT DISTINCT provider FROM identities WHERE account_id = ? ORDER BY provider', accountId).map((r) => r.provider),
  };
}

module.exports = { createAuth, hasBearer, safeNext, parseApp, cleanEmail, cleanAvatar, isPlainAscii };
