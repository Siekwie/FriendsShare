// Asks the classification service ipclass (a container of its own on the same Docker network, see
// its README) whether a caller is a person or a program, and which kind. The answer decides what the
// totals count (lib/stats.js). The service is optional: without IPCLASS_URL, or whenever it does not
// answer in time, or answers something that is not a verdict, the user agent alone decides.
const { judgeByAgent } = require('./stats');

// The kinds of program, with the names the admin page shows for them. "human" is the other verdict.
const BOT_KINDS = {
  search: 'Search engines',
  ai: 'AI crawlers',
  preview: 'Link previews',
  monitor: 'Monitors',
  seo: 'SEO crawlers',
  scanner: 'Scanners',
  script: 'Scripts and tools',
  crawler: 'Other crawlers',
  fake: 'Fake crawlers',
  datacenter: 'Data-center addresses',
};
const CATEGORIES = new Set(['human', ...Object.keys(BOT_KINDS)]);

const MAX_NAME = 80;
const LOG_EVERY_MS = 60_000;

// What the service said, checked against what it documents: a known category, and bot true for every
// kind of program and false for people only. Anything else is no answer at all.
function readVerdict(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { bot, category, name } = value;
  if (typeof category !== 'string' || !CATEGORIES.has(category) || typeof name !== 'string') return null;
  if (bot === false && category === 'human') return { bot: false, category, name: '' };
  if (bot === true && category !== 'human') return { bot: true, category, name: name.trim().slice(0, MAX_NAME) || 'Unknown' };
  return null;
}

// classify(address, userAgent) -> Promise of { bot, category, name }. It never rejects, and it gives up
// after timeoutMs, so counting never waits long for it. url: IPCLASS_URL, empty for "service off".
function createClassifier({ url, timeoutMs = 1500, fetchFn = globalThis.fetch, log = () => {}, now = Date.now } = {}) {
  const endpoint = url ? `${url.replace(/\/+$/, '')}/classify` : null;
  let lastLogged = -Infinity;
  // a service that is down would otherwise log for every page view
  const complain = (reason) => {
    if (now() - lastLogged < LOG_EVERY_MS) return;
    lastLogged = now();
    log(`[stats] could not classify a caller, counted by its user agent instead: ${reason}`);
  };

  return async function classify(address, userAgent) {
    if (!endpoint) return judgeByAgent(userAgent);
    let timer;
    try {
      const ask = Promise.resolve()
        .then(() =>
          fetchFn(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ip: address, ua: userAgent }),
            signal: AbortSignal.timeout(timeoutMs),
          }),
        )
        .then(async (res) => {
          if (!res.ok) throw new Error(`status ${res.status}`);
          return readVerdict(await res.json());
        });
      const late = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
        timer.unref?.();
      });
      const verdict = await Promise.race([ask, late]);
      if (verdict) return verdict;
      complain('the answer is not a verdict');
    } catch (err) {
      complain(err.message);
    } finally {
      clearTimeout(timer);
    }
    return judgeByAgent(userAgent);
  };
}

module.exports = { BOT_KINDS, CATEGORIES, readVerdict, createClassifier };
