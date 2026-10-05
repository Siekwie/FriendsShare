const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  getState: call('state:get'),
  createShare: call('share:create'),
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
  // the disk path of a file dropped onto the window
  pathOf: (file) => webUtils.getPathForFile(file),
});
