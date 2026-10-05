// Small helpers shared by the other modules: hashing, tokens, constant-time compare, versions.
const crypto = require('node:crypto');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const hmac = (secret, value) => crypto.createHmac('sha256', secret).update(value).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex');

// Compares secrets and signatures without leaking where they differ or how long they are:
// both sides are hashed to the same length first.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
}

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---- versions: plain x.y.z, nothing else is an official version ----

const VERSION_RE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const isVersion = (v) => typeof v === 'string' && VERSION_RE.test(v);

// negative when a < b, 0 when equal, positive when a > b
function compareVersions(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

// Something safe to put in a log line even though a stranger chose it.
const logSafe = (value, max = 24) => (typeof value === 'string' && /^[\w.+-]{1,64}$/.test(value) ? value.slice(0, max) : 'invalid');

module.exports = { sha256, hmac, randomToken, randomHex, safeEqual, escapeHtml, isVersion, compareVersions, logSafe };
