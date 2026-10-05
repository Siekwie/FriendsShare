// The matchmaking protocol from the app's side, against a scripted fake server: what the hello
// contains, what is registered under a limit, how errors, notices and plan changes are handled, and
// that a server that closes the connection is not asked again in a tight loop. The real server is
// covered by the other tests; this one can make the server say things it would not say by itself.
//   node test/protocol.js
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const t = require('./lib');

const NAME = 'protocol';
const HOUR = 3600 * 1000;
const FINGERPRINT = t.sha('the app.asar of a test build');
const SECRET = 'protocol-test-secret';
const BLOCKED = 'This share code has been blocked and cannot be used.';
const ui = (app, expr) => app.eval(expr).catch((err) => `error: ${err.message}`);

// A matchmaking server that does what the test says. connections: every socket that was opened, with
// its hello and the messages that came after it (conn.early are messages that came before the hello).
async function fakeMatchmaker(welcome = {}) {
  const port = await t.freePort();
  const wss = new WebSocket.WebSocketServer({ port, host: '127.0.0.1' });
  const fake = {
    signalUrl: `ws://127.0.0.1:${port}/ws`,
    connections: [],
    welcome: { plan: 'free', limit: null, account: null, billing: false, prices: { monthly: '€1.99', yearly: '€11.88', yearly_per_month: '€0.99' }, signed_out: false, ...welcome },
    reject: null,
    dropAfterHello: false,
    onMessage: null,
  };
  wss.on('connection', (ws) => {
    const conn = { ws, nonce: crypto.randomBytes(32).toString('hex'), at: Date.now(), hello: null, helloBytes: 0, early: [], messages: [] };
    fake.connections.push(conn);
    ws.send(JSON.stringify({ t: 'challenge', nonce: conn.nonce }));
    ws.on('message', (data) => {
      const m = JSON.parse(String(data));
      if (!conn.hello) {
        if (m.t !== 'hello') return conn.early.push(m);
        conn.hello = m;
        conn.helloBytes = Buffer.byteLength(String(data));
        if (fake.dropAfterHello) return ws.close();
        if (fake.reject) {
          ws.send(JSON.stringify({ t: 'reject', ...fake.reject }));
          return void setTimeout(() => ws.close(), 50);
        }
        return ws.send(JSON.stringify({ t: 'welcome', id: crypto.randomUUID(), ...fake.welcome }));
      }
      conn.messages.push(m);
      if (fake.onMessage) fake.onMessage(conn, m);
    });
  });
  fake.send = (conn, msg) => conn.ws.send(JSON.stringify(msg));
  fake.last = () => fake.connections[fake.connections.length - 1];
  // the messages of one type from all connections, in order
  fake.sent = (type, filter = () => true) => fake.connections.flatMap((c) => c.messages).filter((m) => m.t === type && filter(m));
  fake.stop = () =>
    new Promise((resolve) => {
      for (const client of wss.clients) client.terminate();
      wss.close(() => resolve());
    });
  return fake;
}

// The folder exists: an owner's folder that is not there says so, in the status line (see files.js)
const hostShare = (id, name, code, createdAt) => {
  const dir = path.join(t.tmpRoot, NAME, 'hostfiles', id);
  fs.mkdirSync(dir, { recursive: true });
  return { id, role: 'host', name, dir, code, hostKey: crypto.randomUUID(), createdAt, expiresAt: Date.now() + 86400000 };
};
const guestShare = (id, code, createdAt) => ({ id, role: 'guest', name: `Share ${code.slice(0, 8)}`, dir: null, code, chosen: true, createdAt });
const online = (app) => t.waitFor(async () => (await ui(app, "document.querySelector('#conn').dataset.state")) === 'online', 20000, `${app.who} to be online`);

(async () => {
  await t.scenario('The hello, and what is registered under a limit', async (cleanup) => {
    t.resetDir(path.join(t.tmpRoot, NAME));
    const fake = await fakeMatchmaker({ limit: 1, billing: true });
    cleanup(() => fake.stop());
    const codeOld = crypto.randomUUID();
    const codeNew = crypto.randomUUID();
    const now = Date.now();
    // the newer folder comes first in the list; the older one has the right to the only slot
    const seed = { shares: [hostShare('new', 'Newer', codeNew, now - HOUR), hostShare('old', 'Older', codeOld, now - 2 * HOUR)] };

    const key = t.buildKeyFor(SECRET);
    const official = await t.startApp({ name: NAME, who: 'official', signal: fake.signalUrl, seed, env: { FS_BUILD_KEY: key, FS_BUILD_HASH: FINGERPRINT } });
    cleanup(() => official.quit());
    await official.ready();
    await online(official);
    await t.sleep(800);
    const conn = fake.connections[0];
    const expected = crypto.createHmac('sha256', key).update(`${conn.nonce}|${FINGERPRINT}|${t.version}`).digest('hex');
    t.check(conn.hello.t === 'hello' && conn.hello.proto === 2 && conn.hello.version === t.version, 'the hello says protocol 2 and the version of the app');
    t.check(conn.hello.hash === FINGERPRINT && conn.hello.proof === expected, 'its proof is the HMAC of nonce|hash|version keyed with the build key, as the contract says');
    t.check(conn.hello.token === null && conn.helloBytes < 4096 && conn.early.length === 0, 'it carries no token, is small, and nothing was sent before it');
    t.check(fake.connections.length === 1, 'and it is sent once, on one connection');

    const hosts = fake.sent('host');
    t.check(hosts.length === 1 && hosts[0].room === t.sha(codeOld) && typeof hosts[0].key === 'string' && hosts[0].exp > Date.now(), 'with a limit of 1 only the older folder is registered, with its key and expiry');
    t.check(!hosts.some((m) => m.room === t.sha(codeNew)) && !JSON.stringify(fake.connections[0].messages).includes(codeOld), 'the newer one is not, and no share code is ever sent, only the room');
    t.check((await ui(official, "document.querySelector('#list-host li.paused .name').textContent")) === 'Newer', 'the newer folder is paused in the list');

    // a copy from source has no key: an empty proof, and "dev"
    const plain = await t.startApp({ name: NAME, who: 'plain', signal: fake.signalUrl });
    cleanup(() => plain.quit());
    await plain.ready();
    await online(plain);
    const hello = fake.connections[1].hello;
    t.check(hello.proof === '' && hello.hash === 'dev' && hello.token === null, 'a build from source says "dev" and sends an empty proof');
    t.check(official.dialogs.length + plain.dialogs.length === 0, 'no dialog was opened');
  });

  await t.scenario('blocked, online, leave and plan', async (cleanup) => {
    t.resetDir(path.join(t.tmpRoot, NAME));
    const fake = await fakeMatchmaker();
    cleanup(() => fake.stop());
    const code = { h1: crypto.randomUUID(), g1: crypto.randomUUID(), g2: crypto.randomUUID() };
    const room = (key) => t.sha(code[key]);
    const now = Date.now();
    fake.onMessage = (conn, m) => {
      if (m.t === 'host' && m.room === room('h1')) fake.send(conn, { t: 'err', room: m.room, code: 'blocked' });
      else if (m.t === 'join' && m.room === room('g1')) fake.send(conn, { t: 'err', room: m.room, code: 'blocked' });
      else if (m.t === 'join' && m.room === room('g2')) fake.send(conn, { t: 'err', room: m.room, code: 'offline' });
    };
    const app = await t.startApp({
      name: NAME, who: 'app', signal: fake.signalUrl,
      seed: { shares: [hostShare('h1', 'Mine', code.h1, now - 3 * HOUR), guestShare('g1', code.g1, now - 2 * HOUR), guestShare('g2', code.g2, now - HOUR)] },
    });
    cleanup(() => app.quit());
    await app.ready();
    await online(app);
    await t.waitFor(() => fake.sent('join', (m) => m.room === room('g1')).length >= 1 && fake.sent('join', (m) => m.room === room('g2')).length >= 1, 15000, 'the folders to be tried');

    // ---- the owner's side: the code was blocked ----
    await ui(app, "select('h1')");
    await t.waitFor(async () => (await ui(app, "document.querySelector('#status').textContent")).startsWith(BLOCKED), 8000, 'the owner to be told');
    t.check((await ui(app, "document.querySelector('#status').className")) === 'hint status error' && /Click New code/.test(await ui(app, "document.querySelector('#status').textContent")), 'a blocked code of your own is said in the folder\'s status line, with what to do');
    await ui(app, 'p2p.setHostShares(activeShares())');
    await t.sleep(1500);
    t.check(fake.sent('host', (m) => m.room === room('h1')).length === 1 && fake.sent('unhost').length === 0, 'the blocked room is not announced again, and not withdrawn either');
    await ui(app, "api.generateCode('h1', 365).then(() => reload())");
    await t.waitFor(() => fake.sent('host').length === 2, 8000, 'the new code to be registered');
    t.check(fake.sent('host')[1].room !== room('h1') && (await ui(app, "document.querySelector('#status').className")) === 'hint status', 'a new code makes a new room, which is announced, and the status line is clear again');
    t.check(fake.sent('unhost').length === 0, 'replacing the code did not withdraw the blocked room either: that is the operator\'s business');

    // ---- a friend's folder whose code is blocked ----
    await ui(app, "select('g1')");
    t.check((await ui(app, "document.querySelector('#status').textContent")) === BLOCKED && (await ui(app, "document.querySelector('#status').className")) === 'status error', 'the sync of a blocked friend\'s code ends with a plain message');
    await ui(app, 'syncAll()');
    await t.sleep(1500);
    t.check(fake.sent('join', (m) => m.room === room('g1')).length === 1, 'it is not tried again by the automatic rounds');
    await ui(app, "syncShare('g1', { download: true, manual: true })");
    await t.waitFor(() => fake.sent('join', (m) => m.room === room('g1')).length === 2, 8000, 'the manual sync');
    t.check(true, 'only a click on Sync now tries it again');

    // ---- a friend's folder whose owner is offline: the notice starts the sync at once ----
    await ui(app, "select('g2')");
    t.check(/not running right now/.test(await ui(app, "document.querySelector('#status').textContent")), 'an owner who is offline is said plainly');
    const joinsBefore = fake.sent('join', (m) => m.room === room('g2')).length;
    fake.send(fake.last(), { t: 'online', room: room('g2') });
    await t.waitFor(() => fake.sent('join', (m) => m.room === room('g2')).length === joinsBefore + 1, 4000, 'the app to join again');
    t.check(true, 'when the server says the owner is online, the app joins again at once');
    // the server blocks the code while we wait
    fake.send(fake.last(), { t: 'err', room: room('g2'), code: 'blocked' });
    await t.waitFor(async () => (await ui(app, "document.querySelector('#status').textContent")) === BLOCKED, 4000, 'the unprompted block to show');
    t.check(true, 'a block that comes while waiting is shown the same way');
    const afterBlock = fake.sent('join', (m) => m.room === room('g2')).length;
    fake.send(fake.last(), { t: 'online', room: room('g2') });
    await t.sleep(1500);
    t.check(fake.sent('join', (m) => m.room === room('g2')).length === afterBlock, 'and the next "online" does not start it again');

    // ---- removing a folder from a friend ----
    await ui(app, "removeShare(state.shares.find((s) => s.id === 'g1'))");
    await t.waitFor(() => fake.sent('leave').length === 1, 4000, 'leave');
    t.check(fake.sent('leave')[0].room === room('g1') && app.dialogs.length === 1, 'removing a folder from a friend tells the server (leave), after the confirmation');

    // ---- the plan changes while connected ----
    const connections = fake.connections.length;
    fake.welcome = { ...fake.welcome, plan: 'pro', limit: null };
    fake.send(fake.last(), { t: 'plan', plan: 'pro', limit: null });
    await t.waitFor(() => fake.connections.length === connections + 1, 6000, 'the app to connect again');
    t.check((await ui(app, "account.plan")) === 'pro' && app.config().welcome.plan === 'pro', 'a plan message is stored, and the app connects again at once');
    await t.waitFor(() => fake.last().messages.some((m) => m.t === 'host'), 6000, 'the folders to be registered again');
    t.check(fake.last().hello.proto === 2 && fake.last().early.length === 0, 'with a new hello, and the folders are registered again on the new connection');
    t.check((await ui(app, "[...document.querySelectorAll('li.paused')].length")) === 0, 'nothing is paused');
  });

  await t.scenario('The token travels in the hello, and a signed_out welcome makes the app forget it', async (cleanup) => {
    t.resetDir(path.join(t.tmpRoot, NAME));
    const fake = await fakeMatchmaker({ signed_out: true });
    cleanup(() => fake.stop());
    const token = `fsa_${crypto.randomBytes(32).toString('base64url')}`;
    const app = await t.startApp({
      name: NAME, who: 'signedin', signal: fake.signalUrl,
      seed: { token: { plain: token }, welcome: { plan: 'pro', limit: null, account: { name: 'Ada', email: 'ada@example.com', avatar: null }, billing: true, prices: null } },
    });
    cleanup(() => app.quit());
    await app.ready();
    await t.waitFor(() => fake.connections.length >= 1 && fake.connections[0].hello, 15000, 'the hello');
    t.check(fake.connections[0].hello.token === token, 'the saved token is in the hello');
    await t.waitFor(() => app.config().token === undefined, 8000, 'the token to be forgotten');
    t.check(app.config().welcome.account === null && app.config().welcome.plan === 'free', 'signed_out in the welcome: the token and the account are forgotten');
    t.check((await ui(app, "document.querySelector('#acct-name').textContent")) === 'Sign in', 'and the window shows signed out');
    fake.welcome = { ...fake.welcome, signed_out: false };
    await ui(app, 'p2p.reconnect()');
    await t.waitFor(() => fake.connections.length === 2 && fake.connections[1].hello, 8000, 'the second hello');
    t.check(fake.connections[1].hello.token === null, 'the next hello carries no token');
  });

  await t.scenario('A server that closes the connection is not asked again in a tight loop', async (cleanup) => {
    t.resetDir(path.join(t.tmpRoot, NAME));
    const fake = await fakeMatchmaker();
    fake.dropAfterHello = true;
    cleanup(() => fake.stop());
    const app = await t.startApp({ name: NAME, who: 'app', signal: fake.signalUrl });
    cleanup(() => app.quit());
    await app.ready();
    await t.waitFor(() => fake.connections.length >= 4, 30000, 'four attempts');
    const gaps = fake.connections.slice(1, 4).map((c, i) => (c.at - fake.connections[i].at) / 1000);
    // 1 s, 2 s, 4 s: the counter starts over with a welcome, not with an open socket
    t.check(gaps[0] >= 0.8 && gaps[1] >= 1.8 && gaps[2] >= 3.6, `the waits between attempts keep growing (${gaps.map((g) => g.toFixed(1)).join(' s, ')} s)`);
    t.check(fake.connections.every((c) => c.early.length === 0), 'nothing is sent before the hello');
  });

  await t.scenario('"limit" that has nothing to do with the plan: the folder is not paused, no upgrade, and it is tried again', async (cleanup) => {
    t.resetDir(path.join(t.tmpRoot, NAME));
    // a welcome that says there is no limit (Pro, or a server without one)
    const fake = await fakeMatchmaker({ limit: null });
    cleanup(() => fake.stop());
    const codes = { h1: crypto.randomUUID(), h2: crypto.randomUUID() };
    const room = (id) => t.sha(codes[id]);
    const now = Date.now();
    // the server turns the first folder away with "limit" the first time it is asked (an address may only
    // register 60 new folders an hour, and its table can be full), and takes everything else
    const refusals = { h1: 1, h2: 0 };
    fake.onMessage = (conn, m) => {
      if (m.t !== 'host') return;
      const id = m.room === room('h1') ? 'h1' : 'h2';
      if (refusals[id] > 0) {
        refusals[id]--;
        fake.send(conn, { t: 'err', room: m.room, code: 'limit' });
      } else {
        fake.send(conn, { t: 'hosted', room: m.room });
      }
    };
    const app = await t.startApp({ name: NAME, who: 'app', signal: fake.signalUrl, seed: { shares: [hostShare('h1', 'One', codes.h1, now - 2 * HOUR), hostShare('h2', 'Two', codes.h2, now - HOUR)] } });
    cleanup(() => app.quit());
    await app.ready();
    await online(app);
    await t.waitFor(async () => (await ui(app, '[...unregistered].join()')) === 'h1', 10000, 'the refusal to be noticed');
    const hosts = (id) => fake.sent('host', (m) => m.room === room(id)).length;
    t.check((await ui(app, 'account.limit === null && [...limited].length === 0 && [...paused].length === 0')) === true, 'the plan has no limit, and the folder is not paused');
    const tags = await ui(app, "[...document.querySelectorAll('#list-host li')].map((li) => li.textContent).join('|')");
    t.check(/^One.*not registered\|Two$/.test(tags) && (await ui(app, "document.querySelectorAll('#list-host li.paused').length")) === 0, `it is shown as not registered in the list, and as nothing else ("${tags}")`);
    await ui(app, "select('h1'); 0");
    const line = await ui(app, "document.querySelector('#status').textContent");
    t.check(/could not be registered right now/.test(line) && /tries again later/.test(line) && !/upgrade|plan/i.test(line) && (await ui(app, "document.querySelector('#status').className")) === 'hint status error', `its card says it could not be registered right now and is tried again later ("${line}")`);
    t.check((await ui(app, "!document.querySelector('#paused-card') && !document.querySelector('#btn-paused-upgrade') && !document.querySelector('#dlg-limit[open]')")) === true, 'with no "Paused", and no "Upgrade to Pro"');
    // it is not asked again by itself every time something changes
    await ui(app, 'reload()');
    await t.sleep(1500);
    t.check(hosts('h1') === 1 && hosts('h2') === 1, 'the server is not asked again just because the window drew again');
    // after a while
    t.check((await ui(app, 'RETRY_REGISTER_EVERY')) === 600000, 'it is asked again every 10 minutes');
    await ui(app, 'retryUnregistered(); 0');
    await t.waitFor(() => hosts('h1') === 2, 5000, 'the folder to be registered again');
    await t.waitFor(async () => (await ui(app, '[...unregistered].length')) === 0, 5000, 'the folder to count as registered');
    t.check(hosts('h2') === 1 && !/not registered/.test(await ui(app, "document.querySelector('#list-host').textContent")) && (await ui(app, "document.querySelector('#status').className")) === 'hint status', 'and when the server takes it, the list and the card say nothing about it any more');
    // on the next connection
    refusals.h1 = 1;
    await ui(app, 'p2p.reconnect()');
    await t.waitFor(async () => (await ui(app, '[...unregistered].join()')) === 'h1', 10000, 'the refusal on the new connection');
    t.check(fake.connections.length === 2 && hosts('h1') === 3, 'a new connection registers the folder again, and is refused again');
    await ui(app, 'p2p.reconnect()');
    await t.waitFor(() => hosts('h1') === 4, 10000, 'the next connection to register it');
    await t.waitFor(async () => (await ui(app, '[...unregistered].length')) === 0, 5000, 'the folder to count as registered');
    const listText = await ui(app, "document.querySelector('#list-host').textContent");
    t.check(fake.connections.length === 3 && !/not registered/.test(listText), `and the next connection gets it registered, without anybody doing anything (${fake.connections.length} connections, list "${listText}")`);
    t.check(app.dialogs.length === 0, 'no dialog was opened');
  });
  t.finish();
})();
