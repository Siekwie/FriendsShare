// The website: static files from site/ plus a tiny template step for the HTML pages.
//
// Template step (HTML only):
//   {{key}}  escaped value      {{{key}}}  raw value      an unknown key is an empty string
//   <!--if key-->...<!--endif-->   kept when the value is truthy   (<!--if !key--> for the opposite)
//   <!--include name-->            inserts site/partials/name.html, which is templated as well
// if-blocks do not nest.
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream');
const { escapeHtml } = require('./util');
const { send } = require('./http');

const CSP =
  "default-src 'self'; img-src 'self' data: https://avatars.githubusercontent.com https://*.googleusercontent.com; " +
  "style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

// addresses without a file extension
const PAGES = {
  '/': 'index.html',
  '/login': 'login.html',
  '/account': 'account.html',
  '/imprint': 'imprint.html',
  '/privacy': 'privacy.html',
  '/terms': 'terms.html',
};
// These name the operator, so they exist only when there is one.
const LEGAL = new Set(['imprint.html', 'privacy.html', 'terms.html']);
// Not pages of their own: the server fills them in itself, for the cases that need them.
const HIDDEN = new Set(['404.html', 'link.html']);
// Windows treats these names as devices, whatever comes after them (the superscript digits too).
const DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;

// What the sign-in page for a link from the app looks like when site/link.html is missing. It is a
// form and nothing else: the person has to say yes before anything happens.
const LINK_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sign in to FriendsShare</title>
</head>
<body>
<h1>Sign in to FriendsShare?</h1>
<p>This signs this browser in as {{link_name}} ({{link_email}}).</p>
<form method="post" action="/auth/link">
<input type="hidden" name="code" value="{{link_code}}">
<input type="hidden" name="next" value="{{link_next}}">
<button type="submit">Sign in</button>
</form>
<p><a href="/">Cancel</a></p>
</body>
</html>
`;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// Whether a path inside site/ (split into its segments) may be served, whatever is or is not on
// disk under that name. Names are compared without regard to case, because on Windows and macOS
// "Partials" and "IMPRINT.html" are the same files as "partials" and "imprint.html".
function servable(parts, operatorEnabled) {
  if (!parts.length) return false;
  // No empty, dot or hidden segments (that also rules out ".."), and no directory listings. A name
  // that ends in a dot or a space is the same file without it on Windows, "~" is how it writes its
  // short names, and its device names open no file at all.
  if (parts.some((p) => !p || p.startsWith('.') || /[. ]$/.test(p) || p.includes('~') || DEVICE.test(p))) return false;
  const first = parts[0].toLowerCase();
  // partials are building blocks, not pages; and "internal" is the operator's, never a file
  if (first === 'partials' || first === 'internal') return false;
  if (parts.length === 1) {
    if (HIDDEN.has(first)) return false;
    if (LEGAL.has(first) && !operatorEnabled) return false;
  }
  return true;
}

// One pass over the text: replaced text is never scanned again, so a value that happens to
// contain "{{" or "<!--if" cannot turn into template syntax.
const TOKEN =
  /<!--if\s+(!?)(\w+)\s*-->([\s\S]*?)<!--endif-->|<!--include\s+([\w-]+)\s*-->|\{\{\{\s*(\w+)\s*\}\}\}|\{\{\s*(\w+)\s*\}\}/g;

function createSite({ config, now, latestVersion }) {
  const root = config.siteDir;

  function context() {
    const op = config.operator;
    return {
      site_url: config.baseUrl,
      repo_url: config.repoUrl,
      download_url: `${config.repoUrl}/releases/latest/download/FriendsShare.exe`,
      version: latestVersion() || '',
      year: new Date(now()).getUTCFullYear(),
      free_limit: config.freeLimit,
      billing: config.billing,
      price_monthly: config.prices.monthly,
      price_yearly: config.prices.yearly,
      price_yearly_per_month: config.prices.yearlyPerMonth,
      github_login: config.github.enabled,
      google_login: config.google.enabled,
      any_login: config.anyLogin,
      operator: op.enabled,
      operator_name: op.name || '',
      // already HTML: every line is escaped here, so the page uses {{{operator_address}}}
      operator_address: op.address.map(escapeHtml).join('<br>'),
      operator_email: op.email || '',
      operator_hosting: op.hosting || '',
      // how long a deleted account can live on in the backups
      backup_days: config.backup.intervalHours > 0 ? Math.ceil((config.backup.intervalHours * config.backup.keep) / 24) : 0,
    };
  }

  function partial(name) {
    try {
      return fs.readFileSync(path.join(root, 'partials', `${name}.html`), 'utf8');
    } catch {
      return '';
    }
  }

  function render(text, values, depth = 0) {
    return text.replace(TOKEN, (_all, negate, ifKey, ifBody, include, rawKey, escapedKey) => {
      if (ifKey !== undefined) {
        const truthy = Object.hasOwn(values, ifKey) && Boolean(values[ifKey]);
        return truthy !== (negate === '!') ? render(ifBody, values, depth) : '';
      }
      // a partial that includes itself must not loop forever
      if (include !== undefined) return depth < 3 ? render(partial(include), values, depth + 1) : '';
      const key = rawKey ?? escapedKey;
      const value = Object.hasOwn(values, key) && values[key] != null ? String(values[key]) : '';
      return rawKey !== undefined ? value : escapeHtml(value);
    });
  }

  // The file a request path stands for, or null. Nothing outside site/ is ever reachable.
  async function locate(pathname) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (/[\\:*?"<>|\x00-\x1f]/.test(rel)) return null;
    if (Object.hasOwn(PAGES, rel)) rel = `/${PAGES[rel]}`;
    const parts = rel.split('/').slice(1);
    if (!servable(parts, config.operator.enabled)) return null;
    const file = path.join(root, ...parts);
    try {
      // a link inside site/ must not lead out of it either
      const [real, realRoot] = await Promise.all([fs.promises.realpath(file), fs.promises.realpath(root)]);
      if (!real.startsWith(realRoot + path.sep)) return null;
      // What the file system calls the file is what counts: another spelling of a name that is not
      // served, or a link to such a file, is not served either.
      if (!servable(path.relative(realRoot, real).split(path.sep), config.operator.enabled)) return null;
      const stat = await fs.promises.stat(real);
      return stat.isFile() ? { file: real, size: stat.size, ext: path.extname(real).toLowerCase() } : null;
    } catch {
      return null;
    }
  }

  async function page(file) {
    return render(await fs.promises.readFile(file, 'utf8'), context());
  }

  // A page the server serves only when it says so (site/link.html), with values of its own.
  async function renderPage(name, extra = {}) {
    let text;
    try {
      text = await fs.promises.readFile(path.join(root, name), 'utf8');
    } catch {
      if (name !== 'link.html') throw new Error(`site/${name} is missing`);
      text = LINK_PAGE;
    }
    return render(text, { ...context(), ...extra });
  }

  // Never cached: it carries a one-time code.
  async function sendPage(res, name, extra, status = 200) {
    send(res, status, await renderPage(name, extra), { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP });
  }

  async function notFound(req, res) {
    let body = 'Not found.\n';
    let type = 'text/plain; charset=utf-8';
    try {
      body = await page(path.join(root, '404.html'));
      type = TYPES['.html'];
    } catch {}
    send(res, 404, body, { 'Content-Type': type, 'Cache-Control': 'no-cache', ...(type === TYPES['.html'] ? { 'Content-Security-Policy': CSP } : {}) });
  }

  // Answers a GET or HEAD for something that is not an API route.
  async function handle(req, res, pathname) {
    const found = await locate(pathname);
    if (!found) return notFound(req, res);
    if (found.ext === '.html') {
      return send(res, 200, await page(found.file), {
        'Content-Type': TYPES['.html'],
        'Cache-Control': 'no-cache',
        'Content-Security-Policy': CSP,
      });
    }
    res.writeHead(200, {
      'Content-Type': TYPES[found.ext] || 'application/octet-stream',
      'Content-Length': found.size,
      'Cache-Control': 'public, max-age=3600',
    });
    if (req.method === 'HEAD') return res.end();
    // pipeline, not pipe: when the client goes away before the end, the file has to be closed as
    // well, or every download that is broken off would keep one open for good
    pipeline(fs.createReadStream(found.file), res, () => {});
  }

  return { handle, notFound, sendPage, renderPage, render: (text) => render(text, context()) };
}

module.exports = { createSite, servable, CSP };
