// The file side of the app with real transfers: a local matchmaking server and hidden app instances
// with their own profiles, one sharing a folder in place and one or two downloading it.
//   - a folder that is excluded as a whole is not downloaded, ticking one file in it later downloads
//     just that file, and the list of files is a tree with three-state checkboxes you can drive
//     with the keyboard
//   - a file the owner's PC cannot read is skipped, and everything else arrives; a junction inside
//     the shared folder does not lead out of it
//   - a folder that is gone is not an empty folder, for the owner and for the friend
//   - the owner's status line counts what all friends got, and a code that runs out says so by itself
//   - the friend's copy of the owner's file list lives in a file of its own, and old configs move there
//   node test/files.js
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

// A sync is started from the window and ends when the window says so: 'ok', 'warn' (some files were
// left out) or 'error'.
const startSync = (app, id = 'g1') => ui(app, `void syncShare('${id}', { download: true, manual: true }); 0`);
const syncEnded = (app, id = 'g1', ms = 90000) =>
  t.waitFor(async () => {
    const kind = await ui(app, `[...syncing].includes('${id}') ? 'busy' : (status.get('${id}') || {}).kind`);
    return ['ok', 'warn', 'error'].includes(kind) && kind;
  }, ms, 'the sync to end');
const statusText = (app) => ui(app, "document.querySelector('#status').textContent");
// the rows of the file list as the window shows them
const rows = (app) =>
  ui(app, "[...document.querySelectorAll('#files .node')].map((r) => ({ key: r.dataset.key, level: r.getAttribute('aria-level'), checked: r.getAttribute('aria-checked'), expanded: r.getAttribute('aria-expanded'), tab: r.getAttribute('tabindex'), text: r.innerText.replace(/\\s+/g, ' ').trim() }))");
const row = async (app, key) => (await rows(app)).find((r) => r.key === key);
// A click on a row, and on the checkbox of a row: a file is ticked by a click anywhere on its row,
// a folder only by its checkbox (a click on the rest of a folder opens or closes it).
const click = (app, key) => ui(app, `document.querySelector('#files [data-key=${JSON.stringify(key)}]').click(); 0`);
const tick = (app, key) => ui(app, `document.querySelector('#files [data-key=${JSON.stringify(key)}] .check').click(); 0`);
// a key pressed on a row of the list: the row gets the focus first, as it would by Tab or a click
const press = (app, key, on) =>
  ui(app, `(() => { const r = document.querySelector('#files [data-key=${JSON.stringify(on)}]'); r.focus(); r.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true })); return document.activeElement.dataset.key; })()`);

(async () => {
  await t.scenario('A folder excluded as a whole stays out, a file ticked inside it comes later, and the list is a tree', async (cleanup) => {
    const NAME = 'files-tree';
    t.resetDir(path.join(t.tmpRoot, NAME));
    const hostDir = path.join(t.tmpRoot, NAME, 'hostfiles', 'Project');
    const data = {
      'keep.txt': 'keep me\n',
      'Docs/guide.md': 'the guide\n',
      'Docs/skip-this.md': 'an old config lists single files: this is one\n',
      'Photos/a.jpg': crypto.randomBytes(5000),
      'Photos/b.jpg': crypto.randomBytes(6000),
      'Photos/c.jpg': crypto.randomBytes(7000),
      'Photos/sub/d.jpg': crypto.randomBytes(8000),
      'Music/x.mp3': crypto.randomBytes(9000),
    };
    t.writeFiles(hostDir, data);
    const server = await t.startServer(NAME);
    cleanup(() => server.stop());
    const code = crypto.randomUUID();
    const host = await t.startApp({ name: NAME, who: 'host', signal: server.signalUrl, seed: { shares: [hostShare('h1', 'Project', hostDir, code)] } });
    cleanup(() => host.quit());
    await host.ready();
    await registered(server);
    // the friend excludes a folder, a file inside another one, and a whole folder with one file
    const guest = await t.startApp({ name: NAME, who: 'guest', signal: server.signalUrl, seed: { shares: [guestShare('g1', code, { excluded: ['Photos/', 'Docs/skip-this.md', 'Music/x.mp3'] })] } });
    cleanup(() => guest.quit());
    await guest.ready();
    await ui(guest, "select('g1'); 0");
    t.check((await syncEnded(guest, 'g1', 60000)) === 'ok', 'the first sync ends well');
    const dir = path.join(guest.home, 'shares', 'Project');
    t.check(sameSet(Object.keys(t.readTree(dir)), ['keep.txt', 'Docs/guide.md']), `the folder that was excluded as a whole, and the plain file path of an old config, were not downloaded (${Object.keys(t.readTree(dir))})`);
    t.check(!fs.existsSync(path.join(dir, 'Photos')) && !fs.existsSync(path.join(dir, 'Music')), 'and not even created');

    // the list of the owner is a file of its own, and nothing about it is in config.json
    const stored = guest.remote('g1');
    const config = guest.config();
    t.check(!!stored && stored.files.length === 8 && config.shares[0].remote === undefined && JSON.stringify(config).length < 2000, 'the list of the owner\'s files is in a file of its own in the profile, not in config.json');
    t.check((await ui(guest, "api.getState().then((s) => s.shares.some((x) => 'remote' in x))")) === false, 'and the window is not sent the list of every folder with state:get');
    t.check((await ui(guest, "api.getRemote('g1').then((r) => r.files.length)")) === 8, 'it gets it for the folder it shows, in a call of its own');

    // ---- the tree ----
    await t.waitFor(async () => (await rows(guest)).length >= 4, 10000, 'the tree');
    const top = await rows(guest);
    t.check(sameSet(top.map((r) => r.key), ['Docs/', 'Music/', 'Photos/', 'keep.txt']) && top.every((r) => r.level === '1'), 'the top level is shown, with the folders closed');
    t.check(top[0].expanded === 'false' && top[3].expanded === null && /^Docs .*2 files/.test(top[0].text), `a folder says how many files it holds, and is open or closed; a file is neither ("${top[0].text}")`);
    t.check(/^Docs 1 of 2 downloaded 2 files/.test(top[0].text), `and how much of it is downloaded ("${top[0].text}")`);
    t.check(top.find((r) => r.key === 'Docs/').checked === 'mixed' && top.find((r) => r.key === 'Photos/').checked === 'false' && top.find((r) => r.key === 'Music/').checked === 'false' && top.find((r) => r.key === 'keep.txt').checked === 'true', 'checkboxes have three states: a folder is ticked, unticked or mixed, a file ticked or not');
    const boxes = await ui(guest, "(() => { const c = (k) => document.querySelector('#files [data-key=\"' + k + '\"] input[type=checkbox]'); return { docs: [c('Docs/').checked, c('Docs/').indeterminate], photos: [c('Photos/').checked, c('Photos/').indeterminate], keep: [c('keep.txt').checked, c('keep.txt').indeterminate] }; })()");
    t.check(JSON.stringify(boxes) === '{"docs":[false,true],"photos":[false,false],"keep":[true,false]}', `the boxes are real checkboxes: ticked, empty, or the usual "mixed" (${JSON.stringify(boxes)})`);
    t.check(/^Files \(2 of 8 selected, \d+(\.\d)? [KM]?B\)$/.test(await ui(guest, "document.querySelector('#files-title').textContent")), 'the title says how many files are selected and how big they are');
    t.check((await row(guest, 'keep.txt')).text.includes('downloaded'), 'a downloaded file says so');

    // the other mixes of keys: Tab reaches the list once (one row has the tabindex), arrows move, Enter opens
    t.check(top.filter((r) => r.tab === '0').length === 1 && top.filter((r) => r.tab === '-1').length === top.length - 1, 'one row of the list is reached with Tab, the arrow keys go from there');
    t.check((await ui(guest, "(() => { const r = document.querySelector('#files .node[tabindex=\"0\"]'); r.focus(); return document.activeElement === r; })()")) === true, 'and it takes the focus');
    t.check((await press(guest, 'Enter', 'Photos/')) === 'Photos/' && (await row(guest, 'Photos/')).expanded === 'true' && !!(await row(guest, 'Photos/a.jpg')), 'Enter opens a folder, which then draws its entries');
    t.check((await press(guest, 'ArrowDown', 'Photos/')) === 'Photos/sub/' && (await press(guest, 'ArrowDown', 'Photos/sub/')) === 'Photos/a.jpg' && (await press(guest, 'ArrowUp', 'Photos/a.jpg')) === 'Photos/sub/', 'the arrow keys go from row to row');
    t.check((await press(guest, 'ArrowRight', 'Photos/sub/')) === 'Photos/sub/' && (await row(guest, 'Photos/sub/')).expanded === 'true' && (await press(guest, 'ArrowRight', 'Photos/sub/')) === 'Photos/sub/d.jpg', 'Right opens a folder and then goes into it');
    t.check((await press(guest, 'ArrowLeft', 'Photos/sub/d.jpg')) === 'Photos/sub/' && (await press(guest, 'ArrowLeft', 'Photos/sub/')) === 'Photos/sub/' && (await row(guest, 'Photos/sub/')).expanded === 'false' && (await press(guest, 'ArrowLeft', 'Photos/sub/')) === 'Photos/', 'Left goes to the folder, closes it, and then goes up');
    t.check((await press(guest, 'ArrowLeft', 'Photos/')) === 'Photos/' && (await row(guest, 'Photos/')).expanded === 'false', 'Left closes a folder');
    t.check((await press(guest, 'ArrowRight', 'Photos/')) === 'Photos/' && (await row(guest, 'Photos/')).expanded === 'true', 'and Right opens it');
    // the window is drawn again now and then (after every sync): somebody on the keyboard keeps their place
    await ui(guest, "document.querySelector('#files [data-key=\"Photos/a.jpg\"]').focus(); reload().then(() => 0)");
    await t.waitFor(async () => (await ui(guest, 'document.activeElement && document.activeElement.dataset.key')) === 'Photos/a.jpg', 5000, 'the focus to be back on its row').catch(() => {});
    t.check((await ui(guest, 'document.activeElement.dataset.key')) === 'Photos/a.jpg' && (await row(guest, 'Photos/')).expanded === 'true', 'when the window is drawn again, the focus is on the same row and the folders are open as they were');

    // Space ticks: a file, and back
    await press(guest, ' ', 'keep.txt');
    t.check(sameSet(guest.config().shares[0].excluded, ['Photos/', 'Docs/skip-this.md', 'Music/x.mp3', 'keep.txt']) && (await row(guest, 'keep.txt')).checked === 'false', 'Space unticks a file, and only the list of excluded paths is written');
    await press(guest, ' ', 'keep.txt');
    t.check(sameSet(guest.config().shares[0].excluded, ['Photos/', 'Docs/skip-this.md', 'Music/x.mp3']), 'and ticks it again');
    const before = fs.statSync(path.join(guest.userdata, 'remote', 'g1.json')).mtimeMs;
    // a folder is ticked as a whole and then unticked as a whole
    await tick(guest, 'Music/');
    t.check(sameSet(guest.config().shares[0].excluded, ['Photos/', 'Docs/skip-this.md']) && (await row(guest, 'Music/')).checked === 'true', 'ticking a folder ticks everything inside it');
    await tick(guest, 'Docs/');
    t.check(sameSet(guest.config().shares[0].excluded, ['Photos/']) && (await row(guest, 'Docs/')).checked === 'true', 'also a folder that was mixed');
    await tick(guest, 'Docs/');
    t.check(sameSet(guest.config().shares[0].excluded, ['Photos/', 'Docs/']) && (await row(guest, 'Docs/')).checked === 'false', 'unticking a folder excludes it as a whole, with one entry');
    // Docs/ and Photos/ are unticked: Select all / none
    await ui(guest, "document.querySelector('#btn-selectall').click(); 0");
    t.check(guest.config().shares[0].excluded.length === 0 && /^Files \(8 of 8 selected/.test(await ui(guest, "document.querySelector('#files-title').textContent")), 'Select all ticks everything');
    await ui(guest, "document.querySelector('#btn-selectall').click(); 0");
    t.check(sameSet(guest.config().shares[0].excluded, ['Docs/', 'Music/', 'Photos/', 'keep.txt']) && /^Files \(0 of 8 selected, 0 B\)$/.test(await ui(guest, "document.querySelector('#files-title').textContent")), 'and Select none is one entry for each top-level folder and file');
    t.check(fs.statSync(path.join(guest.userdata, 'remote', 'g1.json')).mtimeMs === before, 'none of these ticks wrote the list of the owner\'s files again');
    await ui(guest, "document.querySelector('#btn-selectall').click(); 0");

    // ---- ticking one file inside an excluded folder, later ----
    await ui(guest, "api.updateShare('g1', { excluded: ['Photos/', 'Docs/skip-this.md', 'Music/x.mp3'] }).then(() => reload())");
    await t.waitFor(async () => (await row(guest, 'Photos/')) && (await row(guest, 'Photos/')).checked === 'false', 10000, 'the tree again');
    await t.waitFor(async () => !!(await row(guest, 'Photos/b.jpg')), 10000, 'the folder to be open');
    await tick(guest, 'Photos/b.jpg');
    const punched = ['Docs/skip-this.md', 'Music/x.mp3', 'Photos/a.jpg', 'Photos/c.jpg', 'Photos/sub/'];
    t.check(sameSet(guest.config().shares[0].excluded, punched), `ticking one file inside an excluded folder replaces the folder by entries for its other children (${JSON.stringify(guest.config().shares[0].excluded)})`);
    t.check((await row(guest, 'Photos/')).checked === 'mixed' && (await row(guest, 'Photos/b.jpg')).checked === 'true' && (await row(guest, 'Photos/a.jpg')).checked === 'false', 'and the folder is mixed');
    // news in the owner's folder: a file in the folder that is no longer excluded as a whole, and one in a folder that still is
    t.writeFiles(hostDir, { 'Photos/new.jpg': crypto.randomBytes(1500), 'Photos/sub/e.jpg': crypto.randomBytes(1600) });
    await ui(host, "api.listFiles('h1', { fresh: true }).then(() => 0)");
    await startSync(guest);
    t.check((await syncEnded(guest)) === 'ok', 'the next sync ends well');
    const got = t.readTree(dir);
    t.check(sameSet(Object.keys(got), ['keep.txt', 'Docs/guide.md', 'Photos/b.jpg', 'Photos/new.jpg']), `it downloaded just that file, and the new file in the same folder, and none of the others (${Object.keys(got)})`);
    t.check(got['Photos/b.jpg'] === t.sha(data['Photos/b.jpg']), 'byte for byte');
    t.check(!Object.keys(got).some((p) => p.endsWith('.fspart')), 'without leaving a part behind');
    await t.waitFor(async () => (await row(guest, 'Photos/')) && /2 of 6 downloaded/.test((await row(guest, 'Photos/')).text), 10000, 'the folder to say how much of it is downloaded');
    t.check(/2 of 6 downloaded/.test((await row(guest, 'Photos/')).text) && (await row(guest, 'Photos/b.jpg')).text.includes('downloaded'), 'and the marks follow: "2 of 6 downloaded" for the folder, "downloaded" for the file');

    // coming back to the window does not read the folder again every time
    await ui(guest, 'window.__reads = 0; refreshFiles = ((original) => (...args) => { window.__reads++; return original(...args); })(refreshFiles); 0');
    for (let i = 0; i < 4; i++) await ui(guest, "window.dispatchEvent(new Event('focus')); 0");
    t.check((await ui(guest, 'window.__reads')) === 0, 'coming back to the window several times in a row does not read the folder again');
    await ui(guest, "listedAt = Date.now() - FOCUS_REFRESH_AFTER - 1000; window.dispatchEvent(new Event('focus')); 0");
    t.check((await ui(guest, 'window.__reads')) === 1, 'it does after a while, once');
    t.check(guest.dialogs.length === 0 && host.dialogs.length === 0, 'no dialog was opened');
  });

  await t.scenario('A file that cannot be read is skipped and the rest arrives; a junction does not lead out of the folder', async (cleanup) => {
    const NAME = 'files-locked';
    t.resetRights(path.join(t.tmpRoot, NAME));
    t.resetDir(path.join(t.tmpRoot, NAME));
    const hostDir = path.join(t.tmpRoot, NAME, 'hostfiles', 'Share');
    const outside = path.join(t.tmpRoot, NAME, 'outside');
    const data = { 'Sub/inside.txt': 'inside\n', 'a.txt': 'aaa\n', 'locked.bin': crypto.randomBytes(20000), 'z-last.txt': 'after the locked one in the list\n' };
    t.writeFiles(hostDir, data);
    t.writeFiles(outside, { 'secret.txt': 'THE SECRET OUTSIDE THE FOLDER\n' });
    t.junction(path.join(hostDir, 'Link'), outside);
    cleanup(() => fs.rmSync(path.join(hostDir, 'Link'), { force: true }));
    const locked = path.join(hostDir, 'locked.bin');
    t.denyRead(locked);
    cleanup(() => t.allowRead(locked));

    const server = await t.startServer(NAME);
    cleanup(() => server.stop());
    const code = crypto.randomUUID();
    const host = await t.startApp({ name: NAME, who: 'host', signal: server.signalUrl, seed: { shares: [hostShare('h1', 'Share', hostDir, code)] } });
    cleanup(() => host.quit());
    await host.ready();
    await registered(server);
    const guest = await t.startApp({ name: NAME, who: 'guest', signal: server.signalUrl, seed: { shares: [guestShare('g1', code)] } });
    cleanup(() => guest.quit());
    await guest.ready();
    await ui(guest, "select('g1'); 0");
    const kind = await syncEnded(guest, 'g1', 60000);
    const dir = path.join(guest.home, 'shares', 'Share');
    const got = t.readTree(dir);
    t.check(kind === 'warn' && sameSet(Object.keys(got), ['Sub/inside.txt', 'a.txt', 'z-last.txt']), `the sync did not stop at the file that cannot be read: everything else arrived, also what comes after it (${Object.keys(got)})`);
    t.check(got['z-last.txt'] === t.sha(data['z-last.txt']) && got['a.txt'] === t.sha(data['a.txt']), 'byte for byte');
    t.check((await statusText(guest)) === "Synced. 3 files downloaded, 1 could not be read on your friend's PC.", `it says so plainly ("${await statusText(guest)}")`);
    t.check((await ui(guest, "document.querySelector('#status').className")) === 'status warn', 'in the colour of a warning, not an error');
    t.check(guest.config().shares[0].lastSync > 0, 'and counts as a sync that took place');
    t.check((await ui(guest, "document.querySelectorAll('#skipped ul').length")) === 0 && /Show/.test(await ui(guest, "document.querySelector('#skipped button').textContent")), 'the files are behind a small Show');
    await ui(guest, "document.querySelector('#skipped button').click(); 0");
    const listed = await ui(guest, "document.querySelector('#skipped ul').innerText");
    t.check(/locked\.bin/.test(listed) && /could not be read on your friend's PC/.test(listed) && /tried again at the next sync/.test(await ui(guest, "document.querySelector('#skipped').innerText")), 'which lists the file, says why, and that it is tried again at the next sync');
    t.check(!fs.readdirSync(dir).some((n) => n.endsWith('.fspart')), 'no empty part was left behind for it');
    t.check(!fs.existsSync(path.join(dir, 'Link')) && !JSON.stringify(guest.remote('g1').files).includes('secret'), 'the junction in the owner\'s folder is not in the list, and nothing of what it leads to arrived');
    t.check(guest.dialogs.length === 0, 'no dialog was opened by the friend');

    // the owner's side: what a request for a path may reach
    const openRead = (rel) => ui(host, `api.openRead('h1', ${JSON.stringify(rel)}).then((f) => { api.close(f.h); return 'served ' + f.size; }, (e) => e.message.replace(/^Error invoking remote method '[^']*': Error: /, ''))`);
    t.check((await openRead('Sub/inside.txt')) === 'served 7', 'a real file inside the folder is served');
    t.check(/^\[read\]/.test(await openRead('Link/secret.txt')) && /not inside/.test(await openRead('Link/secret.txt')), 'a file behind the junction is refused, as a problem with that file');
    const refused = await Promise.all(['../outside/secret.txt', 'Sub/../../outside/secret.txt', 'a.txt:stream', 'NUL', 'Sub/aux.txt', 'C:/Windows/win.ini', '/outside/secret.txt', 'locked.bin', 'nothing.txt'].map(openRead));
    t.check(refused.every((m) => /^\[read\]/.test(m)), `"..", a data stream, a device name, absolute paths, a file that cannot be opened and one that is not there: all refused as problems with one file (${refused.map((m) => m.slice(0, 20))})`);

    // the file can be read again: the next sync gets it
    t.allowRead(locked);
    await startSync(guest);
    t.check((await syncEnded(guest)) === 'ok' && (await statusText(guest)) === 'Synced. 1 file downloaded.', 'once it can be read, the next sync downloads it');
    t.check(t.readTree(dir)['locked.bin'] === t.sha(data['locked.bin']) && (await ui(guest, "document.querySelectorAll('#skipped *').length")) === 0, 'byte for byte, and the note about it is gone');
  });

  await t.scenario('A folder that is gone is not an empty folder: the owner is told, the friend keeps the last list', async (cleanup) => {
    const NAME = 'files-missing';
    t.resetDir(path.join(t.tmpRoot, NAME));
    const hostDir = path.join(t.tmpRoot, NAME, 'hostfiles', 'Gone');
    const moved = path.join(t.tmpRoot, NAME, 'hostfiles', 'Gone-moved');
    const data = { 'one.txt': 'one\n', 'Sub/two.txt': 'two\n', 'late.txt': 'comes when it is ticked\n' };
    t.writeFiles(hostDir, data);
    const server = await t.startServer(NAME);
    cleanup(() => server.stop());
    const code = crypto.randomUUID();
    const host = await t.startApp({ name: NAME, who: 'host', signal: server.signalUrl, seed: { shares: [hostShare('h1', 'Gone', hostDir, code)] } });
    cleanup(() => host.quit());
    await host.ready();
    await registered(server);
    const guest = await t.startApp({ name: NAME, who: 'guest', signal: server.signalUrl, seed: { shares: [guestShare('g1', code, { excluded: ['late.txt'] })] } });
    cleanup(() => guest.quit());
    await guest.ready();
    await ui(guest, "select('g1'); 0");
    t.check((await syncEnded(guest, 'g1', 60000)) === 'ok', 'the first sync works');
    t.check(guest.remote('g1').files.length === 3, 'and the friend has the list of the owner');
    const dir = path.join(guest.home, 'shares', 'Gone');

    // The folder is moved away while the owner's app still has a listing from before (friends are
    // served from a listing for a few seconds): the friend gets the list, and the first file it asks
    // for is not there. That is the end of the sync, not a problem with one file.
    cleanup(() => fs.existsSync(moved) && fs.renameSync(moved, hostDir));
    await ui(host, "api.listFiles('h1', { fresh: true }).then(() => 0)");
    fs.renameSync(hostDir, moved);
    await ui(guest, "api.updateShare('g1', { excluded: [] }).then(() => reload())");
    await startSync(guest);
    t.check((await syncEnded(guest)) === 'error' && /not available right now/i.test(await statusText(guest)), `a sync in the middle of which the folder is gone says "${await statusText(guest)}"`);
    t.check(!fs.existsSync(path.join(dir, 'late.txt')) && !fs.readdirSync(dir).some((n) => n.endsWith('.fspart')), 'and does not go on asking for files, nor leaves an empty part');

    // the owner's window, when it reads the folder
    await ui(host, "select('h1'); 0");
    await ui(host, 'refreshFiles({ fresh: true }); 0');
    await t.waitFor(async () => (await ui(host, "!!view && view.id === 'h1' && !!view.missing")), 10000, "the owner's window to notice");
    const text = await ui(host, "document.querySelector('#files').innerText");
    t.check(/This folder cannot be found/.test(text) && /Friends cannot download it right now/.test(text) && !/empty/.test(text), `the owner is told that the folder cannot be found and that friends cannot download it, and not that it is empty: "${text.replace(/\s+/g, ' ')}"`);
    t.check(/Friends cannot download this folder right now/.test(await statusText(host)) && (await ui(host, "document.querySelector('#btn-add').disabled")) === true, 'also in the status line of the card, and files cannot be added');

    // the friend asks again: now the list itself says it, instead of an empty list
    await startSync(guest);
    t.check((await syncEnded(guest)) === 'error' && /Your friend's folder is not available right now/.test(await statusText(guest)), `the list of a folder that is gone is "${await statusText(guest)}", and not an empty list`);
    t.check(guest.remote('g1').files.length === 3 && (await rows(guest)).length === 3, 'the friend keeps the last known list: it is still stored and still on the screen');
    t.check((await ui(guest, '[...syncing].length')) === 0 && (await ui(guest, 'p2p.isOnline()')) === true && guest.dialogs.length === 0, 'and nothing is left hanging');

    // the folder is back
    fs.renameSync(moved, hostDir);
    await ui(host, 'refreshFiles({ fresh: true }); 0');
    await startSync(guest);
    t.check((await syncEnded(guest)) === 'ok' && fs.existsSync(path.join(dir, 'late.txt')), 'when the folder is back, the next sync works again');
    await t.waitFor(async () => (await ui(host, '!!view && !view.missing')), 10000, "the owner's window to see the folder again");
    t.check(!/cannot be found/.test(await ui(host, "document.querySelector('#files').innerText")) && !/cannot download/.test(await statusText(host)), "and the owner's window says nothing about it any more");
  });

  await t.scenario('The owner\'s status line counts what all friends got, not what the largest connection did', async (cleanup) => {
    const NAME = 'files-total';
    t.resetDir(path.join(t.tmpRoot, NAME));
    const hostDir = path.join(t.tmpRoot, NAME, 'hostfiles', 'Big');
    // big enough that the owner's window can be seen while both are still downloading
    const size = 48 * 1024 * 1024;
    const data = { 'big.bin': crypto.randomBytes(size) };
    t.writeFiles(hostDir, data);
    const server = await t.startServer(NAME);
    cleanup(() => server.stop());
    const code = crypto.randomUUID();
    const host = await t.startApp({ name: NAME, who: 'host', signal: server.signalUrl, seed: { shares: [hostShare('h1', 'Big', hostDir, code)] } });
    cleanup(() => host.quit());
    await host.ready();
    await ui(host, "select('h1'); 0");
    await registered(server);
    const friends = [];
    for (const who of ['friend-a', 'friend-b']) {
      const app = await t.startApp({ name: NAME, who, signal: server.signalUrl, seed: { shares: [guestShare('g1', code)] } });
      cleanup(() => app.quit());
      friends.push(app);
    }
    await Promise.all(friends.map((f) => f.ready()));
    // the line the owner reads while they download
    let seen = '';
    await t.waitFor(async () => {
      seen = await statusText(host);
      return /friends? (is|are) connected, [\d.]+ [KMG]?B sent/.test(seen);
    }, 60000, 'the owner to see friends connected').catch(() => {});
    t.check(/connected, [\d.]+ [KMG]?B sent\.$/.test(seen), `while friends download, the owner's status line says how much was sent ("${seen}")`);
    for (const f of friends) await t.waitFor(() => fs.existsSync(path.join(f.home, 'shares', 'Big', 'big.bin')) && t.readTree(path.join(f.home, 'shares', 'Big'))['big.bin'] === t.sha(data['big.bin']), 90000, `${f.who} to have the file`);
    t.check(true, 'both friends have the file, byte for byte');
    await t.sleep(1000);
    const sent = await ui(host, "hostInfo.get('h1').sent");
    t.check(sent === 2 * size, `the owner counts everything sent for the folder: ${sent} bytes for two friends who each got ${size} (the largest single connection would be ${size})`);
  });

  await t.scenario('A code that runs out while the window is open says so by itself, and stops being served', async (cleanup) => {
    const NAME = 'files-expiry';
    t.resetDir(path.join(t.tmpRoot, NAME));
    const hostDir = path.join(t.tmpRoot, NAME, 'hostfiles', 'Short');
    t.writeFiles(hostDir, { 'a.txt': 'a\n' });
    const server = await t.startServer(NAME);
    cleanup(() => server.stop());
    const code = crypto.randomUUID();
    const expiresAt = Date.now() + 14000;
    const host = await t.startApp({ name: NAME, who: 'host', signal: server.signalUrl, seed: { shares: [hostShare('h1', 'Short', hostDir, code, { expiresAt })] } });
    cleanup(() => host.quit());
    await host.ready();
    await ui(host, "select('h1'); 0");
    await registered(server);
    const hint = () => ui(host, "document.querySelector('[data-share-card] .hint').textContent");
    t.check(/^Valid until/.test(await hint()), `the card says the code is valid ("${await hint()}")`);
    await t.waitFor(async () => /^Expired on/.test(await hint()), 30000, 'the card to say that the code expired');
    t.check(Date.now() >= expiresAt && Date.now() < expiresAt + 5000, `it switched to "Expired" by itself within seconds of the moment it ran out (${((Date.now() - expiresAt) / 1000).toFixed(1)} s after)`);
    t.check(/Generate a new code/.test(await hint()), 'and says what to do');
    await t.waitFor(async () => (await server.stats()).hosted_rooms === 0, 10000, 'the folder to be withdrawn from the server');
    t.check(true, 'the folder was withdrawn from the server at that moment, and not at the next round');
  });

  await t.scenario('The owner\'s file list moves out of config.json, and goes when the folder does', async (cleanup) => {
    const NAME = 'files-migrate';
    t.resetDir(path.join(t.tmpRoot, NAME));
    const server = await t.startServer(NAME);
    cleanup(() => server.stop());
    // a config.json as 1.2.0 wrote it: the list of the owner's files is part of the folder
    const list = Array.from({ length: 1200 }, (_, i) => ({ path: `dir${i % 12}/file${i}.dat`, size: 1000 + i, mtime: 1700000000000 + i }));
    const guest = await t.startApp({
      name: NAME,
      who: 'guest',
      signal: server.signalUrl,
      seed: { shares: [guestShare('old', crypto.randomUUID(), { chosen: false, remote: list, excluded: ['dir3/file3.dat'] }), guestShare('empty', crypto.randomUUID(), { chosen: false })] },
    });
    cleanup(() => guest.quit());
    await guest.ready();
    await t.waitFor(() => guest.remote('old') && guest.config().shares.every((s) => s.remote === undefined), 15000, 'the list to move');
    t.check(guest.remote('old').files.length === 1200 && JSON.stringify(guest.remote('old').files[1199]) === JSON.stringify(list[1199]), 'a list in an old config.json is in a file of its own now');
    t.check(guest.config().shares.every((s) => s.remote === undefined) && JSON.stringify(guest.config()).length < 3000 && sameSet(guest.config().shares[0].excluded, ['dir3/file3.dat']), 'and no longer in config.json, which keeps the rest (the choice of what to download)');
    t.check((await ui(guest, "api.getState().then((s) => s.shares.some((x) => 'remote' in x))")) === false, 'state:get does not send it');
    await ui(guest, "select('old'); 0");
    await t.waitFor(async () => (await rows(guest)).length === 12, 10000, 'the tree');
    t.check(/^Files \(1199 of 1200 selected/.test(await ui(guest, "document.querySelector('#files-title').textContent")), 'the window shows the folder from it, with the choice that was made');
    // the window holds the list of the folder it shows, and no other (the rest is in the profile)
    t.check((await ui(guest, '[...remoteLists.keys()].join()')) === 'old', 'the window holds the list of the folder in view');
    await ui(guest, "select('empty'); 0");
    t.check((await ui(guest, '[...remoteLists.keys()].length')) === 0, 'and lets go of it when another folder is shown');
    await ui(guest, "select('old'); 0");
    await t.waitFor(async () => (await rows(guest)).length === 12, 10000, 'the tree again');
    t.check((await ui(guest, '[...remoteLists.keys()].join()')) === 'old', 'which it asks for again when it is needed');
    // the file goes with the folder
    t.check(fs.existsSync(path.join(guest.userdata, 'remote', 'old.json')), 'there is one file for it');
    await ui(guest, "removeShare(state.shares.find((s) => s.id === 'old'))");
    await t.waitFor(() => !fs.existsSync(path.join(guest.userdata, 'remote', 'old.json')), 10000, 'the file to be removed');
    t.check(fs.readdirSync(path.join(guest.userdata, 'remote')).every((n) => !n.startsWith('old')), 'removing the folder removes its list');
  });

  t.finish();
})();
