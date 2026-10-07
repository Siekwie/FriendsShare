// The pages of the operator's admin interface (lib/admin-web.js), rendered on the server. Every
// interpolated value goes through html``, which escapes it unless it is Html already, and there
// are no inline scripts or styles (the CSP forbids them): see admin-site/.
const { escapeHtml, compareVersions, isVersion } = require('./util');
const { GRACE_MS, isRunning } = require('./plan');

class Html {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

function render(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  return escapeHtml(String(value));
}

function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new Html(out);
}

// Markup written here, never anything a stranger sent.
const raw = (text) => new Html(text);

const ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>',
  arrow: '<path d="M5 12h14M13 5l7 7-7 7"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
};

const icon = (name, cls = 'icon') =>
  raw(
    `<svg class="${cls}" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`,
  );

// ---- formatting ----

const number = (n) => n.toLocaleString('en');
const plural = (n, one, many = `${one}s`) => `${number(n)} ${n === 1 ? one : many}`;
const iso = (ms) => new Date(ms).toISOString();
// times are stored in milliseconds
const fmt = (ms) => (ms ? `${iso(ms).slice(0, 16).replace('T', ' ')} UTC` : '–');

const UNITS = [
  [365 * 86_400, 'year'],
  [30 * 86_400, 'month'],
  [86_400, 'day'],
  [3600, 'hour'],
  [60, 'minute'],
];

// "3 days ago" for the past, "in 3 days" for what is still to come
function relative(ms, now) {
  const seconds = Math.round(Math.abs(now - ms) / 1000);
  for (const [size, name] of UNITS) {
    const n = Math.floor(seconds / size);
    if (n >= 1) return ms <= now ? `${n} ${name}${n === 1 ? '' : 's'} ago` : `in ${n} ${name}${n === 1 ? '' : 's'}`;
  }
  return ms <= now ? 'just now' : 'in a moment';
}

// A relative time, with the exact one as a tooltip.
const when = (ms, now) => (ms ? html`<time datetime="${iso(ms)}" title="${fmt(ms)}">${relative(ms, now)}</time>` : '–');

const PROVIDERS = { github: 'GitHub', google: 'Google' };
const providerName = (provider) => PROVIDERS[provider] || provider;

const mailto = (email) => `mailto:${encodeURIComponent(email).replaceAll('%40', '@')}`;

function planPill(account) {
  if (account.plan !== 'pro') return html`<span class="pill pill-plain">Free</span>`;
  return html`<span class="pill pill-ok">Pro</span>${account.sub_status === 'past_due' ? html` <span class="pill pill-warn">payment overdue</span>` : ''}${
    account.sub_cancel_at_period_end ? html` <span class="pill pill-plain">ending</span>` : ''
  }`;
}

function listUrl({ query, plan, page }) {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (plan) params.set('plan', plan);
  if (page && page > 1) params.set('page', String(page));
  const search = params.toString();
  return search ? `/accounts?${search}` : '/accounts';
}

// ---- layout ----

// site: { config, asset(name), now }   opts: { title, nav: 'overview' | 'accounts' | 'traffic', query, body }
function layout(site, opts) {
  const { config } = site;
  const navLink = (href, label, id) => html`<a href="${href}" ${opts.nav === id ? raw('aria-current="page"') : ''}>${label}</a>`;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title} – FriendsShare admin</title>
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="${site.asset('logo.svg')}" type="image/svg+xml">
<link rel="stylesheet" href="${site.asset('site.css')}">
<link rel="stylesheet" href="${site.asset('admin.css')}">
<script src="${site.asset('admin.js')}" defer></script>
</head>
<body class="admin">
<a class="skip" href="#main">Skip to content</a>
${config.stripe.testMode ? html`<div class="test-banner" role="note">Stripe test mode: a subscription bought now makes an account Pro that nobody pays for.</div>` : ''}
<header class="admin-header">
  <div class="admin-bar">
    <a class="brand" href="/" aria-label="FriendsShare admin, overview"><img src="${site.asset('logo.svg')}" alt="" width="30" height="30"><span>FriendsShare</span><span class="admin-tag">admin</span></a>
    <nav class="admin-nav" aria-label="Main">
      ${navLink('/', 'Overview', 'overview')}
      ${navLink('/accounts', 'Accounts', 'accounts')}
      ${navLink('/traffic', 'Traffic', 'traffic')}
    </nav>
    <form class="admin-search" action="/accounts" method="get" role="search">
      <input type="search" name="q" value="${opts.query || ''}" placeholder="Name, email or ID" aria-label="Find an account" maxlength="200">
      <button class="btn btn-sm" type="submit">${icon('search')}<span>Find</span></button>
    </form>
  </div>
</header>
<main id="main" class="admin-main">
${opts.body}
</main>
</body>
</html>
`.value;
}

// ---- the table of accounts ----

function accountTable(site, rows) {
  return html`<div class="table-wrap">
  <table class="admin-table">
    <thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Sign-in</th><th scope="col">Plan</th><th scope="col">Created</th><th scope="col">Last sign-in</th><th scope="col" class="num">Apps</th></tr></thead>
    <tbody>
      ${rows.map(
        (a) => html`<tr>
        <td class="wrap-any"><a class="row-link" href="/accounts/${a.id}">${a.name}</a></td>
        <td class="wrap-any">${a.email || html`<span class="muted">–</span>`}</td>
        <td>${a.providers.length ? a.providers.map(providerName).join(', ') : html`<span class="muted">–</span>`}</td>
        <td class="nowrap">${planPill(a)}</td>
        <td class="nowrap">${when(a.created_at, site.now)}</td>
        <td class="nowrap">${when(a.last_login_at, site.now)}</td>
        <td class="num">${a.apps}</td>
      </tr>`,
      )}
    </tbody>
  </table>
</div>`;
}

// ---- overview ----

const row = (label, value) => html`<div><dt>${label}</dt><dd>${value}</dd></div>`;

function setupRow(label, ok, value) {
  return html`<div class="setup-row"><dt>${label}</dt><dd><span class="state ${ok ? 'state-ok' : 'state-todo'}">${icon(ok ? 'check' : 'alert')}</span><span>${value}</span></dd></div>`;
}

// the server leaves its counts once a minute; after three it has missed two
const LIVE_STALE_MS = 180_000;

function liveCard(site, live, stats) {
  const stale = live && site.now - live.at > LIVE_STALE_MS;
  const versions = live
    ? Object.entries(live.byVersion)
        .filter(([version]) => isVersion(version))
        .sort(([a], [b]) => compareVersions(b, a))
    : [];
  return html`<section class="card" aria-labelledby="live-title">
    <h2 id="live-title">Right now</h2>
    ${
      !live
        ? html`<p class="muted">The server has not left its counts yet. They appear within a minute of its start.</p>`
        : html`${stale ? html`<p class="flash flash-error" role="alert">${icon('alert')}<span>The server last reported ${when(live.at, site.now)}. It may be down: <code>docker logs friendsshare</code></span></p>` : ''}
    <dl class="details details-wide">
      ${row('Apps connected', html`<strong>${number(live.connections)}</strong> <span class="muted">${number(live.byPlan.pro)} Pro · ${number(live.byPlan.free)} free</span>`)}
      ${row('App versions', versions.length ? versions.map(([version, count]) => `${version} × ${number(count)}`).join(', ') : html`<span class="muted">–</span>`)}
      ${row('Folders online', html`${number(live.hostedRooms)} <span class="muted">shared by an app that is connected</span>`)}
      ${row('Friends waiting', html`${number(live.waiting)} <span class="muted">for an owner who is away</span>`)}
      ${row('Turned away', html`${number(live.rejected.outdated)} outdated · ${number(live.rejected.unofficial)} unofficial <span class="muted">since the start</span>`)}
      ${row('Running since', html`${fmt(live.startedAt)} <span class="muted">(${when(live.startedAt, site.now)})</span>`)}
    </dl>`
    }
    <dl class="details details-wide details-more">
      ${row('Share codes', html`${number(stats.rooms)} <span class="muted">registered and not expired</span>`)}
      ${row('Blocked codes', number(stats.blocked))}
    </dl>
    ${live && !stale ? html`<p class="muted small">Counted by the server ${when(live.at, site.now)}; it does so every minute.</p>` : ''}
  </section>`;
}

function serverCard(site, state) {
  const { config } = site;
  const { stripe, operator, backup } = config;
  const host = new URL(config.baseUrl).host;
  const logins = [config.github.enabled && 'GitHub', config.google.enabled && 'Google'].filter(Boolean);
  const billingOff = stripe.complete
    ? 'Off: Stripe is set up, but no way to sign in is'
    : stripe.missing.length < 4
      ? `Off: ${stripe.missing.join(', ')} ${stripe.missing.length === 1 ? 'is' : 'are'} not set`
      : 'Off: the Stripe settings are not set';
  return html`<section class="card" aria-labelledby="setup-title">
    <h2 id="setup-title">Server</h2>
    <dl class="setup">
      ${setupRow('Website', true, html`<a href="${config.baseUrl}/" target="_blank" rel="noreferrer">${host}</a>`)}
      ${setupRow('Sign-in', logins.length > 0, logins.length ? logins.join(' and ') : 'Off: neither GitHub nor Google is set up, so there are no accounts')}
      ${setupRow(
        'Pro plan',
        config.billing,
        config.billing ? `On, ${stripe.testMode ? 'Stripe test mode' : 'Stripe live mode'}, ${config.prices.monthly} a month or ${config.prices.yearly} a year shown` : billingOff,
      )}
      ${
        config.billing
          ? setupRow(
              'Customer portal',
              Boolean(stripe.portalConfig),
              stripe.portalConfig ? "FriendsShare's own settings" : "STRIPE_PORTAL_CONFIG is not set: the Stripe account's default is used, which may be another product's",
            )
          : ''
      }
      ${setupRow('Free plan', true, config.enforceLimit ? `${plural(config.freeLimit, 'folder')} at a time` : 'No folder limit')}
      ${setupRow('Apps let in', config.requireOfficial, `${config.requireOfficial ? 'Official builds only' : 'Any build, official or not'}, from version ${config.minVersion}`)}
      ${setupRow('Newest release', Boolean(state.latestVersion), state.latestVersion || 'Not known yet: GitHub has not answered')}
      ${setupRow('Legal pages', operator.enabled, operator.enabled ? 'Imprint, privacy and terms' : 'Off: OPERATOR_NAME and OPERATOR_ADDRESS are not both set')}
      ${setupRow(
        'Backups',
        backup.intervalHours > 0 && state.backups.count > 0,
        !(backup.intervalHours > 0)
          ? 'Off: BACKUP_INTERVAL_HOURS is 0'
          : state.backups.count
            ? html`Newest ${when(state.backups.newest, site.now)}, ${plural(state.backups.count, 'snapshot')} kept`
            : 'None written yet',
      )}
    </dl>
  </section>`;
}

function blockedSection(site, blocked) {
  if (!blocked.length) return '';
  return html`
<section aria-labelledby="blocked-title">
  <div class="section-row"><h2 id="blocked-title">Blocked share codes</h2></div>
  <div class="table-wrap">
    <table class="admin-table">
      <thead><tr><th scope="col">Fingerprint</th><th scope="col">Blocked</th><th scope="col">Note</th></tr></thead>
      <tbody>
        ${blocked.map(
          (b) => html`<tr>
          <td><code title="${b.room}">${b.room.slice(0, 12)}…</code></td>
          <td class="nowrap">${when(b.created_at, site.now)}</td>
          <td class="wrap-any">${b.note || html`<span class="muted">–</span>`}</td>
        </tr>`,
        )}
      </tbody>
    </table>
  </div>
  <p class="muted small">The server never sees a share code, only its SHA-256 fingerprint. To block or unblock one: <code>deploy/ops.sh &lt;ssh-host&gt; block|unblock &lt;share code&gt;</code></p>
</section>`;
}

// data: { stats, state, newest, blocked }
function overviewPage(site, data) {
  const { stats, state, newest, blocked } = data;
  const body = html`
<h1>Overview</h1>

<ul class="tiles">
  <li class="tile"><span class="tile-label">Accounts</span><span class="tile-value">${number(stats.accounts)}</span><span class="tile-sub">${number(stats.pro)} Pro · ${number(stats.free)} free</span></li>
  <li class="tile"><span class="tile-label">Pro subscriptions</span><span class="tile-value">${number(stats.pro)}</span><span class="tile-sub">${number(stats.monthly)} monthly · ${number(stats.yearly)} yearly${stats.ending ? ` · ${number(stats.ending)} ending` : ''}${stats.pastDue ? ` · ${number(stats.pastDue)} overdue` : ''}</span></li>
  <li class="tile"><span class="tile-label">New in 7 days</span><span class="tile-value">${number(stats.last7Days)}</span><span class="tile-sub">${number(stats.last30Days)} in 30 days</span></li>
  <li class="tile"><span class="tile-label">Signed-in apps</span><span class="tile-value">${number(stats.apps)}</span><span class="tile-sub">${number(stats.appsUsed30Days)} used in 30 days · ${plural(stats.accountsWithApp, 'account')}</span></li>
</ul>

<div class="admin-grid">
  ${liveCard(site, state.live, stats)}
  ${serverCard(site, state)}
</div>

<section aria-labelledby="newest-title">
  <div class="section-row">
    <h2 id="newest-title">Newest accounts</h2>
    ${stats.accounts > newest.length ? html`<a href="/accounts">All ${number(stats.accounts)} accounts ${icon('arrow', 'icon icon-inline')}</a>` : ''}
  </div>
  ${newest.length ? accountTable(site, newest) : html`<p class="empty">No accounts yet. One appears here when somebody signs in for the first time. The free plan needs no account, so most people never make one.</p>`}
</section>
${blockedSection(site, blocked)}
`;
  return layout(site, { title: 'Overview', nav: 'overview', body });
}

// ---- the list ----

// data: { rows, total, query, plan, page, pageSize }
function accountsPage(site, data) {
  const { rows, total, query, plan, page, pageSize } = data;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const tab = (label, value) => html`<a href="${listUrl({ query, plan: value })}" ${plan === value ? raw('aria-current="true"') : ''}>${label}</a>`;

  const body = html`
<h1>${query ? html`Accounts matching <q>${query}</q>` : 'Accounts'}</h1>

<div class="section-row">
  <nav class="tabs" aria-label="Filter by plan">${tab('All')}${tab('Pro', 'pro')}${tab('Free', 'free')}</nav>
  <p class="muted count">${plural(total, 'account')}${pages > 1 ? ` · page ${page} of ${pages}` : ''}</p>
</div>

${
  rows.length
    ? accountTable(site, rows)
    : html`<p class="empty">${query ? 'Nothing found. Try a part of the name or of the email address, the account ID, or a Stripe customer or subscription ID.' : 'No accounts here yet.'}${query || plan ? html` <a href="/accounts">Show all accounts</a>` : ''}</p>`
}

${
  pages > 1
    ? html`<nav class="pager" aria-label="Pages">
  ${page > 1 ? html`<a class="btn btn-sm" href="${listUrl({ query, plan, page: page - 1 })}" rel="prev">Newer</a>` : ''}
  ${page < pages ? html`<a class="btn btn-sm" href="${listUrl({ query, plan, page: page + 1 })}" rel="next">Older</a>` : ''}
</nav>`
    : ''
}
`;
  return layout(site, { title: query ? `Accounts matching ${query}` : 'Accounts', nav: 'accounts', query, body });
}

// ---- one account ----

const INTERVALS = { month: 'Monthly', year: 'Yearly' };

function subscriptionCard(site, a) {
  const { stripe } = site.config;
  const dashboard = (kind, id) => `https://dashboard.stripe.com/${stripe.testMode ? 'test/' : ''}${kind}/${encodeURIComponent(id)}`;
  const link = (kind, id) => html`<a href="${dashboard(kind, id)}" target="_blank" rel="noreferrer">${id} ${icon('external', 'icon icon-inline')}</a>`;
  const running = Boolean(a.stripe_subscription_id) && isRunning(a.sub_status);
  const period = a.sub_period_end ? html`${fmt(a.sub_period_end)} <span class="muted">(${when(a.sub_period_end, site.now)})</span>` : '–';
  return html`<section class="card" aria-labelledby="sub-title">
    <h2 id="sub-title">Subscription</h2>
    ${
      !a.stripe_subscription_id && !a.stripe_customer_id
        ? html`<p class="muted">None. This account has never started a checkout.</p>`
        : html`<dl class="details">
      ${row('Plan', planPill(a))}
      ${a.stripe_subscription_id ? row('Stripe says', a.sub_status || '–') : ''}
      ${a.stripe_subscription_id ? row('Billing', INTERVALS[a.sub_interval] || '–') : ''}
      ${a.stripe_subscription_id ? row(!running ? 'Paid until' : a.sub_cancel_at_period_end ? 'Ends' : 'Renews', period) : ''}
      ${a.stripe_customer_id ? row('Customer', html`<span class="wrap-any">${link('customers', a.stripe_customer_id)}</span>`) : ''}
      ${a.stripe_subscription_id ? row('Subscription', html`<span class="wrap-any">${link('subscriptions', a.stripe_subscription_id)}</span>`) : ''}
      ${a.checkout_session_id ? row('Last checkout', html`<span class="wrap-any mono">${a.checkout_session_id}</span>`) : ''}
    </dl>
    ${
      running && a.sub_period_end && a.sub_period_end <= site.now && a.plan === 'pro'
        ? html`<p class="muted small">The paid period is over. The account stays Pro for ${Math.round(GRACE_MS / 86_400_000)} days after it, in case a payment or its news is late.</p>`
        : ''
    }
    ${!a.stripe_subscription_id ? html`<p class="muted small">A checkout was started, but no subscription came of it.</p>` : ''}`
    }
  </section>`;
}

// data: { account, identities, sessions }
function accountPage(site, data) {
  const { account: a, identities, sessions } = data;
  const body = html`
<p class="crumbs"><a href="/accounts">Accounts</a> <span aria-hidden="true">/</span> ${a.id}</p>
<div class="title-row"><h1>${a.name}</h1>${planPill(a)}</div>

<div class="admin-grid">
  <section class="card" aria-labelledby="details-title">
    <h2 id="details-title">Details</h2>
    <dl class="details">
      ${row('Email', a.email ? html`<a class="wrap-any" href="${mailto(a.email)}">${a.email}</a>` : '–')}
      ${row('Account ID', html`<code>${a.id}</code>`)}
      ${row('Created', html`${fmt(a.created_at)} <span class="muted">(${when(a.created_at, site.now)})</span>`)}
      ${row('Last sign-in', a.last_login_at ? html`${fmt(a.last_login_at)} <span class="muted">(${when(a.last_login_at, site.now)})</span>` : '–')}
    </dl>
  </section>
  ${subscriptionCard(site, a)}
</div>

<section aria-labelledby="logins-title">
  <div class="section-row"><h2 id="logins-title">Sign-in methods</h2></div>
  ${
    identities.length
      ? html`<div class="table-wrap">
    <table class="admin-table">
      <thead><tr><th scope="col">Provider</th><th scope="col">Email there</th><th scope="col">User ID there</th><th scope="col">Added</th><th scope="col">Last sign-in</th></tr></thead>
      <tbody>
        ${identities.map(
          (i) => html`<tr>
          <td>${providerName(i.provider)}</td>
          <td class="wrap-any">${i.email || html`<span class="muted">–</span>`}</td>
          <td><code>${i.subject}</code></td>
          <td class="nowrap">${when(i.created_at, site.now)}</td>
          <td class="nowrap">${when(i.last_login_at, site.now)}</td>
        </tr>`,
        )}
      </tbody>
    </table>
  </div>`
      : html`<p class="empty">No sign-in method is left on this account.</p>`
  }
</section>

<section aria-labelledby="sessions-title">
  <div class="section-row"><h2 id="sessions-title">Signed in <span class="muted">${sessions.length}</span></h2></div>
  ${
    sessions.length
      ? html`<div class="table-wrap">
    <table class="admin-table">
      <thead><tr><th scope="col">Where</th><th scope="col">Signed in</th><th scope="col">Last used</th><th scope="col">Good until</th></tr></thead>
      <tbody>
        ${sessions.map(
          (s) => html`<tr>
          <td>${s.kind === 'app' ? 'The app on a PC' : 'A browser'}</td>
          <td class="nowrap">${when(s.created_at, site.now)}</td>
          <td class="nowrap">${s.kind === 'app' ? when(s.last_used_at, site.now) : html`<span class="muted">not recorded</span>`}</td>
          <td class="nowrap">${when(s.expires_at, site.now)}</td>
        </tr>`,
        )}
      </tbody>
    </table>
  </div>
  <p class="muted small">A Pro account works on ${plural(site.config.tuning.proDevices, 'PC')} at a time. Only a hash of each sign-in is stored, so there is nothing here that could be used to sign in.</p>`
      : html`<p class="empty">Signed in nowhere right now.</p>`
  }
</section>

<p class="muted small page-foot">This page only shows what is stored. A subscription is changed or refunded in Stripe; an account is deleted by its owner on the account page of the website.</p>
`;
  return layout(site, { title: a.name, nav: 'accounts', body });
}

// ---- traffic ----

const shortDay = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const longDay = new Intl.DateTimeFormat('en', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const asDate = (day) => new Date(`${day}T00:00:00Z`);

// The axis ends on a round number whose half is round too: 4, 10, 20, 40, 50, 100...
function axisMax(max) {
  for (let scale = 1; ; scale *= 10) {
    for (const step of [4, 10, 20, 40, 50]) if (max <= step * scale) return step * scale;
  }
}

// One column per day. Sizes are SVG attributes and colours come from admin.css, because the page's
// CSP allows no inline styles. The values are also in the table at the end of the page, and
// admin.js shows the one under the pointer.
function columnChart(days, field, noun) {
  const width = 560;
  const height = 196;
  const left = 36;
  const right = 10;
  const top = 18;
  const bottom = 24;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const base = top + plotHeight;
  const slot = plotWidth / days.length;
  const bar = Math.min(24, Math.max(2, slot - 4));
  const values = days.map((d) => d[field]);
  const peak = Math.max(...values);
  const max = axisMax(peak);
  const y = (v) => base - (v / max) * plotHeight;
  const total = values.reduce((a, b) => a + b, 0);
  const peakAt = values.indexOf(peak);
  const last = days.length - 1;
  const count = (n) => `${number(n)} ${n === 1 ? noun[0] : noun[1]}`;

  const columns = days.map((d, i) => {
    const v = d[field];
    const x = left + i * slot + (slot - bar) / 2;
    const h = base - y(v);
    const r = Math.min(4, h, bar / 2);
    // rounded where the data ends, square on the baseline
    const shape = `M${x.toFixed(1)},${base} V${(base - h + r).toFixed(1)} q0,${-r} ${r},${-r} h${(bar - 2 * r).toFixed(1)} q${r},0 ${r},${r} V${base} Z`;
    // the value is written out for the highest day and for today; the axis and the table carry the rest
    const labelled = v > 0 && (i === peakAt || (i === last && Math.abs(last - peakAt) > 2));
    return html`<g class="chart-col" tabindex="0" data-tip="${count(v)}" data-tip-sub="${i === last ? 'Today, ' : ''}${longDay.format(asDate(d.day))}">
      <rect class="chart-hit" x="${(left + i * slot).toFixed(1)}" y="${top}" width="${slot.toFixed(1)}" height="${plotHeight}"></rect>
      ${v > 0 ? html`<path class="chart-bar" d="${shape}"></path>` : ''}
      ${labelled ? html`<text class="chart-value" x="${(x + bar / 2).toFixed(1)}" y="${(y(v) - 5).toFixed(1)}" text-anchor="middle">${number(v)}</text>` : ''}
    </g>`;
  });
  // a date under every seventh column, counted back from today
  const dates = days.map((d, i) =>
    (last - i) % 7 === 0
      ? html`<text class="chart-tick" x="${(left + i * slot + slot / 2).toFixed(1)}" y="${height - 6}" text-anchor="${i === last ? 'end' : 'middle'}">${i === last ? 'Today' : shortDay.format(asDate(d.day))}</text>`
      : '',
  );
  const label = total
    ? `${count(total)} in the last ${days.length} days, the most on ${shortDay.format(asDate(days[peakAt].day))} (${number(peak)})`
    : `No ${noun[1]} in the last ${days.length} days`;

  return html`<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${label}">
    ${[0, max / 2, max].map(
      (tick) => html`<line class="${tick === 0 ? 'chart-axis' : 'chart-grid'}" x1="${left}" x2="${width - right}" y1="${y(tick).toFixed(1)}" y2="${y(tick).toFixed(1)}"></line>
    <text class="chart-tick" x="${left - 7}" y="${(y(tick) + 3.5).toFixed(1)}" text-anchor="end">${number(tick)}</text>`,
    )}
    ${columns}
    ${dates}
  </svg>`;
}

function countTable(title, head, rows, empty, label = (name) => name) {
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  return html`<section class="card" aria-label="${title}">
    <h2>${title}</h2>
    ${
      rows.length
        ? html`<table class="count-table">
      <thead><tr><th scope="col">${head}</th><th scope="col" class="num">Count</th><th scope="col" class="num">Share</th></tr></thead>
      <tbody>
        ${rows.map((r) => html`<tr><td class="wrap-any">${label(r.name)}</td><td class="num">${number(r.count)}</td><td class="num muted">${Math.round((100 * r.count) / total)}%</td></tr>`)}
      </tbody>
    </table>`
        : html`<p class="muted">${empty}</p>`
    }
  </section>`;
}

const PAGE_NAMES = {
  '/': 'Start page  /',
  '/login': 'Sign-in  /login',
  '/account': 'Account  /account',
  '/imprint': 'Imprint  /imprint',
  '/privacy': 'Privacy  /privacy',
  '/terms': 'Terms  /terms',
};

// data: { report (lib/stats.js trafficReport), stats (accountStats), live (liveCounts or null) }
function trafficPage(site, data) {
  const { report: r, stats, live } = data;
  const tile = (label, field) =>
    html`<li class="tile"><span class="tile-label">${label}</span><span class="tile-value">${number(r.month[field])}</span><span class="tile-sub">today ${number(r.today[field])} · 7 days ${number(r.week[field])} · ever ${number(r.allTime[field])}</span></li>`;
  const share = (n) => (r.month.visitors ? `${Math.round((1000 * n) / r.month.visitors) / 10}%` : '–');
  const step = (label, n) => html`<tr><td>${label}</td><td class="num">${number(n)}</td><td class="num muted">${share(n)}</td></tr>`;

  const body = html`
<h1>Traffic</h1>
<p class="muted page-note">Anonymous totals per day (UTC), counted by the site itself: no cookies, nothing stored about a visitor. Crawlers are left out as far as they say who they are. A visitor is counted once per day, so over several days the number means visits. New accounts are those that still exist.</p>

<h2 class="tiles-title">Last ${r.days.length} days</h2>
<ul class="tiles tiles-6">
  ${tile('Visitors', 'visitors')}
  ${tile('Page views', 'views')}
  ${tile('Downloads', 'downloads')}
  ${tile('New accounts', 'signups')}
  ${tile('Checkouts started', 'checkouts')}
  ${tile('Pro bought', 'bought')}
</ul>

<div class="admin-grid">
  <section class="card" aria-labelledby="chart-visitors">
    <h2 id="chart-visitors">Visitors per day</h2>
    ${columnChart(r.days, 'visitors', ['visitor', 'visitors'])}
  </section>
  <section class="card" aria-labelledby="chart-downloads">
    <h2 id="chart-downloads">Downloads per day</h2>
    ${columnChart(r.days, 'downloads', ['download', 'downloads'])}
  </section>
</div>

<div class="admin-grid">
  <section class="card" aria-labelledby="funnel-title">
    <h2 id="funnel-title">From visit to Pro <span class="muted">last ${r.days.length} days</span></h2>
    <table class="count-table">
      <thead><tr><th scope="col">Step</th><th scope="col" class="num">Count</th><th scope="col" class="num">Of visitors</th></tr></thead>
      <tbody>
        ${step('Visited the site', r.month.visitors)}
        ${step('Clicked the download', r.month.downloads)}
        ${step('Made an account', r.month.signups)}
        ${step('Clicked Upgrade and went to the checkout', r.month.checkouts)}
        ${step('Bought Pro', r.month.bought)}
      </tbody>
    </table>
    <p class="muted small">Paying right now: ${plural(stats.pro, 'Pro subscription')}.${live ? html` ${plural(live.connections, 'app')} connected ${when(live.at, site.now)}.` : ''} The free plan needs no account, and an app that updates itself is not a download here, so the connected apps say more about use than either number.</p>
  </section>
  ${countTable('Pages', 'Page', r.pages, 'No page views yet.', (name) => PAGE_NAMES[name] || name)}
</div>

<div class="admin-grid">
  ${countTable('Where visitors came from', 'Site', r.referrers, 'No visits from other sites yet. Visitors who type the address or use a bookmark send no origin.')}
  ${countTable("Visitors' systems", 'System', r.systems, 'No visitors yet.')}
</div>

<details class="card daily">
  <summary>Every day as numbers</summary>
  <div class="table-wrap">
    <table class="admin-table">
      <thead><tr><th scope="col">Day</th><th scope="col" class="num">Visitors</th><th scope="col" class="num">Page views</th><th scope="col" class="num">Downloads</th><th scope="col" class="num">New accounts</th><th scope="col" class="num">Checkouts started</th><th scope="col" class="num">Pro bought</th></tr></thead>
      <tbody>
        ${[...r.days].reverse().map(
          (d) => html`<tr><td class="nowrap">${longDay.format(asDate(d.day))}</td><td class="num">${number(d.visitors)}</td><td class="num">${number(d.views)}</td><td class="num">${number(d.downloads)}</td><td class="num">${number(d.signups)}</td><td class="num">${number(d.checkouts)}</td><td class="num">${number(d.bought)}</td></tr>`,
        )}
      </tbody>
    </table>
  </div>
</details>
`;
  return layout(site, { title: 'Traffic', nav: 'traffic', body });
}

// ---- messages ----

function adminMessagePage(site, { title, text }) {
  const body = html`
<h1>${title}</h1>
<p class="lede-admin">${text}</p>
<p><a class="btn" href="/">Back to the overview</a></p>
`;
  return layout(site, { title, body });
}

module.exports = { html, raw, Html, relative, overviewPage, accountsPage, accountPage, trafficPage, adminMessagePage };
