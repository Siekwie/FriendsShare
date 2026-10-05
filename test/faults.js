// Test only: makes the disk of an app instance run full on demand, to see how the app copes. It is
// preloaded next to guard.js (NODE_OPTIONS=--require, see lib.js), so it runs before the app's own
// code, in the main process of that one instance.
//
//   FS_FAULT_FILE    while a file with this name exists, the writes of downloads fail with ENOSPC
//   FS_FAULT_AFTER   ... once this many bytes of downloads were written (default 0)
//
// A test turns the disk "full" and "empty" again by creating and deleting the file.
const fs = require('fs');

const flag = process.env.FS_FAULT_FILE;
if (flag) {
  const after = Number(process.env.FS_FAULT_AFTER || 0);
  const open = fs.promises.open;
  let written = 0;
  fs.promises.open = async function (...args) {
    const handle = await open.apply(this, args);
    const appendFile = handle.appendFile;
    // downloads are written with appendFile on a handle (see file:write in the main process)
    handle.appendFile = function (data, ...rest) {
      const size = data.byteLength !== undefined ? data.byteLength : Buffer.byteLength(data);
      if (fs.existsSync(flag) && written + size > after) {
        return Promise.reject(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', errno: -28, syscall: 'write' }));
      }
      written += size;
      return appendFile.call(this, data, ...rest);
    };
    return handle;
  };
  console.log('[faults] active');
}
