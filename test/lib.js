// Shared by the end-to-end tests: a local matchmaking server (a child process, or in-process with a
// fake GitHub), app instances with an isolated profile, a small DevTools client to look into them,
// and a way to end them that leaves no tray icon behind.
//
// Safety: only processes started here are ever stopped, by PID. Nothing is killed by name, and an
// app instance always has its own FS_HOME, so the person's real FriendsShare is never touched.
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const WebSocket = require('ws');

const root = path.join(__dirname, '..');
const tmpRoot = path.join(root, '.test-tmp');
const version = require('../package.json').version;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// the key an official build of this version carries (scripts/stamp-build.js derives it the same way)
const buildKeyFor = (secret, v = version) => crypto.createHmac('sha256', secret).update(`friendsshare-build:${v}`).digest('hex');

async function waitFor(fn, ms = 10000, what = 'the condition') {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// ---- processes ----

const started = new Set();

// Ends a process and everything it started. By PID, never by name.
function stopTree(child) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}

function stopAllNow() {
  for (const child of started) stopTree(child);
  started.clear();
}
process.on('exit', stopAllNow);

// Nothing a test starts may run for ever: after this long it is stopped, whatever it is doing.
const LIFETIME = 6 * 60 * 1000;

function spawnTracked(cmd, args, options) {
  const child = spawn(cmd, args, options);
  started.add(child);
  child.once('exit', () => started.delete(child));
  setTimeout(() => stopTree(child), LIFETIME).unref();
  child.output = [];
  for (const stream of [child.stdout, child.stderr]) {
    if (stream) stream.on('data', (chunk) => child.output.push(String(chunk)));
  }
  return child;
}

const exited = (child) => new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once('exit', resolve)));

// ---- the server as a child process (node server/server.js, configured by PORT and DATA_DIR) ----

function resetDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function startServer(name, env = {}) {
  const port = await freePort();
  const dir = path.join(tmpRoot, name, 'server');
  resetDir(dir);
  const child = spawnTracked(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitFor(async () => child.exitCode === null && (await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false)), 20000, 'the server to start');
  return {
    port,
    child,
    signalUrl: `ws://127.0.0.1:${port}/ws`,
    siteUrl: `http://127.0.0.1:${port}`,
    // counts only, from inside the machine (see /internal/stats in the server)
    stats: () => fetch(`http://127.0.0.1:${port}/internal/stats`).then((r) => r.json()),
    log: () => child.output.join(''),
    async stop() {
      stopTree(child);
      await exited(child);
    },
  };
}

// ---- the server in-process, with a fake GitHub (see server/test/helpers.js, which this follows) ----

const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// The only network the server may use in a test: GitHub's sign-in, and nothing else. users maps the
// code the fake GitHub hands out to the profile it stands for.
function fakeGithub() {
  const users = {};
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url);
    calls.push(`${init.method || 'GET'} ${u.hostname}${u.pathname}`);
    if (u.hostname === 'github.com' && u.pathname === '/login/oauth/access_token') {
      const { code } = JSON.parse(init.body);
      return users[code] ? jsonResponse(200, { access_token: `gho_${code}`, token_type: 'bearer' }) : jsonResponse(200, { error: 'bad_verification_code' });
    }
    if (u.hostname === 'api.github.com' && (u.pathname === '/user' || u.pathname === '/user/emails')) {
      const code = /^Bearer gho_(.+)$/.exec((init.headers || {}).Authorization || '');
      const user = code && users[code[1]];
      if (!user) return jsonResponse(401, { message: 'Bad credentials' });
      if (u.pathname === '/user/emails') return jsonResponse(200, user.emails);
      const { emails, ...profile } = user;
      return jsonResponse(200, profile);
    }
    return jsonResponse(404, { message: `the test network has nothing at ${url}` });
  };
  return { users, calls, fetchFn };
}

// Needs node:sqlite (Node 22.13 or newer), like the server itself.
async function startInProcessServer(name, env = {}) {
  const { loadConfig } = require('../server/lib/config');
  const { createServer } = require('../server/lib/server');
  const port = await freePort();
  const dir = resetDir(path.join(tmpRoot, name, 'server'));
  const config = loadConfig({
    PORT: String(port),
    BASE_URL: `http://127.0.0.1:${port}`,
    DATA_DIR: dir,
    APP_SECRET: 'test-app-secret-'.padEnd(48, 'k'),
    BACKUP_INTERVAL_HOURS: '0',
    GITHUB_CLIENT_ID: 'gh-client',
    GITHUB_CLIENT_SECRET: 'gh-secret',
    ...env,
  });
  const github = fakeGithub();
  const logs = [];
  const server = createServer({ config, fetchFn: github.fetchFn, log: (line) => logs.push(line) });
  await server.listen(port, '127.0.0.1');
  return {
    port,
    server,
    config,
    github,
    logs,
    signalUrl: `ws://127.0.0.1:${port}/ws`,
    siteUrl: `http://127.0.0.1:${port}`,
    db: server.db,
    close: () => server.close(),
  };
}

// A person's browser, as far as the sign-in needs one: no redirects followed, cookies kept per host.
function makeBrowser() {
  const jars = new Map();
  return {
    get(url) {
      const target = new URL(url);
      const jar = jars.get(target.host) || new Map();
      jars.set(target.host, jar);
      const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      return new Promise((resolve, reject) => {
        const req = http.request({ host: target.hostname, port: target.port, path: target.pathname + target.search, method: 'GET', headers: cookie ? { cookie } : {}, agent: false }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            for (const line of res.headers['set-cookie'] || []) {
              const [pair, ...attrs] = line.split(';').map((s) => s.trim());
              const at = pair.indexOf('=');
              if (attrs.some((a) => /^max-age=0$/i.test(a)) || at === pair.length - 1) jar.delete(pair.slice(0, at));
              else jar.set(pair.slice(0, at), pair.slice(at + 1));
            }
            resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') });
          });
        });
        req.on('error', reject);
        req.end();
      });
    },
  };
}

// ---- app instances ----

// Minimal DevTools client: evaluates JavaScript in the window of an app started with
// --remote-debugging-port. Instances of the app run from source honour that switch; an official
// build refuses it.
function devtools(port) {
  let ws = null;
  let nextId = 1;
  const waiting = new Map();
  // alert() and confirm() of the window, answered here (confirm gets a yes) instead of being put
  // on the person's desktop
  const dialogs = [];
  async function connect() {
    let page;
    const end = Date.now() + 30000;
    while (!page) {
      try {
        page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((p) => p.type === 'page');
      } catch {}
      if (!page) {
        if (Date.now() > end) throw new Error('the app has no window to look into');
        await sleep(250);
      }
    }
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.on('message', (data) => {
      const m = JSON.parse(data);
      if (m.method === 'Page.javascriptDialogOpening') {
        dialogs.push({ type: m.params.type, message: m.params.message });
        ws.send(JSON.stringify({ id: nextId++, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
        return;
      }
      const entry = waiting.get(m.id);
      if (!entry) return;
      waiting.delete(m.id);
      if (m.error) entry.reject(new Error(m.error.message));
      else entry.resolve(m.result);
    });
    // with the Page domain on, a dialog is handed to us and not shown
    ws.send(JSON.stringify({ id: nextId++, method: 'Page.enable' }));
  }
  return {
    dialogs,
    // the value of the expression, which may be a promise; a thrown error is thrown here
    async eval(expression) {
      if (!ws) await connect();
      const id = nextId++;
      const result = await new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
        setTimeout(() => waiting.delete(id) && reject(new Error('the window did not answer')), 30000).unref();
      });
      if (result.exceptionDetails) throw new Error((result.exceptionDetails.exception && result.exceptionDetails.exception.description) || result.exceptionDetails.text);
      return result.result.value;
    },
    close() {
      if (ws) ws.close();
      ws = null;
    },
  };
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// Starts the app from source with its own profile directory (FS_HOME), hidden (as a startup entry
// would), looking at the given matchmaking address. seed is what config.json starts with. The tray
// option is off, so that closing the window ends the app: that is the graceful way to stop it.
async function startApp({ name, who, signal, seed = {}, env = {}, args = [] }) {
  // a syntax error in the app would make Electron show its error box before anything can stop it
  for (const file of ['main.js', 'build.js', 'account.js', 'preload.js', 'tray.js', 'renderer/p2p.js', 'renderer/app.js']) {
    const check = spawnSync(process.execPath, ['--check', path.join(root, 'app', file)], { encoding: 'utf8' });
    if (check.status !== 0) throw new Error(`app/${file} does not parse: ${check.stderr}`);
  }
  const home = path.join(tmpRoot, name, who);
  resetDir(home);
  const userdata = path.join(home, 'userdata');
  fs.mkdirSync(userdata, { recursive: true });
  fs.writeFileSync(path.join(userdata, 'config.json'), JSON.stringify({ shares: [], ...seed, settings: { tray: false, ...(seed.settings || {}) } }));
  const debugPort = await freePort();
  // guard.js: no error box and no notification, whatever happens. --user-data-dir: everything the
  // instance writes, from its first moment on, goes into its own home and nowhere else.
  const guard = path.join(__dirname, 'guard.js').replace(/\\/g, '/');
  const fullEnv = { ...process.env, NODE_OPTIONS: `--require=${guard}`, FS_HOME: home, FS_SIGNAL: signal, ...env };
  delete fullEnv.ELECTRON_RUN_AS_NODE;
  const child = spawnTracked(require('electron'), ['.', '--hidden', `--user-data-dir=${userdata}`, `--remote-debugging-port=${debugPort}`, ...args], { cwd: root, env: fullEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const dev = devtools(debugPort);
  const instance = {
    who,
    home,
    child,
    dialogs: dev.dialogs,
    eval: (expression) => dev.eval(expression),
    config: () => readJson(path.join(userdata, 'config.json')),
    // the window has loaded and has started
    ready: () => waitFor(() => dev.eval('typeof state === "object" && typeof p2p === "object"').catch(() => false), 30000, `${who} to start`),
    async quit() {
      if (child.exitCode !== null) return;
      // closing the window ends the app, the tray icon with it; killing it would leave the icon behind
      await dev.eval('window.close()').catch(() => {});
      dev.close();
      await Promise.race([exited(child), sleep(8000)]);
      if (child.exitCode === null) stopTree(child);
      await exited(child);
    },
  };
  return instance;
}

// ---- checking things ----

const failures = [];
function check(ok, message) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failures.push(message);
  return ok;
}

// Runs one scenario. fn gets a function to register cleanups, which run at the end, last in first out.
async function scenario(name, fn, { timeout = 180000 } = {}) {
  console.log(`\n${name}`);
  const before = failures.length;
  const cleanups = [];
  const cleanup = async () => {
    while (cleanups.length) {
      try {
        await cleanups.pop()();
      } catch {}
    }
    stopAllNow();
  };
  let error = null;
  const timer = setTimeout(() => {
    console.log(`FAIL: ${name}: did not finish within ${timeout / 1000} s`);
    stopAllNow();
    process.exit(1);
  }, timeout);
  try {
    await fn((fn) => cleanups.push(fn));
  } catch (err) {
    error = err;
  }
  clearTimeout(timer);
  await cleanup();
  if (error) {
    console.log(`  error: ${error.stack || error.message}`);
    failures.push(error.message);
  }
  const problems = failures.length - before;
  console.log(`${problems ? 'FAIL' : 'PASS'}: ${name}${problems ? ` (${problems} problem${problems === 1 ? '' : 's'})` : ''}`);
}

// Ends the process: 0 when every check of every scenario passed.
function finish() {
  setTimeout(() => process.exit(failures.length ? 1 : 0), 300);
}

module.exports = {
  spawnTracked,
  exited,
  root,
  tmpRoot,
  version,
  sleep,
  sha,
  buildKeyFor,
  waitFor,
  freePort,
  resetDir,
  stopTree,
  startServer,
  startInProcessServer,
  makeBrowser,
  startApp,
  devtools,
  readJson,
  check,
  scenario,
  finish,
};
