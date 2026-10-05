// FriendsShare matchmaking server.
// It only introduces two apps to each other (WebRTC signaling). Files never pass through here, and
// it never sees a share code: a room is named by the SHA-256 of the code.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
const MAX_ROOMS_PER_SOCKET = 500;

// room -> { keyHash, exp }. Remembered across restarts so nobody else can claim a host's room.
const rooms = new Map();
// room -> socket of the host that is online right now
const live = new Map();
// socket id -> socket
const clients = new Map();

fs.mkdirSync(DATA_DIR, { recursive: true });
try {
  for (const [room, rec] of Object.entries(JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8')))) rooms.set(room, rec);
} catch {}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(ROOMS_FILE + '.tmp', JSON.stringify(Object.fromEntries(rooms)), (err) => {
      if (!err) fs.rename(ROOMS_FILE + '.tmp', ROOMS_FILE, () => {});
    });
  }, 1000);
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const isRoom = (r) => typeof r === 'string' && /^[0-9a-f]{64}$/.test(r);
const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));

function onMessage(ws, m) {
  if (!m || !isRoom(m.room)) return;
  const { room } = m;
  const rec = rooms.get(room);

  if (m.t === 'host') {
    if (typeof m.key !== 'string' || m.key.length > 100 || typeof m.exp !== 'number') return;
    if (m.exp <= Date.now()) return send(ws, { t: 'err', room, code: 'expired' });
    if (rec && rec.keyHash !== sha(m.key)) return send(ws, { t: 'err', room, code: 'taken' });
    if (ws.hosting.size >= MAX_ROOMS_PER_SOCKET) return;
    rooms.set(room, { keyHash: sha(m.key), exp: m.exp });
    save();
    live.set(room, ws);
    ws.hosting.add(room);
    send(ws, { t: 'hosted', room });
  } else if (m.t === 'unhost') {
    // the host revoked the code
    if (!ws.hosting.has(room)) return;
    ws.hosting.delete(room);
    live.delete(room);
    rooms.delete(room);
    save();
  } else if (m.t === 'join') {
    if (rec && rec.exp <= Date.now()) return send(ws, { t: 'err', room, code: 'expired' });
    const host = live.get(room);
    if (!host) return send(ws, { t: 'err', room, code: rec ? 'offline' : 'unknown' });
    if (ws.joined.size >= MAX_ROOMS_PER_SOCKET) return;
    ws.joined.add(room);
    send(ws, { t: 'joined', room, host: host.id });
  } else if (m.t === 'sig') {
    // relayed only between a room's host and someone who joined that room
    const to = clients.get(m.to);
    if (!to) return;
    const host = live.get(room);
    const ok = (host === ws && to.joined.has(room)) || (host === to && ws.joined.has(room));
    if (ok) send(to, { t: 'sig', room, from: ws.id, data: m.data });
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('FriendsShare matchmaking is running.\n');
});

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
wss.on('connection', (ws) => {
  ws.id = crypto.randomUUID();
  ws.hosting = new Set();
  ws.joined = new Set();
  ws.alive = true;
  clients.set(ws.id, ws);
  ws.on('pong', () => (ws.alive = true));
  ws.on('error', () => {});
  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    onMessage(ws, m);
  });
  ws.on('close', () => {
    clients.delete(ws.id);
    for (const room of ws.hosting) if (live.get(room) === ws) live.delete(room);
  });
});

// drop dead connections, keep the others open through the proxy
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    ws.ping();
  }
}, 30000);

// forget expired rooms
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [room, rec] of rooms) {
    if (rec.exp > now) continue;
    rooms.delete(room);
    live.delete(room);
    changed = true;
  }
  if (changed) save();
}, 3600 * 1000);

server.listen(PORT, () => console.log(`FriendsShare matchmaking on :${PORT}`));
