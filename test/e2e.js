// End-to-end test: a local matchmaking server and two app instances, one sharing a folder and one
// downloading it with the code. Passes when the friend's copy is byte-identical, except for the
// file the friend unchecked, which must not arrive.
//   npm test
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const tmp = path.join(root, '.test-tmp');
const PORT = 18080;
const TIMEOUT = 90000;

const code = crypto.randomUUID();
const hostDir = path.join(tmp, 'host', 'shares', 'Test folder');
const guestDir = path.join(tmp, 'guest', 'shares', 'Test folder');
const files = {
  'hello.txt': Buffer.from('hello friend\n'),
  'empty.txt': Buffer.alloc(0),
  'sub/deeper/big.bin': crypto.randomBytes(40 * 1024 * 1024),
};
const excluded = { 'skip/me.bin': crypto.randomBytes(1024 * 1024) };

function writeConfig(who, share) {
  const dir = path.join(tmp, who, 'userdata');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ shares: [share] }));
}

fs.rmSync(tmp, { recursive: true, force: true });
for (const [rel, data] of Object.entries({ ...files, ...excluded })) {
  fs.mkdirSync(path.dirname(path.join(hostDir, rel)), { recursive: true });
  fs.writeFileSync(path.join(hostDir, rel), data);
}
writeConfig('host', { id: 'h1', role: 'host', name: 'Test folder', dir: hostDir, code, hostKey: crypto.randomUUID(), expiresAt: Date.now() + 86400000 });
writeConfig('guest', { id: 'g1', role: 'guest', name: 'Share', dir: null, code, chosen: true, excluded: Object.keys(excluded) });

const children = [];
function run(cmd, args, env) {
  const fullEnv = { ...process.env, ...env };
  delete fullEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(cmd, args, { cwd: root, env: fullEnv, stdio: 'inherit' });
  children.push(child);
  return child;
}

function finish(ok, message) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${message}`);
  for (const child of children) child.kill();
  setTimeout(() => process.exit(ok ? 0 : 1), 500);
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function synced() {
  for (const [rel, data] of Object.entries(files)) {
    const file = path.join(guestDir, rel);
    if (!fs.existsSync(file) || fs.statSync(file).size !== data.length) return false;
    if (sha(fs.readFileSync(file)) !== sha(data)) return false;
  }
  return true;
}

run(process.execPath, ['server/server.js'], { PORT, DATA_DIR: path.join(tmp, 'server') });
const app = (who) => run(require('electron'), ['.'], { FS_HOME: path.join(tmp, who), FS_SIGNAL: `ws://127.0.0.1:${PORT}` });

setTimeout(() => {
  app('host');
  // the friend starts a little later, like in real life
  setTimeout(() => app('guest'), 3000);
}, 500);

const started = Date.now();
const poll = setInterval(() => {
  if (synced()) {
    clearInterval(poll);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    // the sync is over once everything wanted is here; give a wrongly downloaded file time to show up
    setTimeout(() => {
      const leaked = Object.keys(excluded).filter((rel) => fs.existsSync(path.join(guestDir, rel)) || fs.existsSync(path.join(guestDir, path.dirname(rel))) && fs.readdirSync(path.join(guestDir, path.dirname(rel))).length);
      const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'guest', 'userdata', 'config.json'), 'utf8')).shares[0];
      if (leaked.length) finish(false, `excluded file was downloaded: ${leaked}`);
      else if ((saved.remote || []).length !== Object.keys(files).length + Object.keys(excluded).length) finish(false, 'the remote file list was not stored');
      else finish(true, `folder synced in ${seconds} s, excluded file skipped`);
    }, 2500);
  } else if (Date.now() - started > TIMEOUT) {
    clearInterval(poll);
    finish(false, 'the folder did not arrive in time');
  }
}, 1000);
