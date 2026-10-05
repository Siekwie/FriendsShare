// After packaging: writes dist/build.json with the fingerprints of this release. It is published
// next to the exe; the matchmaking server reads it to learn what an unmodified app of this
// version looks like (asar_sha256), and anyone can use it to check a download (exe_sha256).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const dist = path.join(__dirname, '..', 'dist');
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const info = {
  version: require('../package.json').version,
  asar_sha256: sha256(path.join(dist, 'win-unpacked', 'resources', 'app.asar')),
  exe_sha256: sha256(path.join(dist, 'FriendsShare.exe')),
};
fs.writeFileSync(path.join(dist, 'build.json'), JSON.stringify(info, null, 2) + '\n');
console.log(info);
