// FriendsShare server: the website, accounts, Pro subscriptions, and the matchmaking that
// introduces two apps to each other (WebRTC signaling). Files never pass through here, and it
// never sees a share code: a room is named by the SHA-256 of the code.
//
// PORT and DATA_DIR work as before; everything else is configured in lib/config.js.
const { loadConfig, describeConfig, ConfigError } = require('./lib/config');
const { installProcessHandlers } = require('./lib/process');
const { createServer } = require('./lib/server');

installProcessHandlers(process, { log: (line) => console.error(line), exit: (code) => process.exit(code) });

let config;
try {
  config = loadConfig();
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`Configuration error: ${err.message}`);
  process.exit(1);
}

const app = createServer({ config });

app.listen(config.port).then(
  ({ port }) => {
    console.log(`FriendsShare server on :${port}`);
    for (const line of describeConfig(config)) console.log(line);
  },
  (err) => {
    console.error(`Could not listen on :${config.port}: ${err.message}`);
    process.exit(1);
  },
);

// docker stop sends SIGTERM: tell the apps, finish what is running, close the database
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received, shutting down`);
    app.close().then(() => process.exit(0));
    // docker waits ten seconds before it kills the container
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
