// FriendsShare admin interface: accounts, subscriptions, what the server is doing and the traffic
// totals, for whoever runs it. A process of its own that reads the server's database (DATA_DIR)
// and listens on ADMIN_HOST:ADMIN_PORT. It has no login, so that port must stay private: see
// lib/admin-web.js and deploy/compose.yml.
const { loadConfig, ConfigError } = require('./lib/config');
const { installProcessHandlers } = require('./lib/process');
const { openDb } = require('./lib/db');
const { createAdminServer } = require('./lib/admin-web');

installProcessHandlers(process, { log: (line) => console.error(line), exit: (code) => process.exit(code) });

let config;
try {
  config = loadConfig();
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`Configuration error: ${err.message}`);
  process.exit(1);
}

const db = openDb(config.dbPath);
const server = createAdminServer({ config, db });

server.on('error', (err) => {
  console.error(`Could not listen on ${config.admin.host}:${config.admin.port}: ${err.message}`);
  process.exit(1);
});
server.listen(config.admin.port, config.admin.host, () => {
  console.log(`FriendsShare admin on http://${config.admin.host}:${server.address().port} (no login: this port must stay private)`);
});

let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received, shutting down`);
    server.close(() => {
      db.close();
      process.exit(0);
    });
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
