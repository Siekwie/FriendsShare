// What the two apps do when the other side is not what it should be, or is another version.
//   - a hostile owner puts names into its list that are trouble on Windows (CON, "name:stream", "..",
//     a drive letter ...): the friend writes none of them, skips them with a note, and the rest arrives
//   - a hostile friend asks for what it must not get (a file behind a junction, "..", a data stream,
//     a device name): the owner serves none of it, one file at a time, and goes on
//   - the disk of the friend is full: the sync ends with a plain message, and goes on later
//   - versions: a 1.2.0 friend with this owner, and this friend with a 1.2.0 owner, neither crashes or
//     hangs, in the good case and when a file cannot be read or the folder is gone
// The "hostile" apps are copies of this app with a few lines changed (t.patchedApp), each change
// checked to be there; the old one is the v1.2.0 tag (t.releaseApp).
//   node test/hostile.js
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const t = require('./lib');

const DAY = 86400000;
const ui = (app, expr) => app.eval(expr).catch((err) => `error: ${err.message}`);
const hostShare = (id, name, dir, code, extra = {}) => ({ id, role: 'host', name, dir, code, hostKey: crypto.randomUUID(), createdAt: Date.now(), expiresAt: Date.now() + DAY, ...extra });
const guestShare = (id, code, extra = {}) => ({ id, role: 'guest', name: 'Share', dir: null, code, chosen: true, createdAt: Date.now(), ...extra });
const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const registered = (server, rooms = 1) => t.waitFor(async () => (await server.stats()).hosted_rooms >= rooms, 30000, 'the owner to register its folder');
const startSync = (app, id = 'g1') => ui(app, `void syncShare('${id}', { download: true, manual: true }); 0`);
const syncEnded = (app, id = 'g1', ms = 90000) =>
  t.waitFor(async () => {
    const kind = await ui(app, `[...syncing].includes('${id}') ? 'busy' : (status.get('${id}') || {}).kind`);
    return ['ok', 'warn', 'error'].includes(kind) && kind;
  }, ms, 'the sync to end');
const statusText = (app) => ui(app, "document.querySelector('#status').textContent");
// the owner's app as it is, or with parts of it replaced
const swap = (from, to) => ['renderer/p2p.js', from, to];

(async () => {
  await t.scenario('A hostile owner cannot make a friend write names that are trouble on Windows', async (cleanup) => {
    const NAME = 'hostile-names';
    t.resetDir(path.join(t.tmpRoot, NAME));
    const hostDir = path.join(t.tmpRoot, NAME, 'hostfiles', 'Share');
    const data = { 'good.txt': 'a good file\n', 'dir/ok.txt': 'another good one\n' };
    t.writeFiles(hostDir, data);
    const hostile = [
      'CON.txt', 'sub/NUL', 'aux.c', 'LPT1', 'COM3.log', 'a:b.txt', 'stream.txt:hidden', 'trailing.', 'space ', '../escape.txt', 'sub/../../escape2.txt',
      '/abs.txt', 'C:/abs2.txt', 'back\\slash.txt', 'sub//double.txt', 'q?.txt', 'star*.txt', 'pipe|.txt', 'quote".txt', 'lt<.txt', 'gt>.txt', 'ctl\u0001.txt', 'x.fspart',
    ];
    // a list with the owner's real files and all of those, as an owner that is not our app could send it
    const owner = t.patchedApp(NAME, [
      swap('const p2p = (() => {', `const HOSTILE = ${JSON.stringify(hostile.map((path) => ({ path, size: 5, mtime: 1700000000000 })))};\nconst p2p = (() => {`),
      swap('const { files, missing } = await api.listFiles(share.id);', 'const { files: real, missing } = await api.listFiles(share.id);\n      const files = real.concat(HOSTILE);'),
    ]);
    const server = await t.startServer(NAME);
    cleanup(() => server.stop());
    const code = crypto.randomUUID();
    // the folder is called "CON", which Windows cannot have as the name of a folder either
    const host = await t.startApp({ name: NAME, who: 'host', signal: server.signalUrl, appDir: owner, seed: { shares: [hostShare('h1', 'CON', hostDir, code)] } });
    cleanup(() => host.quit());
    await host.ready();
    await registered(server);
    const guest = await t.startApp({ name: NAME, who: 'guest', signal: server.signalUrl, seed: { shares: [guestShare('g1', code)] } });
    cleanup(() => guest.quit());
    await guest.ready();
    await ui(guest, "select('g1'); 0");
    const kind = await syncEnded(guest, 'g1', 60000);
    const shares = path.join(guest.home, 'shares');
    t.check(fs.existsSync(shares) && sameSet(fs.readdirSync(shares), ['_CON']), `a folder called CON is stored as "_CON" (${fs.readdirSync(shares)})`);
    const dir = path.join(shares, '_CON');
    t.check(kind === 'warn' && sameSet(Object.keys(t.readTree(dir)), ['good.txt', 'dir/ok.txt']), `the real files arrived and nothing else was written (${Object.keys(t.readTree(dir))})`);
    t.check(guest.remote('g1').files.length === 2 + hostile.length, 'although the list had all of them, which is stored as it came');
    const text = await statusText(guest);
    t.check(new RegExp(`^Synced\\. 2 files downloaded, ${hostile.length} have names that Windows does not allow\\.$`).test(text), `the friend says so plainly ("${text}")`);
    // nothing was written anywhere else: not next to the folder, not in the profile, not on the drive
    t.check(sameSet(fs.readdirSync(shares), ['_CON']) && fs.readdirSync(guest.home).every((n) => ['userdata', 'shares', 'dialogs.json', 'dialogs.json.log'].includes(n)), 'nothing was written outside the folder: not next to it, not in the profile');
    t.check(!['C:/abs.txt', 'C:/abs2.txt', 'C:/escape.txt', 'C:/escape2.txt'].some((p) => fs.existsSync(p)), 'and not on the drive');
    t.check(!fs.readdirSync(dir).some((n) => n.includes('fspart')), 'and no part of a file that was not written');

    // the list says which they are, with the reason, behind a small Show
    const note = await ui(guest, "document.querySelector('#files-note').innerText");
    t.check(new RegExp(`^${hostile.length} files cannot be downloaded: their names are not allowed on Windows\\. They are skipped\\.`).test(note.trim()), `the list says so too ("${note.replace(/\s+/g, ' ').slice(0, 90)}")`);
    await ui(guest, "document.querySelector('#files-note button').click(); 0");
    const names = await ui(guest, "document.querySelector('#files-note ul').innerText");
    t.check(/CON\.txt\s+its name is reserved/.test(names) && /a:b\.txt\s+its name has a character/.test(names) && /\.\.\/escape\.txt\s+it uses/.test(names) && /trailing\.\s+its name ends with a dot/.test(names) && /abs\.txt\s+it is an absolute path/.test(names), 'with the reason for each');
    const rowKeys = await ui(guest, "[...document.querySelectorAll('#files .node')].map((r) => r.dataset.key)");
    t.check(sameSet(rowKeys, ['dir/', 'good.txt']) && /^Files \(2 of 2 selected/.test(await ui(guest, "document.querySelector('#files-title').textContent")), 'and the tree has only the files that can be downloaded');

    // the main process refuses them on its own, whatever the window asks
    const refused = await ui(guest, `Promise.all(${JSON.stringify(hostile)}.map((name) => api.openWrite('g1', name, 5, 1700000000000).then((f) => { api.close(f.h); return 'opened'; }, (e) => e.message.replace(/^Error invoking remote method '[^']*': Error: /, '')))).then((r) => JSON.stringify(r))`);
    const refusals = JSON.parse(refused);
    t.check(refusals.length === hostile.length && refusals.every((m) => /^\[name\] Not written: /.test(m)), `the main process refuses to open every one of them for writing, with the reason (${[...new Set(refusals.map((m) => m.slice(0, 20)))]})`);
    t.check((await ui(guest, "api.openWrite('g1', 'fine/new.txt', 5, 1700000000000).then((f) => api.close(f.h, true).then(() => 'opened'), (e) => e.message)")) === 'opened' && !fs.existsSync(path.join(dir, 'fine', 'new.txt')), 'while a fine name opens (and leaves no empty part when it is given up)');
    t.check(sameSet(fs.readdirSync(shares), ['_CON']) && !fs.existsSync(path.join(shares, 'escape.txt')) && guest.dialogs.length === 0, 'still nothing outside the folder, and no dialog was opened');
  });

  await t.scenario('A hostile friend cannot get a file outside the folder, and the owner goes on serving', async (cleanup) => {
    const NAME = 'hostile-friend';
    t.resetRights(path.join(t.tmpRoot, NAME));
    t.resetDir(path.join(t.tmpRoot, NAME));
    const hostDir = path.join(t.tmpRoot, NAME, 'hostfiles', 'Share');
    const outside = path.join(t.tmpRoot, NAME, 'outside');
    const data = { 'Sub/inside.txt': 'inside\n', 'a.txt': 'aaa\n', 'locked.bin': crypto.randomBytes(3000) };
    t.writeFiles(hostDir, data);
    t.writeFiles(outside, { 'secret.txt': 'THE SECRET OUTSIDE THE FOLDER\n' });
    t.junction(path.join(hostDir, 'Link'), outside);
    cleanup(() => fs.rmSync(path.join(hostDir, 'Link'), { force: true }));
    t.denyRead(path.join(hostDir, 'locked.bin'));
    cleanup(() => t.allowRead(path.join(hostDir, 'locked.bin')));
    const attacks = ['Link/secret.txt', '../outside/secret.txt', 'Sub/../../outside/secret.txt', 'a.txt:stream', 'NUL', 'Sub/aux.txt', 'C:/Windows/win.ini', '/outside/secret.txt', 'locked.bin', 'nothing.txt', 'Sub/inside.txt'];
    // a friend that skips the checks of this app, and after its sync asks for these, one by one, and counts what comes back
    const friend = t.patchedApp(NAME, [
      swap('const p2p = (() => {', `const ATTACKS = ${JSON.stringify(attacks)};\nconst p2p = (() => {`),
      swap('async function guestChunk(peer, data) {', 'async function guestChunk(peer, data) {\n    window.__bytes = (window.__bytes || 0) + data.byteLength;'),
      swap("      await api.updateShare(share.id, { lastSync: Date.now() });",
        `      window.__bytes = 0;
      window.__attacks = [];
      for (const attack of ATTACKS) {
        try {
          await request(peer, { t: 'get', path: attack, offset: 0 });
          window.__attacks.push([attack, 'served']);
        } catch (err) {
          window.__attacks.push([attack, err.code + '/' + (err.skip || '')]);
          if (!err.skip) break;
        }
      }
      await api.updateShare(share.id, { lastSync: Date.now() });`),
    ]);
    const server = await t.startServer(NAME);
    cleanup(() => server.stop());
    const code = crypto.randomUUID();
    const host = await t.startApp({ name: NAME, who: 'host', signal: server.signalUrl, seed: { shares: [hostShare('h1', 'Share', hostDir, code)] } });
    cleanup(() => host.quit());
    await host.ready();
    await registered(server);
    const guest = await t.startApp({ name: NAME, who: 'guest', signal: server.signalUrl, appDir: friend, seed: { shares: [guestShare('g1', code)] } });
    cleanup(() => guest.quit());
    await guest.ready();
    await ui(guest, "select('g1'); 0");
    const kind = await syncEnded(guest, 'g1', 60000);
    const results = JSON.parse(await ui(guest, 'JSON.stringify(window.__attacks)'));
    t.check(results.length === attacks.length, `the owner answered every one of the ${attacks.length} requests, so it went on after each refusal (${results.length} answers)`);
    const byPath = Object.fromEntries(results);
    const refusedAll = attacks.slice(0, -1).every((a) => byPath[a] === 'read/read');
    t.check(refusedAll, `a file behind the junction, "..", a data stream, a device name, absolute paths, a file that cannot be opened and one that is not there: each is refused as a problem with that file only (${results.slice(0, -1).map(([a, r]) => `${a} -> ${r}`).join('; ')})`);
    t.check(byPath['Sub/inside.txt'] === 'served' && (await ui(guest, 'window.__bytes')) === 7, 'and the one real file in the list, asked for last, is served: 7 bytes came back in all, so nothing of the others did');
    t.check(kind === 'warn' && sameSet(Object.keys(t.readTree(path.join(guest.home, 'shares', 'Share'))), ['Sub/inside.txt', 'a.txt']), "the friend's own sync went as it should (the file that cannot be read was skipped)");
    t.check(!JSON.stringify(t.readTree(path.join(guest.home, 'shares'))).includes(t.sha('THE SECRET OUTSIDE THE FOLDER\n')), 'the secret is nowhere in what the friend has');
    // the owner is still all right: an honest friend gets everything that can be read
    const honest = await t.startApp({ name: NAME, who: 'honest', signal: server.signalUrl, seed: { shares: [guestShare('g1', code)] } });
    cleanup(() => honest.quit());
    await honest.ready();
    await ui(honest, "select('g1'); 0");
    await syncEnded(honest, 'g1', 60000);
    t.check(sameSet(Object.keys(t.readTree(path.join(honest.home, 'shares', 'Share'))), ['Sub/inside.txt', 'a.txt']), 'and another friend gets everything that can be read');
  });

  await t.scenario('A full disk ends the sync with a plain message, and the next sync goes on', async (cleanup) => {
    const NAME = 'hostile-disk';
    t.resetDir(path.join(t.tmpRoot, NAME));
    const hostDir = path.join(t.tmpRoot, NAME, 'hostfiles', 'Share');
    const data = {};
    for (let i = 1; i <= 4; i++) data[`a${i}.bin`] = crypto.randomBytes(200000);
    t.writeFiles(hostDir, data);
    const server = await t.startServer(NAME);
    cleanup(() => server.stop());
    const code = crypto.randomUUID();
    const host = await t.startApp({ name: NAME, who: 'host', signal: server.signalUrl, seed: { shares: [hostShare('h1', 'Share', hostDir, code)] } });
    cleanup(() => host.quit());
    await host.ready();
    await registered(server);
    // the disk of the friend has room for 250,000 bytes of downloads, and then it is full, for as long as the flag file is there
    const flag = path.join(t.tmpRoot, NAME, 'disk-full.flag');
    fs.writeFileSync(flag, '');
    const guard = path.join(__dirname, 'guard.js').replace(/\\/g, '/');
    const faults = path.join(__dirname, 'faults.js').replace(/\\/g, '/');
    const guest = await t.startApp({
      name: NAME,
      who: 'guest',
      signal: server.signalUrl,
      env: { NODE_OPTIONS: `--require=${guard} --require=${faults}`, FS_FAULT_FILE: flag, FS_FAULT_AFTER: '250000' },
      seed: { shares: [guestShare('g1', code)] },
    });
    cleanup(() => guest.quit());
    await guest.ready();
    await ui(guest, "select('g1'); 0");
    const kind = await syncEnded(guest, 'g1', 60000);
    const dir = path.join(guest.home, 'shares', 'Share');
    const text = await statusText(guest);
    t.check(kind === 'error' && text === 'Not enough space on this disk.', `the sync ends with "Not enough space on this disk", not with a generic error (kind ${kind}, "${text}")`);
    const got = t.readTree(dir);
    t.check(got['a1.bin'] === t.sha(data['a1.bin']) && !got['a3.bin'] && !got['a4.bin'], `what was complete is there, byte for byte, and the sync did not go on to the next files (${Object.keys(got)})`);
    t.check((await ui(guest, '[...syncing].length')) === 0 && (await ui(guest, 'p2p.isOnline()')) === true && !/\[guard\]/.test(guest.output().replace('[guard] active', '')) && guest.dialogs.length === 0, 'the app is fine: nothing is left syncing, it is still online, nothing was thrown');
    // room again
    fs.rmSync(flag);
    await startSync(guest);
    t.check((await syncEnded(guest)) === 'ok', 'when there is room again, the next sync works');
    const all = t.readTree(dir);
    t.check(Object.keys(data).every((n) => all[n] === t.sha(data[n])) && !Object.keys(all).some((n) => n.endsWith('.fspart')), 'and the folder is complete, byte for byte, with no part left behind');
  });

  await t.scenario('Versions: a 1.2.0 friend with this owner, and this friend with a 1.2.0 owner', async (cleanup) => {
    const NAME = 'hostile-compat';
    t.resetRights(path.join(t.tmpRoot, NAME));
    t.resetDir(path.join(t.tmpRoot, NAME));
    const old = t.releaseApp('v1.2.0', NAME);
    // (a 1.2.0 friend leaves the empty part of the file it gave up on: that is no file)
    const have = (dir) => Object.keys(t.readTree(dir)).filter((n) => !n.endsWith('.fspart'));
    const oldVersion = JSON.parse(fs.readFileSync(path.join(old, 'package.json'), 'utf8')).version;
    t.check(oldVersion === '1.2.0', 'the old app is the v1.2.0 release');
    const data = { 'a.txt': 'first\n', 'b-locked.bin': crypto.randomBytes(30000), 'c.txt': 'third\n', 'sub/d.txt': 'fourth\n' };
    const server = await t.startServer(NAME);
    cleanup(() => server.stop());

    // ---- this owner, an old friend ----
    const hostDir = path.join(t.tmpRoot, NAME, 'hostfiles', 'New');
    const moved = path.join(t.tmpRoot, NAME, 'hostfiles', 'New-moved');
    t.writeFiles(hostDir, data);
    const locked = path.join(hostDir, 'b-locked.bin');
    t.denyRead(locked);
    cleanup(() => t.allowRead(locked));
    cleanup(() => fs.existsSync(moved) && fs.renameSync(moved, hostDir));
    const code1 = crypto.randomUUID();
    const newOwner = await t.startApp({ name: NAME, who: 'new-owner', signal: server.signalUrl, seed: { shares: [hostShare('h1', 'New', hostDir, code1)] } });
    cleanup(() => newOwner.quit());
    await newOwner.ready();
    await registered(server);
    const oldFriend = await t.startApp({ name: NAME, who: 'old-friend', signal: server.signalUrl, appDir: old, seed: { shares: [guestShare('g1', code1)] } });
    cleanup(() => oldFriend.quit());
    await oldFriend.ready();
    await ui(oldFriend, "select('g1'); 0");
    const kind1 = await syncEnded(oldFriend, 'g1', 60000);
    const dir1 = path.join(oldFriend.home, 'shares', 'New');
    t.check(kind1 === 'error' && (await statusText(oldFriend)) === "Your friend's app could not read a file.", `a 1.2.0 friend takes the owner's answer for a file that cannot be read as the end of its sync, as it always did ("${await statusText(oldFriend)}")`);
    t.check(sameSet(have(dir1), ['a.txt']), 'it got what comes before that file');
    t.check((await ui(oldFriend, '[...syncing].length')) === 0 && (await ui(oldFriend, 'p2p.isOnline()')) === true, 'and does not hang');
    t.allowRead(locked);
    await startSync(oldFriend);
    t.check((await syncEnded(oldFriend)) === 'ok' && sameSet(have(dir1), Object.keys(data)), 'when the file can be read again it syncs everything');
    // the folder gone: the 1.2.0 friend shows the owner's sentence instead of an empty list
    fs.renameSync(hostDir, moved);
    await ui(newOwner, "api.listFiles('h1', { fresh: true }).then(() => 0)");
    await startSync(oldFriend);
    t.check((await syncEnded(oldFriend)) === 'error' && (await statusText(oldFriend)) === "Your friend's folder is not available right now.", `a folder that is gone is ("${await statusText(oldFriend)}") for a 1.2.0 friend, and not an empty folder`);
    t.check(have(dir1).length === 4 && oldFriend.dialogs.length === 0, 'and it keeps what it has');
    fs.renameSync(moved, hostDir);
    // a friend of this version gets everything from the same owner
    const newFriend = await t.startApp({ name: NAME, who: 'new-friend', signal: server.signalUrl, seed: { shares: [guestShare('g1', code1)] } });
    cleanup(() => newFriend.quit());
    await newFriend.ready();
    await ui(newOwner, "api.listFiles('h1', { fresh: true }).then(() => 0)");
    await ui(newFriend, "select('g1'); 0");
    t.check((await syncEnded(newFriend, 'g1', 60000)) === 'ok' && sameSet(have(path.join(newFriend.home, 'shares', 'New')), Object.keys(data)), 'while this owner is still serving a friend of this version in full');

    // ---- an old owner, this friend ----
    const oldDir = path.join(t.tmpRoot, NAME, 'hostfiles', 'Old');
    t.writeFiles(oldDir, data);
    const oldLocked = path.join(oldDir, 'b-locked.bin');
    t.denyRead(oldLocked);
    cleanup(() => t.allowRead(oldLocked));
    const code2 = crypto.randomUUID();
    const oldOwner = await t.startApp({ name: NAME, who: 'old-owner', signal: server.signalUrl, appDir: old, seed: { shares: [hostShare('h2', 'Old', oldDir, code2)] } });
    cleanup(() => oldOwner.quit());
    await oldOwner.ready();
    await registered(server, 2);
    const id2 = await ui(newFriend, `api.joinShare('${code2}').then((s) => reload().then(() => s.id))`);
    // as in the window: the first sync after adding a code only fetches the list, and then the friend downloads
    await ui(newFriend, `select('${id2}'); void syncShare('${id2}'); 0`);
    t.check((await syncEnded(newFriend, id2, 60000)) === 'ok' && /Choose what to download/.test(await statusText(newFriend)) && newFriend.remote(id2).files.length === Object.keys(data).length, 'a friend of this version gets the list from a 1.2.0 owner');
    await ui(newFriend, `void syncShare('${id2}', { download: true, manual: true }); 0`);
    const kind2 = await syncEnded(newFriend, id2, 60000);
    const dir2 = path.join(newFriend.home, 'shares', 'Old');
    t.check(kind2 === 'error' && (await statusText(newFriend)) === "Your friend's app could not read a file.", `a friend of this version takes the answer of a 1.2.0 owner, which has no path in it, as the end of the sync ("${await statusText(newFriend)}")`);
    t.check(sameSet(have(dir2), ['a.txt']) && (await ui(newFriend, '[...syncing].length')) === 0 && (await ui(newFriend, 'p2p.isOnline()')) === true, `it has what came before that file, and does not hang (has ${JSON.stringify(have(dir2))}, ${await ui(newFriend, '[...syncing].length')} syncing, online ${await ui(newFriend, 'p2p.isOnline()')})`);
    t.allowRead(oldLocked);
    await ui(newFriend, `void syncShare('${id2}', { download: true, manual: true }); 0`);
    const second = await syncEnded(newFriend, id2);
    t.check(second === 'ok' && sameSet(have(dir2), Object.keys(data)) && Object.entries(data).every(([n, d]) => t.readTree(dir2)[n] === t.sha(d)), `and when the file can be read again, it syncs everything from the old owner, byte for byte (${second}, "${await statusText(newFriend)}", has ${JSON.stringify(have(dir2))})`);
    t.check(newFriend.dialogs.length === 0 && oldOwner.dialogs.length === 0, 'and no dialog was opened by any of them');
  });

  t.finish();
})();
