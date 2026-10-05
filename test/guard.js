// Preloaded into the main process of every app instance a test starts (NODE_OPTIONS=--require, see
// lib.js), before any of the app's own code. A test must never put anything on the person's
// desktop: not an error box when something throws (it would sit there, blocking, until somebody
// clicks it), not a notification, and not a dialog of any kind (a folder picker or a question
// would wait for a click that nobody makes). Errors go to the output of the instance, and end it.
//
// The dialogs the app opens on purpose (the folder picker, the question about a big folder) are
// answered from the file that FS_TEST_DIALOGS names, if the test wrote one:
//     { "open": [["C:/folder"], null], "box": [0, 1] }
// one entry for each call, in order. An array is the folders the picker returns, a number is the
// button of the message box that is pressed; null, or nothing left, cancels. Every call is also
// appended to "<that file>.log", one line of JSON each, so that the test can see what was asked.
//
// This runs before Electron's API exists, so the handlers do not need it up front, and the API is
// patched the moment something first requires it (the app does, in its first line).
const fs = require('fs');
const Module = require('module');

const quit = () => {
  try {
    require('electron').app.exit(1);
  } catch {
    process.exit(1);
  }
};
process.on('uncaughtException', (err) => {
  console.error('[guard] uncaught exception:', err);
  quit();
});
process.on('unhandledRejection', (err) => {
  console.error('[guard] unhandled rejection:', err);
  quit();
});

// the next answer for a kind of dialog ('open' or 'box'), or undefined
function answer(kind, options) {
  const file = process.env.FS_TEST_DIALOGS;
  if (!file) return undefined;
  try {
    fs.appendFileSync(`${file}.log`, `${JSON.stringify({ kind, options })}\n`);
    const queue = JSON.parse(fs.readFileSync(file, 'utf8'));
    const next = Array.isArray(queue[kind]) ? queue[kind].shift() : undefined;
    fs.writeFileSync(file, JSON.stringify(queue));
    return next;
  } catch {
    return undefined;
  }
}
// dialog functions take (window, options) or (options)
const optionsOf = (args) => args.find((a, i) => a && typeof a === 'object' && i === args.length - 1) || {};

let patched = false;
const load = Module._load;
Module._load = function guardedLoad(request) {
  const exports = load.apply(this, arguments);
  if (request === 'electron' && !patched && exports && typeof exports === 'object' && exports.dialog) {
    patched = true;
    const { dialog } = exports;
    dialog.showErrorBox = (title, text) => console.error(`[guard] ${title}: ${text}`);
    dialog.showOpenDialog = async (...args) => {
      const next = answer('open', optionsOf(args));
      return Array.isArray(next) ? { canceled: false, filePaths: next } : { canceled: true, filePaths: [] };
    };
    dialog.showMessageBox = (...args) => {
      const options = optionsOf(args);
      const cancel = { response: options.cancelId ?? 0, checkboxChecked: false };
      // alert(), confirm() and prompt() of the window come through here as well, with a signal that
      // ends when the dialog is closed. Those are answered by the test's DevTools connection (see
      // devtools in lib.js); here they just wait, without anything on the screen.
      if (options.signal && typeof options.signal.addEventListener === 'function') {
        return new Promise((resolve) => options.signal.addEventListener('abort', () => resolve(cancel), { once: true }));
      }
      const next = answer('box', options);
      return Promise.resolve(Number.isInteger(next) ? { response: next, checkboxChecked: false } : cancel);
    };
    // everything else that would show a window just says no
    dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' });
    dialog.showOpenDialogSync = () => undefined;
    dialog.showSaveDialogSync = () => undefined;
    dialog.showMessageBoxSync = (...args) => optionsOf(args).cancelId ?? 0;
    dialog.showCertificateTrustDialog = async () => {};
    // the instances run hidden, and a toast would show anyway
    if (exports.Notification && exports.Notification.prototype) exports.Notification.prototype.show = function () {};
    console.log('[guard] active');
  }
  return exports;
};
