// Main process: the window, the list of shares, and all disk access.
// The renderer does the networking (WebRTC) and asks for file chunks over IPC.
const { app, BrowserWindow, ipcMain, dialog, shell, net } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');

const DEFAULT_SIGNAL_URL = 'wss://friendsshare.wiest-lab.eu';
const DEFAULT_EXPIRY_DAYS = 365;
const DAY = 24 * 3600 * 1000;

// FS_HOME moves everything (settings and shared folders) into one directory, so two instances can
// run side by side for testing.
const home = process.env.FS_HOME;
if (home) app.setPath('userData', path.join(home, 'userdata'));

let baseDir;
let configFile;
let config = { shares: [] };
let win = null;

function loadConfig() {
  baseDir = home ? path.join(home, 'shares') : path.join(app.getPath('documents'), 'FriendsShare');
  configFile = path.join(app.getPath('userData'), 'config.json');
  try {
    config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch {}
  if (!Array.isArray(config.shares)) config.shares = [];
}

function saveConfig() {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile + '.tmp', JSON.stringify(config, null, 2));
  fs.renameSync(configFile + '.tmp', configFile);
}

function getShare(id) {
  const share = config.shares.find((s) => s.id === id);
  if (!share) throw new Error('Unknown folder');
  return share;
}

// A new folder under baseDir named after the share, "Name (2)" if that one is taken.
async function makeShareDir(name) {
  const clean = String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 80) || 'Shared folder';
  await fsp.mkdir(baseDir, { recursive: true });
  for (let n = 1; ; n++) {
    const dir = path.join(baseDir, n === 1 ? clean : `${clean} (${n})`);
    try {
      await fsp.mkdir(dir);
      return dir;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
}

// Paths in a share travel as "sub/dir/file.txt". The other side chooses them, so make sure the
// result stays inside the share's folder.
function resolveIn(dir, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new Error('Bad path');
  const full = path.resolve(dir, rel);
  if (!full.startsWith(dir + path.sep)) throw new Error('Bad path');
  return full;
}

const PART_SUFFIX = '.fspart';

async function listFiles(dir) {
  const files = [];
  async function walk(sub) {
    let entries;
    try {
      entries = await fsp.readdir(path.join(dir, sub), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(rel);
      else if (entry.isFile() && !entry.name.endsWith(PART_SUFFIX)) {
        const st = await fsp.stat(path.join(dir, rel)).catch(() => null);
        if (st) files.push({ path: rel, size: st.size, mtime: Math.floor(st.mtimeMs) });
      }
    }
  }
  if (dir) await walk('');
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

// Open files, by handle number, for transfers in progress.
const handles = new Map();
let nextHandle = 1;

const api = {
  'state:get': () => ({
    shares: config.shares,
    baseDir,
    signalUrl: process.env.FS_SIGNAL || DEFAULT_SIGNAL_URL,
    defaultExpiryDays: DEFAULT_EXPIRY_DAYS,
  }),

  'share:create': async (name) => {
    const dir = await makeShareDir(name);
    const share = { id: crypto.randomUUID(), role: 'host', name: path.basename(dir), dir, code: null, createdAt: Date.now() };
    config.shares.push(share);
    saveConfig();
    return share;
  },

  // A new code replaces (and so revokes) the previous one.
  'share:generate': (id, days) => {
    const share = getShare(id);
    days = Number(days) > 0 ? Number(days) : DEFAULT_EXPIRY_DAYS;
    share.code = crypto.randomUUID();
    share.hostKey = crypto.randomUUID();
    share.expiresAt = Date.now() + days * DAY;
    saveConfig();
    return share;
  },

  'share:join': (code) => {
    code = String(code).trim().toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(code)) throw new Error('That is not a valid share code');
    const existing = config.shares.find((s) => s.code === code);
    if (existing) throw new Error(existing.role === 'host' ? 'That is the code of your own folder' : 'You already added this code');
    const share = { id: crypto.randomUUID(), role: 'guest', name: `Share ${code.slice(0, 8)}`, dir: null, code, createdAt: Date.now() };
    config.shares.push(share);
    saveConfig();
    return share;
  },

  // What a friend's app reported about the folder; the local folder is created on first contact.
  'share:update': async (id, info) => {
    const share = getShare(id);
    if (share.role !== 'guest') throw new Error('Not a friend folder');
    if (!share.dir) {
      share.dir = await makeShareDir(info.name || share.name);
      share.name = path.basename(share.dir);
    }
    if (typeof info.expiresAt === 'number') share.expiresAt = info.expiresAt;
    if (typeof info.lastSync === 'number') share.lastSync = info.lastSync;
    // the download choice: last known remote list, paths the friend unchecked, and whether they
    // have started a download (before that, syncs only fetch the list)
    if (Array.isArray(info.remote)) {
      share.remote = info.remote.map((f) => ({ path: String(f.path), size: Number(f.size), mtime: Number(f.mtime) }));
    }
    if (Array.isArray(info.excluded)) share.excluded = [...new Set(info.excluded.map(String))];
    if (typeof info.chosen === 'boolean') share.chosen = info.chosen;
    saveConfig();
    return share;
  },

  // Forgets the share. The files stay on disk.
  'share:remove': (id) => {
    config.shares = config.shares.filter((s) => s.id !== id);
    saveConfig();
  },

  'share:open': (id) => {
    const share = getShare(id);
    if (share.dir) shell.openPath(share.dir);
  },

  'share:files': (id) => listFiles(getShare(id).dir),

  'share:pick': async (id) => {
    const res = await dialog.showOpenDialog(win, { title: 'Add files', properties: ['openFile', 'multiSelections'] });
    if (res.canceled) return 0;
    return api['share:import'](id, res.filePaths);
  },

  // Copies files or whole folders into the share.
  'share:import': async (id, paths) => {
    const share = getShare(id);
    if (share.role !== 'host') throw new Error('You can only add files to your own folders');
    let count = 0;
    for (const src of paths) {
      const dest = path.join(share.dir, path.basename(src));
      if (path.resolve(src) === dest) continue;
      await fsp.cp(src, dest, { recursive: true, force: true });
      count++;
    }
    return count;
  },

  'file:openRead': async (id, rel) => {
    const share = getShare(id);
    if (share.role !== 'host') throw new Error('Not shared');
    const fh = await fsp.open(resolveIn(share.dir, rel), 'r');
    const h = nextHandle++;
    handles.set(h, { fh });
    return { h, size: (await fh.stat()).size };
  },

  'file:read': async (h, offset, length) => {
    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await handles.get(h).fh.read(buf, 0, length, offset);
    return buf.subarray(0, bytesRead);
  },

  // Downloads go to "<file>.<size>-<mtime>.fspart" first. If such a part already exists the
  // download continues where it stopped; a changed file gets a different part name.
  'file:openWrite': async (id, rel, size, mtime) => {
    const share = getShare(id);
    if (share.role !== 'guest' || !share.dir) throw new Error('Not a friend folder');
    const final = resolveIn(share.dir, rel);
    const part = `${final}.${Number(size)}-${Number(mtime)}${PART_SUFFIX}`;
    await fsp.mkdir(path.dirname(final), { recursive: true });
    const fh = await fsp.open(part, 'a');
    let offset = (await fh.stat()).size;
    if (offset > size) {
      await fh.truncate(0);
      offset = 0;
    }
    const h = nextHandle++;
    handles.set(h, { fh, final, part, mtime: Number(mtime) });
    return { h, offset };
  },

  'file:write': async (h, data) => {
    await handles.get(h).fh.appendFile(data instanceof ArrayBuffer ? Buffer.from(data) : data);
  },

  // Download complete: the part becomes the real file and takes the original's modified time,
  // which is how the next sync knows it is up to date.
  'file:finish': async (h) => {
    const { fh, final, part, mtime } = handles.get(h);
    handles.delete(h);
    await fh.close();
    await fsp.rename(part, final);
    await fsp.utimes(final, mtime / 1000, mtime / 1000);
  },

  'file:close': async (h) => {
    const entry = handles.get(h);
    if (!entry) return;
    handles.delete(h);
    await entry.fh.close().catch(() => {});
  },
};

// Self-update from the latest GitHub release. The portable build runs from a temp dir; the real
// exe is PORTABLE_EXECUTABLE_FILE, and Windows lets us rename it while it runs.
const RELEASE_API = 'https://api.github.com/repos/Siekwie/FriendsShare/releases/latest';
const RELEASE_URL_PREFIX = 'https://github.com/Siekwie/FriendsShare/';
const ASSET_NAME = 'FriendsShare.exe';
const portableExe = process.env.PORTABLE_EXECUTABLE_FILE || null;
let latest = null; // { version, url, size, page } of the newest release, once a check found one
let installing = false;

const parseVersion = (v) => String(v).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
function isNewer(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < Math.max(x.length, y.length, 3); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

// -> { status: 'current' | 'available' | 'error', current, latest?, error? }
api['update:check'] = async () => {
  const current = app.getVersion();
  try {
    const res = await net.fetch(RELEASE_API, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const rel = await res.json();
    const asset = (rel.assets || []).find((a) => a.name === ASSET_NAME);
    if (!rel.tag_name || !asset || !String(asset.browser_download_url).startsWith(RELEASE_URL_PREFIX)) throw new Error('No download in the latest release');
    const version = parseVersion(rel.tag_name).join('.');
    if (!isNewer(version, current)) {
      latest = null;
      return { status: 'current', current };
    }
    latest = { version, url: asset.browser_download_url, size: asset.size, page: `${RELEASE_URL_PREFIX}releases/tag/${rel.tag_name}` };
    return { status: 'available', current, latest: version };
  } catch (err) {
    return { status: 'error', current, error: err.message };
  }
};

// Portable exe: download, swap, restart. Otherwise (dev) just open the release page.
api['update:install'] = async () => {
  if (!latest) throw new Error('No update available');
  if (!portableExe) {
    shell.openExternal(latest.page);
    return { opened: true };
  }
  if (installing) throw new Error('Already updating');
  installing = true;
  const next = portableExe + '.new';
  const old = portableExe + '.old';
  try {
    await downloadTo(next, latest.url, latest.size);
    await fsp.rm(old, { force: true });
    await fsp.rename(portableExe, old);
    try {
      await fsp.rename(next, portableExe);
    } catch (err) {
      await fsp.rename(old, portableExe).catch(() => {});
      throw err;
    }
  } catch (err) {
    await fsp.rm(next, { force: true }).catch(() => {});
    installing = false;
    throw new Error(`Update failed: ${err.message}`);
  }
  // the new instance must be able to take the single-instance lock
  app.releaseSingleInstanceLock();
  spawn(portableExe, [], { detached: true, stdio: 'ignore' }).unref();
  app.quit();
  return { restarting: true };
};

async function downloadTo(file, url, size) {
  if (!url.startsWith(RELEASE_URL_PREFIX)) throw new Error('Unexpected download address');
  const res = await net.fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download answered ${res.status}`);
  const fh = await fsp.open(file, 'w');
  let done = 0;
  let lastPct = -1;
  try {
    for await (const chunk of res.body) {
      await fh.write(chunk);
      done += chunk.length;
      const pct = size ? Math.min(100, Math.floor((done / size) * 100)) : 0;
      if (pct !== lastPct && win && !win.isDestroyed()) win.webContents.send('update:progress', pct);
      lastPct = pct;
    }
  } finally {
    await fh.close();
  }
  if (done !== size) throw new Error('Downloaded file has the wrong size');
}

// Clears what an earlier update left behind (the old exe may still be closing; retry next start).
function cleanupUpdate() {
  if (!portableExe) return;
  for (const f of [portableExe + '.old', portableExe + '.new']) fsp.rm(f, { force: true }).catch(() => {});
}

function createWindow() {
  win = new BrowserWindow({
    width: 980,
    height: 660,
    minWidth: 760,
    minHeight: 480,
    backgroundColor: '#14161b',
    autoHideMenuBar: true,
    title: 'FriendsShare',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // transfers must keep their speed while the window is minimized
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

if (!app.requestSingleInstanceLock() && !home) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(() => {
    loadConfig();
    cleanupUpdate();
    for (const [channel, fn] of Object.entries(api)) ipcMain.handle(channel, (_e, ...args) => fn(...args));
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}
