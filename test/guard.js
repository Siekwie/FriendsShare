// Preloaded into the main process of every app instance a test starts (NODE_OPTIONS=--require, see
// lib.js), before any of the app's own code. A test must never put anything on the person's
// desktop: not an error box when something throws (it would sit there, blocking, until somebody
// clicks it) and not a notification. Errors go to the output of the instance, and end it.
//
// This runs before Electron's API exists, so the handlers do not need it up front, and the API is
// patched the moment something first requires it (the app does, in its first line).
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

let patched = false;
const load = Module._load;
Module._load = function guardedLoad(request) {
  const exports = load.apply(this, arguments);
  if (request === 'electron' && !patched && exports && typeof exports === 'object' && exports.dialog) {
    patched = true;
    exports.dialog.showErrorBox = (title, text) => console.error(`[guard] ${title}: ${text}`);
    // the instances run hidden, and a toast would show anyway
    if (exports.Notification && exports.Notification.prototype) exports.Notification.prototype.show = function () {};
    console.log('[guard] active');
  }
  return exports;
};
