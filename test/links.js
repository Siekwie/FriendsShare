// Files and folders shared from where they are (share.links, see app/folder.js): what is dropped on
// the window is not copied into the shared folder, friends get it all the same, taking it out
// again leaves the original alone, and a shared folder whose own folder is gone still serves them.
//   node test/links.js
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const t = require('./lib');

const DAY = 86400000;
const ui = (app, expr) => app.eval(expr).catch((err) => `error: ${err.message}`);
const ERR = "(e) => 'error: ' + e.message.replace(/^Error invoking remote method '[^']*': Error: /, '')";
const add = (app, id, paths) => ui(app, `api.importPaths('${id}', ${JSON.stringify(paths)}).then((n) => 'added ' + n, ${ERR})`);
const guestShare = (id, code) => ({ id, role: 'guest', name: 'Share', dir: null, code, chosen: true, createdAt: Date.now() });
const registered = (server, rooms = 1) => t.waitFor(async () => (await server.stats()).hosted_rooms >= rooms, 30000, 'the owner to register its folder');
const startSync = (app, id = 'g1') => ui(app, `void syncShare('${id}', { download: true, manual: true }); 0`);
const syncEnded = (app, id = 'g1', ms = 90000) =>
  t.waitFor(async () => {
    const kind = await ui(app, `[...syncing].includes('${id}') ? 'busy' : (status.get('${id}') || {}).kind`);
    return ['ok', 'warn', 'error'].includes(kind) && kind;
  }, ms, 'the sync to end');
const rows = (app) => ui(app, "[...document.querySelectorAll('#files .node')].map((r) => ({ key: r.dataset.key, text: r.innerText.replace(/\\s+/g, ' ').trim(), tag: r.querySelector('.tag')?.textContent || '', remove: !!r.querySelector('.unlink') }))");
const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

(async () => {
  await t.scenario('What is dropped on the window is shared from where it is, not copied', async (cleanup) => {
    const NAME = 'links';
    t.resetDir(path.join(t.tmpRoot, NAME));
    const videos = path.join(t.tmpRoot, NAME, 'Videos');
    const data = {
      'match.mp4': crypto.randomBytes(30 * 1024 * 1024),
      'clip.mp4': crypto.randomBytes(5000),
      'Clips/one.mp4': crypto.randomBytes(6000),
      'Clips/more/two.mp4': crypto.randomBytes(7000),
      'Other/clip.mp4': crypto.randomBytes(800),
    };
    t.writeFiles(videos, data);
    const server = await t.startServer(NAME);
    cleanup(() => server.stop());
    const host = await t.startApp({ name: NAME, who: 'host', signal: server.signalUrl });
    cleanup(() => host.quit());
    await host.ready();
    // a folder made in the app, as most people have, with one file put into it by hand
    const share = JSON.parse(await ui(host, "api.createShare('Game night').then((s) => JSON.stringify(s))"));
    const dir = share.dir;
    t.writeFiles(dir, { 'clip.mp4': 'the one in the folder' });
    await ui(host, `reload().then(() => select('${share.id}')); 0`);
    const code = (await ui(host, `api.generateCode('${share.id}', 1).then((s) => s.code)`));
    await ui(host, 'reload(); 0');
    await registered(server);

    // ---- adding ----
    const started = Date.now();
    const result = await add(host, share.id, [path.join(videos, 'match.mp4'), path.join(videos, 'Clips'), path.join(dir, 'clip.mp4')]);
    const took = Date.now() - started;
    t.check(result === 'added 2' && took < 2000, `a 30 MB file and a folder are added in no time (${took} ms), and a file that is in the folder already needs nothing ("${result}")`);
    t.check(sameSet(Object.keys(t.readTree(dir)), ['clip.mp4']), `nothing was copied into the shared folder (${Object.keys(t.readTree(dir))})`);
    const links = () => host.config().shares.find((s) => s.id === share.id).links;
    t.check(JSON.stringify(links()) === JSON.stringify([{ name: 'match.mp4', src: path.join(videos, 'match.mp4') }, { name: 'Clips', src: path.join(videos, 'Clips') }]), `the settings remember where each one is (${JSON.stringify(links())})`);
    t.check((await add(host, share.id, [path.join(videos, 'clip.mp4'), path.join(videos, 'Other', 'clip.mp4')])) === 'added 2' && links().slice(2).map((l) => l.name).join() === 'clip (2).mp4,clip (3).mp4', `two more files called clip.mp4 are numbered, since the folder has one (${links().slice(2).map((l) => l.name)})`);
    t.check((await add(host, share.id, [path.join(videos, 'match.mp4')])) === 'added 0' && links().length === 4, 'adding the same file again does nothing');
    const refused = await add(host, share.id, [process.env.SystemRoot || 'C:\\Windows', path.join(videos, 'nothing.mp4'), path.join(videos, 'Clips', 'one.mp4')]);
    t.check(/^error: /.test(refused) && /windows: That is part of Windows/i.test(refused) && /nothing\.mp4: it cannot be found/.test(refused) && links().length === 5 && links()[4].name === 'one.mp4', `the Windows folder and a file that is not there are refused by name, and the file that is fine in the same drop is added ("${refused.replace(/\n/g, ' | ')}")`);
    await ui(host, `api.unlink('${share.id}', 'one.mp4'); 0`);
    await ui(host, "reload().then(() => refreshFiles({ fresh: true })); 0");
    await t.waitFor(async () => (await rows(host)).length === 5, 10000, 'the list');
    const shown = await rows(host);
    t.check(sameSet(shown.map((r) => r.key), ['Clips/', 'clip.mp4', 'clip (2).mp4', 'clip (3).mp4', 'match.mp4']), `the list shows them with what is in the folder (${shown.map((r) => r.key)})`);
    t.check(shown.filter((r) => r.tag === 'elsewhere' && r.remove).map((r) => r.key).sort().join() === 'Clips/,clip (2).mp4,clip (3).mp4,match.mp4' && !shown.find((r) => r.key === 'clip.mp4').tag, 'what comes from elsewhere is marked, and has a Remove; the file in the folder has neither');
    t.check(/^Files \(6, 30(\.\d)? MB\)$/.test(await ui(host, "document.querySelector('#files-title').textContent")), `the title counts the files in the linked folder too (${await ui(host, "document.querySelector('#files-title').textContent")})`);
    t.check(/Shared from .*Videos.*match\.mp4/.test(await ui(host, "document.querySelector('#files [data-key=\"match.mp4\"] .name').title")), 'and the row says where the file is');

    // ---- a friend gets it all ----
    const guest = await t.startApp({ name: NAME, who: 'guest', signal: server.signalUrl, seed: { shares: [guestShare('g1', code)] } });
    cleanup(() => guest.quit());
    await guest.ready();
    await ui(guest, "select('g1'); 0");
    t.check((await syncEnded(guest)) === 'ok', 'the sync ends well');
    const got = t.readTree(path.join(guest.home, 'shares', 'Game night'));
    const want = { 'clip.mp4': t.sha('the one in the folder'), 'match.mp4': t.sha(data['match.mp4']), 'clip (2).mp4': t.sha(data['clip.mp4']), 'clip (3).mp4': t.sha(data['Other/clip.mp4']), 'Clips/one.mp4': t.sha(data['Clips/one.mp4']), 'Clips/more/two.mp4': t.sha(data['Clips/more/two.mp4']) };
    t.check(JSON.stringify(Object.entries(got).sort()) === JSON.stringify(Object.entries(want).sort()), `the friend has every file, byte for byte, under the names the owner's list shows (${Object.keys(got)})`);
    const remote = guest.remote('g1');
    t.check(remote.files.length === 6 && !JSON.stringify(remote).includes('Videos'), 'the friend\'s copy of the list has the names only, not where the files are on the owner\'s PC');

    // ---- taking one out, and one that goes missing ----
    await ui(host, `api.unlink('${share.id}', 'clip (3).mp4'); 0`);
    t.check(links().length === 3 && fs.existsSync(path.join(videos, 'Other', 'clip.mp4')), 'a file taken out of the folder stays where it is');
    fs.renameSync(path.join(videos, 'clip.mp4'), path.join(videos, 'clip-moved.mp4'));
    await ui(host, 'refreshFiles({ fresh: true }); 0');
    await t.waitFor(async () => /not there any more/.test(await ui(host, "document.querySelector('#files-note').innerText")), 10000, 'the note');
    const noteText = () => ui(host, "document.querySelector('#files-note').innerText");
    t.check((await rows(host)).length === 3 && /A file or folder added from elsewhere is not there any more/.test(await noteText()), `a file that was moved away is out of the list, and the note says so (${(await rows(host)).length} rows, "${await noteText()}")`);
    await ui(host, "document.querySelector('#files-note button').click(); 0");
    const lostText = await ui(host, "document.querySelector('#files-note ul').innerText");
    t.check(/clip\.mp4[\s\S]*cannot be found/.test(lostText) && (await ui(host, "document.querySelector('#files-note ul button').textContent")) === 'Remove', `with the path and a Remove ("${lostText}")`);
    t.check((await ui(host, "document.querySelector('#status').className")) === 'hint status', 'the folder is not "gone" for that');
    await startSync(guest);
    t.check((await syncEnded(guest)) === 'ok' && (await ui(guest, "api.getRemote('g1').then((r) => r.files.map((f) => f.path).sort().join())")) === 'Clips/more/two.mp4,Clips/one.mp4,clip.mp4,match.mp4', 'the friend\'s next sync sees neither, and nothing is deleted on the friend\'s side');
    t.check(sameSet(Object.keys(t.readTree(path.join(guest.home, 'shares', 'Game night'))), Object.keys(want)), 'nothing is deleted on the friend\'s side');

    // ---- the folder itself is gone ----
    fs.rmSync(dir, { recursive: true, force: true });
    await ui(host, 'refreshFiles({ fresh: true }); 0');
    await t.waitFor(async () => (await ui(host, "!!view && !!view.missing")), 10000, 'the owner\'s window to notice');
    t.check((await ui(host, '!view.gone')) === true && (await rows(host)).length === 2 && /folder itself cannot be found/.test(await noteText()), `without its own folder the share still lists what comes from elsewhere, and says the folder is missing (${(await rows(host)).length} rows, "${await noteText()}")`);
    t.check((await ui(host, "document.querySelector('#btn-add').disabled")) === false, 'and files can still be added');
    fs.rmSync(path.join(guest.home, 'shares', 'Game night', 'match.mp4'));
    await startSync(guest);
    t.check((await syncEnded(guest)) === 'ok' && t.readTree(path.join(guest.home, 'shares', 'Game night'))['match.mp4'] === want['match.mp4'], 'and friends still download them');
    t.check(host.dialogs.length === 0 && guest.dialogs.length === 0, 'no dialog was opened');
  }, { timeout: 240000 });

  t.finish();
})();
