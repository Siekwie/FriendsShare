// Anonymous daily totals for the operator's admin interface (lib/admin-web.js): page views,
// visitors, downloads, started checkouts, new subscriptions, where visitors came from and which
// system they use. The database only ever holds counts per day; nothing in it can be traced back to
// a visitor. The privacy page (site/privacy.html) describes this: keep it in step when you change
// what is counted.
const crypto = require('node:crypto');

const DAY_MS = 86_400_000;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

// kind: view | visitor | download | checkout | subscription | referrer | system
function bump(db, nowMs, kind, name = '') {
  db.run(
    'INSERT INTO stats_daily (day, kind, name, count) VALUES (?, ?, ?, 1) ON CONFLICT (day, kind, name) DO UPDATE SET count = count + 1',
    dayOf(nowMs),
    kind,
    String(name).slice(0, 120),
  );
}

// For the places that count in passing (a webhook, say): counting is never a reason for them to fail.
function tally({ db, now, log }, kind, name) {
  try {
    bump(db, now(), kind, name);
  } catch (err) {
    log(`[stats] could not count a ${kind}: ${err.message}`);
  }
}

// What has to be remembered within a day to count without remembering anybody: each visitor once,
// by a hash of address and browser that is salted with a random value, and the names of the sites
// that visitors came from, so that a stranger cannot fill the table with made-up ones. All of it
// exists in memory only, and is thrown away at midnight (UTC) and whenever the server restarts.
class Today {
  constructor({ maxVisitors = 50_000, maxReferrers = 200 } = {}) {
    this.maxVisitors = maxVisitors;
    this.maxReferrers = maxReferrers;
    this.day = '';
    this.salt = crypto.randomBytes(16);
    this.seen = new Set();
    this.referrers = new Set();
  }

  turn(nowMs) {
    const today = dayOf(nowMs);
    if (today === this.day) return;
    this.day = today;
    this.salt = crypto.randomBytes(16);
    this.seen.clear();
    this.referrers.clear();
  }

  // True the first time this visitor shows up today.
  first(nowMs, address, userAgent) {
    this.turn(nowMs);
    if (this.seen.size >= this.maxVisitors) return false;
    const id = crypto.createHash('sha256').update(this.salt).update(address).update('\n').update(userAgent).digest('base64url').slice(0, 16);
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    return true;
  }

  // The name a referring site is counted under: its own, until there are too many of them today.
  referrer(nowMs, host) {
    this.turn(nowMs);
    if (this.referrers.has(host)) return host;
    if (this.referrers.size >= this.maxReferrers) return '(other sites)';
    this.referrers.add(host);
    return host;
  }
}

// Crawlers, link previews, monitors and scripts: they are not people looking at the page.
function isBot(userAgent) {
  return !userAgent || /bot|crawl|spider|slurp|preview|monitor|uptime|pingdom|lighthouse|headless|scan|curl|wget|python|go-http|java\/|okhttp|axios|node|fetch|httpclient|libwww|facebookexternalhit|whatsapp|telegram|embedly/i.test(userAgent);
}

function systemOf(userAgent) {
  if (/Android/i.test(userAgent)) return 'Android';
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'iOS';
  if (/Windows/i.test(userAgent)) return 'Windows';
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'macOS';
  if (/CrOS/i.test(userAgent)) return 'ChromeOS';
  if (/Linux|X11/i.test(userAgent)) return 'Linux';
  return 'Other';
}

// The site a visitor came from: its host name only, and never our own.
function referrerHost(header, ownHost) {
  if (typeof header !== 'string' || !header || header.length > 2048) return null;
  try {
    const host = new URL(header).hostname.toLowerCase().replace(/^www\./, '');
    return !host || host === ownHost || !/^[a-z0-9.-]{1,100}$/.test(host) ? null : host;
  } catch {
    return null;
  }
}

// Pages whose views are counted. Anything else (assets, the API, unknown addresses) is not.
const PAGES = new Set(['/', '/login', '/account', '/imprint', '/privacy', '/terms']);
// Where a visitor arrives from another site. The sign-in and account pages are left out: people
// come back to them from GitHub, Google and Stripe, which says nothing about where they heard of us.
const LANDING = new Set(['/', '/imprint', '/privacy', '/terms']);

// Adds one answered request to the day's totals, if it is something worth counting.
// r: { nowMs, method, path, status, address, userAgent, referrer, ownHost }
function recordRequest(db, today, r) {
  if (isBot(r.userAgent)) return;
  // a click on "Upgrade" that was answered with the address of a Stripe checkout
  if (r.method === 'POST') return r.path === '/api/billing/checkout' && r.status === 200 ? bump(db, r.nowMs, 'checkout', 'started') : undefined;
  if (r.method !== 'GET') return;
  // the download button; the file itself comes from GitHub
  if (r.path === '/download') return r.status === 302 ? bump(db, r.nowMs, 'download', 'windows') : undefined;

  if (r.status !== 200 || !PAGES.has(r.path)) return;
  bump(db, r.nowMs, 'view', r.path);
  const from = LANDING.has(r.path) ? referrerHost(r.referrer, r.ownHost) : null;
  if (from) bump(db, r.nowMs, 'referrer', today.referrer(r.nowMs, from));
  if (today.first(r.nowMs, r.address, r.userAgent)) {
    bump(db, r.nowMs, 'visitor', '');
    bump(db, r.nowMs, 'system', systemOf(r.userAgent));
  }
}

// ---- the report ----

const KIND_FIELD = { visitor: 'visitors', view: 'views', download: 'downloads', checkout: 'checkouts' };
const COUNTED = Object.keys(KIND_FIELD).map((kind) => `'${kind}'`).join(', ');
// visitors: counted once per day each, so over several days this is visits, not different people
// signups: accounts made on that day that still exist
// bought: Pro subscriptions started (those bought with a Stripe test card are left out)
const zero = () => ({ visitors: 0, views: 0, downloads: 0, signups: 0, checkouts: 0, bought: 0 });

// {
//   days: the last `span` days, oldest first, today last ({ day, ...totals }); days without visits are zeros
//   today, week, month, allTime: totals
//   pages, referrers, systems: [{ name, count }] of the last `span` days, most first
// }
function trafficReport(db, nowMs = Date.now(), span = 30) {
  const days = [];
  for (let i = span - 1; i >= 0; i--) days.push({ day: dayOf(nowMs - i * DAY_MS), ...zero() });
  const byDay = new Map(days.map((d) => [d.day, d]));
  const since = days[0].day;
  const fill = (rows, field) => {
    for (const row of rows) {
      const d = byDay.get(row.day);
      if (d) d[typeof field === 'function' ? field(row) : field] = row.n;
    }
  };

  fill(db.all(`SELECT day, kind, SUM(count) AS n FROM stats_daily WHERE day >= ? AND kind IN (${COUNTED}) GROUP BY day, kind`, since), (row) => KIND_FIELD[row.kind]);
  fill(db.all("SELECT day, SUM(count) AS n FROM stats_daily WHERE day >= ? AND kind = 'subscription' AND name = 'live' GROUP BY day", since), 'bought');
  fill(
    db.all("SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM accounts WHERE created_at >= ? GROUP BY 1", Date.parse(`${since}T00:00:00Z`)),
    'signups',
  );

  const sum = (rows) => {
    const total = zero();
    for (const row of rows) for (const key of Object.keys(total)) total[key] += row[key];
    return total;
  };
  const allTime = zero();
  for (const row of db.all(`SELECT kind, SUM(count) AS n FROM stats_daily WHERE kind IN (${COUNTED}) GROUP BY kind`)) allTime[KIND_FIELD[row.kind]] = row.n;
  allTime.bought = db.get("SELECT COALESCE(SUM(count), 0) AS n FROM stats_daily WHERE kind = 'subscription' AND name = 'live'").n;
  allTime.signups = db.get('SELECT COUNT(*) AS n FROM accounts').n;

  const top = (kind, limit) =>
    db.all('SELECT name, SUM(count) AS count FROM stats_daily WHERE kind = ? AND day >= ? GROUP BY name ORDER BY count DESC, name LIMIT ?', kind, since, limit);

  return {
    days,
    today: sum(days.slice(-1)),
    week: sum(days.slice(-7)),
    month: sum(days),
    allTime,
    pages: top('view', 20),
    referrers: top('referrer', 20),
    systems: top('system', 10),
  };
}

module.exports = { bump, tally, Today, isBot, systemOf, referrerHost, recordRequest, trafficReport, dayOf };
