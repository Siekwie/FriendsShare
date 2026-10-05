// Accounts, in the main process: signing in through the system browser, the app token, and what the
// server last told us about the plan. Sign-in is only needed for Pro; the free plan works without.
//
// Nothing here talks to Electron except through what createAccount is handed, so the hand-over can
// be tested without a window (test/account.js) as well as in the real app (test/signin.js).
const http = require('http');
const crypto = require('crypto');
const { safeEqual } = require('./build');

const SIGN_IN_TIMEOUT = 10 * 60 * 1000;
const REQUEST_TIMEOUT = 15 * 1000;
// "fsa_" plus base64url; anything else cannot be a token of ours
const TOKEN_RE = /^[\w-]{20,200}$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---- addresses ----

// The website is at the matchmaking address: ws -> http, wss -> https, and the /ws path dropped.
function deriveSite(signalUrl) {
  const url = new URL(signalUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  return url.origin;
}

// The matchmaking address is <site>/ws. An address without a path is taken to mean that server.
function normalizeSignalUrl(given, fallback) {
  try {
    const url = new URL(given);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return fallback;
    if (url.pathname === '/') url.pathname = '/ws';
    url.hash = '';
    return url.href;
  } catch {
    return fallback;
  }
}

// A link from the server is only ever opened when it leads to our own site. During local
// development the same server is reached as localhost and as 127.0.0.1, so loopback names match.
function sameSite(link, site) {
  if (link.origin === site) return true;
  const own = new URL(site);
  return LOOPBACK.has(own.hostname) && LOOPBACK.has(link.hostname) && link.port === own.port && link.protocol === own.protocol;
}

// ---- what the server says, cleaned up before it is stored or shown ----

const text = (value, max) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

function cleanAccount(a) {
  if (!a || typeof a !== 'object') return null;
  return {
    name: text(a.name, 100) || 'Your account',
    email: text(a.email, 254) || null,
    // the picture is only ever loaded from https (the window's policy allows two hosts besides)
    avatar: typeof a.avatar === 'string' && /^https:\/\/[^\s]{1,480}$/.test(a.avatar) ? a.avatar : null,
  };
}

function cleanPrices(p) {
  if (!p || typeof p !== 'object') return null;
  const prices = { monthly: text(p.monthly, 20), yearly: text(p.yearly, 20), yearly_per_month: text(p.yearly_per_month, 20) };
  return prices.monthly && prices.yearly && prices.yearly_per_month ? prices : null;
}

// A welcome from the server, or what config.json remembers of one. Before there was any welcome:
// signed out, free, no limit.
function cleanWelcome(m) {
  m = m && typeof m === 'object' ? m : {};
  return {
    plan: m.plan === 'pro' ? 'pro' : 'free',
    // null: no limit (Pro, or the server does not enforce one)
    limit: Number.isInteger(m.limit) && m.limit > 0 ? m.limit : null,
    account: cleanAccount(m.account),
    billing: m.billing === true,
    prices: cleanPrices(m.prices),
  };
}

// ---- the page the browser lands on at the end of the hand-over ----

function page(res, status, title, message) {
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>FriendsShare</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#14161b;color:#e7e9ee;font:16px/1.5 'Segoe UI',system-ui,sans-serif}
main{max-width:420px;padding:32px;text-align:center}
h1{margin:0 0 8px;font-size:22px}
p{margin:0;color:#8d94a3}
</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    // the address of this page carries the one-time code
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    // the little server is gone a moment later; no connection should outlive it
    Connection: 'close',
  });
  res.end(body);
}

// deps:
//   fetch(url, init)   net.fetch in the app
//   safeStorage        Electron's, for the token
//   openUrl(url)       opens the system browser
//   config()           the live config object (config.json); save() writes it
//   siteUrl()          the website's origin
//   notify(state)      something changed that the window shows
//   reconnect()        the matchmaking connection has to start over (the token changed)
//   bringToFront()     the sign-in finished in the browser: show the window again
function createAccount({ fetch, safeStorage, openUrl, config, save, siteUrl, notify = () => {}, reconnect = () => {}, bringToFront = () => {}, timeoutMs = SIGN_IN_TIMEOUT }) {
  // the sign-in that waits for the browser: { server, url, verifier, state, timer, ready, used }
  let pending = null;
  // why the last sign-in or account action failed, in words for the person
  let error = null;
  // "Upgrade to Pro" was clicked while signed out: open the account page as soon as sign-in worked
  let afterSignIn = false;
  // undefined until the token was read from config.json
  let tokenCache;

  // ---- the token ----

  // The app token is kept encrypted with Electron's safeStorage (DPAPI on Windows), in config.json.
  // Plain storage only when the system cannot encrypt.
  function storeToken(value) {
    config().token = safeStorage.isEncryptionAvailable() ? { enc: safeStorage.encryptString(value).toString('base64') } : { plain: value };
    tokenCache = value;
  }

  function readToken() {
    const stored = config().token;
    if (!stored || typeof stored !== 'object') return null;
    let value = null;
    try {
      if (typeof stored.enc === 'string') value = safeStorage.decryptString(Buffer.from(stored.enc, 'base64'));
      else if (typeof stored.plain === 'string') value = stored.plain;
    } catch {
      // encrypted for another Windows account or PC: it cannot be read here, so it is as good as gone
    }
    if (typeof value === 'string' && TOKEN_RE.test(value)) return value;
    delete config().token;
    save();
    return null;
  }

  // the saved token, or null
  function token() {
    if (tokenCache === undefined) tokenCache = readToken();
    return tokenCache;
  }

  // Signed out (by the person, or because the server does not know the token any more).
  function forgetToken() {
    delete config().token;
    tokenCache = null;
    config().welcome = { ...current(), account: null, plan: 'free' };
  }

  // ---- what the server last said ----

  const current = () => cleanWelcome(config().welcome);

  function state() {
    const w = current();
    const signedIn = token() !== null;
    return { signedIn, account: signedIn ? w.account : null, plan: w.plan, limit: w.limit, billing: w.billing, prices: w.prices, signingIn: pending !== null, error };
  }

  const push = () => notify(state());

  // Call once the config is loaded: a token stored plain moves into safeStorage as soon as that works.
  function init() {
    tokenCache = undefined;
    const value = token();
    if (value !== null && config().token.plain !== undefined && safeStorage.isEncryptionAvailable()) {
      storeToken(value);
      save();
    }
  }

  // The server's welcome: remember it, so the window shows the right thing while offline or still
  // connecting. A token the server does not accept any more is forgotten.
  function welcome(message) {
    config().welcome = cleanWelcome(message);
    if (message && message.signed_out === true && token() !== null) forgetToken();
    save();
    push();
    return state();
  }

  // The plan changed while connected (bought, cancelled, ran out).
  function plan(newPlan, limit) {
    config().welcome = cleanWelcome({ ...current(), plan: newPlan, limit });
    save();
    push();
    return state();
  }

  // ---- talking to the server ----

  async function api(path, init = {}) {
    let res;
    try {
      res = await fetch(`${siteUrl()}${path}`, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT) });
    } catch {
      throw new Error('Could not reach the FriendsShare server. Check your internet connection and try again.');
    }
    let body = null;
    try {
      body = res.status === 204 ? null : await res.json();
    } catch {}
    if (!res.ok) {
      throw Object.assign(new Error(body && typeof body.message === 'string' ? body.message : `The FriendsShare server answered ${res.status}.`), { status: res.status });
    }
    return body;
  }

  // ---- sign-in: the loopback hand-over (contract section 3) ----

  function stop(flow) {
    clearTimeout(flow.timer);
    flow.server.close();
    // a connection that is still open would keep the little server alive
    setTimeout(() => flow.server.closeAllConnections(), 1000).unref();
    if (pending === flow) pending = null;
  }

  function giveUp(flow, message) {
    error = message;
    afterSignIn = false;
    stop(flow);
    push();
  }

  // The browser comes back here with the one-time code. Anything that is not exactly that is
  // answered and ignored: the sign-in keeps waiting for the real thing.
  async function onRequest(flow, req, res) {
    const port = flow.server.address() && flow.server.address().port;
    const url = new URL(req.url, 'http://127.0.0.1');
    // only our own page, under the only name we listen on (a web page cannot reach us under another)
    if (req.method !== 'GET' || url.pathname !== '/callback' || req.headers.host !== `127.0.0.1:${port}`) {
      return page(res, 404, 'Nothing here', 'This address is only used while FriendsShare signs you in.');
    }
    const code = url.searchParams.get('code');
    if (!code || !safeEqual(url.searchParams.get('state') || '', flow.state)) {
      return page(res, 400, 'This sign-in did not start here', 'It was not started by FriendsShare on this PC. Go back to FriendsShare and click Sign in.');
    }
    if (flow.used) return page(res, 400, 'This sign-in link was already used', 'Go back to FriendsShare.');
    flow.used = true;

    let result;
    try {
      const body = await api('/api/app/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, verifier: flow.verifier }),
      });
      if (!body || typeof body.token !== 'string' || !TOKEN_RE.test(body.token)) {
        throw new Error('The FriendsShare server sent an answer this version does not understand.');
      }
      result = { token: body.token, account: cleanAccount(body.account), plan: body.plan === 'pro' ? 'pro' : 'free' };
    } catch (err) {
      page(res, 400, 'Signing in did not work', `${err.message} Go back to FriendsShare and click Sign in to try again.`);
      return giveUp(flow, err.message);
    }

    storeToken(result.token);
    config().welcome = { ...current(), account: result.account, plan: result.plan };
    save();
    error = null;
    page(res, 200, 'You are signed in.', 'You can close this tab and go back to FriendsShare.');
    stop(flow);
    push();
    // the new hello has to carry the token
    reconnect();
    bringToFront();
    if (afterSignIn) {
      afterSignIn = false;
      try {
        await openWeblink();
      } catch (err) {
        error = err.message;
        push();
      }
    }
  }

  async function open(url) {
    try {
      await openUrl(url);
    } catch {
      throw new Error('FriendsShare could not open your browser. Check that you have a default browser and try again.');
    }
  }

  // Starts signing in: a little server on this PC that the browser comes back to, and the website's
  // sign-in page in the system browser. Resolves once the browser was opened; the rest happens when
  // the person has signed in there (see onRequest) and is reported through notify.
  async function signIn() {
    error = null;
    if (pending) {
      // a second click: the same page again, the person may have lost the tab
      const flow = pending;
      await flow.ready;
      await open(flow.url);
      return state();
    }
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const flow = { verifier, state: b64url(crypto.randomBytes(16)), url: null, server: http.createServer(), timer: null, used: false };
    flow.server.on('request', (req, res) => onRequest(flow, req, res).catch(() => res.destroy()));
    flow.ready = new Promise((resolve, reject) => {
      flow.server.once('error', reject);
      flow.server.listen(0, '127.0.0.1', () => {
        flow.server.off('error', reject);
        flow.url = `${siteUrl()}/login?app_port=${flow.server.address().port}&app_state=${flow.state}&app_challenge=${challenge}`;
        resolve();
      });
    });
    pending = flow;
    try {
      await flow.ready;
    } catch (err) {
      stop(flow);
      throw new Error(`Could not start signing in (${err.code || err.message}).`);
    }
    flow.timer = setTimeout(() => giveUp(flow, 'Signing in took too long. Click Sign in to try again.'), timeoutMs);
    push();
    try {
      await open(flow.url);
    } catch (err) {
      stop(flow);
      push();
      throw err;
    }
    return state();
  }

  function cancelSignIn() {
    if (pending) stop(pending);
    afterSignIn = false;
    error = null;
    push();
    return state();
  }

  // Forgets the token at once, so the window and the next hello are signed out whatever the network
  // does; the server is told as well, best effort.
  async function signOut() {
    if (pending) stop(pending);
    afterSignIn = false;
    error = null;
    const old = token();
    if (old === null) {
      push();
      return state();
    }
    forgetToken();
    save();
    push();
    reconnect();
    try {
      await api('/api/logout', { method: 'POST', headers: { Authorization: `Bearer ${old}` } });
    } catch {
      // offline: the session on the server simply ends by itself after 180 days without use
    }
    return state();
  }

  // ---- the account page on the website ----

  // Asks for a one-time link that signs the browser in as this account, and opens it. Only a link to
  // our own site is ever opened, whatever the answer says.
  async function openWeblink() {
    const value = token();
    let body;
    try {
      body = await api('/api/app/weblink', { method: 'POST', headers: { Authorization: `Bearer ${value}` } });
    } catch (err) {
      if (err.status === 401) {
        // the server does not know this sign-in any more
        forgetToken();
        save();
        push();
        reconnect();
        throw new Error('You were signed out. Sign in again to open your account.');
      }
      throw err;
    }
    let link = null;
    try {
      link = new URL(body.url);
    } catch {}
    if (!link || link.pathname !== '/auth/link' || !sameSite(link, siteUrl())) {
      throw new Error('The FriendsShare server sent an answer this version does not understand.');
    }
    await open(link.href);
  }

  // "Upgrade to Pro" and "Manage subscription": the account page, already signed in. Without a
  // sign-in yet, the person signs in first and the page opens when that is done.
  async function openAccountPage() {
    error = null;
    if (token() === null) {
      afterSignIn = true;
      await signIn();
      return state();
    }
    await openWeblink();
    return state();
  }

  return { init, state, token, welcome, plan, signIn, cancelSignIn, signOut, openAccountPage };
}

module.exports = { createAccount, deriveSite, normalizeSignalUrl, cleanWelcome, cleanAccount, sameSite };
