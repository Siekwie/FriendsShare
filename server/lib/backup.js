// Snapshots of the database in DATA_DIR/backups. A snapshot is a complete SQLite file, so
// restoring one is copying it back over friendsshare.db while the server is stopped.
const fs = require('node:fs');
const path = require('node:path');

const NAME = /^friendsshare-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.db$/;

// Finished snapshots in dir, newest first.
function listBackups(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return []; // none written yet
  }
  const found = [];
  for (const file of names) {
    const m = NAME.exec(file);
    if (m) found.push({ file, takenAt: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) });
  }
  return found.sort((a, b) => b.takenAt - a.takenAt);
}

function backupDue(dir, intervalHours, nowMs) {
  if (!(intervalHours > 0)) return false;
  const newest = listBackups(dir)[0];
  return !newest || nowMs - newest.takenAt >= intervalHours * 3_600_000;
}

// Writes a consistent copy of the live database and deletes all but the newest `keep` snapshots.
function takeBackup(db, dir, keep, nowMs) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // a crash halfway leaves a partial file behind; it is never counted as a snapshot
  for (const name of fs.readdirSync(dir)) if (name.endsWith('.partial')) fs.rmSync(path.join(dir, name), { force: true });
  const stamp = new Date(nowMs).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const file = path.join(dir, `friendsshare-${stamp}.db`);
  db.run('VACUUM INTO ?', `${file}.partial`);
  fs.renameSync(`${file}.partial`, file);
  try {
    // it holds email addresses: readable by the server's user only
    fs.chmodSync(file, 0o600);
  } catch {}
  for (const old of listBackups(dir).slice(keep)) fs.rmSync(path.join(dir, old.file), { force: true });
  return file;
}

module.exports = { listBackups, backupDue, takeBackup };
