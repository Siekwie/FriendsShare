// The free plan holds a limited number of folders (here ENFORCE_LIMIT=1 FREE_LIMIT=1). A friend who has
// two folders from two owners that are both online syncs only the older one; the other is paused,
// nothing is deleted, and it starts by itself when a slot is free. Folders of your own over the limit
// are not announced to the server either.
//   node test/limit.js
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const t = require('./lib');

const NAME = 'limit';
const HOUR = 3600 * 1000;

const codes = { a: crypto.randomUUID(), b: crypto.randomUUID(), extra: crypto.randomUUID() };
const data = { a: Buffer.from('the first folder\n'), b: Buffer.from('the second folder\n') };
const dirOf = (key) => path.join(t.tmpRoot, NAME, 'hostfiles', key);
const host = (key, name, extra = {}) => ({ id: key, role: 'host', name, dir: dirOf(key), code: codes[key], hostKey: crypto.randomUUID(), expiresAt: Date.now() + 86400000, createdAt: Date.now() - 3 * HOUR, ...extra });
const guest = (key, createdAt) => ({ id: `g-${key}`, role: 'guest', name: `Share ${codes[key].slice(0, 8)}`, dir: null, code: codes[key], chosen: true, createdAt });
const ui = (app, expr) => app.eval(expr).catch((err) => `error: ${err.message}`);

t.scenario('The free plan holds one folder: the older one syncs, the newer one is paused', async (cleanup) => {
  t.resetDir(path.join(t.tmpRoot, NAME));
  for (const key of ['a', 'b', 'extra']) fs.mkdirSync(dirOf(key), { recursive: true });
  fs.writeFileSync(path.join(dirOf('a'), 'a.txt'), data.a);
  fs.writeFileSync(path.join(dirOf('b'), 'b.txt'), data.b);

  const server = await t.startServer(NAME, { ENFORCE_LIMIT: '1', FREE_LIMIT: '1' });
  cleanup(() => server.stop());

  // owner A shares one folder. Owner B has two: "Extra" is newer, so it is the one over the limit.
  const ownerA = await t.startApp({ name: NAME, who: 'owner-a', signal: server.signalUrl, seed: { shares: [host('a', 'Folder A')] } });
  cleanup(() => ownerA.quit());
  const ownerB = await t.startApp({ name: NAME, who: 'owner-b', signal: server.signalUrl, seed: { shares: [host('b', 'Folder B'), host('extra', 'Extra', { createdAt: Date.now() - 2 * HOUR })] } });
  cleanup(() => ownerB.quit());
  await Promise.all([ownerA.ready(), ownerB.ready()]);
  await t.waitFor(async () => (await server.stats()).hosted_rooms >= 2, 30000, 'both owners to register a folder');
  await t.sleep(1500);
  t.check((await server.stats()).hosted_rooms === 2, 'the owner with two folders announced only the older one (2 rooms on the server, not 3)');
  t.check((await ui(ownerB, "document.querySelectorAll('#list-host li.paused').length")) === 1, 'the newer folder of that owner is shown as paused');
  t.check((await ui(ownerB, "document.querySelector('#acct-plan').textContent")) === 'Free · 1 of 1 folder', 'the account row counts the folders against the limit of one');

  // the friend lists the newer folder first; the older one (by when it was added) keeps its place
  const friend = await t.startApp({ name: NAME, who: 'friend', signal: server.signalUrl, seed: { shares: [guest('b', Date.now() - HOUR), guest('a', Date.now() - 2 * HOUR)] } });
  cleanup(() => friend.quit());
  await friend.ready();
  const dirA = path.join(friend.home, 'shares', 'Folder A');
  const dirB = path.join(friend.home, 'shares', 'Folder B');
  const arrivedA = await t.waitFor(() => fs.existsSync(path.join(dirA, 'a.txt')) && fs.readFileSync(path.join(dirA, 'a.txt')).equals(data.a), 40000, 'the older folder to sync').then(() => true, () => false);
  t.check(arrivedA, 'the older folder synced');
  await t.sleep(5000);
  t.check(!fs.existsSync(dirB), 'the newer folder did not sync: nothing was created for it');
  const idle = await server.stats();
  t.check(idle.waiting === 0, 'and the server holds no wait for it');

  t.check((await ui(friend, "[...document.querySelectorAll('#list-guest li.paused')].map((li) => li.textContent).join()")) === `Share ${codes.b.slice(0, 8)}paused`, 'the newer folder is dimmed in the list and says paused');
  t.check((await ui(friend, "document.querySelector('#acct-plan').textContent")) === 'Free · 1 of 1 folder', 'the account row shows the free plan, one of one folder');
  await ui(friend, "document.querySelector('li.paused button.item').click()");
  const card = await ui(friend, "document.querySelector('#paused-card') ? document.querySelector('#paused-card').innerText : 'none'");
  t.check(/Paused/.test(card) && /1 folder at a time/.test(card) && /Nothing is deleted/.test(card) && (await ui(friend, "!!document.querySelector('#btn-paused-upgrade')")) === true, 'its detail view explains why and offers Upgrade to Pro');

  // "+ New" and "+ Add code" open the limit dialog instead
  for (const button of ['#btn-new', '#btn-join']) {
    await ui(friend, `document.querySelector('${button}').click()`);
    const dialog = await ui(friend, "[...document.querySelectorAll('dialog')].filter((d) => d.open).map((d) => d.id).join()");
    t.check(dialog === 'dlg-limit', `${button} opens the limit dialog, not the dialog for adding`);
    if (button === '#btn-new') {
      const text = await ui(friend, "document.querySelector('#limit-text').textContent");
      t.check(/holds 1 folder at a time/.test(text) && /files stay on your disk/.test(text) && /upgrade to Pro/.test(text), 'the limit dialog says what the limit is and what to do');
      t.check((await ui(friend, "[...document.querySelectorAll('#dlg-limit button')].map((b) => b.textContent).join()")) === 'Close,Upgrade to Pro', 'with the buttons Close and Upgrade to Pro');
    }
    await ui(friend, "document.querySelector('#dlg-limit').close()");
  }
  // the main process holds the same line where the list is changed
  const refused = await ui(friend, `api.joinShare('${crypto.randomUUID()}').then(() => 'added', (err) => errorText(err))`);
  t.check(/holds 1 folder at a time/.test(refused), 'adding a code is refused in the main process too');

  // The window thinks there is no limit (a welcome that was out of date): the server says no, and the
  // folders it refused are paused again, for both kinds. (The owner's extra folder was not announced
  // before; the friend's newer folder never asked.)
  await ui(ownerB, "account = { ...account, limit: null }; refreshPaused(); 0");
  await t.sleep(2500);
  t.check((await ui(ownerB, "[...limited].join()")) === 'extra' && (await ui(ownerB, "[...paused].join()")) === 'extra', 'a folder of your own that the server refuses with "limit" is paused (the answer of the server, not a count of the window)');
  t.check((await server.stats()).hosted_rooms === 2, 'and is not registered');
  await ui(friend, "account = { ...account, limit: null }; refreshPaused(); 0");
  await t.sleep(4000);
  t.check((await ui(friend, "[...limited].join()")) === 'g-b' && (await ui(friend, "[...paused].join()")) === 'g-b' && !fs.existsSync(dirB), 'a friend\'s folder that the server refuses with "limit" is paused as well, and nothing was created for it');

  // removing the older folder frees the slot: the newer one starts by itself
  await ui(friend, "removeShare(state.shares.find((s) => s.id === 'g-a'))");
  const arrivedB = await t.waitFor(() => fs.existsSync(path.join(dirB, 'b.txt')) && fs.readFileSync(path.join(dirB, 'b.txt')).equals(data.b), 40000, 'the newer folder to start by itself').then(() => true, () => false);
  t.check(arrivedB, 'after removing a folder the paused one resumed by itself and synced');
  t.check(fs.existsSync(path.join(dirA, 'a.txt')), 'removing a folder from the list deleted nothing on the disk');
  t.check((await ui(friend, "document.querySelectorAll('#list-guest li.paused').length")) === 0, 'nothing is paused any more');
  t.check(ownerA.dialogs.length === 0 && ownerB.dialogs.length === 0 && friend.dialogs.length === 1 && /Remove/.test(friend.dialogs[0].message), 'the only dialog of any window was the confirmation for removing the folder');
}).then(t.finish);
