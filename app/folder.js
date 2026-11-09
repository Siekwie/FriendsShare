// Folders on disk, in the main process: what is in one, whether a request for a file stays inside
// it, and whether a folder may be shared at all. Nothing here talks to Electron, so it is tested
// without a window (test/unit.js).
//
// A shared folder can also hold "links": files and folders that lie somewhere else on this PC and
// are shared from there (share.links in config.json, { name, src }). A link is listed under its
// name at the top of the folder, as if it were in it, and served from where it really is. Nothing
// is copied, so a 20 GB recording is shared the moment it is dropped on the window.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const tree = require('./tree');

// How many folders are read at once, and how many files of one folder are asked about at once.
// One after the other is slow on a folder of thousands of files; all at once floods the disk.
const READERS = 8;
const STAT_BATCH = 16;
// A listing is reused for this long (see createLister).
const LISTING_TTL = 5000;
// More files than this in a folder to share, and the person is asked first.
const MANY_FILES = 20000;

// An error that the window can tell apart even after it crossed the IPC boundary, where only the
// message survives: "[tag] text". Tags: gone, read (the owner's side), disk, name, local (the friend's).
class TaggedError extends Error {
  constructor(tag, message) {
    super(`[${tag}] ${message}`);
    this.tag = tag;
  }
}

// Windows paths ignore case, and a folder is inside itself.
const within = (parent, child) => {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

// ---- listing ----

// How a folder that cannot be read is reported: it is not there (moved, deleted, its drive is not
// connected), or it is there but may not be read.
const whyUnreadable = (err) => (err.code === 'EACCES' || err.code === 'EPERM' ? 'denied' : 'missing');

// Every file in a folder, with its size and modified time. Links (symlinks and junctions) are
// skipped, and so are the unfinished downloads of this app: a link could lead anywhere, and a
// listing must never hand out what lies outside the folder.
// -> { files: [{ path, size, mtime }] sorted by path, missing: null | 'missing' | 'denied' }
// `missing` is set when the folder itself cannot be read, which is not the same as an empty folder.
// A folder inside that cannot be read is left out. dir: null is a folder that does not exist yet.
async function listFiles(dir) {
  const files = [];
  if (!dir) return { files, missing: null };
  let missing = null;
  const queue = [''];
  async function reader() {
    while (queue.length) {
      const sub = queue.pop();
      let entries;
      try {
        entries = await fsp.readdir(sub ? path.join(dir, sub) : dir, { withFileTypes: true });
      } catch (err) {
        if (!sub) missing = whyUnreadable(err);
        continue;
      }
      const found = [];
      for (const entry of entries) {
        const rel = sub ? `${sub}/${entry.name}` : entry.name;
        if (entry.isDirectory()) queue.push(rel);
        else if (entry.isFile() && !entry.name.endsWith(tree.PART_SUFFIX)) found.push(rel);
      }
      for (let i = 0; i < found.length; i += STAT_BATCH) {
        await Promise.all(
          found.slice(i, i + STAT_BATCH).map(async (rel) => {
            const st = await fsp.stat(path.join(dir, rel)).catch(() => null);
            if (st) files.push({ path: rel, size: st.size, mtime: Math.floor(st.mtimeMs) });
          })
        );
      }
    }
  }
  await Promise.all(Array.from({ length: READERS }, reader));
  sortFiles(files);
  return { files, missing };
}

const sortFiles = (files) => files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

// the first part of a path: what it is called at the top of the folder
const topOf = (rel) => rel.slice(0, rel.indexOf('/') === -1 ? rel.length : rel.indexOf('/'));

// The folder and its links together, as friends see it. A link is listed under its name; a linked
// folder with everything in it, under "name/...". Where the folder has something of the same name
// as a link (Windows ignores case), the link wins and that is left out. `missing` is about the
// folder itself, as in listFiles: with links the share can still have files while the folder is
// gone, and the caller decides what that means.
// -> { files, missing, links: [{ name, src, dir, problem: null | 'missing' | 'denied' }] }
async function listShare(dir, links = []) {
  const base = await listFiles(dir);
  if (!links.length) return { ...base, links: [] };
  const names = new Set(links.map((l) => l.name.toLowerCase()));
  const files = base.files.filter((f) => !names.has(topOf(f.path).toLowerCase()));
  const info = await Promise.all(
    links.map(async (link) => {
      const out = { name: link.name, src: link.src, dir: false, problem: null };
      const st = await fsp.stat(link.src).catch((err) => err);
      if (st instanceof Error) out.problem = whyUnreadable(st);
      else if (st.isFile()) files.push({ path: link.name, size: st.size, mtime: Math.floor(st.mtimeMs) });
      else if (st.isDirectory()) {
        out.dir = true;
        const sub = await listFiles(link.src);
        out.problem = sub.missing;
        for (const f of sub.files) files.push({ path: `${link.name}/${f.path}`, size: f.size, mtime: f.mtime });
      } else out.problem = 'missing';
      return out;
    })
  );
  sortFiles(files);
  return { files, missing: base.missing, links: info };
}

// listShare with a memory. A listing is reused for a few seconds, and a request that comes while
// one is running waits for that one, so several friends syncing at once and the window refreshing
// cost one walk through the folder instead of one each. key: what the listing is kept under (the
// share's id); a different dir, or other links, under the same key starts over. fresh: do not reuse.
function createLister(ttl = LISTING_TTL) {
  const cache = new Map();
  return {
    list(key, dir, { fresh = false, links = [] } = {}) {
      const sig = JSON.stringify(links);
      const hit = cache.get(key);
      if (hit && !fresh && hit.dir === dir && hit.sig === sig && (hit.at === null || Date.now() - hit.at < ttl)) return hit.promise;
      const entry = { dir, sig, at: null, promise: null };
      entry.promise = listShare(dir, links).then(
        (result) => {
          entry.at = Date.now();
          return result;
        },
        (err) => {
          if (cache.get(key) === entry) cache.delete(key);
          throw err;
        }
      );
      cache.set(key, entry);
      return entry.promise;
    },
    // the folder changed through this app (files were added or arrived)
    invalidate: (key) => cache.delete(key),
  };
}

// How many files are in a folder, links skipped; stops counting above `limit`.
// -> a number that is at most limit + 1
async function countFiles(dir, limit) {
  let count = 0;
  const queue = [dir];
  while (queue.length && count <= limit) {
    const here = queue.pop();
    let entries;
    try {
      entries = await fsp.readdir(here, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) queue.push(path.join(here, entry.name));
      else if (entry.isFile() && !entry.name.endsWith(tree.PART_SUFFIX)) count++;
    }
  }
  return Math.min(count, limit + 1);
}

// ---- sharing a folder in place ----

// Why a folder must not be shared, in words for the person, or null when it may be. These are the
// folders that would show far more than anybody means to: the settings of this app (with the
// sign-in), the folder where friends' downloads are stored, the user's own folder, and Windows.
// places: { home, windir, userData, baseDir }
function unsafeToShare(dir, { home, windir, userData, baseDir }) {
  if (windir && within(windir, dir)) return 'That is part of Windows. Sharing it would hand out system files.';
  if (home && path.resolve(home).toLowerCase() === path.resolve(dir).toLowerCase()) {
    return 'That is your user folder. It holds your settings and private files. Choose a folder inside it, or another one.';
  }
  if (userData && within(dir, userData)) return "That folder contains FriendsShare's own settings, including your sign-in. Choose a folder that holds only what you want to share.";
  if (userData && within(userData, dir)) return "That folder is part of FriendsShare's own settings.";
  if (baseDir && within(dir, baseDir)) {
    const what = path.resolve(dir).toLowerCase() === path.resolve(baseDir).toLowerCase() ? 'That is the folder' : `That folder contains ${baseDir}, the folder`;
    return `${what} where the folders from your friends are stored, so sharing it would share their files too. Choose another folder, or change where new folders are stored in the settings.`;
  }
  return null;
}

// ---- links: files and folders shared from where they are ----

// Why `src` must not be added to the share whose folder is `dir`, or null. A folder is held to the
// same rules as a folder that is shared in place; a file only to the one about this app's settings.
// isDir: whether src is a folder. places: as for unsafeToShare.
function unsafeToLink(src, isDir, dir, places) {
  if (path.parse(src).root === src) return 'That is a whole drive. Choose a folder on it instead.';
  if (isDir) {
    const why = unsafeToShare(src, places);
    if (why) return why;
    // everything in it would be listed twice
    if (dir && within(src, dir)) return 'That folder contains the shared folder itself.';
    return null;
  }
  if (places.userData && within(places.userData, src)) return "That file is part of FriendsShare's own settings.";
  return null;
}

// The name a link gets: the name of the file or folder, and "name (2)" when that one is taken
// (before the extension of a file: "clip (2).mp4"). taken: the names in use, in lower case.
function freeName(name, isDir, taken) {
  const dot = isDir ? -1 : name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${stem} (${n})${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

// ---- serving a file ----

// The real path of a file under `root` that is asked for by its path in the folder, once it is
// certain to be a real file inside the folder. The text of the path is not enough: a junction or a
// symlink inside the shared folder can lead anywhere, so the real path of the file is compared with
// the real path of the folder. Throws a TaggedError: rootTag when the folder itself is not there,
// 'read' when only this file cannot be served.
async function insideOf(root, rel, rootTag) {
  let realRoot;
  try {
    realRoot = await fsp.realpath(root);
  } catch {
    throw new TaggedError(rootTag, 'The shared folder cannot be found');
  }
  let real;
  try {
    real = await fsp.realpath(path.resolve(realRoot, rel));
  } catch {
    throw new TaggedError('read', 'The file cannot be found');
  }
  if (real === realRoot || !within(realRoot, real)) throw new TaggedError('read', 'That file is not inside the shared folder');
  return real;
}

// The real path of a file that a friend asked for by its path in the share: in the folder, or
// behind one of its links (a linked file is the file itself, a linked folder is held to the same
// rule as the folder). Throws a TaggedError: 'gone' when the folder itself is not there (that ends
// the whole sync), 'read' when only this file cannot be served, a link that leads nowhere included.
async function realFile(root, rel, links = []) {
  // the same rules as for what a friend's app writes: no device names, no ":stream", no ".."
  const why = typeof rel === 'string' ? tree.unsafePath(rel) : 'it is not a path';
  if (why) throw new TaggedError('read', `That path cannot be served: ${why}`);
  const top = topOf(rel).toLowerCase();
  const link = links.find((l) => l.name.toLowerCase() === top);
  if (!link) return insideOf(root, rel, 'gone');
  if (rel.length === top.length) {
    // the link itself: whether it is a file is checked where it is opened
    try {
      return await fsp.realpath(link.src);
    } catch {
      throw new TaggedError('read', 'The file cannot be found');
    }
  }
  return insideOf(link.src, rel.slice(top.length + 1), 'read');
}

module.exports = { TaggedError, within, listFiles, listShare, createLister, countFiles, unsafeToShare, unsafeToLink, freeName, realFile, MANY_FILES };
