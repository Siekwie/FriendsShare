// Produces the two app screenshots the website shows (server/site/img/app-share.png and
// app-download.png) from the real app with made-up folders. Run after changing the app's look:
//   npx electron scripts/screenshots.js --hidden
// Everything it needs lives in a temp folder and is removed afterwards. The big demo files are
// sparse, so the "27 GB" on screen take no disk space. The window stays hidden.
const { app, dialog } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// nothing may pop up while this runs
dialog.showErrorBox = (title, text) => console.error(title, text);
for (const event of ['uncaughtException', 'unhandledRejection']) {
  process.on(event, (err) => {
    console.error(err);
    app.exit(1);
  });
}

const root = path.join(__dirname, '..');
const home = path.join(os.tmpdir(), 'friendsshare-demo');
const GB = 1024 ** 3;
const MB = 1024 ** 2;
const DAY = 86400000;
const now = Date.now();

fs.rmSync(home, { recursive: true, force: true });

// A file of any size that occupies nothing: NTFS only stores what was actually written.
function sparse(file, size, mtime) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  if (process.platform === 'win32') execFileSync('fsutil', ['sparse', 'setflag', file]);
  fs.truncateSync(file, size);
  if (mtime) fs.utimesSync(file, mtime / 1000, mtime / 1000);
}

const shares = path.join(home, 'shares');
const holiday = path.join(shares, 'Holiday videos 2026');
const holidayFiles = [
  ['Day 1 - Lisbon.mp4', 4.21 * GB],
  ['Day 2 - Sintra.mp4', 6.84 * GB],
  ['Day 3 - Porto.mp4', 5.07 * GB],
  ['Drone/Coast flyover 4K.mov', 11.3 * GB],
  ['Photos/IMG_2041.jpg', 8.2 * MB],
  ['Photos/IMG_2042.jpg', 7.9 * MB],
  ['Photos/IMG_2047.jpg', 9.1 * MB],
];
for (const [rel, size] of holidayFiles) sparse(path.join(holiday, rel), Math.round(size));
fs.mkdirSync(path.join(shares, 'Band recordings'), { recursive: true });

const clips = path.join(shares, 'Game night clips');
const clipFiles = [
  ['2026-09-12 Rocket League.mp4', 3.4 * GB],
  ['2026-09-19 Among Us.mp4', 2.1 * GB],
  ['2026-09-26 Minecraft build.mp4', 7.8 * GB],
  ['Raw footage/cam1.mkv', 18.2 * GB],
  ['Raw footage/cam2.mkv', 17.6 * GB],
  ['thumbnail.png', 1.2 * MB],
].map(([rel, size], i) => ({ path: rel, size: Math.round(size), mtime: now - (20 - i) * DAY }));
fs.mkdirSync(clips, { recursive: true });
fs.mkdirSync(path.join(shares, 'Wedding photos'), { recursive: true });

const ids = { holiday: 'demo-holiday', band: 'demo-band', clips: 'demo-clips', wedding: 'demo-wedding' };
const config = {
  shares: [
    { id: ids.holiday, role: 'host', name: 'Holiday videos 2026', dir: holiday, code: '7c1f4a52-9e0b-4d37-b6a8-2f5d81c3e940', hostKey: 'demo', expiresAt: now + 351 * DAY, createdAt: now - 14 * DAY },
    { id: ids.band, role: 'host', name: 'Band recordings', dir: path.join(shares, 'Band recordings'), code: null, createdAt: now - 9 * DAY },
    {
      id: ids.clips, role: 'guest', name: 'Game night clips', dir: clips, code: 'b90e2d6c-41a7-4c1e-8f33-6d0a59e7c2b1', createdAt: now - 6 * DAY,
      // the friend has just added the code: the list is there, nothing is downloaded yet
      expiresAt: now + 24 * DAY, chosen: false, excluded: ['Raw footage/'],
      remote: clipFiles,
    },
    { id: ids.wedding, role: 'guest', name: 'Wedding photos', dir: path.join(shares, 'Wedding photos'), code: 'e3a7c0d1-5b28-4f96-a1d4-90c6f2b8e715', createdAt: now - 2 * DAY, expiresAt: now + 300 * DAY, lastSync: now - 7200000, chosen: true, remote: [] },
  ],
  settings: { tray: true, autostart: false },
  trayNoticeShown: true,
};
fs.mkdirSync(path.join(home, 'userdata'), { recursive: true });
fs.writeFileSync(path.join(home, 'userdata', 'config.json'), JSON.stringify(config));

process.env.FS_HOME = home;
// nothing listens there: the app stays offline and the states below are set by hand
process.env.FS_SIGNAL = 'ws://127.0.0.1:1/ws';
// twice the pixels, for sharp pictures on high-density screens
app.commandLine.appendSwitch('force-device-scale-factor', '2');
require(path.join(root, 'app', 'main.js'));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const { BrowserWindow } = require('electron');
  let win;
  for (let i = 0; i < 50 && !win; i++) {
    await wait(200);
    win = BrowserWindow.getAllWindows()[0];
  }
  await wait(2500);
  // tall enough that neither view needs a scrollbar
  win.setContentSize(972, 740);
  const js = (code) => win.webContents.executeJavaScript(code);

  // Shows one folder exactly as a visitor should see it and resolves once it is on screen. The
  // app re-renders on its own now and then (it keeps trying to reach the server), so everything
  // that is set by hand is set in the same breath as the picture is taken.
  const show = (id, expectedRows, tweaks) =>
    js(`(async () => {
      const until = async (test) => { for (let i = 0; i < 100 && !test(); i++) await new Promise((r) => setTimeout(r, 50)); };
      await until(() => state.shares.length > 0);
      setConn({ kind: 'online' });
      applyAccount({ signedIn: false, account: null, plan: 'free', limit: 5, billing: true,
        prices: { monthly: '€1.99', yearly: '€11.88', yearly_per_month: '€0.99' }, signingIn: false, error: null });
      select(${JSON.stringify(id)});
      await until(() => document.querySelectorAll('#files .node').length > 0);
      // the list is a tree with its folders closed: open them all, so the picture shows the files
      for (let i = 0; i < 20; i++) {
        const closed = document.querySelector('#files .node.dir[aria-expanded="false"] .name');
        if (!closed) break;
        closed.click();
        await new Promise((r) => setTimeout(r, 50));
      }
      await until(() => document.querySelectorAll('#files .node').length >= ${expectedRows});
      // no row should look focused in the picture
      if (document.activeElement) document.activeElement.blur();
      ${tweaks}
      setConn({ kind: 'online' });
      renderStatus();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return document.querySelectorAll('#files .node').length;
    })()`);
  const shot = async (file) => {
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(root, 'server', 'site', 'img', file), image.toPNG());
    console.log(file, image.getSize());
  };

  // the owner's view: a friend is downloading. A neutral path instead of this machine's.
  // rows: the files plus the two folders (Drone, Photos)
  let rows = await show(ids.holiday, holidayFiles.length + 2, `
    hostInfo.set(${JSON.stringify(ids.holiday)}, { friends: 1, sent: ${Math.round(2.1 * GB)} });
    document.querySelector('.path').textContent = ${JSON.stringify('D:\\Shared\\Holiday videos 2026')};
  `);
  if (rows < holidayFiles.length + 2) throw new Error('the file list of the first picture did not show up');
  await shot('app-share.png');

  // the friend's view: the list has arrived, nothing is downloaded yet
  rows = await show(ids.clips, clipFiles.length + 1, `
    status.set(${JSON.stringify(ids.clips)}, { kind: 'ok', text: 'Choose what to download, then click Download selected.' });
    document.querySelector('.path').textContent = ${JSON.stringify('D:\\Shared\\Game night clips')};
  `);
  if (rows < clipFiles.length + 1) throw new Error('the file list of the second picture did not show up');
  await shot('app-download.png');

  win.destroy();
  // the profile is still in use for a moment; whatever stays behind is removed by the next run
  await wait(500);
  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch {}
  app.exit(0);
});
