// Puts the pieces together: one HTTP server (website, JSON API, sign-in) with the matchmaking
// WebSocket on the same port. createServer takes everything it talks to as arguments, so tests
// run it in-process on port 0 with a fake fetch and their own clock.
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { openDb, cleanup } = require('./db');
const { takeBackup, backupDue } = require('./backup');
const {
  HttpError, fail, securityHeaders, sendJson, send, redirect, parseCookies, serializeCookie, addCookie,
  readJson, readForm, clientAddress, addressKey, fromThisMachine, createLimiter, crossSite,
} = require('./http');
const { createAuth, hasBearer } = require('./auth');
const { createBilling } = require('./billing');
const { createAccountApi } = require('./account');
const { createBuilds } = require('./builds');
const { createMatch } = require('./match');
const { createOperator } = require('./operator');
const { createSite } = require('./site');
const { Today, recordRequest } = require('./stats');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// The secret that keys the hashes of tokens and codes: APP_SECRET, else one generated next to the
// database. Changing it signs everybody out.
function ensureSecret(dataDir, log) {
  const file = path.join(dataDir, 'secret.key');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {}
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  log('[config] created a new secret key in the data directory');
  return secret;
}

// Before accounts existed the rooms lived in rooms.json. They move into the database once, and the
// file is renamed so it is not read again.
function importRooms(db, dataDir, now, log) {
  const file = path.join(dataDir, 'rooms.json');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return; // nothing to import
  }
  try {
    let imported = 0;
    db.tx(() => {
      for (const [room, rec] of Object.entries(JSON.parse(text))) {
        if (!/^[0-9a-f]{64}$/.test(room) || !rec || !/^[0-9a-f]{64}$/.test(rec.keyHash) || typeof rec.exp !== 'number' || rec.exp <= now()) continue;
        imported += db.run('INSERT OR IGNORE INTO rooms (room, key_hash, exp) VALUES (?, ?, ?)', room, rec.keyHash, Math.floor(rec.exp)).changes;
      }
    });
    fs.renameSync(file, `${file}.imported`);
    log(`[db] imported ${imported} rooms from rooms.json`);
  } catch (err) {
    log(`[db] rooms.json could not be imported: ${err.message}`);
    try {
      fs.renameSync(file, `${file}.unreadable`);
    } catch {}
  }
}

function createServer({ config, fetchFn = globalThis.fetch, now = Date.now, log = (line) => console.log(line) }) {
  if (!config.appSecret) config.appSecret = ensureSecret(config.dataDir, log);
  const db = openDb(config.dbPath);
  importRooms(db, config.dataDir, now, log);
  const startedAt = now();
  const origin = new URL(config.baseUrl).origin;

  // modules tell the matchmaking about changes that concern open connections
  let match;
  const hooks = {
    planChanged: (accountId) => match.assignPlans(accountId),
    sessionEnded: (tokenHash) => match.endSession(tokenHash),
    accountDeleted: (accountId) => match.accountDeleted(accountId),
  };
  const deps = { config, db, fetchFn, now, log, hooks };

  const builds = createBuilds(deps);
  const site = createSite({ config, now, latestVersion: builds.latestVersion });
  const auth = createAuth({ ...deps, site });
  const billing = createBilling(deps);
  const account = createAccountApi({ ...deps, auth, billing });
  match = createMatch({ config, db, auth, builds, now, log });

  // ---- routes ----

  const routes = new Map();
  const router = { add: (method, route, handler, options = {}) => routes.set(`${method} ${route}`, { handler, options }) };
  const findRoute = (method, route) => routes.get(`${method} ${route}`) || (method === 'HEAD' ? routes.get(`GET ${route}`) : undefined);

  auth.register(router);
  billing.register(router);
  account.register(router);

  // answers whatever it is sent; a monitor may well carry an Authorization header
  router.add(
    'GET',
    '/healthz',
    (ctx) => {
      db.get('SELECT 1 AS ok');
      send(ctx.res, 200, 'ok', { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    },
    { bearer: true },
  );

  // The download button of the website. The file comes from GitHub; the click passes through here
  // so that it can be counted (lib/stats.js).
  router.add('GET', '/download', (ctx) => ctx.redirect(`${config.repoUrl}/releases/latest/download/FriendsShare.exe`));

  // for the operator, from inside the machine only (see handle)
  createOperator({ db, match, now, log, startedAt }).register(router);

  // ---- for the admin interface (admin.js), which is a process of its own and sees only the database ----

  const today = new Today();
  const ownHost = new URL(config.baseUrl).hostname.replace(/^www\./, '');
  let closing = null;

  // Adds an answered request to the anonymous daily totals.
  function count(req, res, pathname) {
    if (closing) return;
    try {
      recordRequest(db, today, {
        nowMs: now(),
        method: req.method,
        path: pathname,
        status: res.statusCode,
        address: clientAddress(req, config.trustProxy),
        userAgent: String(req.headers['user-agent'] || ''),
        referrer: req.headers.referer,
        ownHost,
      });
    } catch (err) {
      log(`[stats] could not count a request: ${err.message}`);
    }
  }

  // Who is connected right now is known to the matchmaking alone, so its counts (no more than
  // /internal/stats gives) are left in the database now and then.
  function writeLive() {
    try {
      const live = JSON.stringify({ at: now(), started_at: startedAt, ...match.snapshot() });
      db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'live', live);
    } catch (err) {
      log(`[stats] the counts of right now could not be written: ${err.message}`);
    }
  }

  // Each kind of sign-in request is counted for itself, per address: a sign-in that is started,
  // one that comes back from the provider, a link from the app, and so on. What costs nothing to
  // refuse is not counted, so nobody can use up another person's share by sending them requests.
  const limiters = Object.fromEntries(['start', 'callback', 'link', 'continue', 'exchange'].map((name) => [name, createLimiter(config.tuning.authRate, now)]));

  function makeContext(req, res, url) {
    let cookies;
    let authenticated;
    return {
      req,
      res,
      url,
      query: url.searchParams,
      get cookies() {
        return cookies || (cookies = parseCookies(req.headers.cookie));
      },
      get ip() {
        return clientAddress(req, config.trustProxy);
      },
      auth() {
        if (authenticated === undefined) authenticated = auth.authenticate(req) || null;
        return authenticated;
      },
      // throws the 429 when this address has used up its share of this kind of request
      rateLimit(name) {
        if (limiters[name].allow(addressKey(clientAddress(req, config.trustProxy)))) return;
        fail(429, 'rate_limited', 'Too many attempts. Please wait a few minutes and try again.', { 'Retry-After': String(Math.ceil(config.tuning.authRate.windowMs / 1000)) });
      },
      body: () => readJson(req, config.tuning.jsonBodyBytes),
      form: () => readForm(req, config.tuning.formBodyBytes),
      json: (status, value) => sendJson(res, status, value),
      noContent() {
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        res.end();
      },
      redirect: (location, status) => redirect(res, location, status),
      // a __Host- cookie is only valid for the whole site, over a secure connection
      setCookie: (name, value, options) =>
        addCookie(res, serializeCookie(name, value, { ...options, ...(name.startsWith('__Host-') ? { path: '/' } : {}), secure: config.secureCookies })),
      clearCookie: (name, cookiePath) =>
        addCookie(res, serializeCookie(name, '', { maxAge: 0, path: name.startsWith('__Host-') ? '/' : cookiePath, secure: config.secureCookies })),
    };
  }

  async function handle(req, res) {
    securityHeaders(res);
    let pathname = '/';
    res.once('finish', () => count(req, res, pathname));
    try {
      // origin-form only; "//host/path" would otherwise parse as a different host
      if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//')) fail(400, 'bad_request', 'That address is not valid.');
      const url = new URL(req.url, 'http://localhost');
      pathname = url.pathname;
      const ctx = makeContext(req, res, url);
      // The operator's routes are for the machine itself and nobody else. That is decided by the
      // path, before any route is looked up, so that a route added later cannot forget to ask; what
      // anybody else gets is what any other unknown address gets, so the answer does not even say
      // that something is there.
      const operatorOnly = pathname === '/internal' || pathname.startsWith('/internal/');
      const route = operatorOnly && !fromThisMachine(req) ? undefined : findRoute(req.method, pathname);

      if (route) {
        // The app's token is good for a few routes only; everything else is for a browser session.
        if (hasBearer(req) && !route.options.bearer) {
          fail(403, 'forbidden', "The app's sign-in only works for the app itself. Please use the website in your browser for this.");
        }
        // Another site must not be able to make a signed-in browser act. The webhook is signed by
        // Stripe, and the app's calls carry a Bearer token or a one-time code, not a cookie.
        if (!SAFE_METHODS.has(req.method) && !route.options.webhook && !route.options.noOrigin && !hasBearer(req) && crossSite(req, origin)) {
          fail(403, 'forbidden', 'This request did not come from this site, so it was refused.');
        }
        return await route.handler(ctx);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') fail(404, 'not_found', 'There is nothing here.');
      if (pathname.startsWith('/api/')) fail(404, 'not_found', 'There is nothing here.');
      if (operatorOnly) return await site.notFound(req, res);
      await site.handle(req, res, pathname);
    } catch (err) {
      if (res.headersSent) return res.destroy();
      if (err instanceof HttpError) {
        const headers = { ...err.headers };
        // the rest of an oversized upload is not worth reading
        if (err.status === 413) headers.Connection = 'close';
        return sendJson(res, err.status, { error: err.code, message: err.message }, headers);
      }
      log(`[http] ${req.method} ${pathname} failed: ${err && err.message}`);
      sendJson(res, 500, { error: 'internal', message: 'Something went wrong on our side. Please try again in a moment.' });
    }
  }

  const { requestTimeoutMs, headersTimeoutMs } = config.tuning;
  // Node only looks for slow requests now and then (every 30 seconds unless told otherwise), which
  // would make a 15 second timeout mean anything up to 45
  const server = http.createServer({ connectionsCheckingInterval: Math.max(100, Math.floor(headersTimeoutMs / 3)) }, (req, res) => {
    handle(req, res).catch(() => res.destroy());
  });
  // A request that is slow to arrive is not worth waiting for. Whoever opens connections and then
  // sends nothing, or one byte at a time, would otherwise hold them for minutes.
  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = headersTimeoutMs;
  // Caddy keeps connections to us open for a while; closing them sooner makes it hit a dead one
  server.keepAliveTimeout = 125_000;
  server.on('upgrade', (req, socket, head) => {
    try {
      match.handleUpgrade(req, socket, head);
    } catch (err) {
      // an error nothing catches ends the program (see process.js), so one odd request must not cause one
      log(`[match] an upgrade could not be handled: ${err && err.message}`);
      socket.destroy();
    }
  });
  // for instance "too many open files" when accepting a connection: said, and not a crash
  server.on('error', (err) => log(`[http] the server reported an error: ${err.code || err.message}`));

  // ---- background work ----

  let timers = [];

  function runCleanup() {
    try {
      cleanup(db, now());
      match.expireRooms();
    } catch (err) {
      log(`[db] cleanup failed: ${err.message}`);
    }
  }

  function runBackup() {
    try {
      if (backupDue(config.backup.dir, config.backup.intervalHours, now())) {
        takeBackup(db, config.backup.dir, config.backup.keep, now());
        log('[backup] snapshot written');
      }
    } catch (err) {
      log(`[backup] failed: ${err.message}`);
    }
  }

  function start() {
    runCleanup();
    runBackup();
    builds.refreshLatest();
    writeLive();
    timers.push(
      setInterval(runCleanup, config.tuning.cleanupIntervalMs),
      setInterval(runBackup, config.tuning.backupCheckMs),
      setInterval(() => builds.refreshLatest(), config.tuning.releaseRefreshMs),
      setInterval(writeLive, config.tuning.liveIntervalMs),
    );
    for (const timer of timers) timer.unref();
    match.start();
  }

  function listen(port = config.port, host) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        start();
        resolve({ port: server.address().port });
      });
    });
  }

  function close() {
    if (closing) return closing;
    for (const timer of timers) clearInterval(timer);
    timers = [];
    match.close();
    closing = new Promise((resolve) => {
      server.close(() => {
        db.close();
        resolve();
      });
      server.closeIdleConnections();
      // a request that is still running gets a moment, then the connection goes
      setTimeout(() => server.closeAllConnections(), 1500).unref();
    });
    return closing;
  }

  return { server, db, config, listen, close, runCleanup, runBackup, writeLive, match, auth, builds, router };
}

module.exports = { createServer };
