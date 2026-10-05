// The server only talks to official builds (REQUIRE_OFFICIAL=1, BUILD_SECRET). Two app instances that
// prove they are official sync a folder; a third copy without the key is turned away as
// "unofficial" and never gets it. A server that wants a newer version than the app has turns it
// away as "outdated", and the app does not ask again in a loop.
//   node test/strict.js
//
// A copy run from source has no build key and cannot play an official build, except for tests: the
// key can be given in FS_BUILD_KEY, and the fingerprint of the app in FS_BUILD_HASH (the server's
// EXTRA_BUILDS list takes 64 hex characters, so "dev" cannot be named there).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const t = require('./lib');

const NAME = 'strict';
const SECRET = 'strict-test-secret';
const FINGERPRINT = t.sha('the app.asar of a test build');

const code = crypto.randomUUID();
const hostDir = path.join(t.tmpRoot, NAME, 'hostfiles', 'Folder');
const files = { 'a.txt': Buffer.from('official hello\n'), 'sub/b.bin': crypto.randomBytes(300 * 1024) };

const arrived = (dir) => Object.entries(files).every(([rel, data]) => fs.existsSync(path.join(dir, rel)) && t.sha(fs.readFileSync(path.join(dir, rel))) === t.sha(data));
const state = (app, expr) => app.eval(expr).catch(() => null);
const guestSeed = () => ({ shares: [{ id: 'g1', role: 'guest', name: 'Share', dir: null, code, chosen: true, createdAt: Date.now() }] });

(async () => {
await t.scenario('Only official builds can use a server that requires them', async (cleanup) => {
  t.resetDir(path.join(t.tmpRoot, NAME));
  for (const [rel, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(hostDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(hostDir, rel), data);
  }
  const official = { FS_BUILD_KEY: t.buildKeyFor(SECRET), FS_BUILD_HASH: FINGERPRINT };

  const server = await t.startServer(NAME, { REQUIRE_OFFICIAL: '1', BUILD_SECRET: SECRET, EXTRA_BUILDS: `${t.version}:${FINGERPRINT}` });
  cleanup(() => server.stop());

  // two official apps: they sync
  const host = await t.startApp({
    name: NAME, who: 'host', signal: server.signalUrl, env: official,
    seed: { shares: [{ id: 'h1', role: 'host', name: 'Folder', dir: hostDir, code, hostKey: crypto.randomUUID(), createdAt: Date.now(), expiresAt: Date.now() + 86400000 }] },
  });
  cleanup(() => host.quit());
  await host.ready();
  await t.waitFor(async () => (await server.stats()).hosted_rooms === 1, 20000, 'the official host to register its folder');
  const guest = await t.startApp({ name: NAME, who: 'guest', signal: server.signalUrl, env: official, seed: guestSeed() });
  cleanup(() => guest.quit());
  await guest.ready();
  const guestDir = path.join(guest.home, 'shares', 'Folder');
  let synced = true;
  try {
    await t.waitFor(() => arrived(guestDir), 60000, 'the folder to arrive');
  } catch {
    synced = false;
  }
  t.check(synced, 'two apps that prove they are official sync a folder through a server that requires official builds');
  const stats = await server.stats();
  t.check(stats.rejected.unofficial === 0 && stats.rejected.outdated === 0 && stats.connections === 2, 'the server welcomed both and rejected nobody');

  // a copy without the key (like any build from source) is turned away, and gets nothing
  const stranger = await t.startApp({ name: NAME, who: 'stranger', signal: server.signalUrl, seed: guestSeed() });
  cleanup(() => stranger.quit());
  await stranger.ready();
  const unofficialShown = await t.waitFor(async () => (await state(stranger, "document.querySelector('#conn').dataset.state")) === 'unofficial', 20000, 'the stranger to be turned away').then(() => true, () => false);
  t.check(unofficialShown, 'a copy without the build key is turned away: the connection line says so');
  t.check(!!(await state(stranger, "!!document.querySelector('#notice') && document.querySelector('#notice').innerText.includes('not an official release')")), 'and the main area explains it, with a button to download the official app');
  t.check(!!(await state(stranger, "!!document.querySelector('#btn-notice-download')")), 'the button for the official download is there');
  // long enough for a wrongly accepted copy to have downloaded 300 KB several times over
  await t.sleep(6000);
  t.check(!fs.existsSync(path.join(stranger.home, 'shares')), 'the folder did not arrive at the copy without the key');
  const after = await server.stats();
  t.check(after.rejected.unofficial >= 1 && after.rejected.unofficial <= 2, `the server turned it away without being asked again in a loop (${after.rejected.unofficial} rejects)`);
  t.check(stranger.config().welcome === undefined, 'a copy that was never welcomed has no remembered welcome');
  t.check(stranger.dialogs.length === 0 && host.dialogs.length === 0 && guest.dialogs.length === 0, 'no dialog was opened by any window');
});

await t.scenario('A server that wants a newer version turns the app away, once', async (cleanup) => {
  const server = await t.startServer(`${NAME}-old`, { MIN_VERSION: '99.0.0' });
  cleanup(() => server.stop());
  const app = await t.startApp({ name: `${NAME}-old`, who: 'old', signal: server.signalUrl });
  cleanup(() => app.quit());
  await app.ready();
  const shown = await t.waitFor(async () => (await state(app, "document.querySelector('#conn').dataset.state")) === 'outdated', 20000, 'the app to be told it is too old').then(() => true, () => false);
  t.check(shown, 'the connection line says an update is needed');
  t.check(!!(await state(app, "document.querySelector('#notice') && document.querySelector('#notice').innerText.includes('Version 99.0.0 or newer')")), 'the main area says which version is needed');
  // the first retry of the old loop came after one second, the next after two
  await t.sleep(6000);
  const stats = await server.stats();
  t.check(stats.rejected.outdated === 1, `the app does not ask again soon (${stats.rejected.outdated} reject after 6 s)`);
  t.check(app.dialogs.length === 0, 'no dialog was opened');
});
t.finish();
})();
