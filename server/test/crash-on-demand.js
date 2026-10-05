// Loaded with --require into a server process that a test starts, to make it fail when the test
// says so: when the file named by CRASH_FILE appears, what it says is done ("reject": a promise
// that nobody waits for fails; "throw": an error that nothing catches). The file is removed first.
const fs = require('node:fs');

const file = process.env.CRASH_FILE;
if (file) {
  const timer = setInterval(() => {
    let how = '';
    try {
      how = fs.readFileSync(file, 'utf8').trim();
      if (!how) return; // still being written
      fs.rmSync(file);
    } catch {
      return;
    }
    if (how === 'reject') Promise.reject(new Error('a promise that nobody waits for failed\n[auth] a line that somebody forged'));
    if (how === 'throw') throw new Error('an error that nothing catches');
  }, 20);
  // it must not be the reason the process stays alive
  timer.unref();
}
