// Matchmaking over WebSocket, protocol 2. It only introduces two apps to each other (WebRTC
// signaling). Files never pass through here, and it never sees a share code: a room is named by
// the SHA-256 of the code.
//
// Anybody on the internet can open a socket here, so the door is guarded in layers: which requests
// are let in at all (the upgrade), how much one address may hold and register, and what a
// connection may say before it has said hello.
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const { sha256, safeEqual, isVersion, compareVersions, randomHex, logSafe } = require('./util');
const { accountView, planOf, limitFor } = require('./plan');
const { clientAddress, addressKey, createLimiter } = require('./http');

const isRoom = (r) => typeof r === 'string' && /^[0-9a-f]{64}$/.test(r);

// A complete little HTTP response, for turning somebody away before there is any WebSocket.
function httpResponse(status, reason, text, headers = {}) {
  const body = `${text}\n`;
  const all = {
    Connection: 'close',
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  };
  return `HTTP/1.1 ${status} ${reason}\r\n${Object.entries(all).map(([name, value]) => `${name}: ${value}`).join('\r\n')}\r\n\r\n${body}`;
}

// Sends the answer, then lets go of the socket. Nothing here waits for the other side.
function turnAway(socket, response) {
  socket.on('error', () => {});
  socket.end(response, () => socket.destroy());
}

function createMatch({ config, db, auth, builds, now, log }) {
  const tuning = config.tuning;
  const wss = new WebSocketServer({ noServer: true, maxPayload: tuning.maxPayload });

  // room -> socket of the owner that is online right now
  const live = new Map();
  // connection id -> socket, once the handshake is done
  const clients = new Map();
  // room -> sockets that asked for it while its owner was away and have not been told yet
  const waiting = new Map();
  // account id -> its sockets, oldest first
  const byAccount = new Map();
  const rejected = { outdated: 0, unofficial: 0 };
  let legacyLogged = { at: 0, count: 0 };
  let timers = [];

  // ---- who is let in ----

  // address -> sockets it holds open on /ws; and how often it knocked in the last minute
  const open = new Map();
  const upgrades = createLimiter({ max: config.wsUpgradesPerMinute, windowMs: 60_000 }, now);
  // how often it registered a room the database had not seen, in the last hour
  const newRooms = createLimiter({ max: config.roomsPerAddressHour, windowMs: 3_600_000 }, now);

  const downloadUrl = `${config.repoUrl}/releases/latest/download/FriendsShare.exe`;
  // Apps before 1.2 knock on "/" and, once turned away, again every second. Everything about
  // answering them is prepared in advance.
  const TOO_OLD = httpResponse(426, 'Upgrade Required', `This version of FriendsShare is too old. Download the current one at ${downloadUrl}`, { Upgrade: 'websocket' });
  const FROM_A_PAGE = httpResponse(403, 'Forbidden', 'WebSocket connections from web pages are not accepted.');
  const TOO_MANY = httpResponse(429, 'Too Many Requests', 'Too many connections from this address. Please wait a minute and try again.', { 'Retry-After': '60' });

  // One line a minute at most, however many are turned away.
  const refusals = { origin: 0, busy: 0, at: 0 };
  function noteRefusal(kind) {
    refusals[kind]++;
    if (now() - refusals.at < 60_000) return;
    log(`[match] turned away upgrades since the last line: ${refusals.origin} from web pages, ${refusals.busy} over the limit of an address`);
    Object.assign(refusals, { origin: 0, busy: 0, at: now() });
  }

  // The old apps' answer is counted and logged once a minute, not once per attempt.
  function rejectLegacy(socket) {
    rejected.outdated++;
    legacyLogged.count++;
    if (now() - legacyLogged.at >= 60_000) {
      log(`[match] rejected outdated on the old path (${legacyLogged.count} connections since the last line)`);
      legacyLogged = { at: now(), count: 0 };
    }
    turnAway(socket, TOO_OLD);
  }

  // GET /ws is protocol 2. Everything else is turned away before a WebSocket exists.
  function handleUpgrade(req, socket, head) {
    // A web page (the desktop app sends no Origin, or "null", or "file://"): any site could
    // otherwise have its visitors' browsers open sockets here.
    const origin = req.headers.origin;
    if (typeof origin === 'string' && /^https?:\/\//i.test(origin)) {
      noteRefusal('origin');
      return turnAway(socket, FROM_A_PAGE);
    }
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return socket.destroy();
    }
    if (pathname !== '/ws') return rejectLegacy(socket);

    const address = addressKey(clientAddress(req, config.trustProxy));
    if (!upgrades.allow(address) || (open.get(address) || 0) >= config.wsMaxPerAddress) {
      noteRefusal('busy');
      return turnAway(socket, TOO_MANY);
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      open.set(address, (open.get(address) || 0) + 1);
      ws.once('close', () => {
        const left = (open.get(address) || 1) - 1;
        if (left > 0) open.set(address, left);
        else open.delete(address);
      });
      ws.on('error', () => {});
      ws.peer = address;
      onConnection(ws);
    });
  }

  // ---- talking to a connection ----

  function send(ws, message) {
    if (ws.readyState !== 1) return;
    // somebody who never reads would make us buffer without end
    if (ws.bufferedAmount > 1024 * 1024) return ws.terminate();
    try {
      ws.send(JSON.stringify(message));
    } catch {}
  }

  // Closes politely, and for good a moment later if the other side does not play along.
  function closeSoon(ws, code, reason) {
    ws.state = 'closed';
    try {
      ws.close(code, reason);
    } catch {}
    const timer = setTimeout(() => ws.terminate(), 1000);
    timer.unref();
    ws.once('close', () => clearTimeout(timer));
  }

  function reject(ws, code, version) {
    rejected[code]++;
    log(`[match] rejected ${code} version=${logSafe(version)}`);
    send(ws, code === 'outdated' ? { t: 'reject', code, min: config.minVersion } : { t: 'reject', code });
    closeSoon(ws, 1008, code);
  }

  // ---- handshake ----

  async function onHello(ws, m) {
    ws.state = 'checking';
    const version = typeof m.version === 'string' ? m.version : '';
    if (m.proto !== 2 || !isVersion(version) || compareVersions(version, config.minVersion) < 0) return reject(ws, 'outdated', version);

    let official = false;
    try {
      official = await builds.isOfficial({ version, hash: m.hash, proof: m.proof }, ws.nonce);
    } catch {}
    if (!official) return reject(ws, 'unofficial', version);
    if (ws.readyState !== 1) return; // gone while the build was being checked

    // a token that is not valid any more is not an error: the app is told to forget it
    let signedOut = false;
    let found = null;
    if (m.token !== undefined && m.token !== null) {
      found = typeof m.token === 'string' && m.token.length <= 200 ? auth.accountForToken(m.token) : null;
      signedOut = !found;
    }

    clearTimeout(ws.helloTimer);
    ws.version = version;
    ws.state = 'ready';
    clients.set(ws.id, ws);
    if (found) {
      ws.accountId = found.account.id;
      ws.tokenHash = found.tokenHash;
      // a Pro account works from a few devices at once; the rest are welcomed as free
      const devices = byAccount.get(ws.accountId) || new Set();
      const proNow = [...devices].filter((other) => other.plan === 'pro').length;
      if (planOf(found.account, now()) === 'pro' && proNow < tuning.proDevices) ws.plan = 'pro';
      devices.add(ws);
      byAccount.set(ws.accountId, devices);
    }
    ws.limit = limitFor(ws.plan, config);
    send(ws, {
      t: 'welcome',
      id: ws.id,
      plan: ws.plan,
      limit: ws.limit,
      account: found ? accountView(found.account) : null,
      billing: config.billing,
      prices: { monthly: config.prices.monthly, yearly: config.prices.yearly, yearly_per_month: config.prices.yearlyPerMonth },
      signed_out: signedOut,
    });
  }

  // Before the welcome there is exactly one thing to say, the hello, and it is small. Anything
  // else ends the connection, and nothing large is even parsed.
  function beforeWelcome(ws, raw, isBinary) {
    if (ws.state !== 'new' || isBinary || raw.length > tuning.helloBytes) return closeSoon(ws, 1008, 'hello expected');
    let m;
    try {
      m = JSON.parse(raw.toString('utf8'));
    } catch {
      return closeSoon(ws, 1008, 'hello expected');
    }
    if (!m || typeof m !== 'object' || m.t !== 'hello') return closeSoon(ws, 1008, 'hello expected');
    onHello(ws, m).catch(() => closeSoon(ws, 1011, 'error'));
  }

  // ---- rooms ----

  // Hosted rooms plus joined (or waited-for) rooms count against the limit; without a limit there
  // is still a cap against abuse.
  const full = (ws) => ws.hosting.size + ws.joins.size >= (ws.limit ?? tuning.maxRoomsPerConnection);

  function addWaiter(roomId, ws) {
    if (!waiting.has(roomId)) waiting.set(roomId, new Set());
    waiting.get(roomId).add(ws);
  }
  function removeWaiter(roomId, ws) {
    const set = waiting.get(roomId);
    if (!set) return;
    set.delete(ws);
    if (!set.size) waiting.delete(roomId);
  }

  // The owner is here: everybody who was waiting hears it once and joins again.
  function notifyWaiting(roomId) {
    const set = waiting.get(roomId);
    if (!set) return;
    waiting.delete(roomId);
    for (const ws of set) send(ws, { t: 'online', room: roomId });
  }

  // Rooms the operator blocked. Asked of the database each time rather than remembered, so there is
  // nothing to keep in step with it.
  const isBlocked = (roomId) => db.get('SELECT 1 AS blocked FROM blocked_rooms WHERE room = ?', roomId) !== undefined;

  // How many rooms the table holds. Counting them is not cheap, so it is counted once and then kept
  // up to date; the hourly cleanup counts again.
  let roomCount = db.get('SELECT COUNT(*) AS n FROM rooms').n;

  // Makes space for one more room when the table is full: forgets about 1% of all rooms at once, the
  // ones whose owner registered them longest ago, so this does not have to run for every new room.
  // A room whose owner is connected right now is never taken. -> whether there is space now
  let stuckLogged = 0;
  function makeRoom() {
    if (roomCount < config.maxRooms) return true;
    const batch = Math.max(1, Math.ceil(config.maxRooms / 100));
    // the live rooms may be among the oldest, so look at that many more
    const oldest = db.all('SELECT room FROM rooms ORDER BY last_seen LIMIT ?', batch + live.size);
    const doomed = oldest.filter((r) => !live.has(r.room)).slice(0, batch);
    db.tx(() => {
      for (const { room } of doomed) roomCount -= db.run('DELETE FROM rooms WHERE room = ?', room).changes;
    });
    if (doomed.length) {
      log(`[match] the table of rooms is full (${config.maxRooms}): ${doomed.length} rooms that nobody registered for the longest time were forgotten`);
    } else if (now() - stuckLogged >= 60_000) {
      // once a minute at most, however many are turned away
      stuckLogged = now();
      log(`[match] the table of rooms is full (${config.maxRooms}) and the owner of every room in it is connected, so no new room is taken`);
    }
    return roomCount < config.maxRooms;
  }

  // The operator just blocked this room: whoever is connected loses it at once and is told. That is
  // the owner, friends waiting for the owner, and friends who had joined; none of them keeps a slot
  // for it. The row in rooms stays, so the room is not up for grabs even if the block is lifted.
  // Returns how many connections were told.
  function roomBlocked(roomId) {
    const told = new Set();
    const owner = live.get(roomId);
    if (owner) told.add(owner);
    live.delete(roomId);
    waiting.delete(roomId);
    for (const ws of clients.values()) {
      const hosted = ws.hosting.delete(roomId);
      const joined = ws.joins.delete(roomId);
      if (hosted || joined) told.add(ws);
    }
    for (const ws of told) send(ws, { t: 'err', room: roomId, code: 'blocked' });
    return told.size;
  }

  function onHost(ws, m, roomId) {
    if (typeof m.key !== 'string' || !m.key || m.key.length > 100 || typeof m.exp !== 'number' || !Number.isFinite(m.exp)) return;
    // before everything else: nothing is registered, and no other answer says anything about the room
    if (isBlocked(roomId)) return send(ws, { t: 'err', room: roomId, code: 'blocked' });
    const t = now();
    if (m.exp <= t) return send(ws, { t: 'err', room: roomId, code: 'expired' });
    const keyHash = sha256(m.key);
    const known = db.get('SELECT key_hash, exp FROM rooms WHERE room = ?', roomId);
    // a registration that ran out is free to take again
    if (known && known.exp > t && !safeEqual(known.key_hash, keyHash)) return send(ws, { t: 'err', room: roomId, code: 'taken' });
    if (!ws.hosting.has(roomId) && full(ws)) return send(ws, { t: 'err', room: roomId, code: 'limit' });
    // A room the database has not seen is what fills it, so it is what is counted: per address, and
    // for the table as a whole. Registering a known room again costs nothing.
    if (!known && (!newRooms.allow(ws.peer) || !makeRoom())) return send(ws, { t: 'err', room: roomId, code: 'limit' });
    db.run(
      `INSERT INTO rooms (room, key_hash, exp, last_seen) VALUES (?, ?, ?, ?)
       ON CONFLICT(room) DO UPDATE SET key_hash = excluded.key_hash, exp = excluded.exp, last_seen = excluded.last_seen`,
      roomId,
      keyHash,
      Math.floor(Math.min(m.exp, t + tuning.roomMaxAgeMs)),
      t,
    );
    if (!known) roomCount++;
    live.set(roomId, ws);
    // remembered with the key it was registered with: only that registration is this connection's to take back
    ws.hosting.set(roomId, keyHash);
    send(ws, { t: 'hosted', room: roomId });
    notifyWaiting(roomId);
  }

  // the owner revoked the code: the room is forgotten for good
  function onUnhost(ws, roomId) {
    const keyHash = ws.hosting.get(roomId);
    if (keyHash === undefined) return;
    ws.hosting.delete(roomId);
    const owner = live.get(roomId);
    // another connection of the same app took the room over meanwhile: it is not ours to delete
    if (owner && owner !== ws) return;
    live.delete(roomId);
    // Only the registration this connection made. An earlier owner, whose registration ran out
    // while somebody else took the room over, must not delete the newer owner's room.
    roomCount -= db.run('DELETE FROM rooms WHERE room = ? AND key_hash = ?', roomId, keyHash).changes;
  }

  function onJoin(ws, roomId) {
    // no wait is remembered and no slot is used
    if (isBlocked(roomId)) return send(ws, { t: 'err', room: roomId, code: 'blocked' });
    const known = db.get('SELECT exp FROM rooms WHERE room = ?', roomId);
    if (known && known.exp <= now()) return send(ws, { t: 'err', room: roomId, code: 'expired' });
    if (!ws.joins.has(roomId) && full(ws)) return send(ws, { t: 'err', room: roomId, code: 'limit' });
    const owner = live.get(roomId);
    if (!owner) {
      // remembered, so the app hears when the owner arrives; the wait holds a slot like a join does
      ws.joins.set(roomId, 'waiting');
      addWaiter(roomId, ws);
      return send(ws, { t: 'err', room: roomId, code: known ? 'offline' : 'unknown' });
    }
    ws.joins.set(roomId, 'joined');
    removeWaiter(roomId, ws);
    send(ws, { t: 'joined', room: roomId, host: owner.id });
  }

  function onLeave(ws, roomId) {
    ws.joins.delete(roomId);
    removeWaiter(roomId, ws);
  }

  // relayed only between a room's owner and someone who joined that room
  function onSig(ws, m, roomId) {
    const to = typeof m.to === 'string' ? clients.get(m.to) : undefined;
    if (!to) return;
    const owner = live.get(roomId);
    const allowed = (owner === ws && to.joins.get(roomId) === 'joined') || (owner === to && ws.joins.get(roomId) === 'joined');
    if (allowed) send(to, { t: 'sig', room: roomId, from: ws.id, data: m.data });
  }

  function onMessage(ws, m) {
    if (!isRoom(m.room)) return;
    if (m.t === 'host') onHost(ws, m, m.room);
    else if (m.t === 'unhost') onUnhost(ws, m.room);
    else if (m.t === 'join') onJoin(ws, m.room);
    else if (m.t === 'leave') onLeave(ws, m.room);
    else if (m.t === 'sig') onSig(ws, m, m.room);
  }

  // ---- plans ----

  // Gives every socket of an account the plan it is entitled to now, and tells those that changed.
  function assignPlans(accountId) {
    const sockets = byAccount.get(accountId);
    if (!sockets) return;
    const pro = planOf(db.get('SELECT * FROM accounts WHERE id = ?', accountId), now()) === 'pro';
    let slots = tuning.proDevices;
    // the devices that were here first keep their place
    for (const ws of sockets) {
      const plan = pro && slots > 0 ? 'pro' : 'free';
      if (plan === 'pro') slots--;
      if (plan === ws.plan) continue;
      ws.plan = plan;
      ws.limit = limitFor(plan, config);
      send(ws, { t: 'plan', plan, limit: ws.limit });
    }
  }

  // The socket is not tied to an account any more (signed out, account deleted): back to free.
  function detach(ws) {
    const sockets = byAccount.get(ws.accountId);
    if (sockets) {
      sockets.delete(ws);
      if (!sockets.size) byAccount.delete(ws.accountId);
    }
    ws.accountId = null;
    ws.tokenHash = null;
    if (ws.plan === 'free') return;
    ws.plan = 'free';
    ws.limit = limitFor('free', config);
    send(ws, { t: 'plan', plan: 'free', limit: ws.limit });
  }

  function endSession(tokenHash) {
    for (const ws of [...clients.values()]) if (ws.tokenHash === tokenHash) detach(ws);
  }

  function accountDeleted(accountId) {
    for (const ws of [...(byAccount.get(accountId) || [])]) detach(ws);
  }

  // A paid period can run out with nobody telling us, so look now and then.
  function recheckPlans() {
    for (const accountId of [...byAccount.keys()]) assignPlans(accountId);
  }

  // ---- housekeeping ----

  // Forgets rooms whose time has run out, in memory as well as in the database.
  function expireRooms() {
    const t = now();
    const expired = db.all('SELECT room FROM rooms WHERE exp <= ?', t);
    for (const { room: roomId } of expired) {
      const owner = live.get(roomId);
      if (owner) owner.hosting.delete(roomId);
      live.delete(roomId);
    }
    db.run('DELETE FROM rooms WHERE exp <= ?', t);
    // the moment to count again, in case anything was missed
    roomCount = db.get('SELECT COUNT(*) AS n FROM rooms').n;
    return expired.length;
  }

  function snapshot() {
    const byVersion = {};
    const byPlan = { free: 0, pro: 0 };
    for (const ws of clients.values()) {
      byVersion[ws.version] = (byVersion[ws.version] || 0) + 1;
      byPlan[ws.plan]++;
    }
    let waits = 0;
    for (const set of waiting.values()) waits += set.size;
    return { connections: clients.size, by_version: byVersion, by_plan: byPlan, hosted_rooms: live.size, waiting: waits, rejected: { ...rejected } };
  }

  // ---- connections ----

  // A bucket per connection: a burst big enough for an app registering all its folders after a
  // reconnect, then a steady rate. Whoever keeps going after the bucket is empty is dropped.
  function allowMessage(ws) {
    const t = performance.now();
    ws.tokens = Math.min(tuning.messageBurst, ws.tokens + ((t - ws.refilledAt) / 1000) * tuning.messagesPerSecond);
    ws.refilledAt = t;
    if (ws.tokens >= 1) {
      ws.tokens -= 1;
      ws.dropped = 0;
      return true;
    }
    if (++ws.dropped > tuning.messageBurst) ws.terminate();
    return false;
  }

  function onConnection(ws) {
    ws.id = crypto.randomUUID();
    ws.nonce = randomHex(32);
    // 'new' -> 'checking' while the hello is looked at -> 'ready' after the welcome; 'closed' once it is over
    ws.state = 'new';
    ws.alive = true;
    // room -> the hash of the key it was registered with
    ws.hosting = new Map();
    // room -> 'joined' | 'waiting'
    ws.joins = new Map();
    ws.plan = 'free';
    ws.limit = null;
    ws.accountId = null;
    ws.tokenHash = null;
    ws.version = null;
    ws.tokens = tuning.messageBurst;
    ws.refilledAt = performance.now();
    ws.dropped = 0;

    ws.helloTimer = setTimeout(() => closeSoon(ws, 1008, 'no hello'), tuning.helloTimeoutMs);
    ws.helloTimer.unref();

    ws.on('pong', () => (ws.alive = true));
    ws.on('message', (raw, isBinary) => {
      ws.alive = true;
      if (ws.state === 'closed') return;
      if (ws.state !== 'ready') return beforeWelcome(ws, raw, isBinary);
      if (isBinary || !allowMessage(ws)) return;
      let m;
      try {
        m = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
      // one connection's trouble (a full disk, say) must not take the others down with it
      try {
        onMessage(ws, m);
      } catch (err) {
        log(`[match] a ${logSafe(m.t)} message could not be handled: ${err.message}`);
      }
    });
    ws.on('close', () => {
      clearTimeout(ws.helloTimer);
      clients.delete(ws.id);
      for (const roomId of ws.hosting.keys()) if (live.get(roomId) === ws) live.delete(roomId);
      for (const roomId of ws.joins.keys()) removeWaiter(roomId, ws);
      if (ws.accountId) {
        const sockets = byAccount.get(ws.accountId);
        if (sockets) {
          sockets.delete(ws);
          if (!sockets.size) byAccount.delete(ws.accountId);
        }
      }
    });

    send(ws, { t: 'challenge', nonce: ws.nonce });
  }

  function start() {
    // drop dead connections, keep the others open through the proxy
    timers.push(
      setInterval(() => {
        for (const ws of wss.clients) {
          if (!ws.alive) {
            ws.terminate();
            continue;
          }
          ws.alive = false;
          ws.ping();
        }
      }, tuning.pingIntervalMs),
      setInterval(() => {
        try {
          recheckPlans();
        } catch (err) {
          log(`[match] checking the plans failed: ${err.message}`);
        }
      }, tuning.planCheckMs),
    );
    for (const timer of timers) timer.unref();
  }

  function close() {
    for (const timer of timers) clearInterval(timer);
    timers = [];
    for (const ws of wss.clients) {
      clearTimeout(ws.helloTimer);
      // "going away": the apps connect again to whatever runs next
      closeSoon(ws, 1001, 'restarting');
    }
    wss.close();
  }

  return { handleUpgrade, start, close, assignPlans, endSession, accountDeleted, recheckPlans, expireRooms, roomBlocked, snapshot };
}

module.exports = { createMatch };
