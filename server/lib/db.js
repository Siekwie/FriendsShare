// SQLite through node:sqlite. One file in DATA_DIR holds accounts, sessions, rooms (and the ones
// the operator blocked), the cache of official builds and the anonymous daily totals. Parameters
// are always bound, never spliced into the SQL text. The server and the admin interface (admin.js)
// open the same file; WAL mode plus a busy timeout lets them do so without stepping on each other.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// Append-only: each entry runs once, tracked by PRAGMA user_version.
const MIGRATIONS = [
  `
  -- One per person. The id is random and never reused: Stripe objects carry it, and a reused id
  -- could let a late Stripe event upgrade somebody else.
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT,                          -- a verified address, lowercase
    avatar TEXT,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    sub_status TEXT,                     -- what Stripe last said: active, past_due, canceled, ...
    sub_interval TEXT,                   -- 'month' or 'year'
    sub_period_end INTEGER,              -- end of the paid period, ms
    sub_cancel_at_period_end INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID;
  CREATE INDEX accounts_email ON accounts(email);
  CREATE INDEX accounts_customer ON accounts(stripe_customer_id);

  -- A login at a provider. subject is the provider's own stable user id.
  CREATE TABLE identities (
    provider TEXT NOT NULL CHECK (provider IN ('github', 'google')),
    subject TEXT NOT NULL,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    email TEXT,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER,
    PRIMARY KEY (provider, subject)
  ) WITHOUT ROWID;
  CREATE INDEX identities_account ON identities(account_id);
  CREATE INDEX identities_email ON identities(email);

  -- Browser sessions and app tokens. Only a keyed hash of the token is stored.
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('web', 'app')),
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX sessions_account ON sessions(account_id);
  CREATE INDEX sessions_expires ON sessions(expires_at);

  -- Short-lived single-use values, hashed: the sign-in state, the code the app trades for a
  -- token, and the link that signs a browser in as the app's account.
  CREATE TABLE codes (
    code_hash TEXT PRIMARY KEY,
    purpose TEXT NOT NULL CHECK (purpose IN ('oauth', 'app', 'weblink')),
    account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
    data TEXT NOT NULL DEFAULT '{}',
    expires_at INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX codes_expires ON codes(expires_at);

  -- Registered share rooms (the SHA-256 of a code), kept across restarts so nobody else can
  -- claim a host's room. Nothing here says who the host is.
  CREATE TABLE rooms (
    room TEXT PRIMARY KEY,
    key_hash TEXT NOT NULL,
    exp INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX rooms_exp ON rooms(exp);

  -- Fingerprints of published releases, learned from build.json on GitHub.
  CREATE TABLE builds (
    version TEXT PRIMARY KEY,
    asar_sha256 TEXT NOT NULL,
    exe_sha256 TEXT,
    fetched_at INTEGER NOT NULL
  ) WITHOUT ROWID;

  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) WITHOUT ROWID;
  `,
  `
  -- Rooms the operator blocked after a substantiated abuse report. A blocked room cannot be hosted
  -- or joined by anybody, whatever key they hold, until the operator lifts the block. The row in
  -- rooms is left alone, so the key of the original owner still protects the room afterwards.
  -- Only the SHA-256 of the code is stored, like everywhere else.
  CREATE TABLE blocked_rooms (
    room TEXT PRIMARY KEY CHECK (length(room) = 64 AND room NOT GLOB '*[^0-9a-f]*'),
    created_at INTEGER NOT NULL,
    note TEXT
  ) WITHOUT ROWID;
  `,
  `
  -- When an owner last registered a room. Once the table holds MAX_ROOMS rooms, those that nobody
  -- has registered for the longest time (and whose owner is not connected) are forgotten first.
  -- The rooms that exist now count as seen at the moment of this upgrade.
  ALTER TABLE rooms ADD COLUMN last_seen INTEGER NOT NULL DEFAULT 0;
  UPDATE rooms SET last_seen = CAST(strftime('%s', 'now') AS INTEGER) * 1000;
  CREATE INDEX rooms_last_seen ON rooms(last_seen);

  -- The Checkout Session an account opened last. There is at most one open at a time: opening a
  -- new one first expires this one.
  ALTER TABLE accounts ADD COLUMN checkout_session_id TEXT;
  `,
  `
  -- Anonymous totals per day (lib/stats.js), for the operator's admin interface: how often
  -- something happened, never who did it.
  CREATE TABLE stats_daily (
    day TEXT NOT NULL,                   -- YYYY-MM-DD, UTC
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, kind, name)
  ) WITHOUT ROWID;
  `,
];

function migrate(raw) {
  const current = raw.prepare('PRAGMA user_version').get().user_version;
  if (current > MIGRATIONS.length) throw new Error('The database was written by a newer version of this server.');
  for (let v = current; v < MIGRATIONS.length; v++) {
    raw.exec('BEGIN');
    try {
      raw.exec(MIGRATIONS[v]);
      raw.exec(`PRAGMA user_version = ${v + 1}`);
      raw.exec('COMMIT');
    } catch (err) {
      raw.exec('ROLLBACK');
      throw err;
    }
  }
}

// Rows come back as plain objects (node:sqlite makes them prototype-less).
const plain = (row) => (row ? { ...row } : undefined);

function openDb(file) {
  // it holds email addresses: private to the server's user
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const raw = new DatabaseSync(file);
  if (file !== ':memory:') {
    try {
      fs.chmodSync(file, 0o600);
    } catch {}
  }
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  try {
    migrate(raw);
  } catch (err) {
    raw.close();
    throw err;
  }

  const cache = new Map();
  const prepared = (sql) => {
    let statement = cache.get(sql);
    if (!statement) cache.set(sql, (statement = raw.prepare(sql)));
    return statement;
  };
  let depth = 0;
  let open = true;

  return {
    raw,
    get: (sql, ...params) => plain(prepared(sql).get(...params)),
    all: (sql, ...params) => prepared(sql).all(...params).map(plain),
    run: (sql, ...params) => prepared(sql).run(...params),
    // Never await inside: the callback must run to the end in one go.
    tx(fn) {
      if (depth > 0) return fn();
      raw.exec('BEGIN IMMEDIATE');
      depth++;
      try {
        const result = fn();
        raw.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          raw.exec('ROLLBACK');
        } catch {}
        throw err;
      } finally {
        depth--;
      }
    },
    close() {
      if (!open) return;
      open = false;
      cache.clear();
      raw.close();
    },
  };
}

// Sessions and codes past their time are useless; rooms are handled by the matchmaking, which also
// has to forget them in memory.
function cleanup(db, now) {
  const sessions = db.run('DELETE FROM sessions WHERE expires_at <= ?', now).changes;
  const codes = db.run('DELETE FROM codes WHERE expires_at <= ?', now).changes;
  return { sessions, codes };
}

module.exports = { openDb, cleanup, MIGRATIONS };
