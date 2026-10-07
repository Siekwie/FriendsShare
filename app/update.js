// Self-update from the latest GitHub release: the new FriendsShare.exe is downloaded and takes the
// place of the one the person started.
//
// That exe is locked for as long as the app runs (the portable build itself runs from a temp dir),
// so the new one is downloaded next to it, and a hidden helper that outlives the app puts it in
// place and starts it.
//
// This needs a folder the person may write to. An exe in C:\Program Files, say, is not in one, and
// an update must not need administrator rights: without them the app would stay on a version the
// server turns away. The new exe is then kept in the profile (`dir`) and started from there, and
// from then on the old exe hands over to it every time it is started (see handOver). The same
// happens when the helper cannot put the new exe in place for another reason.
//
// Nothing here talks to Electron, so it is tested without a window (test/unit.js).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const RELEASE_API = 'https://api.github.com/repos/Siekwie/FriendsShare/releases/latest';
const RELEASE_URL_PREFIX = 'https://github.com/Siekwie/FriendsShare/';
const ASSET_NAME = 'FriendsShare.exe';
// a copy kept in the profile says in its name which version it is
const COPY_NAME = /^FriendsShare-(\d+\.\d+\.\d+)\.exe$/;
// tells such a copy which exe it runs in place of
const HOME_SWITCH = '--update-home=';
// how often (once a second) the helper tries to put the new exe in place
const SWAP_TRIES = 60;

const parseVersion = (v) => String(v).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
function isNewer(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < Math.max(x.length, y.length, 3); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

// Windows paths ignore case
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// The exe that updates replace, and that "Start with Windows" names: the one this process was
// started from (exe), unless that is a copy in the profile (dir) that runs in place of another (see
// HOME_SWITCH) and that one is still there.
function homeOf(argv, exe, dir) {
  if (!exe) return null;
  if (!samePath(path.dirname(exe), dir)) return exe;
  const arg = argv.find((a) => typeof a === 'string' && a.startsWith(HOME_SWITCH));
  const given = arg ? arg.slice(HOME_SWITCH.length) : '';
  if (!given || !path.isAbsolute(given) || !/\.exe$/i.test(given)) return exe;
  try {
    return fs.statSync(given).isFile() ? path.resolve(given) : exe;
  } catch {
    return exe;
  }
}

// What the helper runs, in cmd (rather than PowerShell, which does not run without a console). Once
// a second it tries to put the new exe in place, and starts it as soon as that works. When it never
// works, the new exe goes into the profile and runs from there; and when even that fails, the old
// one is started again, so that the person is never left without the app.
const swapCommand = (tries = SWAP_TRIES) =>
  `(for /l %i in (1,1,${tries}) do @(move /y "%FS_UPDATE_NEW%" "%FS_UPDATE_EXE%" >nul 2>&1 && (start "" "%FS_UPDATE_EXE%" & exit) || ping -n 2 127.0.0.1 >nul))` +
  ` & (move /y "%FS_UPDATE_NEW%" "%FS_UPDATE_COPY%" >nul 2>&1 && start "" "%FS_UPDATE_COPY%" "${HOME_SWITCH}%FS_UPDATE_EXE%" || start "" "%FS_UPDATE_EXE%")`;

// exe: the exe this process was started from, null when run from source. home: see homeOf.
// dir(): a folder in the profile for the copies (asked for when it is needed: the profile is not
// to be touched before the app has decided to run). version: of this app. onProgress(percent).
function createUpdater({ fetch, spawn, exe, home, dir, version, onProgress = () => {} }) {
  let latest = null; // { version, url, size, page } of the newest release, once a check found one
  let installing = false;

  const copyOf = (v) => path.join(dir(), `FriendsShare-${v}.exe`);

  // -> { status: 'current' | 'available' | 'error', current, latest?, error? }
  async function check() {
    const current = version;
    try {
      const res = await fetch(RELEASE_API, { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const rel = await res.json();
      const asset = (rel.assets || []).find((a) => a.name === ASSET_NAME);
      if (!rel.tag_name || !asset || !String(asset.browser_download_url).startsWith(RELEASE_URL_PREFIX)) throw new Error('No download in the latest release');
      const found = parseVersion(rel.tag_name).join('.');
      if (!isNewer(found, current)) {
        latest = null;
        return { status: 'current', current };
      }
      latest = { version: found, url: asset.browser_download_url, size: asset.size, page: `${RELEASE_URL_PREFIX}releases/tag/${rel.tag_name}` };
      return { status: 'available', current, latest: found };
    } catch (err) {
      return { status: 'error', current, error: err.message };
    }
  }

  // Next to the exe when a file can be made there, which is what the helper needs. Otherwise in the
  // profile, under a name that only becomes an exe's once the download is complete.
  async function openDownload(v) {
    try {
      const file = `${home}.new`;
      return { file, fh: await fsp.open(file, 'w'), inPlace: true };
    } catch {}
    await fsp.mkdir(dir(), { recursive: true });
    const file = `${copyOf(v)}.part`;
    return { file, fh: await fsp.open(file, 'w'), inPlace: false };
  }

  // -> { file, inPlace }: the new exe, complete
  async function download({ url, size, version: v }) {
    if (!url.startsWith(RELEASE_URL_PREFIX)) throw new Error('Unexpected download address');
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`Download answered ${res.status}`);
    const target = await openDownload(v);
    let done = 0;
    let lastPct = -1;
    try {
      try {
        for await (const chunk of res.body) {
          await target.fh.write(chunk);
          done += chunk.length;
          const pct = size ? Math.min(100, Math.floor((done / size) * 100)) : 0;
          if (pct !== lastPct) onProgress(pct);
          lastPct = pct;
        }
      } finally {
        await target.fh.close();
      }
      if (done !== size) throw new Error('Downloaded file has the wrong size');
      if (target.inPlace) return { file: target.file, inPlace: true };
      await fsp.rename(target.file, copyOf(v));
      return { file: copyOf(v), inPlace: false };
    } catch (err) {
      await fsp.rm(target.file, { force: true }).catch(() => {});
      throw err;
    }
  }

  // Starts an exe that goes on without us -> whether Windows started it
  function launch(file, args) {
    return new Promise((resolve) => {
      let child;
      try {
        // (in its own folder: ours is the temp dir of the portable build, which is deleted when we end)
        child = spawn(file, args, { detached: true, stdio: 'ignore', cwd: path.dirname(file) });
      } catch {
        return resolve(false);
      }
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    });
  }

  // Downloads the update and arranges for it to run. The app has to quit right after: the helper
  // waits for the exe to be free, and a copy that was started needs the single-instance lock.
  // -> { restarting: true }, or { page } when there is no exe to replace (run from source): the
  // release page, for the browser.
  async function install() {
    if (!latest) throw new Error('No update available');
    if (!exe) return { page: latest.page };
    if (installing) throw new Error('Already updating');
    installing = true;
    try {
      const got = await download(latest);
      if (got.inPlace) {
        // for the helper's way out (see swapCommand)
        await fsp.mkdir(dir(), { recursive: true }).catch(() => {});
        spawn('cmd.exe', ['/d', '/s', '/c', `"${swapCommand()}"`], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          windowsVerbatimArguments: true,
          env: { ...process.env, FS_UPDATE_NEW: got.file, FS_UPDATE_EXE: home, FS_UPDATE_COPY: copyOf(latest.version) },
        }).unref();
      } else if (!(await launch(got.file, [HOME_SWITCH + home]))) {
        await fsp.rm(got.file, { force: true }).catch(() => {});
        throw new Error('the new version could not be started');
      }
    } catch (err) {
      installing = false;
      throw new Error(`Update failed: ${err.message}`);
    }
    return { restarting: true };
  }

  // The newest copy in the profile that is newer than this app, or null. Read at every start, before
  // anything else, so it does not wait for anything.
  function newerCopy() {
    if (!exe) return null;
    let names = [];
    try {
      names = fs.readdirSync(dir());
    } catch {}
    let best = null;
    for (const name of names) {
      const m = COPY_NAME.exec(name);
      const file = path.join(dir(), name);
      // (a copy is never newer than itself, whatever its name says)
      if (m && !samePath(file, exe) && isNewer(m[1], best ? best.version : version)) best = { version: m[1], file };
    }
    return best && best.file;
  }

  // An update that could not replace this exe runs in its place: started with what this process was
  // started with (args), and told which exe it stands in for. A copy that Windows does not start is
  // removed, so that it is not tried at every start. -> true when a copy took over, and this
  // process should end
  async function handOver(args) {
    const copy = newerCopy();
    if (!copy) return false;
    if (await launch(copy, [...args.filter((a) => !String(a).startsWith(HOME_SWITCH)), HOME_SWITCH + home])) return true;
    await fsp.rm(copy, { force: true }).catch(() => {});
    return false;
  }

  // Clears what updates left behind: a download that was not installed, and the copies that are not
  // needed any more (this version or older, which is all of them once the exe itself is up to date).
  async function cleanup() {
    if (!exe) return;
    await fsp.rm(`${home}.new`, { force: true }).catch(() => {});
    let names = [];
    try {
      names = await fsp.readdir(dir());
    } catch {}
    for (const name of names) {
      const m = COPY_NAME.exec(name);
      const file = path.join(dir(), name);
      const stale = m ? !samePath(file, exe) && !isNewer(m[1], version) : name.endsWith('.part');
      if (stale) await fsp.rm(file, { force: true }).catch(() => {});
    }
  }

  return { check, install, newerCopy, handOver, cleanup };
}

module.exports = { createUpdater, homeOf, isNewer, swapCommand, HOME_SWITCH };
