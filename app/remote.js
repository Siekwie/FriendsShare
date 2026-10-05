// A friend's copy of the owner's file list, kept apart from config.json: one file per folder,
// <dir>/<share id>.json, holding { at, files }. The list of a big folder is megabytes, and
// config.json is rewritten, synchronously, on every change, while the main process is also serving
// file chunks. Here a list is written when the owner's answer arrives, asynchronously and
// atomically (a temporary file, then a rename), and only read when the window shows that folder.
//
// Nothing here talks to Electron, so it is tested without a window (test/unit.js).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const tree = require('./tree');

function createRemoteStore(dir) {
  // Reads and writes of one folder's list wait for each other, so a read never meets a half-done
  // rename and the newest write is the one that stays.
  const chains = new Map();
  let counter = 0;

  const fileOf = (id) => path.join(dir, `${String(id).replace(/[^\w.-]/g, '_')}.json`);

  function queue(id, task) {
    const next = (chains.get(id) || Promise.resolve()).then(task, task);
    // an error belongs to whoever asked, not to the next one in the line
    const tail = next.catch(() => {});
    chains.set(id, tail);
    tail.then(() => chains.get(id) === tail && chains.delete(id));
    return next;
  }

  return {
    // -> { at, files } or null (nothing stored for this folder, or the file is damaged)
    read: (id) =>
      queue(id, async () => {
        try {
          const saved = JSON.parse(await fsp.readFile(fileOf(id), 'utf8'));
          return saved && Array.isArray(saved.files) ? { at: Number(saved.at) || 0, files: tree.validEntries(saved.files) } : null;
        } catch {
          return null;
        }
      }),

    // files: the owner's list. Whatever is not a path with a size and a time is not stored.
    write: (id, files) =>
      queue(id, async () => {
        const file = fileOf(id);
        const tmp = `${file}.${process.pid}-${counter++}.tmp`;
        await fsp.mkdir(dir, { recursive: true });
        try {
          await fsp.writeFile(tmp, JSON.stringify({ at: Date.now(), files: tree.validEntries(files) }));
          await fsp.rename(tmp, file);
        } catch (err) {
          await fsp.rm(tmp, { force: true }).catch(() => {});
          throw err;
        }
      }),

    // the folder was removed
    remove: (id) => queue(id, () => fsp.rm(fileOf(id), { force: true })),

    // Lists in the old place, share.remote in config.json, move into files of their own. Each one is
    // taken out of the share once its file is written, so nothing is lost when the app ends half way.
    // isLive(share): false for a share that was removed meanwhile, which gets no file.
    // -> true when a share was changed, which then needs saving
    async migrate(shares, isLive = () => true) {
      let changed = false;
      for (const share of [...shares]) {
        if (!('remote' in share) || !isLive(share)) continue;
        if (Array.isArray(share.remote)) {
          try {
            await this.write(share.id, share.remote);
          } catch {
            // the disk is full, say: the list stays where it is and is moved at the next start
            continue;
          }
        }
        delete share.remote;
        changed = true;
      }
      return changed;
    },

    // leftovers of a write that was cut short
    async tidy() {
      let names = [];
      try {
        names = await fsp.readdir(dir);
      } catch {}
      await Promise.all(names.filter((n) => n.endsWith('.tmp')).map((n) => fsp.rm(path.join(dir, n), { force: true }).catch(() => {})));
    },
  };
}

module.exports = { createRemoteStore };
