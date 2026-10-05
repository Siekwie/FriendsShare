const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  getState: call('state:get'),
  setSettings: call('settings:set'),
  pickBaseDir: call('settings:pickBaseDir'),
  onSettingsChanged: (fn) => ipcRenderer.on('settings:changed', (_e, settings) => fn(settings)),
  openLink: call('link:open'),
  // matchmaking handshake and account (see account.js)
  accountHello: call('account:hello'),
  accountWelcome: call('account:welcome'),
  accountPlan: call('account:plan'),
  signIn: call('account:signIn'),
  cancelSignIn: call('account:cancelSignIn'),
  signOut: call('account:signOut'),
  openAccountPage: call('account:openPage'),
  onAccountChanged: (fn) => ipcRenderer.on('account:changed', (_e, state) => fn(state)),
  // the token changed, so the matchmaking connection has to start over
  onReconnect: (fn) => ipcRenderer.on('net:reconnect', () => fn()),
  syncDone: call('sync:done'),
  createShare: call('share:create'),
  addExistingFolder: call('share:addExisting'),
  generateCode: call('share:generate'),
  joinShare: call('share:join'),
  updateShare: call('share:update'),
  removeShare: call('share:remove'),
  openShare: call('share:open'),
  listFiles: call('share:files'),
  pickFiles: call('share:pick'),
  importPaths: call('share:import'),
  openRead: call('file:openRead'),
  read: call('file:read'),
  openWrite: call('file:openWrite'),
  write: call('file:write'),
  finish: call('file:finish'),
  close: call('file:close'),
  checkUpdate: call('update:check'),
  installUpdate: call('update:install'),
  onUpdateProgress: (fn) => ipcRenderer.on('update:progress', (_e, pct) => fn(pct)),
  // the disk path of a file dropped onto the window
  pathOf: (file) => webUtils.getPathForFile(file),
});
