// End-to-end test: a local matchmaking server (node server/server.js, as in production) and two
// app instances, one sharing a folder and one downloading it with the code. Passes when the friend's
// copy is byte-identical, except for the file the friend unchecked, which must not arrive.
//   node test/e2e.js
// (npm test runs this together with the other scenarios, see test/run.js)
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const t = require('./lib');

const NAME = 'e2e';
const TIMEOUT = 90000;

const code = crypto.randomUUID();
const hostDir = path.join(t.tmpRoot, NAME, 'hostfiles', 'Test folder');
const files = {
  'hello.txt': Buffer.from('hello friend\n'),
  'empty.txt': Buffer.alloc(0),
  'sub/deeper/big.bin': crypto.randomBytes(40 * 1024 * 1024),
};
const excluded = { 'skip/me.bin': crypto.randomBytes(1024 * 1024) };

function synced(guestDir) {
  for (const [rel, data] of Object.entries(files)) {
    const file = path.join(guestDir, rel);
    if (!fs.existsSync(file) || fs.statSync(file).size !== data.length) return false;
    if (t.sha(fs.readFileSync(file)) !== t.sha(data)) return false;
  }
  return true;
}

t.scenario('A folder syncs between two app instances through a local server', async (cleanup) => {
  t.resetDir(path.join(t.tmpRoot, NAME));
  for (const [rel, data] of Object.entries({ ...files, ...excluded })) {
    fs.mkdirSync(path.dirname(path.join(hostDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(hostDir, rel), data);
  }

  const server = await t.startServer(NAME);
  cleanup(() => server.stop());
  const host = await t.startApp({
    name: NAME,
    who: 'host',
    signal: server.signalUrl,
    seed: { shares: [{ id: 'h1', role: 'host', name: 'Test folder', dir: hostDir, code, hostKey: crypto.randomUUID(), createdAt: Date.now(), expiresAt: Date.now() + 86400000 }] },
  });
  cleanup(() => host.quit());
  await host.ready();
  // the friend starts a little later, like in real life
  await t.sleep(3000);
  const guest = await t.startApp({
    name: NAME,
    who: 'guest',
    signal: server.signalUrl,
    seed: { shares: [{ id: 'g1', role: 'guest', name: 'Share', dir: null, code, chosen: true, excluded: Object.keys(excluded), createdAt: Date.now() }] },
  });
  cleanup(() => guest.quit());
  await guest.ready();
  const guestDir = path.join(guest.home, 'shares', 'Test folder');

  const started = Date.now();
  let arrived = false;
  try {
    await t.waitFor(() => synced(guestDir), TIMEOUT, 'the folder to arrive');
    arrived = true;
  } catch {}
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  t.check(arrived, `the friend's copy is byte-identical (${Object.keys(files).length} files, one of them 40 MB), after ${seconds} s`);
  if (!arrived) return;

  // the sync is over once everything wanted is here; give a wrongly downloaded file time to show up
  await t.sleep(2500);
  const leaked = Object.keys(excluded).filter((rel) => fs.existsSync(path.join(guestDir, rel)) || (fs.existsSync(path.join(guestDir, path.dirname(rel))) && fs.readdirSync(path.join(guestDir, path.dirname(rel))).length));
  t.check(leaked.length === 0, `the file the friend unchecked was not downloaded${leaked.length ? ` (found ${leaked})` : ''}`);
  const saved = guest.config().shares[0];
  t.check((saved.remote || []).length === Object.keys(files).length + Object.keys(excluded).length, 'the friend\'s app stored the file list of the owner');

  // protocol 2: both apps shook hands, as plain builds from source, and nobody was turned away
  const stats = await server.stats();
  t.check(stats.by_version[t.version] === 2 && stats.rejected.outdated === 0 && stats.rejected.unofficial === 0, `both apps are welcomed as version ${t.version}, none rejected`);
  const welcome = guest.config().welcome;
  t.check(welcome && welcome.plan === 'free' && welcome.limit === null && welcome.account === null, 'the friend\'s app remembers the welcome: free, no limit, signed out');
  t.check((await guest.eval("document.querySelector('#conn').dataset.state")) === 'online', 'the connection line says online');
  t.check((await guest.eval("document.querySelector('#acct-name').textContent + ' / ' + document.querySelector('#acct-plan').textContent")) === 'Sign in / Free', 'the account row shows signed out and the free plan, without a limit');
}).then(t.finish);
