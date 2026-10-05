// Test only (see test/official.js): makes the app, started from source with NODE_OPTIONS=--require,
// believe it is a packaged official build, so that the strict behaviour of official builds can be
// tested. An official build ignores FS_HOME, and --user-data-dir is refused, so without this the
// instance would have only one place to keep its data: the person's real profile. That must never
// happen, so before the app's own code runs, this moves the profile into the test's directory, and
// stops the instance if that did not work.
//
// An official build refuses debugging switches, so nothing can look into it from outside. What it
// does is written to FAKE_OFFICIAL_LOG instead, one JSON object per line, and creating the file
// FAKE_OFFICIAL_QUIT ends it gracefully (the tray icon goes with it).
require('./guard');
const fs = require('fs');
const Module = require('module');
const path = require('path');

const need = (name) => {
  if (!process.env[name]) {
    console.error(`[fake-official] ${name} is not set`);
    process.exit(1);
  }
  return process.env[name];
};
const key = need('FAKE_OFFICIAL_KEY');
const profile = path.resolve(need('FAKE_OFFICIAL_PROFILE'));
const log = need('FAKE_OFFICIAL_LOG');
const resources = path.resolve(need('FAKE_OFFICIAL_RESOURCES'));
const quitFile = need('FAKE_OFFICIAL_QUIT');
const appDir = path.join(__dirname, '..', 'app') + path.sep;
const note = (entry) => fs.appendFileSync(log, `${JSON.stringify(entry)}\n`);

const load = Module._load;
let installed = false;
let forTheApp = null;
Module._load = function fakeOfficialLoad(request, parent) {
  // the build.json that only official builds have
  if (/(^|[\\/])build\.json$/.test(request) && parent && parent.filename && parent.filename.startsWith(appDir)) return { key };
  const exports = load.apply(this, arguments);
  if (request === 'electron' && exports && exports.app) {
    const { app } = exports;
    if (!installed) {
      installed = true;
      Object.defineProperty(app, 'isPackaged', { value: true, configurable: true });
      Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true, writable: true });
      // the wrapper app has its own package.json; the version is the real app's
      app.getVersion = () => require('../package.json').version;
      app.setPath('userData', profile);
      if (path.resolve(app.getPath('userData')) !== profile) {
        console.error('[fake-official] could not move the profile into the test directory; not going on');
        process.exit(1);
      }
      app.whenReady().then(() => {
        note({ event: 'ready', isPackaged: app.isPackaged, userData: app.getPath('userData'), argv: process.argv.slice(1) });
        setInterval(() => fs.existsSync(quitFile) && app.quit(), 200);
      });
      // what the app asks for when it creates its window (only the app gets this wrapper)
      class RecordingWindow extends exports.BrowserWindow {
        constructor(options) {
          super(options);
          note({ event: 'window', devTools: options && options.webPreferences ? options.webPreferences.devTools : null });
        }
      }
      forTheApp = new Proxy(exports, { get: (target, name) => (name === 'BrowserWindow' ? RecordingWindow : target[name]) });
    }
    if (parent && parent.filename && parent.filename.startsWith(appDir)) return forTheApp;
  }
  return exports;
};
