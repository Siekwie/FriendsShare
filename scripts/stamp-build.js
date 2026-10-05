// CI only: marks the build as an official one. Derives this version's build key from the
// BUILD_SECRET repository secret and puts it into the app as app/build.json (never committed).
// The matchmaking server knows the same secret and only talks to apps that can prove they hold
// the key of their version, so a copy built from source cannot use the official server.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const secret = process.env.BUILD_SECRET;
if (!secret) {
  console.error('BUILD_SECRET is not set');
  process.exit(1);
}
const { version } = require('../package.json');
const key = crypto.createHmac('sha256', secret).update(`friendsshare-build:${version}`).digest('hex');
fs.writeFileSync(path.join(__dirname, '..', 'app', 'build.json'), JSON.stringify({ key }));
console.log(`Stamped official build ${version}`);
