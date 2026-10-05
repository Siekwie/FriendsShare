// Tools for whoever runs the server. Every route here lives under /internal/, which server.js
// answers only for a request that comes from the machine itself and not through the proxy; for
// everybody else these routes do not exist. (It is decided by the path, so nothing here has to ask.)
//
//   GET  /internal/stats      counts, no personal data
//   POST /internal/block      block a share room after a substantiated abuse report
//   POST /internal/unblock    lift that again
//   GET  /internal/blocked    what is blocked
const { fail } = require('./http');
const { sha256 } = require('./util');
const { planOf } = require('./plan');

const ROOM_RE = /^[0-9a-f]{64}$/;
// what the app accepts as a share code once it has been trimmed and lowercased
const CODE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_NOTE = 500;
const BAD_ROOM = 'Give either "code" (the share code as the reporter sent it) or "room" (64 hexadecimal characters), not both.';

function createOperator({ db, match, now, log, startedAt }) {
  // The room a request is about. A code is turned into its room the way the apps do it: trimmed,
  // lowercased, SHA-256 of the text. It is only held for this call, never stored or logged.
  function roomOf(body) {
    const hasCode = body.code !== undefined;
    if (hasCode === (body.room !== undefined)) fail(400, 'bad_request', BAD_ROOM);
    if (hasCode) {
      const code = typeof body.code === 'string' ? body.code.trim().toLowerCase() : '';
      // The apps refuse anything else, so a typo would "work" and block a room nobody can ever have.
      if (!CODE_RE.test(code)) fail(400, 'bad_request', 'That is not a share code. A share code looks like 123e4567-e89b-12d3-a456-426614174000.');
      return sha256(code);
    }
    const room = typeof body.room === 'string' ? body.room.trim().toLowerCase() : '';
    if (!ROOM_RE.test(room)) fail(400, 'bad_request', 'That is not a room. A room is 64 hexadecimal characters.');
    return room;
  }

  // For the operator's own records: the reference of the report, say. Never shown to anybody else.
  function noteOf(body) {
    if (body.note === undefined || body.note === null) return null;
    if (typeof body.note !== 'string') fail(400, 'bad_request', 'The note must be text.');
    const note = body.note.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
    if (note.length > MAX_NOTE) fail(400, 'bad_request', `The note can be at most ${MAX_NOTE} characters.`);
    return note || null;
  }

  // The log gets a piece of the room, so a line can be found again, and never the code or the note.
  const shown = (room) => room.slice(0, 12);

  function register(router) {
    router.add(
      'GET',
      '/internal/stats',
      (ctx) => {
        const snap = match.snapshot();
        const t = now();
        const proAccounts = db.all('SELECT * FROM accounts WHERE stripe_subscription_id IS NOT NULL').filter((a) => planOf(a, t) === 'pro').length;
        ctx.json(200, {
          connections: snap.connections,
          by_version: snap.by_version,
          by_plan: snap.by_plan,
          hosted_rooms: snap.hosted_rooms,
          waiting: snap.waiting,
          accounts: db.get('SELECT COUNT(*) AS n FROM accounts').n,
          pro_accounts: proAccounts,
          rooms_known: db.get('SELECT COUNT(*) AS n FROM rooms WHERE exp > ?', t).n,
          blocked_rooms: db.get('SELECT COUNT(*) AS n FROM blocked_rooms').n,
          rejected: snap.rejected,
          started_at: startedAt,
        });
      },
    );

    router.add(
      'POST',
      '/internal/block',
      async (ctx) => {
        const body = await ctx.body();
        const room = roomOf(body);
        const note = noteOf(body);
        // Blocking again keeps the first date, and the old note unless there is a new one.
        db.run(
          `INSERT INTO blocked_rooms (room, created_at, note) VALUES (?, ?, ?)
           ON CONFLICT(room) DO UPDATE SET note = COALESCE(excluded.note, note)`,
          room,
          now(),
          note,
        );
        // in the same breath: nobody can host or join in between
        const told = match.roomBlocked(room);
        log(`[operator] room ${shown(room)} blocked, ${told} connection${told === 1 ? '' : 's'} told`);
        ctx.json(200, { room, blocked: true });
      },
    );

    router.add(
      'POST',
      '/internal/unblock',
      async (ctx) => {
        const room = roomOf(await ctx.body());
        if (db.run('DELETE FROM blocked_rooms WHERE room = ?', room).changes) log(`[operator] room ${shown(room)} unblocked`);
        // asking for a room that was not blocked is not an error: it is as unblocked as can be
        ctx.json(200, { room, blocked: false });
      },
    );

    router.add(
      'GET',
      '/internal/blocked',
      (ctx) => ctx.json(200, db.all('SELECT room, created_at, note FROM blocked_rooms ORDER BY created_at DESC, room')),
    );
  }

  return { register };
}

module.exports = { createOperator };
