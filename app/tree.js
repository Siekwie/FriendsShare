// The paths of a shared folder, and the tree they make. Plain functions without Electron or the DOM:
// the window loads this file with a script tag (index.html), the main process and the tests with
// require, so there is one definition of what a path may look like and of what "wanted" means.
//
// Paths travel as "sub/dir/file.txt". share.excluded, what a friend does not want, is a list of
// such paths. A path that ends in "/" is a whole folder: everything in it, now and later. A file is
// excluded when it, or any folder above it, is in the list. Everything else is wanted, including
// files that appear later anywhere outside an excluded folder.
const tree = (() => {
  // how many entries of a folder are shown before "Show more"
  const PAGE = 300;
  // the working suffix of an unfinished download (main.js); a file with that name could never count as done
  const PART_SUFFIX = '.fspart';

  // ---- names that Windows cannot store ----

  // Device names are reserved, with or without an extension (NUL.txt is NUL).
  const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

  // Why one name (a single part of a path) is trouble on Windows, or null.
  function unsafeName(name) {
    if (name === '') return 'it has an empty name in its path';
    if (name === '.' || name === '..') return 'it uses "." or ".." in its path';
    // ":" would write an alternate data stream (name:stream) instead of a file
    if (/[\u0000-\u001f<>:"|?*\\]/.test(name)) return 'its name has a character Windows does not allow (< > : " | ? * \\ or a control character)';
    if (/[. ]$/.test(name)) return 'its name ends with a dot or a space';
    if (RESERVED.test(name.split('.')[0].trimEnd())) return 'its name is reserved by Windows (CON, NUL, COM1 and so on)';
    if (name.length > 255) return 'its name is too long';
    if (name.endsWith(PART_SUFFIX)) return `its name ends with ${PART_SUFFIX}, which FriendsShare uses for unfinished downloads`;
    return null;
  }

  // Why a path from the other side must not be written (or read), or null when it is fine. The other
  // side chooses these, so nothing about them is taken for granted.
  function unsafePath(rel) {
    if (typeof rel !== 'string' || rel === '') return 'it has no name';
    if (rel.startsWith('/') || /^[A-Za-z]:\//.test(rel)) return 'it is an absolute path';
    for (const name of rel.split('/')) {
      const why = unsafeName(name);
      if (why) return why;
    }
    return null;
  }

  // ---- file lists from the other side ----

  // The entries of a list that are what they should be: a path, a size and a time. The rest is
  // dropped, and so is a path that comes twice.
  function validEntries(list) {
    const out = [];
    if (!Array.isArray(list)) return out;
    const seen = new Set();
    for (const f of list) {
      if (!f || typeof f.path !== 'string' || !Number.isSafeInteger(f.size) || f.size < 0) continue;
      // the range of dates a file system takes (the year 1601 to 9999)
      if (!Number.isFinite(f.mtime) || f.mtime < -11644473600000 || f.mtime > 253402300799999 || seen.has(f.path)) continue;
      seen.add(f.path);
      out.push({ path: f.path, size: f.size, mtime: f.mtime });
    }
    return out;
  }

  // A finished download carries the original's modified time, to the precision of the disk.
  const upToDate = (remote, mine) => !!mine && mine.size === remote.size && Math.abs(mine.mtime - remote.mtime) <= 2000;

  // ---- what is excluded ----

  // the entry of a node in share.excluded
  const entryOf = (node) => (node.dir ? `${node.path}/` : node.path);

  // set: the entries of share.excluded as a Set
  function isExcluded(set, path) {
    if (set.has(path)) return true;
    for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) if (set.has(path.slice(0, i + 1))) return true;
    return false;
  }

  // ---- the tree ----

  const newDir = (name, parent) => ({
    dir: true,
    name,
    path: parent && parent.path ? `${parent.path}/${name}` : name,
    parent,
    kids: new Map(),
    sorted: null,
    count: 0,
    size: 0,
    wantedCount: 0,
    wantedSize: 0,
    done: 0,
    state: 'all',
  });

  function total(dir) {
    dir.count = 0;
    dir.size = 0;
    for (const kid of dir.kids.values()) {
      if (kid.dir) total(kid);
      dir.count += kid.dir ? kid.count : 1;
      dir.size += kid.size;
    }
  }

  // The tree of a list of { path, size, mtime } (see validEntries). Files whose names cannot be
  // written (see unsafePath) are not part of it: they come back in `bad`, with the reason.
  // extras: files that are only on this PC, shown apart under "Only on this PC", without a choice.
  // -> { root, bad: [{ path, why }], extras }
  function build(list, extras = []) {
    const root = newDir('', null);
    const bad = [];
    for (const f of list) {
      const why = unsafePath(f.path);
      if (why) {
        bad.push({ path: f.path, why });
        continue;
      }
      const parts = f.path.split('/');
      let dir = root;
      for (let i = 0; i < parts.length - 1 && dir; i++) {
        let next = dir.kids.get(parts[i]);
        if (!next) dir.kids.set(parts[i], (next = newDir(parts[i], dir)));
        // a file in the way of a folder of the same name
        dir = next.dir ? next : null;
      }
      const name = parts[parts.length - 1];
      if (!dir || dir.kids.has(name)) {
        bad.push({ path: f.path, why: 'its name clashes with another one in the list' });
        continue;
      }
      dir.kids.set(name, { dir: false, name, path: f.path, parent: dir, size: f.size, mtime: f.mtime, wanted: true, done: false });
    }
    total(root);
    let only = null;
    if (extras.length) {
      only = newDir('Only on this PC', null);
      only.extra = true;
      only.path = '\u0000only-here';
      for (const f of extras) only.kids.set(f.path, { dir: false, extra: true, name: f.path, path: `${only.path}/${f.path}`, parent: only, size: f.size, mtime: f.mtime, wanted: false, done: true });
      total(only);
    }
    return { root, bad, extras: only };
  }

  // Works out what the list of excluded paths makes of every node: wanted or not for a file, and for
  // a folder how much of it is wanted ("all", "none" or "mixed") and the count and size of that.
  function choose(dir, set, inherited = false) {
    const here = inherited || (dir.path !== '' && set.has(`${dir.path}/`));
    dir.wantedCount = 0;
    dir.wantedSize = 0;
    for (const kid of dir.kids.values()) {
      if (kid.dir) {
        choose(kid, set, here);
        dir.wantedCount += kid.wantedCount;
        dir.wantedSize += kid.wantedSize;
      } else {
        kid.wanted = !(here || set.has(kid.path));
        if (kid.wanted) {
          dir.wantedCount++;
          dir.wantedSize += kid.size;
        }
      }
    }
    dir.state = dir.wantedCount === 0 ? 'none' : dir.wantedCount === dir.count ? 'all' : 'mixed';
  }

  // Works out which files are on this disk already, for the "downloaded" marks: file.done, and
  // for a folder how many of its files are. local: Map of path -> { size, mtime }
  function markDone(dir, local) {
    dir.done = 0;
    for (const kid of dir.kids.values()) {
      if (kid.dir) {
        markDone(kid, local);
        dir.done += kid.done;
      } else {
        kid.done = upToDate(kid, local.get(kid.path));
        if (kid.done) dir.done++;
      }
    }
  }

  // The node at a path ("a/b" is a file, "a/b/" a folder, "" the root), or null.
  function find(root, key) {
    if (key === '') return root;
    const dir = key.endsWith('/');
    let node = root;
    for (const part of (dir ? key.slice(0, -1) : key).split('/')) {
      node = node.dir ? node.kids.get(part) : null;
      if (!node) return null;
    }
    return node.dir === dir ? node : null;
  }

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  // folders first, then by name, "file2" before "file10"
  function sortedKids(dir) {
    if (!dir.sorted) {
      dir.sorted = [...dir.kids.values()].sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
    }
    return dir.sorted;
  }

  // The rows the window shows: the root's entries, and below a folder that is open its own. At most
  // shown.get(folder path) entries of a folder are listed (PAGE until "Show more" was used); the
  // rest is one "more" row. open: Set of folder paths; shown: Map of folder path -> number.
  // -> [{ node, depth, index, of } | { more: dir, depth, hidden }]
  function rows(built, open, shown) {
    const out = [];
    const add = (dir, depth) => {
      const kids = sortedKids(dir);
      const upTo = Math.min(kids.length, shown.get(dir.path) || PAGE);
      for (let i = 0; i < upTo; i++) {
        out.push({ node: kids[i], depth, index: i, of: kids.length });
        if (kids[i].dir && open.has(kids[i].path)) add(kids[i], depth + 1);
      }
      if (kids.length > upTo) out.push({ more: dir, depth, hidden: kids.length - upTo });
    };
    add(built.root, 0);
    if (built.extras) {
      out.push({ node: built.extras, depth: 0, index: 0, of: 1 });
      if (open.has(built.extras.path)) add(built.extras, 1);
    }
    return out;
  }

  // the key of a row: what ties it to the same row after the list was drawn again
  const rowKey = (row) => (row.more ? `${row.more.path}/\u0000more` : entryOf(row.node));

  // ---- changing what is excluded ----

  // A folder or file (a node of the tree) is ticked or unticked. -> the new list of excluded paths,
  // or the same one when nothing changes.
  //   Unticking a file excludes it, unticking a folder excludes the folder as a whole.
  //   Ticking something inside a folder that is excluded as a whole takes that folder out of the
  //   list and puts everything else of it in, level by level, so that nothing but the ticked node
  //   changes: what was excluded stays excluded, and what is new in the other folders still is.
  function setWanted(list, node, on) {
    const set = new Set(list);
    // the folders above the node, from the top (the root has no entry)
    const above = [];
    for (let d = node.parent; d && d.parent; d = d.parent) above.unshift(d);
    const insideNode = () => {
      for (const e of set) if (e.startsWith(`${node.path}/`)) set.delete(e);
    };
    if (on) {
      const top = above.findIndex((d) => set.has(`${d.path}/`));
      for (let i = top === -1 ? above.length : top; i < above.length; i++) {
        const next = above[i + 1] || node;
        set.delete(`${above[i].path}/`);
        for (const kid of above[i].kids.values()) if (kid !== next) set.add(entryOf(kid));
      }
      if (node.dir) insideNode();
      else set.delete(node.path);
    } else {
      // already excluded by a folder above
      if (above.some((d) => set.has(`${d.path}/`))) return list;
      if (node.dir) {
        insideNode();
        set.add(`${node.path}/`);
      } else {
        set.add(node.path);
      }
    }
    return [...set];
  }

  // Whether an entry of the list names something that is in the tree.
  const exists = (root, entry) => !!find(root, entry);

  // Everything is wanted. Entries for things that are not in the tree (files the owner removed) stay.
  const selectAll = (list, root) => list.filter((e) => !exists(root, e));

  // Nothing is wanted, in as few entries as possible: one for each top-level folder and file.
  // Entries for things that are not in the tree stay, unless they are inside one of those folders.
  function selectNone(list, root) {
    const set = new Set();
    for (const e of list) {
      const first = root.kids.get(e.split('/')[0]);
      if (!exists(root, e) && !(first && first.dir)) set.add(e);
    }
    for (const kid of root.kids.values()) set.add(entryOf(kid));
    return [...set];
  }

  return { PAGE, PART_SUFFIX, unsafeName, unsafePath, validEntries, upToDate, entryOf, isExcluded, build, choose, markDone, find, sortedKids, rows, rowKey, setWanted, selectAll, selectNone };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = tree;
