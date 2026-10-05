// The small pieces of an HTTP server that the routes share: errors, cookies, bodies, client
// addresses, rate limiting and the cross-site check. No framework on purpose.
const net = require('node:net');

// Thrown anywhere in a handler; sent as { error, message }. The message is read by people.
// headers: extra response headers, such as Retry-After.
class HttpError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}
const fail = (status, code, message, headers) => {
  throw new HttpError(status, code, message, headers);
};

// ---- responses ----

// On every response, whatever it is.
function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
}

function send(res, status, body, headers = {}) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '');
  res.writeHead(status, { 'Content-Length': data.length, ...headers });
  res.end(data);
}

function sendJson(res, status, value, headers = {}) {
  send(res, status, JSON.stringify(value), {
    'Content-Type': 'application/json; charset=utf-8',
    // answers depend on who is asking
    'Cache-Control': 'no-store',
    ...headers,
  });
}

function redirect(res, location, status = 302) {
  res.writeHead(status, { Location: location, 'Cache-Control': 'no-store', 'Content-Length': 0 });
  res.end();
}

// ---- cookies ----

function parseCookies(header) {
  const cookies = {};
  if (typeof header !== 'string') return cookies;
  for (const piece of header.split(';')) {
    const at = piece.indexOf('=');
    if (at < 0) continue;
    const name = piece.slice(0, at).trim();
    // the first one wins; a cookie cannot be named after something every object has
    if (!name || name === '__proto__' || Object.hasOwn(cookies, name)) continue;
    let value = piece.slice(at + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {}
    cookies[name] = value;
  }
  return cookies;
}

// maxAge 0 deletes the cookie. Values are always base64url tokens, so nothing needs quoting.
function serializeCookie(name, value, { maxAge, path = '/', secure = false } = {}) {
  let cookie = `${name}=${value}; Path=${path}; HttpOnly; SameSite=Lax`;
  if (maxAge !== undefined) cookie += `; Max-Age=${Math.floor(maxAge)}`;
  if (secure) cookie += '; Secure';
  return cookie;
}

function addCookie(res, cookie) {
  const existing = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', existing ? [].concat(existing, cookie) : [cookie]);
}

// ---- request bodies ----

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => new HttpError(413, 'too_large', 'That request is too large.');
    if (Number(req.headers['content-length']) > limit) return reject(tooLarge());
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        chunks.length = 0;
        return reject(tooLarge());
      }
      chunks.push(chunk);
    });
    req.on('end', () => !done && resolve(Buffer.concat(chunks)));
    req.on('error', (err) => !done && reject(err));
  });
}

// A form as a browser posts it. null when it is not one, so that nothing else is mistaken for it.
async function readForm(req, limit) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') return null;
  return new URLSearchParams((await readBody(req, limit)).toString('utf8'));
}

const hasBody = (req) => Number(req.headers['content-length']) > 0 || 'transfer-encoding' in req.headers;

async function readJson(req, limit) {
  let value;
  try {
    value = JSON.parse((await readBody(req, limit)).toString('utf8'));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    return fail(400, 'bad_request', 'The request must contain a JSON object.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail(400, 'bad_request', 'The request must contain a JSON object.');
  }
  return value;
}

// ---- who is calling ----

// Behind Caddy the socket belongs to the proxy; it writes the real address as the last entry of
// X-Forwarded-For (earlier entries are whatever the client sent).
function clientAddress(req, trustProxy) {
  if (trustProxy && typeof req.headers['x-forwarded-for'] === 'string') {
    const last = req.headers['x-forwarded-for'].split(',').pop().trim();
    if (last) return last;
  }
  return req.socket.remoteAddress || 'unknown';
}

// One person usually has a whole /64 of IPv6 addresses, so that is what a limit has to count.
function addressKey(address) {
  let ip = String(address).replace(/%.*$/, '').toLowerCase();
  if (ip.startsWith('::ffff:') && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
  if (!net.isIPv6(ip)) return ip;
  const [head, tail] = ip.split('::');
  const first = head ? head.split(':') : [];
  const last = tail ? tail.split(':') : [];
  const groups = tail === undefined ? first : [...first, ...Array(Math.max(0, 8 - first.length - last.length)).fill('0'), ...last];
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':');
}

const isLoopback = (address) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);

// Every sign that a request came through a proxy. Their mere presence counts, even with an empty
// value: a request that talks of forwarding is not the operator at the machine.
const FORWARDING_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'forwarded', 'x-real-ip', 'via'];

// True only for a request that was made on this machine, to this machine, and not through the
// proxy. The proxy's own connections are not loopback, and a request it forwards carries headers.
function fromThisMachine(req) {
  const { remoteAddress, localAddress } = req.socket;
  return isLoopback(remoteAddress) && isLoopback(localAddress) && !FORWARDING_HEADERS.some((name) => name in req.headers);
}

// A browser says what it is loading. Anything but a page of its own (an image, a script, a fetch)
// has no business at an address that is meant to be navigated to. Requests without the header, from
// scripts and older browsers, are not judged.
function isSubresource(req) {
  const dest = req.headers['sec-fetch-dest'];
  return dest !== undefined && dest !== 'document';
}

// A simple sliding window per key, in memory.
function createLimiter({ max, windowMs }, now) {
  const hits = new Map();
  return {
    allow(key) {
      const t = now();
      const recent = (hits.get(key) || []).filter((at) => t - at < windowMs);
      const allowed = recent.length < max;
      if (allowed) recent.push(t);
      hits.delete(key);
      hits.set(key, recent);
      if (hits.size > 10_000) {
        for (const [k, times] of hits) if (!times.length || t - times[times.length - 1] >= windowMs) hits.delete(k);
        // still too many distinct callers: forget the oldest ones
        for (const k of hits.keys()) {
          if (hits.size <= 5_000) break;
          hits.delete(k);
        }
      }
      return allowed;
    },
  };
}

// ---- cross-site requests ----

// True when a state-changing request comes from some other site. Requests that carry neither an
// Origin nor a Sec-Fetch-Site header (scripts, the desktop app) are not browsers being tricked.
function crossSite(req, origin) {
  const sent = req.headers.origin;
  if (sent !== undefined) return sent !== origin;
  return req.headers['sec-fetch-site'] === 'cross-site';
}

module.exports = {
  HttpError,
  fail,
  securityHeaders,
  send,
  sendJson,
  redirect,
  parseCookies,
  serializeCookie,
  addCookie,
  readBody,
  readJson,
  readForm,
  hasBody,
  clientAddress,
  addressKey,
  isLoopback,
  fromThisMachine,
  isSubresource,
  createLimiter,
  crossSite,
};
