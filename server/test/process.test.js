// The real entry point, started the way the root package.json and the container start it:
// node server/server.js with PORT and DATA_DIR in the environment.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { sleep, sha256 } = require('./helpers');
const { installProcessHandlers, describe } = require('../lib/process');

const SERVER = path.join(__dirname, '..', 'server.js');
const PRELOAD = path.join(__dirname, 'no-network.js');
// makes a process fail when a test asks it to
const CRASH = path.join(__dirname, 'crash-on-demand.js');
// whatever the developer's own environment has must not leak into these processes
const BLANK = Object.fromEntries(
  [
    'BASE_URL', 'APP_SECRET', 'TRUST_PROXY', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_MONTHLY', 'STRIPE_PRICE_YEARLY', 'STRIPE_PORTAL_CONFIG', 'STRIPE_MANAGED_PAYMENTS', 'FREE_LIMIT', 'ENFORCE_LIMIT',
    'REQUIRE_OFFICIAL', 'BUILD_SECRET', 'MIN_VERSION', 'RELEASE_REPO', 'EXTRA_BUILDS', 'BACKUP_INTERVAL_HOURS', 'BACKUP_KEEP', 'OPERATOR_NAME',
    'OPERATOR_ADDRESS', 'OPERATOR_EMAIL', 'OPERATOR_HOSTING', 'NODE_OPTIONS',
  ].map((name) => [name, '']),
);

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function start(env, preload = [PRELOAD]) {
  const child = spawn(process.execPath, [...preload.flatMap((file) => ['--require', file]), '--disable-warning=ExperimentalWarning', SERVER], {
    env: { ...process.env, ...BLANK, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { out: '', err: '' };
  child.stdout.on('data', (chunk) => (output.out += chunk));
  child.stderr.on('data', (chunk) => (output.err += chunk));
  // 'close', not 'exit': only then has everything the process printed been read
  const exited = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  return { child, output, exited };
}

async function waitForHealth(port, running) {
  for (let n = 0; n < 100; n++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`the server did not come up. stdout: ${running.output.out} stderr: ${running.output.err}`);
}

// What a process printed reaches us a moment after it happened, so it is waited for, not assumed.
async function waitForOutput(running, stream, pattern) {
  for (let n = 0; n < 250; n++) {
    if (pattern.test(running.output[stream])) return;
    await sleep(20);
  }
  throw new Error(`${pattern} never appeared in ${stream}: ${running.output[stream]}`);
}

const cleanUp = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

test('node server/server.js serves on PORT and keeps its data in DATA_DIR', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'friendsshare-process-'));
  const port = await freePort();
  const running = start({ PORT: String(port), DATA_DIR: dir });
  try {
    await waitForHealth(port, running);
    const base = `http://127.0.0.1:${port}`;

    assert.equal(await (await fetch(`${base}/healthz`)).text(), 'ok');
    const me = await (await fetch(`${base}/api/me`)).json();
    assert.equal(me.account, null);
    assert.equal(me.billing, false);
    // whatever the real website has at "/" comes with the security headers
    const home = await fetch(`${base}/`);
    assert.ok([200, 404].includes(home.status));
    assert.equal(home.headers.get('x-frame-options'), 'DENY');

    // an app from source connects to the new path and is welcomed; the old path is turned away
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    await new Promise((resolve, reject) => (ws.once('open', resolve), ws.once('error', reject)));
    for (let n = 0; n < 250 && !messages.length; n++) await sleep(20);
    assert.equal(messages[0].t, 'challenge');
    ws.send(JSON.stringify({ t: 'hello', proto: 2, version: '1.2.0', hash: 'dev', proof: '', token: null }));
    for (let n = 0; n < 250 && messages.length < 2; n++) await sleep(20);
    assert.equal(messages[1].t, 'welcome');
    ws.close();

    // an old app knocks on "/": plain HTTP 426, no WebSocket
    const status = await new Promise((resolve) => {
      const old = new WebSocket(`ws://127.0.0.1:${port}/`);
      old.on('unexpected-response', (req, res) => resolve(res.statusCode));
      old.on('error', () => {});
    });
    assert.equal(status, 426);

    // everything it keeps is under DATA_DIR
    assert.ok(fs.existsSync(path.join(dir, 'friendsshare.db')));
    assert.match(fs.readFileSync(path.join(dir, 'secret.key'), 'utf8'), /^[0-9a-f]{64}$/);
    assert.equal(fs.readdirSync(path.join(dir, 'backups')).length, 1);
    await waitForOutput(running, 'out', new RegExp(`FriendsShare server on :${port}`));
    await waitForOutput(running, 'out', /\[config\] http:\/\/localhost:\d+, sign-in: off, billing: off/);
    assert.ok(!running.output.err.includes('ExperimentalWarning'), running.output.err);
  } finally {
    // only the process this test started, by its own handle
    running.child.kill();
    await running.exited;
    cleanUp(dir);
  }
});

test('the operator can block a share code on the running server, from the machine itself', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'friendsshare-process-'));
  const port = await freePort();
  const running = start({ PORT: String(port), DATA_DIR: dir });
  const code = '123e4567-e89b-12d3-a456-426614174000';
  const room = sha256(code);
  const base = `http://127.0.0.1:${port}`;
  const operator = (method, urlPath, body, headers) =>
    fetch(`${base}${urlPath}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  let app = null;
  try {
    await waitForHealth(port, running);
    app = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages = [];
    const next = async (match) => {
      for (let n = 0; n < 100; n++) {
        const at = messages.findIndex(match);
        if (at >= 0) return messages.splice(at, 1)[0];
        await sleep(20);
      }
      throw new Error(`nothing arrived; unread: ${JSON.stringify(messages)}`);
    };
    app.on('message', (data) => messages.push(JSON.parse(data.toString())));
    await new Promise((resolve, reject) => (app.once('open', resolve), app.once('error', reject)));
    await next((m) => m.t === 'challenge');
    app.send(JSON.stringify({ t: 'hello', proto: 2, version: '1.2.0', hash: 'dev', proof: '', token: null }));
    await next((m) => m.t === 'welcome');
    const host = () => app.send(JSON.stringify({ t: 'host', room, key: 'k', exp: Date.now() + 3_600_000 }));

    host();
    assert.equal((await next((m) => m.room === room)).t, 'hosted');

    // from the machine: blocking works at once, for the code as the reporter sent it
    const blocked = await operator('POST', '/internal/block', { code: ` ${code.toUpperCase()} `, note: 'abuse report 17' });
    assert.equal(blocked.status, 200);
    assert.deepEqual(await blocked.json(), { room, blocked: true });
    assert.deepEqual(await next((m) => m.room === room), { t: 'err', room, code: 'blocked' });
    host();
    assert.deepEqual(await next((m) => m.room === room), { t: 'err', room, code: 'blocked' });
    const list = await (await operator('GET', '/internal/blocked')).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].room, room);
    assert.equal(list[0].note, 'abuse report 17');
    assert.equal((await (await operator('GET', '/internal/stats')).json()).blocked_rooms, 1);

    // through the proxy none of it exists
    for (const [method, urlPath, body] of [['POST', '/internal/unblock', { room }], ['GET', '/internal/blocked'], ['GET', '/internal/stats']]) {
      const res = await operator(method, urlPath, body, { 'x-forwarded-for': '203.0.113.9' });
      assert.equal(res.status, 404, `${method} ${urlPath}`);
    }
    assert.equal((await (await operator('GET', '/internal/blocked')).json()).length, 1);

    // and it can be lifted again
    assert.deepEqual(await (await operator('POST', '/internal/unblock', { code })).json(), { room, blocked: false });
    host();
    assert.equal((await next((m) => m.room === room)).t, 'hosted');
    await waitForOutput(running, 'out', new RegExp(`\\[operator\\] room ${room.slice(0, 12)} blocked, 1 connection told`));
    assert.ok(!running.output.out.includes(code) && !running.output.out.includes('abuse report'), 'neither the code nor the note is logged');
  } finally {
    if (app) app.close();
    running.child.kill();
    await running.exited;
    cleanUp(dir);
  }
});

test('a configuration that cannot work stops the server with a plain message', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'friendsshare-process-'));
  try {
    const running = start({ PORT: String(await freePort()), DATA_DIR: dir, REQUIRE_OFFICIAL: '1' });
    const { code } = await running.exited;
    assert.equal(code, 1);
    assert.match(running.output.err, /Configuration error: BUILD_SECRET is required when REQUIRE_OFFICIAL=1/);
    assert.ok(!running.output.err.includes('    at '), 'no stack trace for a mistake in the settings');

    const taken = await freePort();
    const holder = net.createServer();
    await new Promise((resolve) => holder.listen(taken, resolve));
    const clash = start({ PORT: String(taken), DATA_DIR: dir });
    assert.equal((await clash.exited).code, 1);
    assert.match(clash.output.err, /Could not listen on/);
    holder.close();
  } finally {
    cleanUp(dir);
  }
});

test('SIGTERM closes the server cleanly (where the platform has signals)', { skip: process.platform === 'win32' && 'Windows ends a process on kill() without running its handlers' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'friendsshare-process-'));
  const port = await freePort();
  const running = start({ PORT: String(port), DATA_DIR: dir });
  try {
    await waitForHealth(port, running);
    running.child.kill('SIGTERM');
    const { code } = await running.exited;
    assert.equal(code, 0);
    await waitForOutput(running, 'out', /SIGTERM received, shutting down/);
  } finally {
    cleanUp(dir);
  }
});

// ---- what nobody planned for ----

test('a promise nobody waits for is logged and the program carries on, an error nothing catches is logged and stops it', () => {
  const proc = new EventEmitter();
  const lines = [];
  const exits = [];
  installProcessHandlers(proc, { log: (line) => lines.push(line), exit: (code) => exits.push(code) });

  proc.emit('unhandledRejection', new Error('nobody waited for this'), Promise.resolve());
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[process\] unhandled rejection: Error: nobody waited for this\n/);
  assert.deepEqual(exits, [], 'a failed promise is no reason to stop');
  // whatever it was that failed, it is said and nothing more happens
  for (const reason of ['plain text', 42, undefined, null, { a: 1 }, Object.create(null), { toString: () => { throw new Error('no'); } }]) proc.emit('unhandledRejection', reason);
  assert.equal(lines.length, 8);
  assert.equal(lines[1], '[process] unhandled rejection: plain text');
  assert.equal(lines[2], '[process] unhandled rejection: 42');
  assert.equal(lines[7], '[process] unhandled rejection: something that cannot be printed');
  assert.deepEqual(exits, []);

  proc.emit('uncaughtException', new Error('this broke'), 'uncaughtException');
  assert.match(lines.at(-1), /^\[process\] uncaught exception: Error: this broke\n/);
  assert.deepEqual(exits, [1], 'what state the program is in is unknown, so it stops, with a code that makes the supervisor start it again');

  // a log that cannot be written does not keep either of them from doing what it should
  const stubborn = new EventEmitter();
  const codes = [];
  installProcessHandlers(stubborn, { log: () => { throw new Error('the log is gone'); }, exit: (code) => codes.push(code) });
  stubborn.emit('unhandledRejection', new Error('x'));
  stubborn.emit('uncaughtException', new Error('y'));
  assert.deepEqual(codes, [1]);
});

test('what a failure says cannot forge a line of the log or carry control codes', () => {
  assert.equal(describe('a\r\n[auth] forged\n\u001b[31mred\u0000'), 'a\n  [auth] forged\n  ?[31mred?');
  const lines = [];
  installProcessHandlers(new EventEmitter().on('unhandledRejection', () => {}), { log: (line) => lines.push(line), exit() {} });
  const proc = new EventEmitter();
  installProcessHandlers(proc, { log: (line) => lines.push(line), exit() {} });
  proc.emit('unhandledRejection', new Error('first\n[auth] session of ada@example.com started\nthird'));
  const [line] = lines;
  assert.ok(line.startsWith('[process] unhandled rejection: Error: first\n  [auth] session'), line);
  assert.deepEqual(line.split('\n').filter((l) => l.startsWith('[')), [line.split('\n')[0]], 'only the first line is a line of ours');
});

async function connectedApp(port) {
  const app = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const messages = [];
  app.on('message', (data) => messages.push(JSON.parse(data.toString())));
  // the server going away must not be an error of the test
  app.on('error', () => {});
  const next = async (match) => {
    for (let n = 0; n < 150; n++) {
      const at = messages.findIndex(match);
      if (at >= 0) return messages.splice(at, 1)[0];
      await sleep(20);
    }
    throw new Error(`nothing arrived; unread: ${JSON.stringify(messages)}`);
  };
  await new Promise((resolve, reject) => (app.once('open', resolve), app.once('error', reject)));
  await next((m) => m.t === 'challenge');
  app.send(JSON.stringify({ t: 'hello', proto: 2, version: '1.2.0', hash: 'dev', proof: '', token: null }));
  await next((m) => m.t === 'welcome');
  return { app, next };
}

test('in the running server a failed promise changes nothing for those who are connected, and an error nothing catches ends it with code 1', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'friendsshare-process-'));
  const port = await freePort();
  const trigger = path.join(dir, 'crash-now');
  const running = start({ PORT: String(port), DATA_DIR: dir, CRASH_FILE: trigger }, [PRELOAD, CRASH]);
  const room = (n) => sha256(`room ${n}`);
  let client = null;
  try {
    await waitForHealth(port, running);
    client = await connectedApp(port);
    const host = async (n) => {
      client.app.send(JSON.stringify({ t: 'host', room: room(n), key: 'k', exp: Date.now() + 3_600_000 }));
      return (await client.next((m) => m.room === room(n))).t;
    };
    assert.equal(await host(1), 'hosted');

    // a promise that nobody waits for fails: said, and nothing else
    fs.writeFileSync(trigger, 'reject');
    await waitForOutput(running, 'err', /\[process\] unhandled rejection: Error: a promise that nobody waits for failed/);
    assert.ok(!/^\[auth\]/m.test(running.output.err), 'what the message said cannot start a line of its own');
    assert.match(running.output.err, /\n {2}\[auth\] a line that somebody forged/);
    assert.equal(running.child.exitCode, null, 'still running');
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/healthz`)).text(), 'ok');
    assert.equal(client.app.readyState, WebSocket.OPEN, 'nobody was cut off');
    assert.equal(await host(2), 'hosted', 'and the matchmaking works as before');

    // an error that nothing catches: said, and the process ends with 1
    fs.writeFileSync(trigger, 'throw');
    // ended, and not left running: a process that carries on would otherwise leave the test waiting for ever
    const { code } = await Promise.race([running.exited, sleep(10_000).then(() => ({ code: 'still running' }))]);
    assert.equal(code, 1);
    assert.match(running.output.err, /\[process\] uncaught exception: Error: an error that nothing catches/);

    // started again on the same data, it is simply there
    const again = start({ PORT: String(port), DATA_DIR: dir });
    try {
      await waitForHealth(port, again);
      await waitForOutput(again, 'out', new RegExp(`FriendsShare server on :${port}`));
    } finally {
      again.child.kill();
      await again.exited;
    }
  } finally {
    if (client) client.app.close();
    running.child.kill();
    await running.exited;
    cleanUp(dir);
  }
});
