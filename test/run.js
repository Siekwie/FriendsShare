// Runs all tests of the app, one file after the other, and ends with 0 only if every one passed.
//   node test/run.js           everything
//   node test/run.js limit     only the files whose name contains "limit"
//
// The tests start app instances (hidden, each with its own profile) and servers; see test/lib.js.
// Every file has a hard time limit, and a file that runs past it is stopped with everything it started.
const { spawn, spawnSync } = require('child_process');
const path = require('path');

const FILES = [
  ['unit.js', 'decisions of official builds, addresses, the sign-in hand-over without a window'],
  ['e2e.js', 'a folder syncs between two apps through a local server'],
  ['strict.js', 'a server that requires official builds, and one that wants a newer version'],
  ['limit.js', 'the free plan: one folder, paused folders, the limit dialog'],
  ['signin.js', 'signing in through the browser, Pro, signing out'],
  ['protocol.js', 'hello, errors, blocked codes, notices and plan changes against a scripted server'],
  ['official.js', 'how an official build behaves'],
  ['files.js', 'the file side with real transfers: choosing what to download, unreadable files, a folder that is gone, the owner\'s status'],
  ['hostile.js', 'hostile names and requests, a full disk, and a 1.2.0 app on either side'],
  ['folders.js', 'sharing a folder in place: the folders that are refused, and a huge one'],
  ['big.js', 'thousands of small files: a complete sync, and how fast it lists and draws'],
];
const LIMIT_MS = 8 * 60 * 1000;

const wanted = process.argv.slice(2);
const files = FILES.filter(([name]) => !wanted.length || wanted.some((w) => name.includes(w)));

function runFile(name) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, name)], { stdio: 'inherit' });
    const timer = setTimeout(() => {
      console.log(`FAIL: ${name} did not finish within ${LIMIT_MS / 60000} minutes, stopping it`);
      spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
    }, LIMIT_MS);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

(async () => {
  const started = Date.now();
  const results = [];
  for (const [name, what] of files) {
    console.log(`\n==== ${name}: ${what}`);
    const t0 = Date.now();
    results.push([name, await runFile(name), (Date.now() - t0) / 1000]);
  }
  console.log('\n==== summary');
  for (const [name, ok, seconds] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${seconds.toFixed(0)} s)`);
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`${failed ? 'FAIL' : 'PASS'}: ${results.length - failed} of ${results.length} test files passed in ${((Date.now() - started) / 1000).toFixed(0)} s`);
  process.exit(failed ? 1 : 0);
})();
