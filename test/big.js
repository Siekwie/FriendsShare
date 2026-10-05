// A folder of thousands of small files, shared in place: the friend downloads it completely, and the
// windows stay responsive while it is listed, drawn and transferred. The numbers (how long the
// owner's listing takes, the time to the first list on the friend's side, the time to draw the tree,
// the longest stall of a window and of the main process) are printed with the checks.
//   node test/big.js                     3,000 files, as part of the suite
//   BIG_FILES=20000 node test/big.js     a game folder
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const t = require('./lib');

const FILES = Number(process.env.BIG_FILES || 3000);
const DAY = 86400000;
const ui = (app, expr) => app.eval(expr).catch((err) => `error: ${err.message}`);
const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// a probe in a window: how long its main thread stalls (long tasks), and how long the main process
// takes to answer a call, which is what the transfers of the owner compete with
const PROBE = `
  window.__long = []; window.__ipc = [];
  try { new PerformanceObserver((list) => list.getEntries().forEach((e) => window.__long.push(e.duration))).observe({ entryTypes: ['longtask'] }); } catch {}
  window.__probe = setInterval(async () => { const t0 = performance.now(); await api.getState(); window.__ipc.push(performance.now() - t0); }, 100);
  0`;
const probeResult = (app) => ui(app, 'clearInterval(window.__probe); ({ longest: Math.max(0, ...window.__long), tasks: window.__long.length, ipcMax: Math.max(0, ...window.__ipc), ipcAvg: window.__ipc.reduce((a, b) => a + b, 0) / Math.max(1, window.__ipc.length), ipcCount: window.__ipc.length })');
const ms = (n) => `${Math.round(n)} ms`;

(async () => {
  await t.scenario(`A folder of ${FILES} small files syncs completely, and listing and drawing it stays responsive`, async (cleanup) => {
    const NAME = 'big';
    t.resetDir(path.join(t.tmpRoot, NAME));
    const hostDir = path.join(t.tmpRoot, NAME, 'hostfiles', 'Game');
    // some folders of about a hundred files, one folder with a third of all the files directly in it,
    // a folder inside a folder, and a few files at the top
    const flat = Math.floor(FILES / 3);
    const dirs = Math.max(10, Math.round((FILES - flat) / 100));
    const content = (i) => Buffer.from(`file number ${i}\n`.repeat(1 + (i % 40)));
    let made = 0;
    const started = Date.now();
    const add = (rel) => {
      const file = path.join(hostDir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content(made++));
    };
    for (let i = 0; i < flat; i++) add(`flat/f${i}.dat`);
    for (let i = 0; made < FILES - 5; i++) add(`d${String(i % dirs).padStart(2, '0')}${i % 7 === 0 ? '/sub' : ''}/file${i}.dat`);
    for (const n of ['readme.txt', 'Launcher.exe', 'a.cfg', 'b.cfg', 'c.cfg']) add(n);
    console.log(`  (${made} files made in ${((Date.now() - started) / 1000).toFixed(1)} s)`);

    const server = await t.startServer(NAME);
    cleanup(() => server.stop());
    const code = crypto.randomUUID();
    const host = await t.startApp({ name: NAME, who: 'host', signal: server.signalUrl, seed: { shares: [{ id: 'h1', role: 'host', name: 'Game', dir: hostDir, code, hostKey: crypto.randomUUID(), createdAt: Date.now(), expiresAt: Date.now() + DAY }] } });
    cleanup(() => host.quit());
    await host.ready();
    await t.waitFor(async () => (await server.stats()).hosted_rooms >= 1, 30000, 'the owner to register its folder');

    // ---- the owner's window: the folder in place ----
    await ui(host, "select('h1'); 0");
    await t.waitFor(async () => (await ui(host, "!!view && view.id === 'h1' && document.querySelectorAll('#files .node').length > 0")) === true, 120000, "the owner's tree");
    await ui(host, `window.__times = []; for (const [o, n] of [[tree, 'build'], [window, 'renderTree']]) { const original = o[n]; o[n] = (...a) => { const t0 = performance.now(); const r = original(...a); window.__times.push([n, performance.now() - t0]); return r; }; } 0`);
    const owner = await ui(host, `(async () => { const t0 = performance.now(); const listing = await api.listFiles('h1', { fresh: true }); const t1 = performance.now(); await refreshFiles({ fresh: true }); const t2 = performance.now(); return { listing: t1 - t0, files: listing.files.length, refresh: t2 - t1, times: window.__times, rows: document.querySelectorAll('#files .node').length, title: document.querySelector('#files-title').textContent }; })()`);
    const timeOf = (list, name) => Math.max(0, ...list.filter(([n]) => n === name).map(([, v]) => v));
    t.check(owner.files === FILES && /^Files \(\d+, /.test(owner.title) && owner.rows <= 301, `the owner lists ${owner.files} files in place in ${ms(owner.listing)} (the whole read of the folder and the tree: ${ms(owner.refresh)}), and draws ${owner.rows} rows`);
    console.log(`  numbers (owner): listing ${ms(owner.listing)}, tree built in ${ms(timeOf(owner.times, 'build'))}, rows drawn in ${ms(timeOf(owner.times, 'renderTree'))}`);
    t.check(owner.listing < 15000 && timeOf(owner.times, 'build') < 1500 && timeOf(owner.times, 'renderTree') < 500, 'which is quick enough');
    // a folder with a third of the files in it shows 300 and "Show more", and more of them on a click
    await ui(host, "uiState('h1').open.add('flat'); renderTree(); 0");
    const flatRows = await ui(host, "({ rows: document.querySelectorAll('#files .node').length, more: document.querySelector('#files .node.more') && document.querySelector('#files .node.more').innerText })");
    t.check(flatRows.rows <= owner.rows + 301 && /Show more \(\d+ more\)/.test(flatRows.more || ''), `a big folder opened is 300 rows and "${flatRows.more && flatRows.more.replace(/\s+/g, ' ')}", not ${flat} rows`);
    await ui(host, "document.querySelector('#files .node.more').click(); 0");
    t.check((await ui(host, "document.querySelectorAll('#files .node').length")) <= owner.rows + 601, '"Show more" adds 300');
    // and with the keyboard: the "more" row is a row of the list like the others
    const shown = await ui(host, "document.querySelectorAll('#files .node').length");
    await ui(host, "(() => { const r = document.querySelector('#files .node.more'); r.focus(); r.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()");
    const shownAfter = await ui(host, "document.querySelectorAll('#files .node').length");
    t.check(shownAfter > shown && shownAfter <= owner.rows + 901, `Enter on the "Show more" row shows 300 more (${shown} rows, then ${shownAfter})`);

    // ---- the friend ----
    const guest = await t.startApp({ name: NAME, who: 'guest', signal: server.signalUrl, seed: { shares: [{ id: 'g1', role: 'guest', name: 'Share', dir: null, code, chosen: false, createdAt: Date.now() }] } });
    cleanup(() => guest.quit());
    await guest.ready();
    await t.waitFor(async () => (await ui(guest, "document.querySelector('#conn').dataset.state")) === 'online', 30000, 'the friend to be online');
    await ui(guest, "select('g1'); 0");
    // the first sync only fetches the list: this is the time from the start of it to the list in the window
    const first = await ui(guest, `(async () => { const t0 = performance.now(); void syncShare('g1', { manual: true }); while (!remoteLists.has('g1')) await new Promise((r) => setTimeout(r, 5)); return performance.now() - t0; })()`);
    await t.waitFor(async () => (await ui(guest, "!!view && view.kind === 'choice' && document.querySelectorAll('#files .node').length > 0")) === true, 60000, "the friend's tree");
    console.log(`  numbers (friend): time to the first list ${ms(first)} (connecting included)`);
    t.check(typeof first === 'number' && first < 60000, `the friend has the list of ${FILES} files ${ms(first)} after it started, connecting included`);
    await t.waitFor(async () => (await ui(guest, "[...syncing].length")) === 0, 30000, 'the list-only sync to end');
    const stored = guest.remote('g1');
    t.check(!!stored && stored.files.length === FILES && JSON.stringify(guest.config()).length < 3000, `the list is in a file of its own (${(fs.statSync(path.join(guest.userdata, 'remote', 'g1.json')).size / 1024).toFixed(0)} KB), and config.json stays small (${JSON.stringify(guest.config()).length} bytes)`);
    await ui(guest, `window.__times = []; for (const [o, n] of [[tree, 'build'], [tree, 'choose'], [tree, 'markDone'], [window, 'renderTree']]) { const original = o[n]; o[n] = (...a) => { const t0 = performance.now(); const r = original(...a); window.__times.push([n, performance.now() - t0]); return r; }; } 0`);
    const drawn = await ui(guest, `(async () => { const t0 = performance.now(); await refreshFiles({ fresh: true }); return { total: performance.now() - t0, times: window.__times, rows: document.querySelectorAll('#files .node').length, title: document.querySelector('#files-title').textContent }; })()`);
    console.log(`  numbers (friend): the tree of ${FILES} files, everything: ${ms(drawn.total)} (built ${ms(timeOf(drawn.times, 'build'))}, chosen ${ms(timeOf(drawn.times, 'choose'))}, marks ${ms(timeOf(drawn.times, 'markDone'))}, rows drawn ${ms(timeOf(drawn.times, 'renderTree'))})`);
    t.check(drawn.rows <= 301 && new RegExp(`^Files \\(${FILES} of ${FILES} selected`).test(drawn.title) && drawn.total < 5000 && timeOf(drawn.times, 'renderTree') < 500, `the friend's tree is drawn in ${ms(drawn.total)}, ${drawn.rows} rows`);
    await ui(guest, `window.__times = []; document.querySelector('#files [data-key="flat/"] .check').click(); 0`);
    const ticked = await ui(guest, `({ title: document.querySelector('#files-title').textContent, times: window.__times, excluded: selected().excluded })`);
    t.check(sameSet(ticked.excluded, ['flat/']) && new RegExp(`^Files \\(${FILES - flat} of ${FILES} selected`).test(ticked.title), `unticking the folder with ${flat} files is one entry ("flat/") and ${ms(timeOf(ticked.times, 'renderTree'))} of drawing`);
    await ui(guest, `document.querySelector('#files [data-key="flat/"] .check').click(); 0`);

    // ---- the whole folder, with both windows watched ----
    await ui(guest, PROBE);
    await ui(host, PROBE);
    const t0 = Date.now();
    await ui(guest, "void syncShare('g1', { download: true, manual: true }); 0");
    const kind = await t.waitFor(async () => {
      const k = await ui(guest, "[...syncing].includes('g1') ? 'busy' : (status.get('g1') || {}).kind");
      return ['ok', 'warn', 'error'].includes(k) && k;
    }, Math.max(150000, FILES * 60), `the ${FILES} files to arrive`);
    const seconds = (Date.now() - t0) / 1000;
    const friendProbe = await probeResult(guest);
    const ownerProbe = await probeResult(host);
    console.log(`  numbers: ${FILES} files downloaded in ${seconds.toFixed(1)} s (${(FILES / seconds).toFixed(0)} files/s)`);
    console.log(`  numbers (friend's window while syncing): longest stall ${ms(friendProbe.longest)} (${friendProbe.tasks} long tasks), main process answered in ${ms(friendProbe.ipcAvg)} on average, ${ms(friendProbe.ipcMax)} at most (${friendProbe.ipcCount} calls)`);
    console.log(`  numbers (owner's window while serving): longest stall ${ms(ownerProbe.longest)} (${ownerProbe.tasks} long tasks), main process answered in ${ms(ownerProbe.ipcAvg)} on average, ${ms(ownerProbe.ipcMax)} at most (${ownerProbe.ipcCount} calls)`);
    t.check(kind === 'ok', `the sync ends well after ${seconds.toFixed(1)} s`);
    const mine = t.readTree(hostDir);
    const theirs = t.readTree(path.join(guest.home, 'shares', 'Game'));
    const names = Object.keys(mine);
    t.check(names.length === FILES && names.length === Object.keys(theirs).length && names.every((n) => theirs[n] === mine[n]), `all ${FILES} files are there, byte for byte, with no part left over`);
    t.check(friendProbe.longest < 1500 && ownerProbe.longest < 1500 && friendProbe.ipcMax < 3000 && ownerProbe.ipcMax < 3000, 'neither window stalled for long, and the main processes (which also serve and write the files) kept answering');
    t.check(host.dialogs.length === 0 && guest.dialogs.length === 0, 'no dialog was opened');
  }, { timeout: Math.max(300000, FILES * 120) });

  t.finish();
})();
