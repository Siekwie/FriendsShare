#!/usr/bin/env node
// Sets up "Sign in with GitHub" or "Sign in with Google" for the FriendsShare server and stores
// the credentials in the server's .env (they are never printed and never touch git).
//
//   node deploy/setup-login.js github <ssh-host>     one click in the browser
//   node deploy/setup-login.js google <ssh-host>     a few minutes in the Google Cloud console
//
// SITE_URL (default https://friendsshare.wiest-lab.eu) is the public address of the server.
// DRY_RUN=1 goes through the motions without changing the server; NO_BROWSER=1 opens nothing.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { Writable } = require('stream');
const { spawn, execFile } = require('child_process');

const [provider, host] = process.argv.slice(2);
const SITE = (process.env.SITE_URL || 'https://friendsshare.wiest-lab.eu').replace(/\/$/, '');
// SERVER_DIR: where the server lives on the host
const DIR = process.env.SERVER_DIR || '/srv/friendsshare';

if (!['github', 'google'].includes(provider) || !host) {
  console.error('usage: node deploy/setup-login.js <github|google> <ssh-host>');
  process.exit(1);
}

// NO_BROWSER=1 only prints the addresses (for a machine without a desktop)
const open = (url) => {
  if (process.env.NO_BROWSER) return;
  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url.replace(/&/g, '^&')], { windowsVerbatimArguments: true });
  else execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]).on('error', () => {});
};

// Replaces the given variables in the server's .env and restarts the container. The values travel
// over ssh's stdin, so they show up neither in a process list nor in this terminal.
function storeOnServer(values) {
  if (process.env.DRY_RUN) {
    console.log(`Dry run: would store ${Object.keys(values).join(', ')} in ${host}:${DIR}/.env`);
    return Promise.resolve();
  }
  const names = Object.keys(values).join('|');
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n');
  const script = `set -e
cd ${DIR}
umask 077
touch .env
grep -v -E '^(${names})=' .env > .env.new || true
cat >> .env.new <<'FS_VALUES'
${lines}
FS_VALUES
mv .env.new .env
if [ -f app/deploy/compose.yml ]; then
  docker compose -f app/deploy/compose.yml --project-directory . up -d --force-recreate >/dev/null 2>&1
fi
echo "Stored ${Object.keys(values).join(', ')} in ${DIR}/.env"
`;
  return new Promise((resolve, reject) => {
    const ssh = spawn('ssh', [host, 'bash -s'], { stdio: ['pipe', 'inherit', 'inherit'] });
    ssh.on('error', reject);
    ssh.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ssh exited with ${code}`))));
    ssh.stdin.end(script);
  });
}

// GitHub shows the client secret exactly once, so it must not get lost when the server cannot be
// reached at that moment: try a few times, then park the values in a private local file.
async function storeSafely(values) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await storeOnServer(values);
    } catch (err) {
      if (attempt < 3) continue;
      const file = path.join(os.tmpdir(), `friendsshare-login-${Date.now()}.env`);
      fs.writeFileSync(file, Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
      throw new Error(`Could not store the values on ${host} (${err.message}). They are saved in ${file}: add its lines to ${DIR}/.env on the server, then delete the file.`);
    }
  }
}

// GitHub has no API to register an app, but it has the "manifest" flow: we send GitHub a
// description of the app, the account owner confirms it with one click, and GitHub hands the
// credentials back to this script.
async function github() {
  const name = process.env.APP_NAME || 'FriendsShare';
  const state = crypto.randomBytes(16).toString('hex');
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  // "localhost" may resolve to ::1 in the browser, so answer there too when the port is free
  const server6 = http.createServer((req, res) => server.emit('request', req, res));
  server6.on('error', () => {});
  server6.listen(port, '::1');
  const manifest = {
    name,
    url: SITE,
    description: 'Sign in to FriendsShare, the app for sharing big folders with friends.',
    hook_attributes: { url: `${SITE}/github/hook`, active: false },
    redirect_url: `http://localhost:${port}/done`,
    callback_urls: [`${SITE}/auth/github/callback`],
    public: true,
    // only what a login needs: who you are and your verified email address
    default_permissions: { emails: 'read' },
    default_events: [],
    request_oauth_on_install: false,
    setup_on_update: false,
  };
  const escape = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const page = (body) => `<!doctype html><meta charset="utf-8"><title>FriendsShare setup</title>
<body style="font:16px system-ui;max-width:560px;margin:15vh auto;padding:0 20px">${body}</body>`;

  const done = new Promise((resolve, reject) => {
    server.on('request', async (req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (url.pathname === '/') {
        res.end(page(`<h2>One click to go</h2>
<p>GitHub will ask to create the app <b>${escape(name)}</b> in your account. Press its green button.</p>
<form id="f" action="https://github.com/settings/apps/new?state=${state}" method="post">
<input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest))}">
<button>Continue to GitHub</button></form><script>document.getElementById('f').submit()</script>`));
      } else if (url.pathname === '/done') {
        if (url.searchParams.get('state') !== state || !url.searchParams.get('code')) {
          res.statusCode = 400;
          return res.end(page('<h2>That did not work</h2><p>Run the setup again.</p>'));
        }
        try {
          const r = await fetch(`https://api.github.com/app-manifests/${url.searchParams.get('code')}/conversions`, {
            method: 'POST',
            headers: { accept: 'application/vnd.github+json', 'user-agent': 'friendsshare-setup' },
          });
          if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
          const app = await r.json();
          await storeSafely({ GITHUB_CLIENT_ID: app.client_id, GITHUB_CLIENT_SECRET: app.client_secret });
          res.end(page('<h2>GitHub sign-in is set up</h2><p>You can close this tab.</p>'));
          resolve(app);
        } catch (err) {
          res.statusCode = 500;
          res.end(page(`<h2>That did not work</h2><p>${escape(err.message)}</p>`));
          reject(err);
        }
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
  });

  console.log(`Opening your browser. On the GitHub page, press "Create GitHub App for ...".`);
  console.log(`If no browser opens, go to http://localhost:${port}/`);
  open(`http://localhost:${port}/`);
  const app = await done;
  server.close();
  server6.close();
  console.log(`Created ${app.html_url}`);
  console.log(`To change its picture or name later: ${app.html_url.replace('/apps/', '/settings/apps/')}`);
}

// Google has no such flow: the OAuth client has to be created in the Cloud console by hand.
async function google() {
  const callback = `${SITE}/auth/google/callback`;
  console.log(`Google sign-in needs an "OAuth client" from the Google Cloud console:

  1. Create a project (any name, e.g. FriendsShare):
       https://console.cloud.google.com/projectcreate
  2. Open "Google Auth Platform" and press Get started:
       https://console.cloud.google.com/auth/overview
     App name: FriendsShare, Audience: External, then your email twice.
  3. Clients > Create client > Web application, and add this authorised redirect URI:
       ${callback}
       https://console.cloud.google.com/auth/clients
  4. Audience > Publish app, so everyone can sign in and not only test users.
       https://console.cloud.google.com/auth/audience
  5. Copy the client ID and client secret of step 3 into the two questions below.
`);
  open('https://console.cloud.google.com/projectcreate');

  // Lines are queued, so pasted or piped input works as well as typing; the secret is not echoed.
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) process.stdout.write(chunk, encoding);
      callback();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
  const lines = [];
  const waiting = [];
  rl.on('line', (line) => (waiting.length ? waiting.shift()(line) : lines.push(line)));
  rl.on('close', () => waiting.forEach((resolve) => resolve('')));
  const ask = async (question, hidden) => {
    process.stdout.write(question);
    muted = Boolean(hidden);
    const answer = lines.length ? lines.shift() : await new Promise((resolve) => waiting.push(resolve));
    muted = false;
    if (hidden) process.stdout.write('\n');
    return answer.trim();
  };
  const id = await ask('Client ID: ');
  const secret = await ask('Client secret (hidden): ', true);
  rl.close();
  if (!/\.apps\.googleusercontent\.com$/.test(id) || secret.length < 10) {
    console.error('That does not look like a Google client ID and secret. Nothing was changed.');
    process.exit(1);
  }
  await storeOnServer({ GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret });
  console.log('Google sign-in is set up.');
}

(provider === 'github' ? github() : google()).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
