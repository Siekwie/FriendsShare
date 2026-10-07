// The operator's admin interface: accounts, subscriptions, what the server is doing and the
// anonymous traffic totals, as web pages. It is a listener of its own, started on its own
// (`node admin.js`, the friendsshare-admin container) and never put behind the proxy.
//
// It has no login. What protects it instead:
//   - It listens only where the operator can reach it: 127.0.0.1 unless told otherwise. In Docker
//     the port is published on the server's loopback and opened from the operator's PC through an
//     SSH tunnel.
//   - It answers only requests addressed to localhost (the Host header), so a web page that points
//     its own domain at 127.0.0.1 (DNS rebinding) gets nothing.
//   - It only shows things. There is no request here that changes anything, so there is nothing
//     another website could make the operator's browser do. Whoever adds one has to add a token to
//     every form first, one that other sites cannot read.
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { securityHeaders, send } = require('./http');
const { accountStats, searchAccounts, accountDetail, blockedRooms, serverState, ACCOUNT_ID_RE } = require('./admin-data');
const { overviewPage, accountsPage, accountPage, trafficPage, adminMessagePage } = require('./admin-pages');
const { trafficReport } = require('./stats');

const PAGE_SIZE = 50;

const PAGE_CSP = ["default-src 'none'", "img-src 'self'", "style-src 'self'", "script-src 'self'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"].join('; ');

const TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// What the pages borrow from the website, under the name they are served by here.
const FROM_SITE = { 'site.css': 'site.css', 'logo.svg': path.join('img', 'logo.svg'), 'favicon.ico': 'favicon.ico' };

// localhost, 127.0.0.1 or [::1] with any port: what a browser sends through the SSH tunnel.
const isLocalHost = (host) => typeof host === 'string' && /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i.test(host);

// name -> { body, type, hash }: the files of admin-site/ and the borrowed ones, read once.
function loadStatic(config) {
  const files = new Map();
  const add = (name, file) => {
    const type = TYPES[path.extname(name).toLowerCase()];
    if (!type) return;
    try {
      const body = fs.readFileSync(file);
      files.set(name, { body, type, hash: crypto.createHash('sha256').update(body).digest('hex').slice(0, 10) });
    } catch {
      // a page then points at a file that is not there, which shows soon enough
    }
  };
  for (const [name, file] of Object.entries(FROM_SITE)) add(name, path.join(config.siteDir, file));
  let own = [];
  try {
    own = fs.readdirSync(config.adminSiteDir);
  } catch {}
  for (const name of own) add(name, path.join(config.adminSiteDir, name));
  return files;
}

const text = (status, body, headers = {}) => ({ status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers }, body });
const redirect = (status, location) => ({ status, headers: { Location: location, 'Cache-Control': 'no-store' }, body: '' });

// A file from loadStatic(): kept for a year when asked for with its hash (?v=), else for an hour.
function staticReply(file, url, req) {
  const etag = `"${file.hash}"`;
  const cache = url.searchParams.get('v') === file.hash ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';
  if (req.headers['if-none-match'] === etag) return { status: 304, headers: { ETag: etag, 'Cache-Control': cache }, body: '' };
  return { status: 200, headers: { 'Content-Type': file.type, ETag: etag, 'Cache-Control': cache }, body: file.body };
}

function createAdminApp({ config, db, now = Date.now, log = (line) => console.log(line) }) {
  const files = loadStatic(config);

  const site = () => ({
    config,
    now: now(),
    asset: (name) => {
      const file = files.get(name);
      return file ? `/static/${encodeURIComponent(name)}?v=${file.hash}` : `/static/${encodeURIComponent(name)}`;
    },
  });

  const page = (status, body) => ({
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': PAGE_CSP,
      // the pages name people: nothing about them leaves with a link to another site
      'Referrer-Policy': 'same-origin',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
    body,
  });

  const notFound = () => page(404, adminMessagePage(site(), { title: 'Not found', text: "There's nothing at this address." }));

  // ---- pages ----

  function overview() {
    const t = now();
    return page(
      200,
      overviewPage(site(), {
        stats: accountStats(db, t),
        state: serverState(db, config),
        newest: searchAccounts(db, { limit: 8 }, t).rows,
        blocked: blockedRooms(db),
      }),
    );
  }

  function list(url) {
    const query = (url.searchParams.get('q') || '').trim().slice(0, 200);
    const planParam = url.searchParams.get('plan');
    const plan = planParam === 'pro' || planParam === 'free' ? planParam : undefined;
    const pageNo = Math.min(Math.max(1, Number.parseInt(url.searchParams.get('page') || '1', 10) || 1), 1_000_000);
    const { rows, total } = searchAccounts(db, { query, plan, limit: PAGE_SIZE, offset: (pageNo - 1) * PAGE_SIZE }, now());
    // a search with exactly one hit goes straight to that account
    if (query && !plan && pageNo === 1 && total === 1) return redirect(302, `/accounts/${rows[0].id}`);
    return page(200, accountsPage(site(), { rows, total, query, plan, page: pageNo, pageSize: PAGE_SIZE }));
  }

  function traffic() {
    const t = now();
    return page(200, trafficPage(site(), { report: trafficReport(db, t), stats: accountStats(db, t), live: serverState(db, config).live }));
  }

  // ---- routing ----

  function route(req) {
    if (!isLocalHost(req.headers.host)) {
      return text(403, `The FriendsShare admin interface only answers on localhost. Open it through the SSH tunnel, e.g. http://localhost:${config.admin.port}/\n`);
    }
    const rawUrl = req.url || '/';
    if (rawUrl.length > 2048) return text(414, 'URI too long\n');
    let url;
    try {
      url = new URL(rawUrl, 'http://localhost');
    } catch {
      return text(400, 'Bad request\n');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return text(405, 'Method not allowed\n', { Allow: 'GET, HEAD' });

    const pathname = url.pathname;
    if (pathname === '/') return overview();
    if (pathname === '/healthz') {
      db.get('SELECT 1 AS ok');
      return text(200, 'ok');
    }
    if (pathname === '/accounts') return list(url);
    if (pathname === '/traffic') return traffic();
    if (pathname.startsWith('/accounts/')) {
      const id = pathname.slice('/accounts/'.length);
      const found = ACCOUNT_ID_RE.test(id) ? accountDetail(db, id, now()) : null;
      return found ? page(200, accountPage(site(), found)) : notFound();
    }
    if (pathname === '/favicon.ico') return redirect(301, site().asset('favicon.ico'));
    if (pathname.startsWith('/static/')) {
      const file = files.get(pathname.slice('/static/'.length));
      return file ? staticReply(file, url, req) : notFound();
    }
    return notFound();
  }

  function handle(req, res) {
    securityHeaders(res);
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    let reply;
    try {
      reply = route(req);
    } catch (err) {
      // the path only: a query can hold the name somebody was searched for
      log(`[admin] ${req.method} ${String(req.url || '').split('?')[0].slice(0, 200)} failed: ${(err && err.stack) || err}`);
      reply = text(500, 'Something went wrong. The details are in the log: docker logs friendsshare-admin\n');
    }
    send(res, reply.status, reply.body, reply.headers);
  }

  return { handle };
}

function createAdminServer(deps) {
  const server = http.createServer({ requestTimeout: 30_000, headersTimeout: 15_000 }, createAdminApp(deps).handle);
  server.keepAliveTimeout = 65_000;
  return server;
}

module.exports = { createAdminApp, createAdminServer, isLocalHost, PAGE_CSP };
