// Renders assets/logo.svg into every icon the project needs. Run after changing the logo:
//   npx electron scripts/make-icons.js
// Writes build/icon.ico (the exe), app/icon.png and app/tray.png (window and tray),
// and the website's favicon files under server/site.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'assets', 'logo.svg'), 'utf8');
const BASE = 1024;

// An .ico is a small directory followed by the images; PNG data is allowed for every size.
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, at);
    header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.png)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: BASE, height: BASE, frame: false, transparent: true, webPreferences: { offscreen: true } });
  const html = `<body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${BASE}" height="${BASE}" `)}</body>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 300));
  const big = (await win.webContents.capturePage()).resize({ width: BASE, height: BASE, quality: 'best' });
  const png = (size) => big.resize({ width: size, height: size, quality: 'best' }).toPNG();
  const write = (rel, data) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), data);
    console.log(rel, data.length);
  };

  write('build/icon.ico', ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: png(size) }))));
  write('app/icon.png', png(256));
  write('app/tray.png', png(32));
  write('server/site/favicon.ico', ico([16, 32, 48].map((size) => ({ size, png: png(size) }))));
  write('server/site/img/logo.svg', svg);
  write('server/site/img/logo-192.png', png(192));
  write('server/site/img/logo-512.png', png(512));
  app.exit(0);
});
