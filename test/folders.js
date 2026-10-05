// Sharing a folder you already have, in place (share:addExisting): folders that would show far more
// than anybody means to share are refused, with the reason, and a folder with more than 20,000 files
// asks first, with a native message box. The folder picker and the message box are not shown (see
// guard.js): the test answers them. Every folder it picks is one of its own in .test-tmp, except the
// ones that are refused before anything in them is looked at.
//   node test/folders.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const t = require('./lib');

const ui = (app, expr) => app.eval(expr).catch((err) => `error: ${err.message}`);
const RESULT = "(s) => (s ? 'added ' + s.name : 'cancelled'), (e) => e.message.replace(/^Error invoking remote method '[^']*': Error: /, '')";
// what the person gets from picking a folder, as the window gets it
const pick = (app, dir, box) => {
  app.answer({ open: [[dir]], box: box === undefined ? [] : [box] });
  return ui(app, `api.addExistingFolder().then(${RESULT})`);
};

(async () => {
  await t.scenario('Folders that would show too much are refused, and a huge one asks first', async (cleanup) => {
    const NAME = 'folders';
    t.resetDir(path.join(t.tmpRoot, NAME));
    // the app is offline here: nothing in this test needs a server
    const app = await t.startApp({ name: NAME, who: 'owner', signal: 'ws://127.0.0.1:9/ws' });
    cleanup(() => app.quit());
    await app.ready();
    const shares = () => app.config().shares;
    // the folder where friends' downloads go has not been needed yet, so it does not exist yet
    fs.mkdirSync(path.join(app.home, 'shares'), { recursive: true });

    const system = process.env.SystemRoot || 'C:\\Windows';
    const refusals = {
      'your user folder': [os.homedir(), /user folder/],
      'the Windows folder': [system, /part of Windows/],
      'a folder in the Windows folder': [path.join(system, 'System32'), /part of Windows/],
      'the settings folder of this app': [path.join(app.home, 'userdata'), /own settings/],
      'a folder that contains it': [app.home, /own settings/],
      'a folder that contains that': [path.dirname(app.home), /own settings/],
      "the folder where friends' downloads are stored": [path.join(app.home, 'shares'), /friends are stored/],
    };
    for (const [what, [dir, reason]] of Object.entries(refusals)) {
      const answer = await pick(app, dir);
      t.check(reason.test(answer) && !/^added|^cancelled/.test(answer), `${what} is refused, and the message says why ("${answer.slice(0, 120)}")`);
    }
    t.check(shares().length === 0 && app.dialogLog().every((e) => e.kind === 'open'), 'and none of them was added to the list, or asked about');

    // ordinary folders are fine, also one that came from a friend (it lies in the downloads folder)
    const fine = path.join(t.tmpRoot, NAME, 'fine');
    t.writeFiles(fine, { 'a.txt': 'a' });
    t.check((await pick(app, fine)) === 'added fine', 'an ordinary folder is added, in place');
    t.check(/already in your list/.test(await pick(app, fine)), 'twice is not');
    const received = path.join(app.home, 'shares', 'From a friend');
    t.writeFiles(received, { 'x.txt': 'x' });
    t.check((await pick(app, received)) === 'added From a friend', 'a folder that came from a friend can be shared on: it is inside the downloads folder, which is not the same as containing it');
    t.check(shares().length === 2 && app.dialogLog().every((e) => e.kind === 'open'), 'and none of this asked a question');

    // ---- more than 20,000 files ----
    const many = path.join(t.tmpRoot, NAME, 'many');
    const started = Date.now();
    for (let d = 0; d < 20; d++) {
      fs.mkdirSync(path.join(many, `d${d}`), { recursive: true });
      for (let i = 0; i < 1000; i++) fs.closeSync(fs.openSync(path.join(many, `d${d}`, `f${i}.txt`), 'w'));
    }
    fs.mkdirSync(path.join(many, 'rest'));
    fs.writeFileSync(path.join(many, 'rest', 'one-more.txt'), 'x');
    console.log(`  (20,001 files made in ${((Date.now() - started) / 1000).toFixed(1)} s)`);
    const asked = app.dialogLog().length;
    const declined = await pick(app, many, 1);
    const box = app.dialogLog().slice(asked).filter((e) => e.kind === 'box');
    t.check(declined === 'cancelled' && shares().length === 2, 'a folder with 20,001 files is not added when the person says Cancel');
    t.check(box.length === 1 && /more than 20,000 files/.test(box[0].options.message) && JSON.stringify(box[0].options.buttons) === '["Share it","Cancel"]' && box[0].options.cancelId === 1 && box[0].options.defaultId === 1, `it asked first, with a message box that says so, with Cancel as the default (${box[0] && JSON.stringify([box[0].options.message, box[0].options.buttons])})`);
    t.check((await pick(app, many, 0)) === 'added many' && shares().length === 3 && shares()[2].dir === many, 'and it is added when the person says to share it');
    // exactly 20,000 is not "more than"
    await ui(app, "api.getState().then((s) => api.removeShare(s.shares.find((x) => x.name === 'many').id))");
    fs.rmSync(path.join(many, 'rest'), { recursive: true });
    const before = app.dialogLog().length;
    t.check((await pick(app, many, 1)) === 'added many' && app.dialogLog().slice(before).every((e) => e.kind === 'open'), 'a folder with exactly 20,000 files is added without a question');
    t.check(app.dialogs.length === 0, 'no dialog was opened by the window');
  }, { timeout: 240000 });

  t.finish();
})();
