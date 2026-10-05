// Test harness: the whole server in-process on port 0, a fake GitHub, Google, Stripe and release
// lookup standing in for the network, a clock the tests control, a small browser (cookie jar) and
// a WebSocket client that plays the app. Nothing here touches the real network or server/site/.
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { loadConfig } = require('../lib/config');
const { createServer } = require('../lib/server');
const { buildKey, makeProof } = require('../lib/builds');

const BASE = 'https://friendsshare.test';
// over https the cookies carry the __Host- prefix (plain http, see the cookie tests, does not)
const SESSION = '__Host-fs_session';
const STATE = '__Host-fs_oauth_state';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
// where the tests' clock starts
const START = Date.parse('2026-10-05T12:00:00Z');

// waits until the condition holds (the server finishes some things a moment after the client sees them)
async function until(condition, ms = 2000) {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error('the condition did not become true in time');
    await sleep(5);
  }
}

// ---- a small website to serve ----

function write(dir, file, content) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
}

function writeSite(dir) {
  write(dir, 'index.html', [
    '<!doctype html><html><head><title>Home</title><link rel="stylesheet" href="/site.css"></head><body>',
    '<!--include header-->',
    '<h1>{{operator_name}}</h1>',
    '<p id="raw">{{{operator_address}}}</p>',
    '<p id="escaped">{{operator_address}}</p>',
    '<p id="when-on"><!--if billing-->billing on<!--endif--></p>',
    '<p id="when-off"><!--if !billing-->billing off<!--endif--></p>',
    '<p id="version"><!--if version-->v{{version}}<!--endif--><!--if !version-->unknown<!--endif--></p>',
    '<p id="misc">{{free_limit}}|{{price_monthly}}|{{price_yearly}}|{{price_yearly_per_month}}|{{unknown_key}}|{{constructor}}|{{ site_url }}</p>',
    '<p id="logins"><!--if github_login-->gh<!--endif--><!--if google_login-->go<!--endif--><!--if any_login-->any<!--endif--></p>',
    '<p id="urls">{{repo_url}}|{{download_url}}|{{backup_days}}</p>',
    '<!--include footer-->',
    '</body></html>',
  ].join('\n'));
  write(dir, 'login.html', '<!doctype html><title>Sign in</title><h1>Sign in</h1>');
  // the confirmation page for a link from the app; the tests read the values out of it
  write(dir, 'link.html', [
    '<!doctype html><title>Link</title><h1>FIXTURE LINK PAGE</h1>',
    '<p id="who">{{link_name}}|{{link_email}}</p>',
    '<form method="post" action="/auth/link"><input type="hidden" name="code" value="{{link_code}}"><input type="hidden" name="next" value="{{link_next}}"><button>Sign in</button></form>',
  ].join('\n'));
  write(dir, 'account.html', '<!doctype html><title>Account</title><h1>Account</h1>');
  write(dir, '404.html', '<!doctype html><title>Not found</title><h1>Nothing here</h1><!--include footer-->');
  write(dir, 'imprint.html', '<!doctype html><title>Imprint</title><h1>Imprint of {{operator_name}}</h1><p>{{{operator_address}}}</p><p>{{operator_email}}</p>');
  write(dir, 'privacy.html', '<!doctype html><title>Privacy</title><h1>Privacy</h1><p>{{operator_hosting}}</p><p>{{backup_days}} days</p>');
  write(dir, 'terms.html', '<!doctype html><title>Terms</title><h1>Terms</h1>');
  write(dir, 'partials/header.html', '<header>{{site_url}}<!--if github_login--> github-login<!--endif--><!--if !any_login--> no-login<!--endif--></header>');
  write(dir, 'partials/footer.html', '<footer><!--if operator--><a href="/imprint">Imprint</a><!--endif--><!--if !operator-->no-imprint<!--endif--> {{year}}</footer>');
  write(dir, 'partials/secret.html', 'PARTIAL-SECRET-MARKER');
  write(dir, 'site.css', 'body { margin: 0 }');
  write(dir, 'js/app.js', 'window.x = 1;');
  write(dir, 'img/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
  write(dir, 'robots.txt', 'User-agent: *\n');
  write(dir, 'favicon.ico', Buffer.from([0, 0, 1, 0]));
  write(dir, 'data.bin', Buffer.from([1, 2, 3]));
  write(dir, '.hidden.html', 'hidden');
}

// ---- the network, faked ----

const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// What Stripe would say about a subscription of ours. newApi puts the period on the item, as newer API versions do.
function subscription({ id = 'sub_1', customer = 'cus_1', status = 'active', price, accountId, periodEnd, cancelAtPeriodEnd = false, newApi = false, metadata }) {
  const item = { id: 'si_1', price: { id: price, recurring: { interval: 'month' } } };
  const sub = {
    id,
    object: 'subscription',
    customer,
    status,
    cancel_at_period_end: cancelAtPeriodEnd,
    items: { data: [item] },
    metadata: metadata || { app: 'friendsshare', fs_account: accountId },
  };
  if (newApi) item.current_period_end = periodEnd;
  else sub.current_period_end = periodEnd;
  return sub;
}

function createNet(config) {
  const net = {
    calls: [],
    github: { users: {} },
    google: { users: {} },
    release: { tag: 'v1.2.0', fail: false },
    // version -> the build.json GitHub would serve; a version that is not here is a 404
    builds: {},
    hold: null,
    down: null,
    // customers: id -> the form it was made with; checkoutSessions: id -> { status: open | complete | expired, form }
    // approval: what the key may not do without a person's yes, per kind of call (cancel: DELETE of a subscription,
    //   update: POST to it): true for every subscription, or a Set of subscription ids.
    // approvals: the requests that were made for the owner, one for each such call.
    stripe: { subscriptions: {}, customers: {}, checkoutSessions: {}, customerCount: 0, sessions: 0, portals: 0, fail: {}, approval: { cancel: false, update: false }, approvals: [] },
    calling: (predicate) => net.calls.filter(predicate),
  };

  net.fetch = async (url, init = {}) => {
    // the network is gone (set net.down to the error to throw)
    if (net.down) throw net.down;
    const u = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const call = { method, url: String(url), host: u.hostname, path: u.pathname, headers, body: init.body };
    if (typeof init.body === 'string') {
      if (headers['content-type'] === 'application/json') call.json = JSON.parse(init.body);
      else call.form = Object.fromEntries(new URLSearchParams(init.body));
    }
    net.calls.push(call);

    // ---- GitHub ----
    if (u.hostname === 'github.com' && u.pathname === '/login/oauth/access_token') {
      const { client_id: id, client_secret: secret, code, redirect_uri: redirect } = call.json;
      const user = net.github.users[code];
      if (id !== config.github.clientId || secret !== config.github.clientSecret || redirect !== `${config.baseUrl}/auth/github/callback` || !user) {
        return jsonResponse(200, { error: 'bad_verification_code' });
      }
      return jsonResponse(200, { access_token: `gho_${code}`, token_type: 'bearer', scope: 'read:user,user:email' });
    }
    if (u.hostname === 'api.github.com' && (u.pathname === '/user' || u.pathname === '/user/emails')) {
      const code = /^Bearer gho_(.+)$/.exec(headers.authorization || '');
      const user = code && net.github.users[code[1]];
      if (!user) return jsonResponse(401, { message: 'Bad credentials' });
      if (u.pathname === '/user/emails') return jsonResponse(200, user.emails);
      const { emails, ...profile } = user;
      return jsonResponse(200, profile);
    }
    if (u.hostname === 'api.github.com' && u.pathname === `/repos/${config.releaseRepo}/releases/latest`) {
      return net.release.fail ? jsonResponse(500, { message: 'down' }) : jsonResponse(200, { tag_name: net.release.tag });
    }
    const download = u.hostname === 'github.com' && new RegExp(`^/${config.releaseRepo}/releases/download/v([^/]+)/build.json$`).exec(u.pathname);
    if (download) {
      // lets a test keep a lookup waiting while others pile up
      if (net.hold) await net.hold;
      const info = net.builds[download[1]];
      return info ? jsonResponse(200, info) : jsonResponse(404, { message: 'Not Found' });
    }

    // ---- Google ----
    if (u.hostname === 'oauth2.googleapis.com' && u.pathname === '/token') {
      const form = call.form;
      const user = net.google.users[form.code];
      if (!user || form.client_id !== config.google.clientId || form.client_secret !== config.google.clientSecret || form.grant_type !== 'authorization_code' || form.redirect_uri !== `${config.baseUrl}/auth/google/callback`) {
        return jsonResponse(400, { error: 'invalid_grant' });
      }
      return jsonResponse(200, { access_token: `ya29.${form.code}`, token_type: 'Bearer', id_token: 'ignored' });
    }
    if (u.hostname === 'openidconnect.googleapis.com' && u.pathname === '/v1/userinfo') {
      const code = /^Bearer ya29\.(.+)$/.exec(headers.authorization || '');
      const user = code && net.google.users[code[1]];
      return user ? jsonResponse(200, user) : jsonResponse(401, { error: 'invalid_token' });
    }

    // ---- Stripe ----
    if (u.hostname === 'api.stripe.com') {
      if (headers.authorization !== `Bearer ${config.stripe.secretKey}`) return jsonResponse(401, { error: { type: 'invalid_request_error', code: 'api_key_invalid', message: 'Invalid API Key provided' } });
      const route = u.pathname.replace(/^\/v1/, '');
      // failures are switched on per call, e.g. net.stripe.fail['DELETE /subscriptions/:id'] = { status: 500 }
      const shape = route.replace(/^\/subscriptions\/[^/]+$/, '/subscriptions/:id').replace(/^\/checkout\/sessions\/[^/]+\/expire$/, '/checkout/sessions/:id/expire');
      const fail = net.stripe.fail[`${method} ${shape}`];
      if (fail) return jsonResponse(fail.status, { error: { type: 'api_error', code: fail.code, message: fail.message || `Stripe says no, and quotes ${config.stripe.secretKey}` } });
      if (method === 'POST' && route === '/customers') {
        const id = `cus_made_${++net.stripe.customerCount}`;
        net.stripe.customers[id] = call.form;
        return jsonResponse(200, { id, object: 'customer', email: call.form.email || null, name: call.form.name || null });
      }
      if (method === 'POST' && route === '/checkout/sessions') {
        const id = `cs_test_${++net.stripe.sessions}`;
        net.stripe.checkoutSessions[id] = { id, status: 'open', form: call.form };
        return jsonResponse(200, { id, url: `https://checkout.stripe.com/c/pay/${id}` });
      }
      const expire = /^\/checkout\/sessions\/([^/]+)\/expire$/.exec(route);
      if (expire && method === 'POST') {
        // lets a test make something happen while the server waits for this answer
        if (net.stripe.onExpire) await net.stripe.onExpire(expire[1]);
        const found = net.stripe.checkoutSessions[expire[1]];
        if (!found) return jsonResponse(404, { error: { type: 'invalid_request_error', code: 'resource_missing', message: `No such checkout.session: '${expire[1]}'` } });
        // what Stripe says about a session that is not open any more
        if (found.status !== 'open') return jsonResponse(400, { error: { type: 'invalid_request_error', message: `Only Checkout Sessions with a status in open can be expired. This Session has a status of ${found.status}.` } });
        found.status = 'expired';
        return jsonResponse(200, { id: found.id, object: 'checkout.session', status: 'expired' });
      }
      if (method === 'POST' && route === '/billing_portal/sessions') {
        net.stripe.portals++;
        return jsonResponse(200, { id: `bps_${net.stripe.portals}`, url: `https://billing.stripe.com/p/session/test_${net.stripe.portals}` });
      }
      const sub = /^\/subscriptions\/([^/]+)$/.exec(route);
      if (sub && method === 'GET') {
        const found = net.stripe.subscriptions[sub[1]];
        return found ? jsonResponse(200, found) : jsonResponse(404, { error: { type: 'invalid_request_error', code: 'resource_missing', message: `No such subscription: '${sub[1]}'` } });
      }
      // A key with Stripe's approval rules: the call does nothing but make a request for the owner (the
      // answer is the one Stripe gives).
      const needsApproval = (kind) => net.stripe.approval[kind] === true || (net.stripe.approval[kind] instanceof Set && net.stripe.approval[kind].has(sub && sub[1]));
      const askForApproval = (kind) => {
        net.stripe.approvals.push({ kind, subscription: sub[1] });
        return jsonResponse(403, {
          error: {
            type: 'invalid_request_error',
            code: 'approval_required',
            message: 'This action requires human approval before it can be completed. An approval request has been created and is awaiting review. If approved, it will automatically execute.',
          },
        });
      };
      if (sub && method === 'DELETE') {
        if (net.stripe.onDelete) net.stripe.onDelete(sub[1]);
        if (needsApproval('cancel')) return askForApproval('cancel');
        const found = net.stripe.subscriptions[sub[1]];
        if (!found) return jsonResponse(404, { error: { type: 'invalid_request_error', code: 'resource_missing', message: `No such subscription: '${sub[1]}'` } });
        found.status = 'canceled';
        return jsonResponse(200, found);
      }
      if (sub && method === 'POST') {
        if (needsApproval('update')) return askForApproval('update');
        const found = net.stripe.subscriptions[sub[1]];
        if (!found) return jsonResponse(404, { error: { type: 'invalid_request_error', code: 'resource_missing', message: `No such subscription: '${sub[1]}'` } });
        if (found.status === 'canceled') return jsonResponse(400, { error: { type: 'invalid_request_error', message: 'A canceled subscription can only update its cancellation_details.' } });
        if (call.form && call.form.cancel_at_period_end !== undefined) found.cancel_at_period_end = call.form.cancel_at_period_end === 'true';
        return jsonResponse(200, found);
      }
    }
    return jsonResponse(404, { error: `the test network has nothing at ${url}` });
  };
  return net;
}

// ---- talking to the server ----

function rawRequest(port, method, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const text = raw.toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json, raw, cookies: res.headers['set-cookie'] || [] });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// A request written by hand: the headers of a POST that announces `contentLength` bytes of body,
// and then nothing (or `body`, if given). For uploads that are too large. The server answers 413
// from the headers alone and closes the connection; Node's own client would write the whole body
// first, and a connection that closes while it is still writing can be reset before the answer is
// read. Here the answer is always read, whatever the machine is doing.
function announce(port, method, urlPath, headers, contentLength, body = '') {
  return new Promise((resolve, reject) => {
    // "close" so that every answer, not only a refusal, ends with the connection closing
    const sent = { host: '127.0.0.1', connection: 'close', ...headers, 'content-length': contentLength };
    const head = [`${method} ${urlPath} HTTP/1.1`, ...Object.entries(sent).map(([name, value]) => `${name}: ${value}`), '', ''].join('\r\n');
    const chunks = [];
    const socket = net.connect(port, '127.0.0.1', () => socket.write(head + body));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const at = raw.indexOf('\r\n\r\n');
      const text = at < 0 ? '' : raw.slice(at + 4);
      let json;
      try {
        json = JSON.parse(text);
      } catch {}
      resolve({ status: Number((/^HTTP\/1\.1 (\d{3})/.exec(raw) || [])[1]) || null, text, json, raw });
    });
    // a server that kept the connection open would otherwise leave the test waiting
    setTimeout(() => socket.destroy(new Error('the server did not answer or close in time')), 3000).unref();
  });
}

// A browser: keeps cookies, and sends the Origin a browser on the site would send with a POST.
function makeBrowser(port) {
  const jar = new Map();
  const browser = {
    jar,
    cookie: (name) => (jar.has(name) ? jar.get(name).value : undefined),
    async request(method, urlPath, { headers = {}, json, body, origin = BASE } = {}) {
      const sent = { ...headers };
      if (!SAFE.has(method) && origin !== null && sent.origin === undefined) sent.origin = origin;
      const cookie = [...jar].filter(([, c]) => urlPath.startsWith(c.path)).map(([name, c]) => `${name}=${c.value}`).join('; ');
      if (cookie && sent.cookie === undefined) sent.cookie = cookie;
      let payload = body;
      if (json !== undefined) {
        payload = JSON.stringify(json);
        sent['content-type'] = 'application/json';
      }
      if (payload !== undefined) sent['content-length'] = Buffer.byteLength(payload);
      const res = await rawRequest(port, method, urlPath, sent, payload);
      for (const line of res.cookies) {
        const [pair, ...attributes] = line.split(';').map((s) => s.trim());
        const at = pair.indexOf('=');
        const name = pair.slice(0, at);
        const value = pair.slice(at + 1);
        const attr = (key) => (attributes.find((a) => a.toLowerCase().startsWith(`${key}=`)) || '').split('=')[1];
        if (attr('max-age') === '0' || !value) jar.delete(name);
        else jar.set(name, { value, path: attr('path') || '/' });
      }
      return res;
    },
    get: (urlPath, options) => browser.request('GET', urlPath, options),
    post: (urlPath, json, options = {}) => browser.request('POST', urlPath, { ...options, json }),
  };
  return browser;
}

// A WebSocket upgrade written by hand, for the ones that are turned away with plain HTTP (the ws
// client only reports those as an error). Resolves with the answer { status, headers, text, closed }
// or, when the server agrees to upgrade, { upgraded: true, socket } (the caller closes the socket).
function rawUpgrade(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: urlPath,
      method: 'GET',
      agent: false,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), ...headers },
    });
    req.on('response', (res) => {
      req.setTimeout(0);
      const chunks = [];
      const closed = new Promise((done) => res.socket.once('close', done));
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8'), closed }));
    });
    req.on('upgrade', (res, socket) => {
      // from here on the socket is the caller's, and may be quiet for as long as it likes
      req.setTimeout(0);
      resolve({ upgraded: true, status: res.statusCode, socket });
    });
    req.on('error', reject);
    // a server that neither answers nor closes would otherwise leave the test waiting for ever
    req.setTimeout(5000, () => req.destroy(new Error('the server neither answered the upgrade nor closed the connection in time')));
    req.end();
  });
}

function wsClient(port, urlPath = '/ws', options = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${urlPath}`, options);
  const queue = [];
  const waiters = [];
  const closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  ws.on('message', (data) => {
    const message = JSON.parse(data.toString());
    const at = waiters.findIndex((w) => w.match(message));
    if (at >= 0) waiters.splice(at, 1)[0].resolve(message);
    else queue.push(message);
  });
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const client = {
    ws,
    opened,
    closed,
    queue,
    send: (message) => ws.send(JSON.stringify(message)),
    // the next message of this type (or matching this function), waiting for it if need be
    next(what, ms = 2000) {
      const match = typeof what === 'function' ? what : (m) => m.t === what;
      const at = queue.findIndex(match);
      if (at >= 0) return Promise.resolve(queue.splice(at, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) {
            waiters.splice(i, 1);
            reject(new Error(`no message ${typeof what === 'string' ? `"${what}"` : 'matching'} within ${ms} ms; unread: ${JSON.stringify(queue)}`));
          }
        }, ms).unref();
      });
    },
    // whatever arrives within a moment (usually expected to be nothing)
    async quiet(ms = 150) {
      await sleep(ms);
      return queue.splice(0);
    },
    close: () => ws.close(),
  };
  return client;
}

// Opens a connection, answers the challenge like an app would and returns the answer.
async function connectApp(h, { hello = {}, official = null, path: urlPath = '/ws', options } = {}) {
  const client = wsClient(h.port, urlPath, options);
  await client.opened;
  const challenge = await client.next('challenge');
  const message = { t: 'hello', proto: 2, version: '1.2.0', hash: 'dev', proof: '', token: null, ...hello };
  if (official) {
    // an official build: the hash of its app.asar, and the proof made with its version's key
    message.hash = official.hash;
    message.proof = official.proof ?? makeProof(buildKey(h.config.buildSecret, message.version), challenge.nonce, message.hash, message.version);
  }
  client.send(message);
  const reply = await client.next((m) => m.t === 'welcome' || m.t === 'reject');
  return Object.assign(client, { challenge, reply, id: reply.id });
}

// ---- the server under test ----

async function startServer({ env = {}, tune, net: givenNet, prepare, dir: givenDir } = {}) {
  const dir = givenDir || fs.mkdtempSync(path.join(os.tmpdir(), 'friendsshare-test-'));
  // a chance to put files into the data directory before the server starts (an old rooms.json)
  if (prepare) prepare(path.join(dir, 'data'));
  const config = loadConfig({
    BASE_URL: BASE,
    APP_SECRET: 'test-app-secret-'.padEnd(48, 'k'),
    DATA_DIR: path.join(dir, 'data'),
    BACKUP_INTERVAL_HOURS: '0',
    ...env,
  });
  config.siteDir = path.join(dir, 'site');
  writeSite(config.siteDir);
  // the limit on sign-in routes would get in the way of tests that sign in a lot; its own tests lower it again
  config.tuning.authRate = { max: 10_000, windowMs: 600_000 };
  if (tune) tune(config);
  const clock = { t: START, advance(ms) { clock.t += ms; } };
  const net = typeof givenNet === 'function' ? givenNet(config) : givenNet || createNet(config);
  const logs = [];
  const server = createServer({ config, fetchFn: net.fetch, now: () => clock.t, log: (line) => logs.push(line) });
  const { port } = await server.listen(0, '127.0.0.1');
  return {
    server,
    config,
    net,
    clock,
    logs,
    port,
    dir,
    db: server.db,
    request: (method, urlPath, options) => makeBrowser(port).request(method, urlPath, options),
    browser: () => makeBrowser(port),
    accountId: (email) => server.db.get('SELECT id FROM accounts WHERE email = ?', email).id,
    // an app goes away; returns once the server has noticed too
    async disconnect(app) {
      const before = server.match.snapshot().connections;
      app.close();
      await app.closed;
      await until(() => server.match.snapshot().connections < before);
    },
    async close() {
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function withServer(options, fn) {
  const h = await startServer(options);
  try {
    await fn(h);
  } finally {
    await h.close();
  }
}

// ---- sign-in shortcuts ----

let counter = 0;

// Plays the person: starts the sign-in, lets the fake provider approve, comes back with the code.
async function signIn(h, { provider = 'github', id = 1, name = 'Ada Lovelace', email = 'ada@example.com', verified = true, query = '', browser, userinfo } = {}) {
  const b = browser || h.browser();
  const code = `code-${provider}-${id}-${++counter}`;
  if (provider === 'github') {
    h.net.github.users[code] = userinfo || {
      id,
      login: name.toLowerCase().replace(/\W+/g, '-'),
      name,
      avatar_url: `https://avatars.githubusercontent.com/u/${id}`,
      emails: [{ email, primary: true, verified }],
    };
  } else {
    h.net.google.users[code] = userinfo || { sub: String(id), name, picture: `https://lh3.googleusercontent.com/a/${id}`, email, email_verified: verified };
  }
  const start = await b.get(`/auth/${provider}${query}`);
  if (start.status !== 302 || !start.headers.location.startsWith(provider === 'github' ? 'https://github.com/' : 'https://accounts.google.com/')) return { b, start, done: null };
  const state = new URL(start.headers.location).searchParams.get('state');
  const done = await b.get(`/auth/${provider}/callback?code=${code}&state=${state}`);
  return { b, start, done, state, code };
}

const b64url = (buffer) => Buffer.from(buffer).toString('base64url');

// The desktop app's side of the hand-over, up to the browser coming back with the one-time code.
async function appHandover(h, { provider = 'github', port = 51234, ...person } = {}) {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const query = `?app_port=${port}&app_state=${state}&app_challenge=${challenge}`;
  const { b, done } = await signIn(h, { provider, query, ...person });
  const target = new URL(done.headers.location);
  return { b, verifier, challenge, state, code: target.searchParams.get('code'), target, done };
}

// ... and the exchange of the code for the app's token.
async function appLogin(h, options = {}) {
  const hand = await appHandover(h, options);
  const exchange = await h.request('POST', '/api/app/session', { json: { code: hand.code, verifier: hand.verifier }, origin: null });
  return { ...hand, exchange, token: exchange.json && exchange.json.token };
}

// ---- Stripe ----

// An account that pays, as the webhook would have left it (or one whose period is in the past).
function makePro(h, accountId, { periodEnd = h.clock.t + 30 * 86_400_000, status = 'active', interval = 'month', cancelAtPeriodEnd = 0 } = {}) {
  h.db.run(
    `UPDATE accounts SET stripe_customer_id = 'cus_1', stripe_subscription_id = 'sub_1', sub_status = ?, sub_interval = ?,
       sub_period_end = ?, sub_cancel_at_period_end = ? WHERE id = ?`,
    status,
    interval,
    periodEnd,
    cancelAtPeriodEnd,
    accountId,
  );
}

// Every table as one string: for checking that a secret is nowhere in the database.
function dumpDatabase(h) {
  const parts = [];
  for (const { name } of h.db.all("SELECT name FROM sqlite_master WHERE type = 'table'")) parts.push(JSON.stringify(h.db.all(`SELECT * FROM ${name}`)));
  return parts.join('\n');
}

function signWebhook(config, event, { t = Math.floor(START / 1000), secret = config.stripe.webhookSecret } = {}) {
  const body = JSON.stringify(event);
  const signature = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return { body, headers: { 'stripe-signature': `t=${t},v1=${signature}`, 'content-type': 'application/json' } };
}

const LOGIN_ENV = { GITHUB_CLIENT_ID: 'gh-client', GITHUB_CLIENT_SECRET: 'gh-secret', GOOGLE_CLIENT_ID: 'go-client', GOOGLE_CLIENT_SECRET: 'go-secret' };

const BILLING_ENV = {
  ...LOGIN_ENV,
  STRIPE_SECRET_KEY: 'sk_test_fakeKeyForTests',
  STRIPE_WEBHOOK_SECRET: 'whsec_fakeSecretForTests',
  STRIPE_PRICE_MONTHLY: 'price_monthly_fs',
  STRIPE_PRICE_YEARLY: 'price_yearly_fs',
  STRIPE_PORTAL_CONFIG: 'bpc_friendsshare',
};

module.exports = {
  BASE,
  SESSION,
  STATE,
  START,
  until,
  BILLING_ENV,
  LOGIN_ENV,
  sleep,
  sha256,
  b64url,
  startServer,
  withServer,
  wsClient,
  connectApp,
  makeBrowser,
  rawRequest,
  rawUpgrade,
  announce,
  signIn,
  appHandover,
  appLogin,
  signWebhook,
  makePro,
  dumpDatabase,
  subscription,
  createNet,
  writeSite,
};
