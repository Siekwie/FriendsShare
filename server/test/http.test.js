// The website side of the server: the template step, static files, the legal pages that only
// exist for a named operator, headers, and requests that try to get out of the site directory.
// The tests serve a small fixture site, never the real server/site/.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { withServer, startServer, connectApp, appLogin, makePro, createNet, rawRequest, sha256, until, BASE, START, LOGIN_ENV, BILLING_ENV } = require('./helpers');
const { servable } = require('../lib/site');

const CSP =
  "default-src 'self'; img-src 'self' data: https://avatars.githubusercontent.com https://*.googleusercontent.com; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const OPERATOR = {
  OPERATOR_NAME: 'Ada <&> Co',
  OPERATOR_ADDRESS: 'Main Street 1; 12345 Town ;<script>x</script>;;',
  OPERATOR_EMAIL: 'ada@example.com',
  OPERATOR_HOSTING: 'Hetzner Online GmbH, Germany',
};
const paragraph = (html, id) => new RegExp(`<p id="${id}">(.*?)</p>`, 's').exec(html)[1];

// ---- the template step ----

test('keys are filled in escaped, or raw with three braces, and unknown keys are empty', () =>
  withServer({ env: { ...OPERATOR, ...LOGIN_ENV } }, async (h) => {
    const res = await h.request('GET', '/');
    assert.equal(res.status, 200);
    assert.match(res.text, /<h1>Ada &lt;&amp;&gt; Co<\/h1>/);
    // every line of the address is escaped by the server, and the lines are joined with <br>
    assert.equal(paragraph(res.text, 'raw'), 'Main Street 1<br>12345 Town<br>&lt;script&gt;x&lt;/script&gt;');
    // the escaped form escapes that again
    assert.equal(paragraph(res.text, 'escaped'), 'Main Street 1&lt;br&gt;12345 Town&lt;br&gt;&amp;lt;script&amp;gt;x&amp;lt;/script&amp;gt;');
    // plain keys; unknown ones, and names that only exist on Object, are empty; spaces inside the braces are fine
    assert.equal(paragraph(res.text, 'misc'), `5|€1.99|€11.88|€0.99|||${BASE}`);
    assert.equal(paragraph(res.text, 'urls'), 'https://github.com/Siekwie/FriendsShare|https://github.com/Siekwie/FriendsShare/releases/latest/download/FriendsShare.exe|0');
    assert.ok(!res.text.includes('{{'), 'no braces are left over');
  }));

test('if and if-not blocks keep or drop their text by the value of a key', async () => {
  await withServer({}, async (h) => {
    const off = (await h.request('GET', '/')).text;
    assert.equal(paragraph(off, 'when-on'), '');
    assert.equal(paragraph(off, 'when-off'), 'billing off');
    assert.equal(paragraph(off, 'logins'), '');
    assert.ok(!off.includes('<!--'), 'the markers are gone');
  });
  await withServer({ env: BILLING_ENV }, async (h) => {
    const on = (await h.request('GET', '/')).text;
    assert.equal(paragraph(on, 'when-on'), 'billing on');
    assert.equal(paragraph(on, 'when-off'), '');
    assert.equal(paragraph(on, 'logins'), 'ghgoany');
  });
  await withServer({ env: { GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b' } }, async (h) => {
    assert.equal(paragraph((await h.request('GET', '/')).text, 'logins'), 'goany');
  });
});

test('the keys carry the configuration', () =>
  withServer(
    {
      env: {
        ...BILLING_ENV,
        FREE_LIMIT: '3',
        PRICE_DISPLAY_MONTHLY: '$2',
        PRICE_DISPLAY_YEARLY: '$20',
        PRICE_DISPLAY_YEARLY_PER_MONTH: '$1.67',
        RELEASE_REPO: 'someone/else',
        BACKUP_INTERVAL_HOURS: '12',
        BACKUP_KEEP: '3',
      },
    },
    async (h) => {
      const html = (await h.request('GET', '/')).text;
      assert.equal(paragraph(html, 'misc'), `3|$2|$20|$1.67|||${BASE}`);
      // 12 hours between snapshots, three kept: a deleted account lives on for up to 36 hours, shown as 2 days
      assert.equal(paragraph(html, 'urls'), 'https://github.com/someone/else|https://github.com/someone/else/releases/latest/download/FriendsShare.exe|2');
    },
  ));

test('values that look like template syntax are not expanded a second time', () =>
  withServer({ env: { OPERATOR_NAME: '{{site_url}} <!--if !billing-->INJECTED<!--endif-->', OPERATOR_ADDRESS: '{{{version}}};{{{operator_name}}}' } }, async (h) => {
    const html = (await h.request('GET', '/')).text;
    assert.match(html, /<h1>\{\{site_url\}\} &lt;!--if !billing--&gt;INJECTED&lt;!--endif--&gt;<\/h1>/);
    assert.equal(paragraph(html, 'raw'), '{{{version}}}<br>{{{operator_name}}}');
    assert.ok(!html.includes('INJECTED<!--'), 'nothing was turned into markup');
  }));

test('the newest release is shown, kept when GitHub cannot be reached, and ignored when it makes no sense', async () => {
  const first = await startServer();
  try {
    // the lookup at start may not have finished yet, so ask again and wait for it
    first.net.release.tag = 'v1.2.7';
    await first.server.builds.refreshLatest();
    assert.equal(paragraph((await first.request('GET', '/')).text, 'version'), 'v1.2.7');
    assert.equal(first.net.calling((c) => c.path.endsWith('/releases/latest')).at(-1).headers.accept, 'application/vnd.github+json');

    first.net.release.fail = true;
    await first.server.builds.refreshLatest();
    assert.equal(paragraph((await first.request('GET', '/')).text, 'version'), 'v1.2.7', 'the last known version stays');
    first.net.release.fail = false;
    for (const tag of ['latest', 'v1.2', 'nightly-2026', '', 'v1.2.3-beta']) {
      first.net.release.tag = tag;
      await first.server.builds.refreshLatest();
      assert.equal(paragraph((await first.request('GET', '/')).text, 'version'), 'v1.2.7', tag);
    }
    first.net.release.tag = '2.0.0'; // without the v
    await first.server.builds.refreshLatest();
    assert.equal(paragraph((await first.request('GET', '/')).text, 'version'), 'v2.0.0');
  } finally {
    await first.server.close();
  }

  // after a restart while GitHub is down the last known version is still there
  const second = await startServer({ dir: first.dir, net: (config) => Object.assign(createNet(config), { release: { tag: 'v9.9.9', fail: true } }) });
  try {
    await second.server.builds.refreshLatest();
    assert.equal(paragraph((await second.request('GET', '/')).text, 'version'), 'v2.0.0');
  } finally {
    await second.close();
  }
});

test('the newest release is unknown until GitHub has answered, and the pages say so', async () => {
  const h = await startServer({ net: (config) => Object.assign(createNet(config), { release: { tag: 'v1.2.0', fail: true } }) });
  try {
    await h.server.builds.refreshLatest();
    assert.equal(paragraph((await h.request('GET', '/')).text, 'version'), 'unknown');
  } finally {
    await h.close();
  }
});

test('the release is looked up at start and then about hourly', () =>
  withServer({ tune: (config) => (config.tuning.releaseRefreshMs = 60) }, async (h) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const lookups = h.net.calling((c) => c.path.endsWith('/releases/latest')).length;
    assert.ok(lookups >= 3, `${lookups} lookups`);
    assert.equal(paragraph((await h.request('GET', '/')).text, 'version'), 'v1.2.0');
  }));

test('partials are included and templated themselves, a missing one is empty, one that includes itself ends', () =>
  withServer({ env: LOGIN_ENV }, async (h) => {
    const dir = h.config.siteDir;
    fs.writeFileSync(path.join(dir, 'partials', 'loop.html'), 'a<!--include loop-->b');
    fs.writeFileSync(path.join(dir, 'partials', 'nested.html'), '[<!--include header-->]');
    fs.writeFileSync(path.join(dir, 'page.html'), '<!--include header-->|<!--include nested-->|<!--include missing-->|<!--include ../secret-->|<!--include loop-->|<!--if any_login-->in<!--include header--><!--endif-->');
    const res = await h.request('GET', '/page.html');
    const header = `<header>${BASE} github-login</header>`;
    // a name that is not a plain name is not an include at all: it is left alone and nothing is read
    assert.ok(res.text.startsWith(`${header}|[${header}]||<!--include ../secret-->|`), res.text.slice(0, 200));
    assert.match(res.text, /\|a+b+\|/);
    assert.ok(res.text.endsWith(`in${header}`));
    assert.ok(!res.text.includes('<!--include loop') && !res.text.includes('<!--include missing') && !res.text.includes('<!--include nested'), 'every include was dealt with');
    // the header of the page itself
    assert.match((await h.request('GET', '/')).text, new RegExp(`<header>${BASE} github-login</header>`));
  }));

test('the year is the current one on the server\'s clock', () =>
  withServer({}, async (h) => {
    assert.match((await h.request('GET', '/')).text, /no-imprint 2026<\/footer>/);
    h.clock.advance(100 * 86_400_000);
    assert.match((await h.request('GET', '/')).text, /no-imprint 2027<\/footer>/);
  }));

// ---- static files ----

test('static files are sent as they are, with their type and an hour of caching', () =>
  withServer({}, async (h) => {
    fs.writeFileSync(path.join(h.config.siteDir, 'js', 'app.js'), 'window.url = "{{site_url}}";');
    const expected = {
      '/site.css': 'text/css; charset=utf-8',
      '/js/app.js': 'text/javascript; charset=utf-8',
      '/img/logo.svg': 'image/svg+xml',
      '/robots.txt': 'text/plain; charset=utf-8',
      '/favicon.ico': 'image/x-icon',
      '/data.bin': 'application/octet-stream',
    };
    for (const [url, type] of Object.entries(expected)) {
      const res = await h.request('GET', url);
      assert.equal(res.status, 200, url);
      assert.equal(res.headers['content-type'], type, url);
      assert.equal(res.headers['cache-control'], 'public, max-age=3600', url);
      assert.equal(res.headers['content-length'], String(res.raw.length), url);
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      assert.equal(res.headers['content-security-policy'], undefined, 'the CSP is for pages');
    }
    // not templated
    assert.equal((await h.request('GET', '/js/app.js')).text, 'window.url = "{{site_url}}";');
    assert.deepEqual([...(await h.request('GET', '/favicon.ico')).raw], [0, 0, 1, 0]);
    // a HEAD request has the headers and no body
    const head = await h.request('HEAD', '/site.css');
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-length'], '18');
    assert.equal(head.text, '');
  }));

test('a download that is broken off does not keep its file open', () =>
  withServer({}, async (h) => {
    // far more than the connection can take in one go, so that the server is still reading when the client leaves
    const size = 24 * 1024 * 1024;
    fs.writeFileSync(path.join(h.config.siteDir, 'big.bin'), Buffer.alloc(size, 7));
    const streams = [];
    const original = fs.createReadStream;
    fs.createReadStream = (...args) => {
      const stream = original.apply(fs, args);
      streams.push(stream);
      return stream;
    };
    try {
      for (let n = 0; n < 5; n++) {
        const socket = net.connect(h.port, '127.0.0.1', () => {
          socket.write('GET /big.bin HTTP/1.1\r\nHost: x\r\n\r\n');
          socket.pause(); // a client that stops reading
        });
        socket.on('error', () => {});
        await until(() => streams.length === n + 1 && streams[n].bytesRead > 0, 5000);
        assert.ok(streams[n].bytesRead < size && !streams[n].destroyed, `the server is still sending (${streams[n].bytesRead} of ${size} bytes read)`);
        socket.destroy();
        await until(() => streams[n].destroyed, 5000);
      }
    } finally {
      fs.createReadStream = original;
    }
    // and a download that is not broken off still arrives whole, and closes its file
    const whole = await h.request('GET', '/data.bin');
    assert.deepEqual([...whole.raw], [1, 2, 3]);
  }));

test('pages are templated, never cached, and carry the content security policy', () =>
  withServer({}, async (h) => {
    for (const url of ['/', '/login', '/account', '/index.html', '/login.html']) {
      const res = await h.request('GET', url);
      assert.equal(res.status, 200, url);
      assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
      assert.equal(res.headers['cache-control'], 'no-cache');
      assert.equal(res.headers['content-security-policy'], CSP);
    }
    assert.match((await h.request('GET', '/login')).text, /<h1>Sign in<\/h1>/);
    assert.match((await h.request('GET', '/account')).text, /<h1>Account<\/h1>/);
    const head = await h.request('HEAD', '/');
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
  }));

test('an unknown address gets the 404 page with a 404 status, and so does the page itself', () =>
  withServer({}, async (h) => {
    for (const url of ['/nope', '/img/nope.png', '/404.html', '/a/b/c', '/login/', '/index', '/img', '/img/']) {
      const res = await h.request('GET', url);
      assert.equal(res.status, 404, url);
      assert.match(res.text, /<h1>Nothing here<\/h1>/, url);
      assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
      assert.equal(res.headers['cache-control'], 'no-cache');
      assert.equal(res.headers['content-security-policy'], CSP);
    }
    // the 404 page is templated too
    assert.match((await h.request('GET', '/nope')).text, /no-imprint 2026/);
  }));

test('without a 404 page of its own the server still answers 404', () =>
  withServer({}, async (h) => {
    fs.rmSync(path.join(h.config.siteDir, '404.html'));
    const res = await h.request('GET', '/nope');
    assert.equal(res.status, 404);
    assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8');
  }));

test('only GET and HEAD reach the pages; other methods and unknown API routes answer in JSON', () =>
  withServer({}, async (h) => {
    const api = await h.request('GET', '/api/nope');
    assert.equal(api.status, 404);
    assert.equal(api.json.error, 'not_found');
    assert.match(api.json.message, /^[A-Z].*\.$/);
    assert.equal((await h.request('POST', '/')).json.error, 'not_found');
    assert.equal((await h.request('POST', '/api/nope', { json: {} })).status, 404);
    assert.equal((await h.request('PUT', '/api/me', { json: {} })).status, 404);
    // the right path with the wrong method
    assert.equal((await h.request('GET', '/api/billing/checkout')).status, 404);
  }));

// ---- the pages that need an operator ----

test('imprint, privacy and terms are 404 until an operator with a name and an address is set', async () => {
  const pages = ['/imprint', '/privacy', '/terms', '/imprint.html', '/privacy.html', '/terms.html'];
  for (const env of [{}, { OPERATOR_NAME: 'Ada' }, { OPERATOR_ADDRESS: 'Main Street 1' }, { OPERATOR_EMAIL: 'a@example.com', OPERATOR_HOSTING: 'x' }]) {
    await withServer({ env }, async (h) => {
      for (const url of pages) {
        const res = await h.request('GET', url);
        assert.equal(res.status, 404, `${url} with ${Object.keys(env)}`);
        assert.match(res.text, /Nothing here/);
        assert.doesNotMatch(res.text, /Imprint of/);
      }
      // and the footer link is hidden
      const home = (await h.request('GET', '/')).text;
      assert.match(home, /no-imprint/);
      assert.ok(!home.includes('href="/imprint"'));
    });
  }
  await withServer({ env: OPERATOR }, async (h) => {
    for (const url of pages) {
      const res = await h.request('GET', url);
      assert.equal(res.status, 200, url);
      assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
    }
    const imprint = (await h.request('GET', '/imprint')).text;
    assert.match(imprint, /<h1>Imprint of Ada &lt;&amp;&gt; Co<\/h1>/);
    assert.match(imprint, /<p>Main Street 1<br>12345 Town<br>&lt;script&gt;x&lt;\/script&gt;<\/p>/);
    assert.match(imprint, /<p>ada@example\.com<\/p>/);
    assert.match((await h.request('GET', '/privacy')).text, /<p>Hetzner Online GmbH, Germany<\/p><p>0 days<\/p>/);
    assert.match((await h.request('GET', '/')).text, /<a href="\/imprint">Imprint<\/a> 2026/);
  });
});

// ---- headers ----

test('every kind of response carries the security headers, and only pages carry the policy', () =>
  withServer({ env: LOGIN_ENV }, async (h) => {
    const responses = [
      await h.request('GET', '/'),
      await h.request('GET', '/nope'),
      await h.request('GET', '/site.css'),
      await h.request('GET', '/api/me'),
      await h.request('GET', '/api/nope'),
      await h.request('GET', '/healthz'),
      await h.request('GET', '/auth/github'),
      await h.request('POST', '/api/logout'),
      await h.request('POST', '/api/billing/webhook', { body: '{}' }),
    ];
    for (const res of responses) {
      assert.equal(res.headers['x-content-type-options'], 'nosniff', String(res.status));
      assert.equal(res.headers['referrer-policy'], 'strict-origin-when-cross-origin');
      assert.equal(res.headers['x-frame-options'], 'DENY');
    }
    assert.deepEqual(responses.map((r) => r.headers['content-security-policy'] === CSP), [true, true, false, false, false, false, false, false, false]);
  }));

test('JSON answers are JSON, not cached, and errors have a code and a sentence', () =>
  withServer({}, async (h) => {
    const res = await h.request('GET', '/api/me');
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(res.headers['cache-control'], 'no-store');
    const error = await h.request('POST', '/api/billing/checkout', { json: { interval: 'month' } });
    assert.deepEqual(Object.keys(error.json).sort(), ['error', 'message']);
    assert.equal(error.headers['content-type'], 'application/json; charset=utf-8');
  }));

test('a request that is not for a page of this site is refused when it comes from another site', () =>
  withServer({ env: LOGIN_ENV }, async (h) => {
    const post = (headers) => h.request('POST', '/api/logout', { origin: null, headers });
    assert.equal((await post({ origin: BASE })).status, 204);
    assert.equal((await post({})).status, 204, 'no Origin and no Sec-Fetch-Site: not a browser');
    assert.equal((await post({ 'sec-fetch-site': 'same-origin' })).status, 204);
    assert.equal((await post({ 'sec-fetch-site': 'same-site' })).status, 204);
    assert.equal((await post({ 'sec-fetch-site': 'none' })).status, 204);
    // an Origin decides, whatever Sec-Fetch-Site says
    assert.equal((await post({ origin: BASE, 'sec-fetch-site': 'cross-site' })).status, 204);
    assert.equal((await post({ origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' })).status, 403);
    for (const origin of ['https://evil.example', 'http://friendsshare.test', 'https://friendsshare.test:8443', 'https://sub.friendsshare.test', 'null', '']) {
      const res = await post({ origin });
      assert.equal(res.status, 403, JSON.stringify(origin));
      assert.equal(res.json.error, 'forbidden');
    }
    assert.equal((await post({ 'sec-fetch-site': 'cross-site' })).status, 403);
    // reading is not restricted: a cross-site page may navigate here
    const read = await h.request('GET', '/api/me', { headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } });
    assert.equal(read.status, 200);
  }));

test('a http:// base address does not set Secure cookies, a https:// one does', async () => {
  await withServer({ env: { ...LOGIN_ENV, BASE_URL: 'http://localhost:8080/' } }, async (h) => {
    assert.equal(h.config.baseUrl, 'http://localhost:8080');
    const state = await h.request('GET', '/auth/github');
    const cookie = state.cookies.find((c) => c.startsWith('fs_oauth_state='));
    assert.ok(!cookie.includes('Secure'));
    // and the redirect_uri follows the base address
    assert.equal(new URL(state.headers.location).searchParams.get('redirect_uri'), 'http://localhost:8080/auth/github/callback');
  });
});

// ---- requests that try to leave the site ----

test('paths that try to leave the site directory, or reach what is not a page, are all 404', () =>
  withServer({}, async (h) => {
    fs.writeFileSync(path.join(h.dir, 'outside.txt'), 'OUTSIDE-SECRET-MARKER');
    fs.writeFileSync(path.join(h.dir, 'data', 'secret.key'), 'KEY-MARKER');
    const attempts = [
      '/../outside.txt', '/%2e%2e/outside.txt', '/%2E%2E/outside.txt', '/..%2foutside.txt', '/..%2Foutside.txt', '/%2e%2e%2foutside.txt',
      '/img/../../outside.txt', '/img/%2e%2e/%2e%2e/outside.txt', '/..\\outside.txt', '/..%5coutside.txt', '/%5c..%5coutside.txt',
      '/img/..%5c..%5coutside.txt', '/....//outside.txt', '/.%2e/outside.txt', '/%252e%252e/outside.txt',
      '/../data/secret.key', '/../../data/secret.key', '/%2e%2e/data/secret.key',
      '/js/%00.js', '/site.css%00.png', '/%00', '/C:/Windows/win.ini', '/C%3A/Windows/win.ini', '/img/logo.svg:stream', '/site.css::$DATA',
      '/.hidden.html', '/.git/config', '/img/.hidden', '/partials/secret.html', '/partials/header.html', '/partials/', '/partials',
      '/img/', '/img', '/js/', '//outside.txt', '/./site.css/.', '/site.css/', '/%2fsite.css',
    ];
    for (const attempt of attempts) {
      let res;
      try {
        res = await rawRequest(h.port, 'GET', attempt, {});
      } catch (err) {
        continue; // the client library refused to send it at all
      }
      assert.ok([400, 404].includes(res.status), `${attempt} -> ${res.status}`);
      for (const marker of ['OUTSIDE-SECRET-MARKER', 'KEY-MARKER', 'PARTIAL-SECRET-MARKER', 'hidden']) assert.ok(!res.text.includes(marker), `${attempt} leaked ${marker}`);
    }
    // the same names still work when they are what they should be
    assert.equal((await h.request('GET', '/site.css')).status, 200);
    assert.equal((await h.request('GET', '/img/./logo.svg')).status, 200);
  }));

test('a link inside the site directory that points outside is not followed', (t) =>
  withServer({}, async (h) => {
    const outside = path.join(h.dir, 'outside.txt');
    fs.writeFileSync(outside, 'OUTSIDE-SECRET-MARKER');
    const made = [];
    try {
      fs.symlinkSync(outside, path.join(h.config.siteDir, 'linked.txt'), 'file');
      made.push('file');
    } catch {}
    try {
      fs.symlinkSync(path.join(h.dir, 'data'), path.join(h.config.siteDir, 'linked-dir'), 'junction');
      made.push('directory');
    } catch {}
    if (!made.length) return t.skip('links cannot be created here');
    if (made.includes('file')) {
      const file = await h.request('GET', '/linked.txt');
      assert.equal(file.status, 404);
      assert.ok(!file.text.includes('OUTSIDE-SECRET-MARKER'));
    }
    if (made.includes('directory')) assert.equal((await h.request('GET', '/linked-dir/friendsshare.db')).status, 404);
  }));

// a request that is not answered fails the test instead of keeping it waiting
const within = (ms, promise) =>
  Promise.race([promise, new Promise((resolve, reject) => setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms).unref())]);

test('what is not a page of its own is not served under any spelling of its name', () =>
  withServer({}, async (h) => {
    const site = h.config.siteDir;
    // on a file system that tells "Partials" from "partials" these are other files than the fixture's: they must be refused as well
    fs.mkdirSync(path.join(site, 'Partials'), { recursive: true });
    fs.writeFileSync(path.join(site, 'Partials', 'secret.html'), 'PARTIAL-SECRET-MARKER');
    fs.mkdirSync(path.join(site, 'PARTIALS'), { recursive: true });
    fs.writeFileSync(path.join(site, 'PARTIALS', 'Header.HTML'), 'PARTIAL-SECRET-MARKER');
    // (not 404.html: on a file system that ignores case that would be the 404 page itself)
    for (const name of ['LINK.HTML', 'Link.html', 'Imprint.html', 'PRIVACY.HTML', 'Terms.Html']) fs.writeFileSync(path.join(site, name), `HIDDEN-PAGE-MARKER ${name}`);

    const refused = [
      // partials, in every case and with the tricks that make Windows read another name as the same one
      '/partials/secret.html', '/Partials/secret.html', '/PARTIALS/secret.html', '/PARTIALS/Header.HTML', '/partials/HEADER.html', '/partials/', '/Partials', '/PARTIALS/',
      '/partials./secret.html', '/partials%20/secret.html', '/partials/secret.html.', '/partials/secret.html%20', '/partials/secret.html::$DATA', '/partials::$INDEX_ALLOCATION/secret.html',
      '/PARTIA~1/secret.html', '/partials/SECRET~1.HTM', '/partials%5csecret.html', '/partials\\secret.html', '/par%74ials/secret.html',
      // pages the server fills in itself
      '/404.html', '/404.HTML', '/LINK.HTML', '/Link.html', '/link.html', '/link', '/Link', '/404.html.', '/link.html%20', '/LINK~1.HTM', '/link.html::$DATA', '/%6cink.html',
      // pages that name the operator, when there is none
      '/imprint.html', '/Imprint.html', '/IMPRINT.html', '/imprint', '/PRIVACY.HTML', '/privacy.html', '/Terms.Html', '/terms.html', '/TERMS', '/imprint.html.', '/imprint.html%20',
    ];
    for (const target of refused) {
      let res;
      try {
        res = await within(3000, rawRequest(h.port, 'GET', target, {}));
      } catch (err) {
        if (/no answer/.test(err.message)) throw err;
        continue; // the client library refused to send it at all
      }
      assert.ok([400, 404].includes(res.status), `${target} -> ${res.status}`);
      for (const marker of ['PARTIAL-SECRET-MARKER', 'HIDDEN-PAGE-MARKER', 'FIXTURE LINK PAGE', 'Imprint of', '<h1>Privacy</h1>', '<h1>Terms</h1>', 'github-login', 'no-login']) {
        assert.ok(!res.text.includes(marker), `${target} leaked ${marker}`);
      }
    }
    // and what is meant to be there still is
    for (const target of ['/', '/login', '/index.html', '/site.css', '/img/logo.svg', '/js/app.js', '/robots.txt']) assert.equal((await h.request('GET', target)).status, 200, target);
  }));

test('which names may be served is decided by the name alone, in any case, whatever the file system would make of it', () => {
  const segments = (target) => target.split('/').slice(1);
  const refusedAlways = [
    '/partials/x.html', '/Partials/x.html', '/PARTIALS/x.html', '/partials', '/Partials', '/partials/sub/x.html', '/internal/stats', '/Internal/stats', '/INTERNAL',
    '/404.html', '/404.HTML', '/404.Html', '/link.html', '/Link.html', '/LINK.HTML',
    '/', '/a//b', '/.hidden.html', '/img/.hidden', '/img/../x', '/..', '/.', '/img/', '/x.html.', '/x.html ', '/partials./x.html', '/img./x.png', '/img /x.png',
    '/PARTIA~1/x.html', '/IMPRIN~1.HTM', '/x~1.html',
    '/con', '/CON.html', '/nul.txt', '/img/aux', '/PRN.css', '/com1', '/COM9.js', '/lpt1.txt', '/img/LPT9', '/com¹', '/lpt².png', '/conin$', '/CONOUT$.txt',
  ];
  for (const operatorEnabled of [false, true]) {
    for (const target of refusedAlways) assert.equal(servable(segments(target), operatorEnabled), false, `${target} (operator ${operatorEnabled})`);
  }
  assert.equal(servable([], true), false);
  // the pages that name the operator, in any case, only once there is one
  for (const target of ['/imprint.html', '/Imprint.html', '/IMPRINT.HTML', '/privacy.html', '/PRIVACY.html', '/terms.html', '/Terms.Html']) {
    assert.equal(servable(segments(target), false), false, target);
    assert.equal(servable(segments(target), true), true, target);
  }
  // everything else, also names that only look like the refused ones
  for (const target of [
    '/index.html', '/login.html', '/site.css', '/img/logo.svg', '/js/app.js', '/robots.txt', '/img/404.html', '/docs/link.html', '/img/imprint.html', '/a/Partials/x.html',
    '/console.txt', '/auxiliary.txt', '/com10.txt', '/lpt10.txt', '/connect.js', '/null.png', '/internal.html', '/internals/x.html', '/partials-old/x.html', '/my-link.html', '/link.html.bak', '/a.b.c',
  ]) {
    assert.equal(servable(segments(target), false), true, target);
  }
});

test('the pages that name the operator are served, in any spelling the file system accepts, once there is one', () =>
  withServer({ env: OPERATOR }, async (h) => {
    for (const target of ['/imprint', '/imprint.html', '/privacy', '/terms.html']) assert.equal((await h.request('GET', target)).status, 200, target);
    // the hidden ones stay hidden whoever runs the site
    for (const target of ['/404.html', '/404.HTML', '/link.html', '/Link.HTML', '/link']) assert.equal((await h.request('GET', target)).status, 404, target);
    assert.ok(!(await h.request('GET', '/link.html')).text.includes('FIXTURE LINK PAGE'));
    for (const target of ['/partials/header.html', '/Partials/header.html']) assert.equal((await h.request('GET', target)).status, 404, target);
  }));

test('names that Windows reads as devices are refused at once, and nothing is looked up for them', () =>
  withServer({}, async (h) => {
    const names = ['con', 'CON', 'prn', 'aux', 'AUX', 'nul', 'Nul', 'com1', 'COM9', 'lpt1', 'LPT9', 'com¹', 'COM²', 'lpt³', 'conin$', 'CONOUT$'];
    const targets = [];
    for (const name of names) targets.push(`/${name}`, `/${name}.html`, `/${name}.txt`, `/img/${name}`, `/img/${name}.png`, `/${name}/x.html`);
    for (const target of targets) {
      const res = await within(3000, rawRequest(h.port, 'GET', encodeURI(target), {}));
      assert.equal(res.status, 404, target);
      assert.match(res.text, /Nothing here/, target);
    }
    // files that merely start with such a name are files like any other
    fs.writeFileSync(path.join(h.config.siteDir, 'console.txt'), 'plain');
    fs.writeFileSync(path.join(h.config.siteDir, 'auxiliary.txt'), 'plain');
    fs.writeFileSync(path.join(h.config.siteDir, 'com10.txt'), 'plain');
    for (const target of ['/console.txt', '/auxiliary.txt', '/com10.txt']) assert.equal((await h.request('GET', target)).text, 'plain', target);
  }));

test('a link to a file that is not served does not make it served', (t) =>
  withServer({ env: {} }, async (h) => {
    const site = h.config.siteDir;
    const made = [];
    const link = (target, name, type) => {
      try {
        fs.symlinkSync(target, path.join(site, name), type);
        made.push(name);
      } catch {}
    };
    link(path.join(site, 'partials', 'secret.html'), 'alias.html', 'file');
    link(path.join(site, 'link.html'), 'alias-link.html', 'file');
    link(path.join(site, '404.html'), 'alias-404.html', 'file');
    link(path.join(site, 'imprint.html'), 'alias-imprint.html', 'file');
    // a link to a whole directory of building blocks
    link(path.join(site, 'partials'), 'docs', 'junction');
    if (!made.length) return t.skip('links cannot be created here');
    for (const name of made) {
      const target = name === 'docs' ? '/docs/secret.html' : `/${name}`;
      const res = await h.request('GET', target);
      assert.equal(res.status, 404, target);
      for (const marker of ['PARTIAL-SECRET-MARKER', 'FIXTURE LINK PAGE', 'Imprint of']) assert.ok(!res.text.includes(marker), `${target} leaked ${marker}`);
    }
  }));

test('malformed request targets are refused', () =>
  withServer({}, async (h) => {
    for (const target of ['//evil.example/x', '/%', '/%zz', '/\u0000']) {
      let res;
      try {
        res = await rawRequest(h.port, 'GET', target, {});
      } catch {
        continue;
      }
      assert.ok([400, 404].includes(res.status), `${JSON.stringify(target)} -> ${res.status}`);
    }
    // an absolute-form target, as a proxy would send
    const absolute = await rawRequest(h.port, 'GET', 'http://evil.example/site.css', {});
    assert.equal(absolute.status, 400);
  }));

// ---- slow requests ----

test('a request that is slow to arrive has 15 seconds for its headers and 30 for the whole request, and connections stay open for the proxy', () =>
  withServer({}, async (h) => {
    const server = h.server.server;
    assert.equal(server.headersTimeout, 15_000);
    assert.equal(server.requestTimeout, 30_000);
    // Caddy keeps its connections to us for a while: ours must outlast its, or it hits a dead one
    assert.equal(server.keepAliveTimeout, 125_000);
    assert.equal(h.config.tuning.headersTimeoutMs, 15_000);
    assert.equal(h.config.tuning.requestTimeoutMs, 30_000);
  }));

// what a connection that behaves like `write` says does: how long it lasted, and what it was answered
function behave(port, write, { patience = 4000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let received = '';
    let timer;
    const socket = net.connect(port, '127.0.0.1', () => write(socket));
    socket.on('data', (chunk) => (received += chunk));
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(timer);
      resolve({ ms: Date.now() - started, open: false, answer: received.split('\r\n')[0] });
    });
    timer = setTimeout(() => {
      resolve({ ms: Date.now() - started, open: true, answer: received.split('\r\n')[0] });
      socket.destroy();
    }, patience);
  });
}

test('whoever is slow to send is dropped, whether nothing arrives, the headers trickle in or the body does', () =>
  withServer({ tune: (config) => ((config.tuning.headersTimeoutMs = 300), (config.tuning.requestTimeoutMs = 700)) }, async (h) => {
    const every = (socket, ms, text) => {
      const timer = setInterval(() => socket.destroyed || socket.write(text), ms);
      socket.on('close', () => clearInterval(timer));
    };
    // far less than the patience of the test, far more than the time they were given: the checking is often enough to matter
    const dropped = (what, result) => assert.ok(!result.open && result.ms < 2500, `${what}: open ${result.open} after ${result.ms} ms`);

    const silent = await behave(h.port, () => {});
    dropped('a connection that sends nothing', silent);
    assert.equal(silent.answer, 'HTTP/1.1 408 Request Timeout');

    const half = await behave(h.port, (socket) => socket.write('GET /heal'));
    dropped('half a request line', half);
    assert.equal(half.answer, 'HTTP/1.1 408 Request Timeout');

    dropped('headers one by one', await behave(h.port, (socket) => (socket.write('GET /healthz HTTP/1.1\r\nHost: x\r\n'), every(socket, 100, 'X-Another: header\r\n'))));
    dropped('a body one byte at a time', await behave(h.port, (socket) => (socket.write('POST /api/logout HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n'), every(socket, 100, 'a'))));
    const never = await behave(h.port, (socket) => socket.write('POST /api/logout HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n'));
    dropped('a body that never comes', never);
    assert.equal(never.answer, 'HTTP/1.1 408 Request Timeout');

    // the server itself is as it was
    assert.equal((await h.request('GET', '/healthz')).status, 200);
  }));

test('a fast request is answered, and an idle connection waiting for the next one is not mistaken for a slow request', () =>
  withServer({ tune: (config) => ((config.tuning.headersTimeoutMs = 300), (config.tuning.requestTimeoutMs = 700)) }, async (h) => {
    // two requests on one connection, with a pause longer than both timeouts between them
    const result = await new Promise((resolve, reject) => {
      const socket = net.connect(h.port, '127.0.0.1');
      let received = '';
      socket.on('data', (chunk) => (received += chunk));
      socket.on('error', reject);
      socket.once('connect', () => socket.write('GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n'));
      setTimeout(() => {
        const first = (received.match(/^HTTP\/1\.1 (\d+)/) || [])[1];
        const stillOpen = !socket.destroyed;
        received = '';
        socket.write('GET /healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
        socket.on('close', () => resolve({ first, stillOpen, second: (received.match(/^HTTP\/1\.1 (\d+)/) || [])[1] }));
      }, 1500);
    });
    assert.deepEqual(result, { first: '200', stillOpen: true, second: '200' });
  }));

test('an error of the server itself is logged, with its code and nothing else, and the program carries on', () =>
  withServer({}, async (h) => {
    h.server.server.emit('error', Object.assign(new Error('accept failed: too many open files in /secret/place'), { code: 'EMFILE' }));
    h.server.server.emit('error', new Error('something without a code'));
    assert.deepEqual(
      h.logs.filter((line) => line.startsWith('[http]')),
      ['[http] the server reported an error: EMFILE', '[http] the server reported an error: something without a code'],
    );
    assert.equal((await h.request('GET', '/healthz')).status, 200);
  }));

test('a body that is not a JSON object is a bad request, however it is wrong', () =>
  withServer({}, async (h) => {
    for (const body of ['', 'not json', '[]', '"text"', '5', 'null', '{"unterminated": ']) {
      const res = await h.request('POST', '/api/app/session', { body, origin: null });
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.json.error, 'bad_request');
      assert.match(res.json.message, /^[A-Z].*\.$/);
    }
  }));

// ---- healthz and the internal numbers ----

test('/healthz answers ok after a trivial database query', () =>
  withServer({}, async (h) => {
    const res = await h.request('GET', '/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.text, 'ok');
    assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal((await h.request('HEAD', '/healthz')).status, 200);
    // when the database is gone it says so
    h.db.close = () => {};
    h.db.raw.close();
    const broken = await h.request('GET', '/healthz');
    assert.equal(broken.status, 500);
  }));

test('/internal/stats answers from the machine itself and is invisible through the proxy', () =>
  withServer({ env: BILLING_ENV }, async (h) => {
    fs.mkdirSync(path.join(h.config.siteDir, 'internal'));
    fs.writeFileSync(path.join(h.config.siteDir, 'internal', 'stats'), 'A FILE THAT MUST NOT BE SERVED');

    // an empty server
    const empty = await h.request('GET', '/internal/stats');
    assert.equal(empty.status, 200);
    assert.match(empty.headers['content-type'], /^application\/json/);
    assert.deepEqual(empty.json, {
      connections: 0, by_version: {}, by_plan: { free: 0, pro: 0 }, hosted_rooms: 0, waiting: 0, accounts: 0, pro_accounts: 0, rooms_known: 0, blocked_rooms: 0, rejected: { outdated: 0, unofficial: 0 }, started_at: START,
    });

    const { token } = await appLogin(h);
    makePro(h, h.accountId('ada@example.com'));
    await appLogin(h, { id: 2, name: 'Bob', email: 'bob@example.com' });
    const pro = await connectApp(h, { hello: { token } });
    const free = await connectApp(h, { hello: { version: '1.3.0' } });
    const other = await connectApp(h);
    const room = (n) => sha256(`room ${n}`);
    for (const n of [1, 2]) {
      pro.send({ t: 'host', room: room(n), key: 'k', exp: h.clock.t + 3_600_000 });
      await pro.next('hosted');
    }
    free.send({ t: 'join', room: room(9) });
    await free.next('err');
    other.send({ t: 'join', room: room(1) });
    await other.next('joined');
    await connectApp(h, { hello: { version: '1.1.0' } });
    await connectApp(h, { hello: { proto: 3 } });

    const stats = (await h.request('GET', '/internal/stats')).json;
    assert.deepEqual(stats, {
      connections: 3,
      by_version: { '1.2.0': 2, '1.3.0': 1 },
      by_plan: { free: 2, pro: 1 },
      hosted_rooms: 2,
      waiting: 1,
      accounts: 2,
      pro_accounts: 1,
      rooms_known: 2,
      blocked_rooms: 0,
      rejected: { outdated: 2, unofficial: 0 },
      started_at: START,
    });

    // seen through the proxy, or with any sign of one, it is just another unknown page
    for (const headers of [{ 'x-forwarded-for': '203.0.113.9' }, { forwarded: 'for=203.0.113.9' }, { 'x-real-ip': '203.0.113.9' }, { 'x-forwarded-for': '127.0.0.1' }]) {
      const res = await h.request('GET', '/internal/stats', { headers });
      assert.equal(res.status, 404, JSON.stringify(headers));
      assert.match(res.text, /Nothing here/);
      assert.ok(!res.text.includes('connections'));
    }
    // other paths under /internal never come from the site files, from anywhere
    assert.equal((await h.request('GET', '/internal/other')).status, 404);
    assert.equal((await h.request('GET', '/internal')).status, 404);
    const file = await h.request('GET', '/internal/stats', { headers: { 'x-forwarded-for': '1.1.1.1' } });
    assert.ok(!file.text.includes('MUST NOT'));
    assert.equal((await h.request('POST', '/internal/stats', { json: {} })).status, 404);
  }));

test('the numbers on /internal/stats contain no personal data', () =>
  withServer({ env: BILLING_ENV }, async (h) => {
    await appLogin(h);
    const text = (await h.request('GET', '/internal/stats')).text;
    for (const secret of ['ada@', 'example.com', 'Lovelace', 'github']) assert.ok(!text.toLowerCase().includes(secret.toLowerCase()), secret);
  }));
