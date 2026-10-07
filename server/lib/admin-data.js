// What the admin interface (lib/admin-web.js) reads from the database. Reading is all it does:
// what changes an account goes through the server itself, which also has to tell the apps that are
// connected (deploy/ops.sh for blocking a share code, Stripe for a subscription).
const { PRO_SQL, planOf } = require('./plan');
const { listBackups } = require('./backup');
const { isVersion } = require('./util');

const DAY_MS = 86_400_000;
const ACCOUNT_ID_RE = /^[0-9a-f]{16}$/;

function accountStats(db, now) {
  const n = (sql, ...params) => db.get(sql, ...params).n;
  const pro = (extra = '') => n(`SELECT COUNT(*) AS n FROM accounts WHERE ${PRO_SQL}${extra}`, now);
  const apps = (extra = '', ...params) => n(`SELECT COUNT(*) AS n FROM sessions WHERE kind = 'app' AND expires_at > ?${extra}`, now, ...params);
  const accounts = n('SELECT COUNT(*) AS n FROM accounts');
  return {
    accounts,
    pro: pro(),
    free: accounts - pro(),
    monthly: pro(" AND sub_interval = 'month'"),
    yearly: pro(" AND sub_interval = 'year'"),
    // paid for, and set to end with the paid period
    ending: pro(' AND sub_cancel_at_period_end = 1'),
    pastDue: pro(" AND sub_status = 'past_due'"),
    last7Days: n('SELECT COUNT(*) AS n FROM accounts WHERE created_at >= ?', now - 7 * DAY_MS),
    last30Days: n('SELECT COUNT(*) AS n FROM accounts WHERE created_at >= ?', now - 30 * DAY_MS),
    // PCs whose app is signed in
    apps: apps(),
    appsUsed30Days: apps(' AND last_used_at >= ?', now - 30 * DAY_MS),
    accountsWithApp: n("SELECT COUNT(DISTINCT account_id) AS n FROM sessions WHERE kind = 'app' AND expires_at > ?", now),
    rooms: n('SELECT COUNT(*) AS n FROM rooms WHERE exp > ?', now),
    blocked: n('SELECT COUNT(*) AS n FROM blocked_rooms'),
  };
}

// Newest first, with the number of matches before `limit` and `offset`.
// query: an account id, or part of a name, an email address or a Stripe id.  plan: 'pro' | 'free' | undefined
function searchAccounts(db, { query, plan, limit, offset = 0 }, now) {
  const where = [];
  const params = [];
  const q = (query || '').trim();
  if (ACCOUNT_ID_RE.test(q)) {
    where.push('a.id = ?');
    params.push(q);
  } else if (q) {
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    const columns = ['a.name', 'a.email', 'a.stripe_customer_id', 'a.stripe_subscription_id'];
    // an account can be signed in to with an address that is not its own
    const logins = "EXISTS (SELECT 1 FROM identities i WHERE i.account_id = a.id AND i.email LIKE ? ESCAPE '\\')";
    where.push(`(${[...columns.map((column) => `${column} LIKE ? ESCAPE '\\'`), logins].join(' OR ')})`);
    params.push(...columns.map(() => like), like);
  }
  if (plan === 'pro' || plan === 'free') {
    where.push(plan === 'pro' ? PRO_SQL : `NOT ${PRO_SQL}`);
    params.push(now);
  }
  const cond = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.get(`SELECT COUNT(*) AS n FROM accounts a ${cond}`, ...params).n;
  const rows = db
    .all(
      `SELECT a.*,
         (SELECT COUNT(*) FROM sessions s WHERE s.account_id = a.id AND s.kind = 'app' AND s.expires_at > ?) AS apps,
         (SELECT group_concat(provider, ',') FROM (SELECT DISTINCT provider FROM identities i WHERE i.account_id = a.id ORDER BY provider)) AS providers
       FROM accounts a ${cond} ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`,
      now,
      ...params,
      limit,
      offset,
    )
    .map((row) => ({ ...row, providers: row.providers ? row.providers.split(',') : [], plan: planOf(row, now) }));
  return { rows, total };
}

// One account with its sign-in methods and the sessions that are still good. Never a token or its hash.
function accountDetail(db, id, now) {
  if (!ACCOUNT_ID_RE.test(id)) return null;
  const account = db.get('SELECT * FROM accounts WHERE id = ?', id);
  if (!account) return null;
  return {
    account: { ...account, plan: planOf(account, now) },
    identities: db.all('SELECT provider, subject, email, created_at, last_login_at FROM identities WHERE account_id = ? ORDER BY created_at, provider', id),
    sessions: db.all('SELECT kind, created_at, last_used_at, expires_at FROM sessions WHERE account_id = ? AND expires_at > ? ORDER BY last_used_at DESC', id, now),
  };
}

const blockedRooms = (db) => db.all('SELECT room, created_at, note FROM blocked_rooms ORDER BY created_at DESC, room');

// The counts the server left behind (server.js writeLive), or null when there are none to read.
function liveCounts(db) {
  const row = db.get('SELECT value FROM meta WHERE key = ?', 'live');
  if (!row) return null;
  try {
    const live = JSON.parse(row.value);
    const number = (value) => (Number.isFinite(value) ? value : 0);
    const counts = (value) => Object.fromEntries(Object.entries(value && typeof value === 'object' ? value : {}).map(([key, count]) => [key, number(count)]));
    if (!live || !Number.isFinite(live.at)) return null;
    return {
      at: live.at,
      startedAt: number(live.started_at),
      connections: number(live.connections),
      byVersion: counts(live.by_version),
      byPlan: { free: 0, pro: 0, ...counts(live.by_plan) },
      hostedRooms: number(live.hosted_rooms),
      waiting: number(live.waiting),
      rejected: { outdated: 0, unofficial: 0, ...counts(live.rejected) },
    };
  } catch {
    return null;
  }
}

// What the overview says about the server itself, apart from its configuration.
function serverState(db, config) {
  const latest = db.get('SELECT value FROM meta WHERE key = ?', 'latest_version');
  const backups = listBackups(config.backup.dir);
  return {
    latestVersion: latest && isVersion(latest.value) ? latest.value : null,
    live: liveCounts(db),
    backups: { count: backups.length, newest: backups.length ? backups[0].takenAt : null },
  };
}

module.exports = { accountStats, searchAccounts, accountDetail, blockedRooms, liveCounts, serverState, ACCOUNT_ID_RE };
