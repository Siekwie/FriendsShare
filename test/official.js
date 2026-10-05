// How an official build behaves: strictly. The app is started from source but made to believe it is
// a packaged build with a build key (test/fake-official.js), with its profile pinned into this test's
// directory. An official build
//   - ignores FS_HOME and FS_SIGNAL (unless FS_TEST_KEY is its own key),
//   - refuses to run with a debugger attached or another profile directory (--user-data-dir),
//   - has no developer tools,
//   - proves itself with the key it carries and the SHA-256 of its own app.asar, whatever the
//     environment says.
//   node test/official.js
//
// Nothing can look into an official build from outside, so the results come from files and from the
// network: a fake matchmaking server (does the app come to it?) and a small proxy that every other
// connection of the app is sent to, which also keeps the test away from the real server.
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const t = require('./lib');

const NAME = 'official';
const SECRET = 'official-test-secret';
const key = t.buildKeyFor(SECRET);
const decoy = t.buildKeyFor('another secret');

// ---- what the app can talk to ----

async function startFakeServer() {
  const port = await t.freePort();
  const wss = new WebSocket.WebSocketServer({ port, host: '127.0.0.1' });
  const server = { signalUrl: `ws://127.0.0.1:${port}/ws`, hellos: [], connections: 0 };
  wss.on('connection', (ws) => {
    const nonce = crypto.randomBytes(32).toString('hex');
    server.connections++;
    ws.send(JSON.stringify({ t: 'challenge', nonce }));
    ws.on('message', (data) => {
      const m = JSON.parse(String(data));
      if (m.t === 'hello') server.hellos.push({ ...m, nonce });
    });
  });
  server.stop = () => new Promise((resolve) => (wss.clients.forEach((c) => c.terminate()), wss.close(() => resolve())));
  return server;
}

// Everything the app sends to "the internet" ends here and is refused. seen: the hosts it asked for.
async function startProxy() {
  const port = await t.freePort();
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers.host || req.url);
    res.writeHead(502).end();
  });
  server.on('connect', (req, socket) => {
    seen.push(req.url);
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { port, seen, stop: () => new Promise((resolve) => (server.closeAllConnections(), server.close(resolve))) };
}

// ---- an official instance ----

// Where Chromium writes its first files at start-up, under the name of the wrapper app (see
// official-app/main.js). It belongs to this test, and is removed again.
const strayProfile = path.join(process.env.APPDATA || '', 'FriendsShareOfficialTest');
const removeStrayProfile = () => process.env.APPDATA && fs.rmSync(strayProfile, { recursive: true, force: true });

function startOfficial({ who, env = {}, args = [], proxy }) {
  const dir = t.resetDir(path.join(t.tmpRoot, NAME, who));
  const home = path.join(dir, 'home');
  const files = { log: path.join(dir, 'log.jsonl'), quit: path.join(dir, 'quit'), resources: path.join(dir, 'resources'), profile: path.join(dir, 'profile') };
  fs.mkdirSync(files.resources, { recursive: true });
  // a stand-in for the app.asar of the build: its SHA-256 is what the app has to report
  const asar = crypto.randomBytes(20000);
  fs.writeFileSync(path.join(files.resources, 'app.asar'), asar);
  const preload = path.join(__dirname, 'fake-official.js').replace(/\\/g, '/');
  const fullEnv = {
    ...process.env,
    NODE_OPTIONS: `--require=${preload}`,
    FAKE_OFFICIAL_KEY: key,
    FAKE_OFFICIAL_PROFILE: files.profile,
    FAKE_OFFICIAL_LOG: files.log,
    FAKE_OFFICIAL_RESOURCES: files.resources,
    FAKE_OFFICIAL_QUIT: files.quit,
    FS_HOME: home,
    ...env,
  };
  delete fullEnv.ELECTRON_RUN_AS_NODE;
  // no --user-data-dir and no debugging port: an official build would refuse them (that is tested below)
  const child = t.spawnTracked(require('electron'), [path.join(__dirname, 'official-app'), '--hidden', `--proxy-server=127.0.0.1:${proxy.port}`, ...args], { cwd: t.root, env: fullEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const read = () => (fs.existsSync(files.log) ? fs.readFileSync(files.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return {
    child,
    home,
    files,
    asarHash: t.sha(asar),
    events: read,
    event: (name) => read().find((e) => e.event === name),
    async quit() {
      if (child.exitCode === null) {
        fs.writeFileSync(files.quit, '');
        await Promise.race([t.exited(child), t.sleep(8000)]);
      }
      if (child.exitCode === null) t.stopTree(child);
      await t.exited(child);
    },
  };
}

(async () => {
  removeStrayProfile();
  await t.scenario('An official build ignores FS_HOME and FS_SIGNAL, and has no developer tools', async (cleanup) => {
    t.resetDir(path.join(t.tmpRoot, NAME));
    const fake = await startFakeServer();
    cleanup(() => fake.stop());
    const proxy = await startProxy();
    cleanup(() => proxy.stop());

    // no test key, and a wrong one: the environment is not honoured
    const plain = startOfficial({ who: 'plain', proxy, env: { FS_SIGNAL: fake.signalUrl } });
    cleanup(() => plain.quit());
    const wrong = startOfficial({ who: 'wrong', proxy, env: { FS_SIGNAL: fake.signalUrl, FS_TEST_KEY: decoy } });
    cleanup(() => wrong.quit());
    await Promise.all([t.waitFor(() => plain.event('ready'), 30000, 'the first instance'), t.waitFor(() => wrong.event('ready'), 30000, 'the second instance')]);
    await t.waitFor(() => proxy.seen.some((host) => host.startsWith('friendsshare.wiest-lab.eu')), 20000, 'the apps to look for the real server');
    for (const app of [plain, wrong]) {
      t.check(app.event('ready').isPackaged === true && app.event('ready').userData === app.files.profile, `${path.basename(path.dirname(app.files.log))}: FS_HOME is ignored (the profile is not under FS_HOME)`);
      t.check(!fs.existsSync(app.home), `${path.basename(path.dirname(app.files.log))}: nothing was created under FS_HOME`);
      t.check(app.event('window') && app.event('window').devTools === false, `${path.basename(path.dirname(app.files.log))}: the window is created without developer tools`);
    }
    t.check(fake.connections === 0, 'FS_SIGNAL is ignored: nobody came to the fake server');
    t.check(proxy.seen.some((host) => host.startsWith('friendsshare.wiest-lab.eu')), 'the app went for friendsshare.wiest-lab.eu instead (the proxy refused it)');
  });

  await t.scenario('With its own key as FS_TEST_KEY an official build honours FS_HOME and FS_SIGNAL, and proves itself', async (cleanup) => {
    t.resetDir(path.join(t.tmpRoot, NAME));
    const fake = await startFakeServer();
    cleanup(() => fake.stop());
    const proxy = await startProxy();
    cleanup(() => proxy.stop());
    // the test-only variables for builds from source are ignored by a packaged one
    const app = startOfficial({ who: 'tested', proxy, env: { FS_SIGNAL: fake.signalUrl, FS_TEST_KEY: key, FS_BUILD_KEY: decoy, FS_BUILD_HASH: t.sha('not the asar') } });
    cleanup(() => app.quit());
    await t.waitFor(() => fake.hellos.length >= 1, 30000, 'the app to say hello');
    const hello = fake.hellos[0];
    t.check(app.event('ready').userData === path.join(app.home, 'userdata'), 'FS_HOME is honoured with the right FS_TEST_KEY');
    t.check(app.event('window').devTools === false, 'still without developer tools');
    t.check(hello.proto === 2 && hello.version === t.version, 'the hello says protocol 2 and the version');
    t.check(hello.hash === app.asarHash, 'it reports the SHA-256 of its own app.asar (read from the file next to the app)');
    const proof = crypto.createHmac('sha256', key).update(`${hello.nonce}|${hello.hash}|${hello.version}`).digest('hex');
    t.check(hello.proof === proof, 'and proves it with the key the build carries, not the one in FS_BUILD_KEY');
    t.check(!proxy.seen.some((host) => host.startsWith('friendsshare.wiest-lab.eu')), 'the real server was not looked for');
  });

  await t.scenario('An official build refuses debugging switches and another profile directory', async (cleanup) => {
    t.resetDir(path.join(t.tmpRoot, NAME));
    const proxy = await startProxy();
    cleanup(() => proxy.stop());
    const fake = await startFakeServer();
    cleanup(() => fake.stop());
    const port = await t.freePort();
    const switches = [`--remote-debugging-port=${port}`, `--inspect=${await t.freePort()}`, `--user-data-dir=${path.join(t.tmpRoot, NAME, 'elsewhere')}`];
    for (const [i, option] of switches.entries()) {
      // the test key does not cover these
      const app = startOfficial({ who: `switch${i}`, proxy, env: { FS_SIGNAL: fake.signalUrl, FS_TEST_KEY: key }, args: [option] });
      cleanup(() => app.quit());
      const code = await Promise.race([t.exited(app.child).then(() => app.child.exitCode), t.sleep(20000).then(() => 'still running')]);
      t.check(code === 1 && !app.event('window'), `${option.split('=')[0]}: the app ends at once (exit code ${code}) without opening a window`);
    }
    t.check(fake.connections === 0, 'and never connected anywhere');
    // (Chromium itself may create the directory while it starts; the app must not have put anything in it)
    t.check(!fs.existsSync(path.join(t.tmpRoot, NAME, 'elsewhere', 'config.json')), 'nor wrote anything into the other profile directory');
  });
  removeStrayProfile();
  t.finish();
})();
