// The one place that reads the environment. Everything else gets the resulting object, so tests
// can build a server with any configuration without touching process.env.
const path = require('node:path');
const { isVersion } = require('./util');

class ConfigError extends Error {}

function loadConfig(env = process.env) {
  const str = (key) => (typeof env[key] === 'string' && env[key].trim() ? env[key].trim() : null);
  const flag = (key) => ['1', 'true', 'yes', 'on'].includes((str(key) || '').toLowerCase());
  const num = (key, fallback, min = -Infinity) => {
    const n = Number(str(key));
    return str(key) !== null && Number.isFinite(n) && n >= min ? n : fallback;
  };

  const port = num('PORT', 8080, 0);
  const dataDir = path.resolve(str('DATA_DIR') || path.join(__dirname, '..', 'data'));

  let baseUrl;
  try {
    const url = new URL(str('BASE_URL') || `http://localhost:${port}`);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('scheme');
    // only the origin counts: it is compared with the Origin header of browsers
    baseUrl = url.origin;
  } catch {
    throw new ConfigError('BASE_URL must be an http:// or https:// address such as https://friendsshare.example.com');
  }

  const github = { clientId: str('GITHUB_CLIENT_ID'), clientSecret: str('GITHUB_CLIENT_SECRET') };
  github.enabled = Boolean(github.clientId && github.clientSecret);
  const google = { clientId: str('GOOGLE_CLIENT_ID'), clientSecret: str('GOOGLE_CLIENT_SECRET') };
  google.enabled = Boolean(google.clientId && google.clientSecret);

  const stripe = {
    secretKey: str('STRIPE_SECRET_KEY'),
    webhookSecret: str('STRIPE_WEBHOOK_SECRET'),
    priceMonthly: str('STRIPE_PRICE_MONTHLY'),
    priceYearly: str('STRIPE_PRICE_YEARLY'),
    portalConfig: str('STRIPE_PORTAL_CONFIG'),
    managedPayments: flag('STRIPE_MANAGED_PAYMENTS'),
  };
  const needed = { STRIPE_SECRET_KEY: stripe.secretKey, STRIPE_WEBHOOK_SECRET: stripe.webhookSecret, STRIPE_PRICE_MONTHLY: stripe.priceMonthly, STRIPE_PRICE_YEARLY: stripe.priceYearly };
  stripe.missing = Object.keys(needed).filter((name) => !needed[name]);
  stripe.complete = stripe.missing.length === 0;
  // Without a way to sign in nobody could buy Pro, so billing then behaves exactly as if off.
  const billing = stripe.complete && (github.enabled || google.enabled);

  const requireOfficial = flag('REQUIRE_OFFICIAL');
  const buildSecret = str('BUILD_SECRET');
  // better to refuse to start than to turn every app away with a confusing "unofficial"
  if (requireOfficial && !buildSecret) throw new ConfigError('BUILD_SECRET is required when REQUIRE_OFFICIAL=1');

  const minVersion = str('MIN_VERSION') || '1.2.0';
  if (!isVersion(minVersion)) throw new ConfigError('MIN_VERSION must look like 1.2.0');

  const releaseRepo = str('RELEASE_REPO') || 'Siekwie/FriendsShare';
  if (!/^[A-Za-z0-9-]+\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/.test(releaseRepo)) throw new ConfigError('RELEASE_REPO must look like owner/name');

  // "version:asar_sha256,..." A typo here would silently lock an app out, so it is an error.
  // "version:dev" admits an app run from source that holds the build key (the end-to-end tests).
  const extraBuilds = new Map();
  for (const entry of (str('EXTRA_BUILDS') || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const at = entry.indexOf(':');
    const version = entry.slice(0, at);
    const hash = entry.slice(at + 1).toLowerCase();
    if (at < 1 || !isVersion(version) || !/^(?:[0-9a-f]{64}|dev)$/.test(hash)) {
      throw new ConfigError('EXTRA_BUILDS must look like 1.2.0:<64 hex characters>,1.2.1:<64 hex characters> (or 1.2.0:dev)');
    }
    if (!extraBuilds.has(version)) extraBuilds.set(version, new Set());
    extraBuilds.get(version).add(hash);
  }

  const operator = {
    name: str('OPERATOR_NAME'),
    address: (str('OPERATOR_ADDRESS') || '').split(';').map((s) => s.trim()).filter(Boolean),
    email: str('OPERATOR_EMAIL'),
    hosting: str('OPERATOR_HOSTING'),
  };
  // the legal pages are only worth showing once somebody is named on them
  operator.enabled = Boolean(operator.name && operator.address.length);

  return {
    port,
    dataDir,
    dbPath: path.join(dataDir, 'friendsshare.db'),
    siteDir: path.resolve(__dirname, '..', 'site'),
    baseUrl,
    secureCookies: baseUrl.startsWith('https://'),
    // Over https the cookies carry the __Host- prefix: a browser then only accepts them from this
    // exact host over a secure connection, so a sibling subdomain cannot plant one. That also means
    // Path=/ for the sign-in state. Plain http (development) has neither.
    cookies: baseUrl.startsWith('https://')
      ? { session: '__Host-fs_session', state: '__Host-fs_oauth_state', statePath: '/' }
      : { session: 'fs_session', state: 'fs_oauth_state', statePath: '/auth' },
    trustProxy: flag('TRUST_PROXY'),
    // null: createServer reads or creates DATA_DIR/secret.key
    appSecret: str('APP_SECRET'),

    github,
    google,
    anyLogin: github.enabled || google.enabled,
    stripe,
    billing,
    prices: {
      monthly: str('PRICE_DISPLAY_MONTHLY') || '€1.99',
      yearly: str('PRICE_DISPLAY_YEARLY') || '€11.88',
      yearlyPerMonth: str('PRICE_DISPLAY_YEARLY_PER_MONTH') || '€0.99',
    },
    freeLimit: Math.floor(num('FREE_LIMIT', 5, 1)),
    // no way to upgrade means no limit
    enforceLimit: billing || flag('ENFORCE_LIMIT'),

    requireOfficial,
    buildSecret,
    minVersion,
    releaseRepo,
    repoUrl: `https://github.com/${releaseRepo}`,
    extraBuilds,

    // Against anybody who just opens sockets and registers rooms. Per client address (an IPv6
    // address counts as its /64), except maxRooms, which is for the whole server.
    wsMaxPerAddress: Math.floor(num('WS_MAX_PER_ADDRESS', 40, 1)),
    wsUpgradesPerMinute: Math.floor(num('WS_UPGRADES_PER_MINUTE', 120, 1)),
    // rooms the database did not know yet; registering a known room again never counts
    roomsPerAddressHour: Math.floor(num('ROOMS_PER_ADDRESS_HOUR', 60, 1)),
    maxRooms: Math.floor(num('MAX_ROOMS', 200_000, 1)),

    backup: {
      dir: path.join(dataDir, 'backups'),
      intervalHours: num('BACKUP_INTERVAL_HOURS', 24),
      keep: Math.max(1, Math.floor(num('BACKUP_KEEP', 7))),
    },
    operator,

    // Not read from the environment; tests shorten these.
    tuning: {
      helloTimeoutMs: 15_000,
      pingIntervalMs: 30_000,
      maxPayload: 64 * 1024,
      // a burst this large covers an app registering a big list of folders after a reconnect
      messageBurst: 1200,
      messagesPerSecond: 100,
      proDevices: 5,
      // before the welcome: one message, and a hello is small
      helloBytes: 4096,
      // abuse cap for connections without a folder limit
      maxRoomsPerConnection: 1000,
      roomMaxAgeMs: 400 * 86_400_000,
      // each kind of sign-in request has its own count, so that one cannot use up another's
      authRate: { max: 40, windowMs: 10 * 60_000 },
      // what a signed-in person may do that costs us a call to Stripe or a row in the database
      accountRates: {
        checkout: { max: 10, windowMs: 3_600_000 },
        portal: { max: 20, windowMs: 3_600_000 },
        weblink: { max: 20, windowMs: 3_600_000 },
      },
      jsonBodyBytes: 64 * 1024,
      formBodyBytes: 8 * 1024,
      webhookBodyBytes: 1024 * 1024,
      // a request that is slow to arrive is not worth waiting for
      requestTimeoutMs: 30_000,
      headersTimeoutMs: 15_000,
      cleanupIntervalMs: 3_600_000,
      backupCheckMs: 3_600_000,
      releaseRefreshMs: 3_600_000,
      planCheckMs: 60_000,
      buildMissMs: 60_000,
      fetchTimeoutMs: 15_000,
    },
  };
}

// What the operator should know after a start, without any secret in it.
function describeConfig(config) {
  const logins = [config.github.enabled && 'github', config.google.enabled && 'google'].filter(Boolean);
  const lines = [
    `[config] ${config.baseUrl}, sign-in: ${logins.join(', ') || 'off'}, billing: ${config.billing ? 'on' : 'off'}, ` +
      `folder limit: ${config.enforceLimit ? config.freeLimit : 'off'}, official builds only: ${config.requireOfficial ? 'yes' : 'no'}, minimum app version ${config.minVersion}`,
  ];
  const some = config.stripe.missing.length < 4;
  if (some && config.stripe.missing.length) lines.push(`[config] Stripe is only partly set up (missing ${config.stripe.missing.join(', ')}), so billing stays off.`);
  if (config.stripe.complete && !config.anyLogin) lines.push('[config] Stripe is set up but no sign-in provider is, so billing stays off.');
  if (config.billing && !config.stripe.portalConfig) {
    lines.push(
      "[config] WARNING STRIPE_PORTAL_CONFIG is not set, so the customer portal falls back to the Stripe account's default configuration, which may belong to another product. " +
        'Set it to the id (bpc_...) of the portal configuration made for FriendsShare.',
    );
  }
  if (!config.operator.enabled) lines.push('[config] OPERATOR_NAME and OPERATOR_ADDRESS are not both set, so the imprint, privacy and terms pages are off.');
  return lines;
}

module.exports = { loadConfig, describeConfig, ConfigError };
