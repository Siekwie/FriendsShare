// Renders assets/og.html (1200x630) into server/site/img/og.png, the picture that shows up when
// the website is shared in a chat or on social media. Run after changing that page:
//   npx electron scripts/make-og.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const WIDTH = 1200;
const HEIGHT = 630;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: WIDTH, height: HEIGHT, frame: false, webPreferences: { offscreen: true } });
  await win.loadFile(path.join(root, 'assets', 'og.html'));
  await new Promise((resolve) => setTimeout(resolve, 500));
  const image = (await win.webContents.capturePage()).resize({ width: WIDTH, height: HEIGHT, quality: 'best' });
  const out = path.join(root, 'server', 'site', 'img', 'og.png');
  fs.writeFileSync(out, image.toPNG());
  console.log(out, fs.statSync(out).size);
  app.exit(0);
});
