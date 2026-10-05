// Which apps may use the matchmaking, and what the newest release is.
//
// An official app proves two things in its hello:
//   - it knows the key of its version (stamped into the release by CI from BUILD_SECRET), shown as
//     an HMAC over the connection's nonce, so a recorded hello is useless on another connection
//   - its app.asar has the fingerprint that the release published in build.json
// This keeps copies built from source off the official server. It is a deterrent against casual
// use, not a guarantee: whoever extracts the key from an official download can imitate that version.
const crypto = require('node:crypto');
const { hmac, safeEqual, isVersion } = require('./util');

// The key stamped into a release (scripts/stamp-build.js computes the same).
const buildKey = (secret, version) => hmac(secret, `friendsshare-build:${version}`);

// The key is used as the hex text it is written in, as UTF-8 bytes.
const makeProof = (key, nonce, hash, version) => crypto.createHmac('sha256', key).update(`${nonce}|${hash}|${version}`).digest('hex');

const HEX64 = /^[0-9a-f]{64}$/i;

function createBuilds({ config, db, fetchFn, now, log }) {
  // the website shows it as the current version; kept across restarts in case GitHub is down at start
  const stored = db.get('SELECT value FROM meta WHERE key = ?', 'latest_version');
  let latest = stored && isVersion(stored.value) ? stored.value : '';

  // version -> promise of the lookup that is running right now
  const inflight = new Map();
  // version -> earliest time of the next lookup
  const notBefore = new Map();

  async function refreshLatest() {
    try {
      const res = await fetchFn(`https://api.github.com/repos/${config.releaseRepo}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'FriendsShare-server' },
        signal: AbortSignal.timeout(config.tuning.fetchTimeoutMs),
      });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const tag = (await res.json()).tag_name;
      const version = typeof tag === 'string' ? tag.replace(/^v/, '') : '';
      if (!isVersion(version)) throw new Error('the latest release has an unexpected tag');
      if (version !== latest) {
        latest = version;
        db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'latest_version', version);
      }
    } catch (err) {
      // the last known version stays
      log(`[builds] could not read the latest release: ${err.message}`);
    }
  }

  // The fingerprints a release published, from the release itself.
  async function fetchPublished(version) {
    // whatever the outcome, not again for a minute: a miss is cached, and a wrong hash cannot make us hammer GitHub
    notBefore.set(version, now() + config.tuning.buildMissMs);
    if (notBefore.size > 1000) for (const [v, until] of notBefore) if (until <= now()) notBefore.delete(v);
    try {
      const res = await fetchFn(`https://github.com/${config.releaseRepo}/releases/download/v${version}/build.json`, {
        headers: { Accept: 'application/json', 'User-Agent': 'FriendsShare-server' },
        signal: AbortSignal.timeout(config.tuning.fetchTimeoutMs),
      });
      if (!res.ok || Number(res.headers.get('content-length')) > 8192) return null;
      const text = await res.text();
      if (text.length > 8192) return null;
      const info = JSON.parse(text);
      if (!info || info.version !== version || typeof info.asar_sha256 !== 'string' || !HEX64.test(info.asar_sha256)) return null;
      const record = {
        asar_sha256: info.asar_sha256.toLowerCase(),
        exe_sha256: typeof info.exe_sha256 === 'string' && HEX64.test(info.exe_sha256) ? info.exe_sha256.toLowerCase() : null,
      };
      db.run(
        `INSERT INTO builds (version, asar_sha256, exe_sha256, fetched_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(version) DO UPDATE SET asar_sha256 = excluded.asar_sha256, exe_sha256 = excluded.exe_sha256, fetched_at = excluded.fetched_at`,
        version,
        record.asar_sha256,
        record.exe_sha256,
        now(),
      );
      return record;
    } catch {
      return null;
    }
  }

  // At most one lookup per version at a time; everyone who asks meanwhile gets the same answer.
  function lookup(version) {
    const running = inflight.get(version);
    if (running) return running;
    if ((notBefore.get(version) || 0) > now()) return Promise.resolve(null);
    const run = fetchPublished(version).finally(() => inflight.delete(version));
    inflight.set(version, run);
    return run;
  }

  async function publishedMatches(version, hash) {
    const known = db.get('SELECT asar_sha256 FROM builds WHERE version = ?', version);
    if (known && safeEqual(known.asar_sha256, hash)) return true;
    // Unknown, or a different hash than we remember (a release can be rebuilt): look at what is published now.
    const fresh = await lookup(version);
    return Boolean(fresh) && safeEqual(fresh.asar_sha256, hash);
  }

  // true when this hello comes from an unmodified official build (or nothing is required)
  async function isOfficial(hello, nonce) {
    if (!config.requireOfficial) return true;
    const { version, hash, proof } = hello;
    // "dev" is what an app run from source reports instead of a fingerprint
    const fromSource = hash === 'dev';
    if (!isVersion(version) || typeof proof !== 'string' || !proof || typeof hash !== 'string' || !(fromSource || HEX64.test(hash))) return false;
    // The proof comes first: it needs the secret, so a stranger cannot make us fetch anything.
    const expected = makeProof(buildKey(config.buildSecret, version), nonce, hash, version);
    if (!safeEqual(proof.toLowerCase(), expected)) return false;
    const wanted = hash.toLowerCase();
    const extra = config.extraBuilds.get(version);
    if (extra && extra.has(wanted)) return true;
    // no release ever publishes "dev": only EXTRA_BUILDS can admit it
    if (fromSource) return false;
    return publishedMatches(version, wanted);
  }

  return { isOfficial, refreshLatest, latestVersion: () => latest };
}

module.exports = { createBuilds, buildKey, makeProof };
