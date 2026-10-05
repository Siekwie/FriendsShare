// What kind of build this is, and the few decisions that hang on it. Everything that makes an
// official build behave differently from one run from source is decided here or in main.js, so it
// is easy to audit.
//
//   official = the app is packaged AND carries the build key that only the release workflow has
//              (scripts/stamp-build.js writes it to app/build.json, which is never committed)
//
// Anything else (run from source, or a local build without the key) is a development build. It
// honours FS_HOME and FS_SIGNAL, because the tests and local development need them, and it cannot
// prove itself to the official server, which is the point.
const crypto = require('crypto');
const path = require('path');
const { app } = require('electron');

// the key is the lowercase hex of an HMAC-SHA256, and so is a fingerprint
const HEX64 = /^[0-9a-f]{64}$/;

// The key stamped into this build, or null (the file is only there in official builds).
function stampedKey() {
  try {
    const { key } = require('./build.json');
    return typeof key === 'string' && HEX64.test(key) ? key : null;
  } catch {
    return null;
  }
}

// The key this process proves itself with. Only a copy run from source (never a packaged one) can
// also take it from FS_BUILD_KEY: that is how the end-to-end tests play an official build without
// writing files into app/.
function resolveKey({ packaged, stamped, env }) {
  if (stamped) return stamped;
  if (!packaged && HEX64.test(env.FS_BUILD_KEY || '')) return env.FS_BUILD_KEY;
  return null;
}

let cached = null;
// -> { packaged, key, official }, decided once
function info() {
  if (!cached) {
    const packaged = Boolean(app && app.isPackaged);
    const key = resolveKey({ packaged, stamped: stampedKey(), env: process.env });
    cached = { packaged, key, official: packaged && key !== null };
  }
  return cached;
}

// Compares two secrets without leaking where they differ or how long they are.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
}

// Whether FS_HOME and FS_SIGNAL are honoured. The one rule to audit.
//   - A development build honours them (the tests need that).
//   - An official build ignores them: FS_HOME would let one person run several profiles, each with
//     its own free folders, and FS_SIGNAL would point the app at another server.
//   - One deliberate exception, so the owner can try a released build without touching their real
//     profile: FS_TEST_KEY equal to the build's own key. Whoever has the key can already play an
//     official build, so this gives nobody anything. The debugging switches stay refused either way
//     (see forbiddenSwitch).
function mayUseEnvOverrides({ official, key, testKey }) {
  if (!official) return true;
  return typeof testKey === 'string' && testKey !== '' && key !== null && safeEqual(testKey, key);
}

// Switches an official build refuses to run with. The debugging ones would let anybody look into
// (and change) the running app; --user-data-dir is honoured by Electron itself and would give one
// person several profiles side by side, each with its own five free folders.
const FORBIDDEN_SWITCHES = new Set([
  'remote-debugging-port',
  'remote-debugging-pipe',
  'inspect',
  'inspect-brk',
  'inspect-wait',
  'inspect-brk-node',
  'user-data-dir',
]);

// The first forbidden switch among the command line arguments, or null. Chromium takes "--name",
// "-name" and (on Windows) "/name", each with an optional "=value". hasSwitch is Electron's own
// view of the command line, asked as well.
function forbiddenSwitch(argv, hasSwitch = () => false) {
  for (const arg of argv) {
    const match = /^(?:--?|\/)([A-Za-z][\w-]*)(?:=|$)/.exec(String(arg));
    if (match && FORBIDDEN_SWITCHES.has(match[1].toLowerCase())) return match[1].toLowerCase();
  }
  for (const name of FORBIDDEN_SWITCHES) if (hasSwitch(name)) return name;
  return null;
}

// The proof in the hello (contract section 4): an HMAC keyed with the build key (as the hex text it
// is written in) over the connection's nonce, the app's fingerprint and its version. The nonce
// makes a recorded hello useless on another connection.
function makeProof(key, nonce, hash, version) {
  return crypto.createHmac('sha256', key).update(`${nonce}|${hash}|${version}`).digest('hex');
}

// SHA-256 (hex) of a file. Electron's patched fs treats an .asar as a folder, so the app's own
// archive has to be read with original-fs.
function hashFile(file, fs = require('original-fs')) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

let hashed = null;
// The app's fingerprint for the hello, computed once: the SHA-256 of its own app.asar when
// packaged, "dev" when run from source. The server compares it with the one published next to the
// release. A copy run from source can name a fingerprint in FS_BUILD_HASH (tests only: the server's
// EXTRA_BUILDS list takes 64 hex characters, not "dev").
function appHash() {
  if (!hashed) {
    hashed = (async () => {
      if (!info().packaged) return HEX64.test(process.env.FS_BUILD_HASH || '') ? process.env.FS_BUILD_HASH : 'dev';
      try {
        return await hashFile(path.join(process.resourcesPath, 'app.asar'));
      } catch {
        // not a hash, so the server turns it away as unofficial
        return 'unreadable';
      }
    })();
  }
  return hashed;
}

module.exports = { info, resolveKey, mayUseEnvOverrides, forbiddenSwitch, makeProof, hashFile, appHash, safeEqual };
