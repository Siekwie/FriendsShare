// Main process: the window, the list of shares, and all disk access.
// The renderer does the networking (WebRTC) and asks for file chunks over IPC.
const { app, BrowserWindow, ipcMain, dialog, shell, net, safeStorage } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { createTray, notify } = require('./tray');
const build = require('./build');
const { createAccount, deriveSite, normalizeSignalUrl } = require('./account');
const tree = require('./tree');
const folder = require('./folder');
const { createRemoteStore } = require('./remote');
const { createUpdater, homeOf } = require('./update');

const APP_ID = 'eu.wiest-lab.friendsshare';
// the matchmaking address; the website is at the same origin (see deriveSite)
const DEFAULT_SIGNAL_URL = 'wss://friendsshare.wiest-lab.eu/ws';
const DEFAULT_EXPIRY_DAYS = 365;
const DAY = 24 * 3600 * 1000;
// the only places the window can send the system browser to (see link:open), besides our own site
const LINK_HOSTS = new Set(['friendsshare.wiest-lab.eu', 'github.com']);

// Windows notifications, and the taskbar, attribute the app by this id.
app.setAppUserModelId(APP_ID);

// Decided once. An official build is a packaged one that carries the release workflow's key (see
// build.js); it behaves strictly. Everything else, run from source or a local build, is development.
const { official, key: buildKey } = build.info();
// An official build ignores FS_HOME and FS_SIGNAL, with one deliberate exception that is decided,
// and explained, in build.js.
const useEnv = build.mayUseEnvOverrides({ official, key: buildKey, testKey: process.env.FS_TEST_KEY });
// ... and does not run at all with a debugger attached or another profile directory (see the end of
// this file); the exception above does not cover those.
const refusedSwitch = official ? build.forbiddenSwitch(process.argv, (name) => app.commandLine.hasSwitch(name)) : null;

// FS_HOME moves everything (settings and shared folders) into one directory, so two instances can
// run side by side for testing.
const home = useEnv ? process.env.FS_HOME : undefined;
if (home) app.setPath('userData', path.join(home, 'userdata'));
// the matchmaking server, FS_SIGNAL aside
const signalUrl = normalizeSignalUrl(useEnv ? process.env.FS_SIGNAL : null, DEFAULT_SIGNAL_URL);
const siteUrl = deriveSite(signalUrl);

// For tests only, and never in a packaged app: with FS_OPEN_LOG set, links that would open in the
// system browser are appended to that file instead, so a test can read them and play the browser.
const openLog = !app.isPackaged && process.env.FS_OPEN_LOG ? process.env.FS_OPEN_LOG : null;
// The one way out to the system browser.
function openExternal(url) {
  if (openLog) {
    fs.appendFileSync(openLog, `${url}\n`);
    return Promise.resolve();
  }
  return shell.openExternal(url);
}

// The portable build runs from a temp dir; the real exe is PORTABLE_EXECUTABLE_FILE. Null when
// started from source.
const portableExe = process.env.PORTABLE_EXECUTABLE_FILE || null;
// Where an update is kept that cannot take the place of the exe (see update.js).
const updateDir = () => path.join(app.getPath('userData'), 'update');
// The exe to register for "Start with Windows" and to replace on an update. That is the one above,
// unless this is such an update, running in place of the exe it could not replace.
const homeExe = homeOf(process.argv, portableExe, updateDir());
// the startup entry launches the app straight into the tray
const AUTOSTART_ARGS = ['--hidden'];
const startHidden = process.argv.includes('--hidden');

let configFile;
let config = { shares: [], settings: {} };
// the friends' copies of the owners' file lists, one file each (see remote.js)
let remoteStore;
// listings of folders, kept for a few seconds so that many requests cost one walk (see folder.js)
const lister = folder.createLister();
let win = null;
let tray = null;
// true once the app is really going away, so closing the window is no longer turned into hiding it
let quitting = false;

const sendToWindow = (channel, ...args) => win && !win.isDestroyed() && win.webContents.send(channel, ...args);

// Sign-in, the app token and the plan from the last welcome (see account.js). The window shows
// them and does the networking; the token and the build key stay in this process.
const account = createAccount({
  fetch: (url, init) => net.fetch(url, init),
  safeStorage,
  openUrl: openExternal,
  config: () => config,
  save: () => saveConfig(),
  siteUrl: () => siteUrl,
  notify: (state) => sendToWindow('account:changed', state),
  reconnect: () => sendToWindow('net:reconnect'),
  // the person was in the browser; with a log file instead of a browser there is nothing to come back from
  bringToFront: () => !openLog && showWindow(),
});

// Self-update from the latest GitHub release (see update.js).
const updater = createUpdater({
  fetch: (url, init) => net.fetch(url, init),
  spawn,
  exe: portableExe,
  home: homeExe,
  dir: updateDir,
  version: app.getVersion(),
  onProgress: (pct) => sendToWindow('update:progress', pct),
});

const defaultBaseDir = () => (home ? path.join(home, 'shares') : path.join(app.getPath('documents'), 'FriendsShare'));
const getBaseDir = () => config.settings.baseDir || defaultBaseDir();
// Windows paths ignore case
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function loadConfig() {
  configFile = path.join(app.getPath('userData'), 'config.json');
  try {
    config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch {}
  if (!config || typeof config !== 'object' || Array.isArray(config)) config = {};
  if (!Array.isArray(config.shares)) config.shares = [];
  // baseDir is only stored once the person has picked one; until then the default (which follows
  // the Documents folder if that is moved) is used
  const saved = config.settings && typeof config.settings === 'object' ? config.settings : {};
  config.settings = { tray: saved.tray !== false, autostart: saved.autostart === true };
  if (typeof saved.baseDir === 'string' && path.isAbsolute(saved.baseDir)) config.settings.baseDir = saved.baseDir;

  // The lists of the owners' files used to live in config.json, which is rewritten on every change.
  // They have a place of their own now; the old ones move there, and out of config.json, when their
  // file is written.
  remoteStore = createRemoteStore(path.join(app.getPath('userData'), 'remote'));
  remoteStore.tidy();
  remoteStore.migrate(config.shares, (share) => config.shares.includes(share)).then((changed) => changed && saveConfig(), () => {});
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

// A new folder in the base folder (see the settings) named after the share, "Name (2)" if that one
// is taken.
async function makeShareDir(name) {
  let clean = String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 80).replace(/[. ]+$/, '') || 'Shared folder';
  // The name comes from the owner's app, which may be hostile: a device name such as CON or NUL is
  // not a name Windows can give a folder.
  if (tree.unsafeName(clean)) clean = `_${clean}`;
  const baseDir = getBaseDir();
  try {
    await fsp.mkdir(baseDir, { recursive: true });
  } catch (err) {
    // the base folder can be on a drive that is not connected right now
    throw new Error(`Cannot create folders in ${baseDir} (${err.code || err.message}). Choose another folder in the settings.`);
  }
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
  const root = path.resolve(dir);
  const full = path.resolve(root, rel);
  // a drive root such as D:\ already ends in a separator
  const inside = root.endsWith(path.sep) ? root : root + path.sep;
  if (full === root || !full.startsWith(inside)) throw new Error('Bad path');
  return full;
}

const PART_SUFFIX = tree.PART_SUFFIX;

// What went wrong on the friend's disk, as an error the window can act on (see TaggedError): "disk"
// ends the whole sync, "local" costs only the file at hand. Errors that are not about the disk
// pass as they are.
function diskError(err) {
  if (err instanceof folder.TaggedError) return err;
  if (/^(ENOSPC|EDQUOT)$/.test(err.code)) return new folder.TaggedError('disk', 'Not enough space on this disk');
  if (typeof err.code === 'string' && /^(E[A-Z]+|UNKNOWN)$/.test(err.code)) return new folder.TaggedError('local', `The file cannot be written on this PC (${err.code})`);
  return err;
}

// ---- settings ----

// What the settings dialog shows. From source there is no exe to register, so a stored "start with
// Windows" does not count as being in effect there.
const publicSettings = () => ({ baseDir: getBaseDir(), tray: config.settings.tray, autostart: !!portableExe && config.settings.autostart });

// Writes or removes the Windows startup entry for the portable exe. Done on every start while the
// setting is on, because the person may have moved the exe since.
function applyAutostart({ force = false } = {}) {
  if (!portableExe) return;
  const entry = { path: homeExe, args: AUTOSTART_ARGS };
  const on = config.settings.autostart;
  // Windows lets the person switch an entry off in Task Manager. At startup an entry that already
  // points at this exe is left alone, since writing it again would switch it back on.
  if (on && !force && app.getLoginItemSettings(entry).openAtLogin) return;
  // the registry value is named after the AppUserModelId set at the top
  app.setLoginItemSettings({ ...entry, openAtLogin: on });
}

// Applies and stores changed settings and tells the window and the tray menu. Throws, changing
// nothing, when one cannot be applied. patch: any of { baseDir, tray, autostart }.
function setSettings(patch) {
  const before = config.settings;
  const next = { ...before };
  if (typeof patch.tray === 'boolean') next.tray = patch.tray;
  if (typeof patch.autostart === 'boolean') {
    if (patch.autostart && !portableExe) throw new Error('Starting with Windows only works in the FriendsShare.exe download');
    next.autostart = patch.autostart;
  }
  if (typeof patch.baseDir === 'string') {
    // the default is not stored, so that it keeps following the Documents folder
    if (samePath(patch.baseDir, defaultBaseDir())) delete next.baseDir;
    else next.baseDir = path.resolve(patch.baseDir);
  }
  config.settings = next;
  try {
    if (next.autostart !== before.autostart) applyAutostart({ force: true });
  } catch (err) {
    config.settings = before;
    throw new Error(`Windows did not accept the startup entry (${err.message})`);
  }
  saveConfig();
  if (tray) tray.refresh();
  if (win && !win.isDestroyed()) win.webContents.send('settings:changed', publicSettings());
  return publicSettings();
}

// Open files, by handle number, for transfers in progress.
const handles = new Map();
let nextHandle = 1;

// The free plan holds a limited number of folders, shared and received together. The window checks
// this before it opens a dialog; this is the same rule where the list is changed. Folders that are
// there already (after Pro ended, say) are never touched: they are paused, not removed.
function assertRoom() {
  const { limit } = account.state();
  if (limit !== null && config.shares.length >= limit) {
    throw new Error(`The free plan holds ${limit} folder${limit === 1 ? '' : 's'} at a time. Remove a folder or upgrade to Pro.`);
  }
}

const api = {
  'state:get': () => ({
    // the owners' file lists are not part of it (see remote.js): the window asks for the one it shows
    shares: config.shares.map(({ remote, ...share }) => share),
    baseDir: getBaseDir(),
    settings: publicSettings(),
    canAutostart: !!portableExe,
    version: app.getVersion(),
    signalUrl,
    siteUrl,
    account: account.state(),
    defaultExpiryDays: DEFAULT_EXPIRY_DAYS,
  }),

  // ---- account (see account.js) ----

  // What goes into the hello of the matchmaking handshake (contract section 4), for the challenge
  // the server just sent -> { proto, version, hash, proof, token }. The window only relays it.
  'account:hello': async (nonce) => {
    nonce = String(nonce);
    if (nonce.length > 200) throw new Error('Bad challenge');
    const version = app.getVersion();
    const hash = await build.appHash();
    return { proto: 2, version, hash, proof: buildKey ? build.makeProof(buildKey, nonce, hash, version) : '', token: account.token() };
  },

  // The window got the server's welcome: remember it (and forget a token the server does not accept)
  // -> the account state
  'account:welcome': (message) => account.welcome(message),

  // The server says the plan changed while connected -> the account state
  'account:plan': (plan, limit) => account.plan(plan, limit),

  // Opens the website's sign-in page in the system browser; the rest happens when the person is done
  // there and is reported with account:changed. A second call while waiting opens the page again.
  'account:signIn': () => account.signIn(),

  // Gives up a pending sign-in, if there is one, and clears the last error -> the account state
  'account:cancelSignIn': () => account.cancelSignIn(),

  'account:signOut': () => account.signOut(),

  // "Upgrade to Pro" and "Manage subscription": the account page in the system browser, signed in
  // already. Signed out: signs in first.
  'account:openPage': () => account.openAccountPage(),

  // patch: { tray?: boolean, autostart?: boolean } -> the settings as in state:get
  'settings:set': (patch) => setSettings({ tray: patch && patch.tray, autostart: patch && patch.autostart }),

  // Folder picker for "New folders are stored in" -> the settings, or null when cancelled.
  'settings:pickBaseDir': async () => {
    const res = await dialog.showOpenDialog(win, { title: 'Where to store new folders', defaultPath: getBaseDir(), properties: ['openDirectory', 'createDirectory'] });
    if (res.canceled || !res.filePaths[0]) return null;
    const dir = path.resolve(res.filePaths[0]);
    // fail here, with a clear message, instead of on the next new folder
    try {
      await fsp.rm(await fsp.mkdtemp(path.join(dir, '.fs-check-')), { recursive: true });
    } catch (err) {
      throw new Error(`FriendsShare cannot write to that folder (${err.code || err.message}). Choose another one.`);
    }
    return setSettings({ baseDir: dir });
  },

  // Opens a link in the system browser. The window itself blocks all navigation, so this is the
  // only way out, and it only knows our own pages. The website counts even where a development
  // setup puts it on another address (FS_SIGNAL).
  'link:open': (url) => {
    let u;
    try {
      u = new URL(String(url));
    } catch {
      throw new Error('That is not a link');
    }
    const listed = u.protocol === 'https:' && LINK_HOSTS.has(u.hostname) && !u.port;
    if (!(listed || u.origin === siteUrl) || u.username || u.password) throw new Error('That link cannot be opened');
    return openExternal(u.href);
  },

  // A sync that downloaded something finished. Worth a notification only if nobody can see the window.
  'sync:done': (name, downloaded, skipped) => {
    downloaded = Number(downloaded);
    skipped = Number(skipped) || 0;
    if (!(downloaded > 0) || (win && win.isVisible() && !win.isMinimized())) return;
    const files = `${downloaded} file${downloaded === 1 ? '' : 's'} downloaded`;
    // a sync that left files out is not "up to date"
    notify('FriendsShare', `${String(name).slice(0, 100)} ${skipped > 0 ? `synced: ${files}, ${skipped} could not be downloaded` : `is up to date: ${files}`}`, showWindow);
  },

  'share:create': async (name) => {
    assertRoom();
    const dir = await makeShareDir(name);
    const share = { id: crypto.randomUUID(), role: 'host', name: path.basename(dir), dir, code: null, createdAt: Date.now() };
    config.shares.push(share);
    saveConfig();
    return share;
  },

  // Shares a folder the person already has, where it is: nothing is copied or moved. The picker
  // is opened here, so the renderer cannot make us share a path the person did not choose.
  // -> the new share, or null when cancelled.
  'share:addExisting': async () => {
    assertRoom();
    const res = await dialog.showOpenDialog(win, { title: 'Choose the folder to share', properties: ['openDirectory'] });
    if (res.canceled || !res.filePaths[0]) return null;
    const dir = path.resolve(res.filePaths[0]);
    // a whole drive is almost never meant, and its system files cannot be read anyway
    if (path.parse(dir).root === dir) throw new Error('That is a whole drive. Choose a folder on it instead.');
    const st = await fsp.stat(dir).catch(() => null);
    if (!st || !st.isDirectory()) throw new Error('That is not a folder');
    if (config.shares.some((s) => s.dir && samePath(s.dir, dir))) throw new Error('That folder is already in your list');
    // folders that would show far more than anybody means to share
    const why = folder.unsafeToShare(dir, {
      home: app.getPath('home'),
      windir: process.env.SystemRoot || process.env.windir,
      userData: app.getPath('userData'),
      baseDir: getBaseDir(),
    });
    if (why) throw new Error(why);
    // A huge folder is probably not what the person meant, and listing it takes a while.
    if ((await folder.countFiles(dir, folder.MANY_FILES)) > folder.MANY_FILES) {
      const answer = await dialog.showMessageBox(win, {
        type: 'question',
        title: 'Share this folder?',
        message: `This folder holds more than ${folder.MANY_FILES.toLocaleString('en-US')} files.`,
        detail: `Friends will be able to see and download every file in "${path.basename(dir)}", and listing them takes a while. Share it anyway?`,
        buttons: ['Share it', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (answer.response !== 0) return null;
    }
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
    assertRoom();
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
    // the download choice: paths the friend does not want (files, or whole folders with a "/" at
    // the end, see tree.js), and whether they have started a download (before that, syncs only
    // fetch the list)
    if (Array.isArray(info.excluded)) share.excluded = [...new Set(info.excluded.map(String))];
    if (typeof info.chosen === 'boolean') share.chosen = info.chosen;
    saveConfig();
    // The owner's file list is big, so it is not part of config.json: it gets a file of its own
    // (remote.js). Not being able to keep it, a full disk say, is no reason to fail the sync: the
    // window has the list, and the next sync fetches it again.
    if (Array.isArray(info.remote)) await remoteStore.write(id, info.remote).catch(() => {});
    return share;
  },

  // The friend's copy of the owner's file list for the folder the window is showing.
  // -> { at, files: [{ path, size, mtime }] }, or null when there is none yet
  'share:remote': (id) => {
    getShare(id);
    return remoteStore.read(id);
  },

  // Forgets the share. The files stay on disk.
  'share:remove': (id) => {
    config.shares = config.shares.filter((s) => s.id !== id);
    saveConfig();
    lister.invalidate(id);
    remoteStore.remove(id).catch(() => {});
  },

  'share:open': async (id) => {
    const share = getShare(id);
    // openPath answers with an error message, or an empty string when it worked
    if (share.dir && (await shell.openPath(share.dir))) throw new Error('Could not open the folder. Was it moved or deleted?');
  },

  // The files in a folder -> { files: [{ path, size, mtime }], missing: null | 'missing' | 'denied' }.
  // `missing` says the folder itself cannot be read, which is not the same as an empty folder. A
  // listing is reused for a few seconds; opts.fresh asks for a new one.
  'share:files': (id, opts) => lister.list(id, getShare(id).dir, { fresh: !!(opts && opts.fresh) }),

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
    try {
      for (const src of paths) {
        const dest = path.join(share.dir, path.basename(src));
        if (path.resolve(src) === dest) continue;
        await fsp.cp(src, dest, { recursive: true, force: true });
        count++;
      }
    } finally {
      lister.invalidate(id);
    }
    return count;
  },

  // A friend asked for this file. It has to be a real file inside the shared folder; resolveIn
  // only looks at the text of the path, folder.realFile at where it leads. The errors are tagged
  // (see TaggedError): "gone" is the folder itself, "read" is only this file.
  'file:openRead': async (id, rel) => {
    const share = getShare(id);
    if (share.role !== 'host') throw new Error('Not shared');
    const real = await folder.realFile(share.dir, rel);
    let fh;
    try {
      fh = await fsp.open(real, 'r');
    } catch (err) {
      throw new folder.TaggedError('read', `The file cannot be opened (${err.code || err.message})`);
    }
    try {
      const st = await fh.stat();
      if (!st.isFile()) throw new folder.TaggedError('read', 'That is not a file');
      const h = nextHandle++;
      handles.set(h, { fh });
      return { h, size: st.size };
    } catch (err) {
      await fh.close().catch(() => {});
      throw err;
    }
  },

  'file:read': async (h, offset, length) => {
    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await handles.get(h).fh.read(buf, 0, length, offset);
    return buf.subarray(0, bytesRead);
  },

  // Downloads go to "<file>.<size>-<mtime>.fspart" first. If such a part already exists the
  // download continues where it stopped; a changed file gets a different part name.
  // The errors are tagged (see diskError): "name" and "local" cost only this file, "disk" is the end
  // of the sync.
  'file:openWrite': async (id, rel, size, mtime) => {
    const share = getShare(id);
    if (share.role !== 'guest' || !share.dir) throw new Error('Not a friend folder');
    // The owner's app chooses these names and is only as trustworthy as the person who runs it. A
    // name that is trouble on Windows (CON, "name:stream", a trailing dot, "..") is not written.
    const why = tree.unsafePath(rel);
    if (why) throw new folder.TaggedError('name', `Not written: ${why}`);
    if (!Number.isSafeInteger(size) || size < 0 || !Number.isFinite(mtime)) throw new Error('Bad size or time');
    const final = resolveIn(share.dir, rel);
    const part = `${final}.${size}-${mtime}${PART_SUFFIX}`;
    let fh;
    try {
      await fsp.mkdir(path.dirname(final), { recursive: true });
      fh = await fsp.open(part, 'a');
      let offset = (await fh.stat()).size;
      if (offset > size) {
        await fh.truncate(0);
        offset = 0;
      }
      const h = nextHandle++;
      handles.set(h, { id, fh, final, part, mtime });
      return { h, offset };
    } catch (err) {
      if (fh) await fh.close().catch(() => {});
      throw diskError(err);
    }
  },

  'file:write': async (h, data) => {
    try {
      await handles.get(h).fh.appendFile(data instanceof ArrayBuffer ? Buffer.from(data) : data);
    } catch (err) {
      throw diskError(err);
    }
  },

  // Download complete: the part becomes the real file and takes the original's modified time,
  // which is how the next sync knows it is up to date.
  'file:finish': async (h) => {
    const { id, fh, final, part, mtime } = handles.get(h);
    handles.delete(h);
    try {
      await fh.close();
      await fsp.rename(part, final);
      await fsp.utimes(final, mtime / 1000, mtime / 1000);
    } catch (err) {
      throw diskError(err);
    } finally {
      lister.invalidate(id);
    }
  },

  // dropEmpty: a download that is given up before the first byte arrived (the owner could not read
  // the file) does not leave an empty part behind. What did arrive stays, to go on from.
  'file:close': async (h, dropEmpty) => {
    const entry = handles.get(h);
    if (!entry) return;
    handles.delete(h);
    const empty = dropEmpty && entry.part && (await entry.fh.stat().catch(() => null))?.size === 0;
    await entry.fh.close().catch(() => {});
    if (empty) await fsp.rm(entry.part, { force: true }).catch(() => {});
  },
};

// -> { status: 'current' | 'available' | 'error', current, latest?, error? }
api['update:check'] = () => updater.check();

// Portable exe: download, swap, restart. Otherwise (dev) just open the release page.
api['update:install'] = async () => {
  const done = await updater.install();
  if (done.page) {
    openExternal(done.page);
    return { opened: true };
  }
  // what runs next must be able to take the single-instance lock, however long this one takes to end
  app.releaseSingleInstanceLock();
  app.quit();
  return { restarting: true };
};

// Brings the window back, from the tray or from being minimized.
function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
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
    icon: path.join(__dirname, 'icon.png'),
    // Started by Windows at login: straight into the tray. The window still has to exist, hidden,
    // because all the networking lives in it. Without a tray icon there would be no way to bring
    // it back, so then it is shown.
    show: !(startHidden && tray),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // transfers must keep their speed while the window is minimized or hidden
      backgroundThrottling: false,
      // an official build cannot be taken apart from inside
      devTools: !official,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  // Closing the window only hides it, so friends can keep downloading. Real quits (the tray menu,
  // the updater, Windows shutting down) set `quitting` first and are not held back.
  win.on('close', (e) => {
    if (quitting || !config.settings.tray || !tray) return;
    e.preventDefault();
    win.hide();
    if (!config.trayNoticeShown) {
      config.trayNoticeShown = true;
      saveConfig();
      notify('FriendsShare is still running', 'It keeps running in the tray so friends can still download. To quit, right-click the tray icon and choose Quit.', showWindow);
    }
  });
  win.on('session-end', () => (quitting = true));
  win.on('closed', () => (win = null));
}

// Everything from the single-instance lock on.
function start() {
  if (!app.requestSingleInstanceLock() && !home) return app.quit();
  app.on('second-instance', (_e, argv) => {
    // a startup entry that fires while the app already runs must not pop the window up
    if (!argv.includes('--hidden')) showWindow();
  });
  app.on('before-quit', () => (quitting = true));
  app.on('will-quit', () => {
    if (tray) tray.destroy();
  });
  app.whenReady().then(() => {
    loadConfig();
    account.init();
    // read once, now, so the first hello does not wait for it
    build.appHash();
    updater.cleanup();
    for (const [channel, fn] of Object.entries(api)) ipcMain.handle(channel, (_e, ...args) => fn(...args));
    tray = createTray({
      open: showWindow,
      quit: () => app.quit(),
      getAutostart: () => ({ available: !!portableExe, checked: publicSettings().autostart }),
      setAutostart: (on) => setSettings({ autostart: on }),
    });
    try {
      if (config.settings.autostart) applyAutostart();
    } catch {}
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}

if (refusedSwitch) {
  // An official build does not run with a debugger attached, or with another profile directory
  // (--user-data-dir, which Electron honours by itself, would give one person several profiles, each
  // with its own five free folders). Nothing has been touched yet.
  app.exit(1);
} else if (updater.newerCopy()) {
  // An update that could not replace this exe is kept in the profile and runs in its place (see
  // update.js). When Windows does not start it, this one runs after all.
  updater.handOver(process.argv.slice(1)).then((handed) => (handed ? app.exit(0) : start()));
} else {
  start();
}
