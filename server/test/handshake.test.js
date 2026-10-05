// The WebSocket handshake: who is welcomed and who is turned away.
const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');
const { withServer, wsClient, connectApp, rawUpgrade, sha256, sleep } = require('./helpers');
const { buildKey, makeProof } = require('../lib/builds');

const SECRET = 'build-secret-for-tests';
const HASH_120 = sha256('app.asar of 1.2.0');
const OFFICIAL = { REQUIRE_OFFICIAL: '1', BUILD_SECRET: SECRET, EXTRA_BUILDS: `1.2.0:${HASH_120}` };
const ROOM = sha256('a share code');

// When the connection is over, or "still open" when it is not over in a few seconds: a test that fails, not one that waits for ever.
const over = (client, ms = 3000) => Promise.race([client.closed, sleep(ms).then(() => ({ code: 'still open', reason: 'still open' }))]);

const build = (version, asar) => ({ version, asar_sha256: asar, exe_sha256: sha256(`exe ${version}`) });

test('a build from source is welcomed when official builds are not required', () =>
  withServer({}, async (h) => {
    const app = await connectApp(h);
    assert.match(app.challenge.nonce, /^[0-9a-f]{64}$/);
    assert.equal(app.reply.t, 'welcome');
    assert.match(app.reply.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(
      { ...app.reply, id: undefined },
      {
        t: 'welcome',
        id: undefined,
        plan: 'free',
        // billing is off, so there is nothing to upgrade to and no limit
        limit: null,
        account: null,
        billing: false,
        prices: { monthly: '€1.99', yearly: '€11.88', yearly_per_month: '€0.99' },
        signed_out: false,
      },
    );
    app.close();
  }));

test('every connection gets its own challenge', () =>
  withServer({}, async (h) => {
    const a = await connectApp(h);
    const b = await connectApp(h);
    assert.notEqual(a.challenge.nonce, b.challenge.nonce);
    a.close();
    b.close();
  }));

test('an app older than the minimum version is told to update and disconnected', () =>
  withServer({}, async (h) => {
    const app = await connectApp(h, { hello: { version: '1.1.1' } });
    assert.deepEqual(app.reply, { t: 'reject', code: 'outdated', min: '1.2.0' });
    assert.equal((await app.closed).reason, 'outdated');
  }));

test('the minimum version itself and anything newer is welcome, compared as numbers', () =>
  withServer({ env: { MIN_VERSION: '1.9.0' } }, async (h) => {
    // 1.10.0 is newer than 1.9.0 even though it sorts before it as text
    for (const version of ['1.9.0', '1.10.0', '2.0.0']) {
      const app = await connectApp(h, { hello: { version } });
      assert.equal(app.reply.t, 'welcome', version);
      app.close();
    }
    const old = await connectApp(h, { hello: { version: '1.8.12' } });
    assert.deepEqual(old.reply, { t: 'reject', code: 'outdated', min: '1.9.0' });
  }));

test('a protocol other than 2 is told to update', () =>
  withServer({}, async (h) => {
    for (const proto of [1, 3, '2', null, undefined]) {
      const app = await connectApp(h, { hello: { proto } });
      assert.deepEqual(app.reply, { t: 'reject', code: 'outdated', min: '1.2.0' }, String(proto));
    }
  }));

test('a version that is not x.y.z is told to update', () =>
  withServer({}, async (h) => {
    for (const version of ['1.2', '1.2.0-beta.1', 'banana', '', 1.2, null, '01.2.0', '1.2.0\n[auth] forged']) {
      const app = await connectApp(h, { hello: { version } });
      assert.equal(app.reply.code, 'outdated', JSON.stringify(version));
    }
  }));

test('a knock on the old path is answered with plain HTTP 426 and no WebSocket at all', () =>
  withServer({}, async (h) => {
    // nothing may create a WebSocket for it: that is what makes it cheap
    const upgrades = [];
    const original = WebSocketServer.prototype.handleUpgrade;
    WebSocketServer.prototype.handleUpgrade = function (...args) {
      upgrades.push(args[0].url);
      return original.apply(this, args);
    };
    try {
      for (const urlPath of ['/', '/old', '/ws/', '/WS', '/ws2', '/ws/extra', '/?x=/ws']) {
        const res = await rawUpgrade(h.port, urlPath);
        assert.equal(res.status, 426, urlPath);
        assert.equal(res.headers.upgrade, 'websocket');
        assert.equal(res.headers.connection, 'close');
        assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8');
        // one line: too old, and where to get the current one
        assert.equal(res.text, 'This version of FriendsShare is too old. Download the current one at https://github.com/Siekwie/FriendsShare/releases/latest/download/FriendsShare.exe\n');
        assert.equal(Number(res.headers['content-length']), Buffer.byteLength(res.text));
        await res.closed;
      }
      assert.deepEqual(upgrades, [], 'no WebSocket was ever set up for any of them');
      // and the real path still works
      assert.equal((await connectApp(h)).reply.t, 'welcome');
      assert.equal(upgrades.length, 1);
    } finally {
      WebSocketServer.prototype.handleUpgrade = original;
    }
  }));

test('an old app that sends a hello on the old path does not even get a WebSocket to send it on', () =>
  withServer({}, async (h) => {
    const failure = await new Promise((resolve) => {
      const client = wsClient(h.port, '/');
      client.ws.on('unexpected-response', (req, res) => resolve(res.statusCode));
      // a server that agrees would otherwise leave the test waiting for ever
      client.ws.on('open', () => (client.ws.terminate(), resolve('a WebSocket was opened')));
      client.ws.on('error', () => {});
    });
    assert.equal(failure, 426);
    assert.equal((await h.request('GET', '/internal/stats')).json.connections, 0);
  }));

test('a web page cannot open a socket: an Origin of http:// or https:// is refused with plain HTTP 403', () =>
  withServer({}, async (h) => {
    const upgrades = [];
    const original = WebSocketServer.prototype.handleUpgrade;
    WebSocketServer.prototype.handleUpgrade = function (...args) {
      upgrades.push(args[0].url);
      return original.apply(this, args);
    };
    try {
      for (const origin of ['https://evil.example', 'http://evil.example', 'http://localhost:8080', 'HTTPS://EVIL.EXAMPLE', 'https://friendsshare.test', 'http://127.0.0.1']) {
        // on the right path and on the old one: the Origin counts first
        for (const urlPath of ['/ws', '/']) {
          const res = await rawUpgrade(h.port, urlPath, { Origin: origin });
          assert.equal(res.status, 403, `${origin} ${urlPath}`);
          assert.equal(res.text, 'WebSocket connections from web pages are not accepted.\n');
          assert.equal(res.headers.connection, 'close');
          await res.closed;
        }
      }
      assert.deepEqual(upgrades, []);
      // The desktop app sends none, "null" or file://, and other kinds of origins are not web pages
      for (const origin of [undefined, 'null', 'file://', 'app://friendsshare', 'chrome-extension://abcdef']) {
        const res = await rawUpgrade(h.port, '/ws', origin === undefined ? {} : { Origin: origin });
        assert.equal(res.upgraded, true, String(origin));
        res.socket.destroy();
      }
      assert.equal(upgrades.length, 5);
    } finally {
      WebSocketServer.prototype.handleUpgrade = original;
    }
  }));

test('turned-away upgrades are counted and logged at most once a minute', () =>
  withServer({}, async (h) => {
    for (let n = 0; n < 4; n++) await (await rawUpgrade(h.port, '/ws', { Origin: 'https://evil.example' })).closed;
    assert.deepEqual(
      h.logs.filter((line) => line.startsWith('[match] turned away')),
      ['[match] turned away upgrades since the last line: 1 from web pages, 0 over the limit of an address'],
    );
    h.clock.advance(61_000);
    await (await rawUpgrade(h.port, '/ws', { Origin: 'https://evil.example' })).closed;
    assert.equal(h.logs.filter((line) => line.startsWith('[match] turned away')).length, 2);
    assert.match(h.logs.filter((line) => line.startsWith('[match] turned away'))[1], /: 4 from web pages/);
  }));

test('an upgrade that cannot be handled is dropped and logged, and the server carries on', () =>
  withServer({}, async (h) => {
    // an error nothing catches would end the whole program, so this one is caught where it happens
    const original = h.server.match.handleUpgrade;
    h.server.match.handleUpgrade = () => {
      throw new Error('something nobody expected');
    };
    try {
      await assert.rejects(rawUpgrade(h.port, '/ws'), /socket hang up|ECONNRESET/);
    } finally {
      h.server.match.handleUpgrade = original;
    }
    assert.ok(h.logs.includes('[match] an upgrade could not be handled: something nobody expected'), h.logs.join('\n'));
    assert.equal((await h.request('GET', '/healthz')).status, 200);
    assert.equal((await connectApp(h)).reply.t, 'welcome', 'and the next app is welcomed as before');
  }));

// ---- how much one address may hold ----

test('one address may hold WS_MAX_PER_ADDRESS sockets open at once, the next is refused with 429 until one is gone', () =>
  withServer({ tune: (config) => (config.wsMaxPerAddress = 3) }, async (h) => {
    const held = [];
    for (let n = 0; n < 3; n++) {
      const res = await rawUpgrade(h.port, '/ws');
      assert.equal(res.upgraded, true, `socket ${n + 1}`);
      held.push(res.socket);
    }
    const refused = await rawUpgrade(h.port, '/ws');
    assert.equal(refused.status, 429);
    assert.equal(refused.headers['retry-after'], '60');
    assert.equal(refused.text, 'Too many connections from this address. Please wait a minute and try again.\n');
    await refused.closed;

    // a socket that never said hello counts as well, and one that is gone stops counting
    held[0].destroy();
    let again;
    for (let n = 0; n < 50 && !(again && again.upgraded); n++) {
      await sleep(20);
      again = await rawUpgrade(h.port, '/ws');
    }
    assert.equal(again.upgraded, true);
    for (const socket of [...held, again.socket]) socket.destroy();
  }));

test('one address may open WS_UPGRADES_PER_MINUTE sockets a minute, even if it closes them again', () =>
  withServer({ tune: (config) => (config.wsUpgradesPerMinute = 4) }, async (h) => {
    for (let n = 0; n < 4; n++) {
      const res = await rawUpgrade(h.port, '/ws');
      assert.equal(res.upgraded, true);
      res.socket.destroy();
    }
    await sleep(50);
    const refused = await rawUpgrade(h.port, '/ws');
    assert.equal(refused.status, 429);
    await refused.closed;
    // the old path and the web pages are not part of this count
    assert.equal((await rawUpgrade(h.port, '/old')).status, 426);
    h.clock.advance(61_000);
    const later = await rawUpgrade(h.port, '/ws');
    assert.equal(later.upgraded, true);
    later.socket.destroy();
    assert.match(h.logs.find((line) => line.startsWith('[match] turned away')), /1 over the limit of an address/);
  }));

test('behind the proxy the limits count the address the proxy saw, and an IPv6 customer owns its whole /64', () =>
  withServer({ env: { TRUST_PROXY: '1' }, tune: (config) => (config.wsMaxPerAddress = 1) }, async (h) => {
    const via = (address) => rawUpgrade(h.port, '/ws', { 'X-Forwarded-For': address });
    const first = await via('203.0.113.7');
    assert.equal(first.upgraded, true);
    // the client's own first entry is not believed, the proxy's last one is
    assert.equal((await via('198.51.100.1, 203.0.113.7')).status, 429);
    const other = await via('203.0.113.8');
    assert.equal(other.upgraded, true);

    const v6 = await via('2001:db8:1:2::1');
    assert.equal(v6.upgraded, true);
    assert.equal((await via('2001:db8:1:2:ffff::9')).status, 429, 'the same /64');
    const elsewhere = await via('2001:db8:1:3::1');
    assert.equal(elsewhere.upgraded, true, 'another /64');
    for (const res of [first, other, v6, elsewhere]) res.socket.destroy();
  }));

// ---- what a connection may say before the welcome ----

test('before the welcome a connection may send one hello and nothing else: anything else closes it', () =>
  withServer({}, async (h) => {
    const cases = {
      'a host': (c) => c.send({ t: 'host', room: ROOM, key: 'k', exp: h.clock.t + 60_000 }),
      'a join': (c) => c.send({ t: 'join', room: ROOM }),
      'a sig': (c) => c.send({ t: 'sig', room: ROOM, to: 'x', data: {} }),
      'something that is not JSON': (c) => c.ws.send('this is not json'),
      'something that is not an object': (c) => c.ws.send('[1,2,3]'),
      'binary': (c) => c.ws.send(Buffer.from('{"t":"hello"}')),
      'a message without a type': (c) => c.send({ proto: 2 }),
      'a hello with a type that is not a string': (c) => c.send({ t: ['hello'], proto: 2 }),
    };
    for (const [what, act] of Object.entries(cases)) {
      const client = wsClient(h.port);
      await client.opened;
      await client.next('challenge');
      act(client);
      const closed = await over(client);
      assert.equal(closed.code, 1008, what);
      assert.equal(closed.reason, 'hello expected', what);
    }
    // and none of it took effect: a friend asking now finds no such room
    const friend = await connectApp(h);
    friend.send({ t: 'join', room: ROOM });
    assert.deepEqual(await friend.next('err'), { t: 'err', room: ROOM, code: 'unknown' });
    assert.equal((await h.request('GET', '/internal/stats')).json.connections, 1);
  }));

test('a hello is at most 4 KB, and a larger message is not even parsed', () =>
  withServer({}, async (h) => {
    const hello = (pad) => {
      const base = JSON.stringify({ t: 'hello', proto: 2, version: '1.2.0', hash: 'dev', proof: '', token: null, pad: '' });
      return base.replace('"pad":""', `"pad":"${'x'.repeat(pad)}"`);
    };
    const exact = 4096 - Buffer.byteLength(hello(0));
    assert.equal(Buffer.byteLength(hello(exact)), 4096);

    const parsed = [];
    const original = JSON.parse;
    JSON.parse = function (text, ...rest) {
      parsed.push(String(text).length);
      return original.call(this, text, ...rest);
    };
    try {
      const fits = wsClient(h.port);
      await fits.opened;
      await fits.next('challenge');
      fits.ws.send(hello(exact));
      assert.equal((await fits.next((m) => m.t === 'welcome' || m.t === 'reject')).t, 'welcome', 'exactly 4096 bytes');

      for (const size of [4097, 5000, 60_000]) {
        const big = wsClient(h.port);
        await big.opened;
        await big.next('challenge');
        big.ws.send(hello(size - Buffer.byteLength(hello(0))));
        assert.equal((await over(big)).code, 1008, `${size} bytes`);
      }
      // neither a text that is too long to be a hello, whatever it looks like
      const junk = wsClient(h.port);
      await junk.opened;
      await junk.next('challenge');
      junk.ws.send('x'.repeat(60_000));
      assert.equal((await over(junk)).code, 1008);
    } finally {
      JSON.parse = original;
    }
    assert.ok(parsed.every((length) => length <= 4096), `JSON.parse was given ${Math.max(...parsed)} characters`);
  }));

test('a second message while the hello is being checked closes the connection, and the welcome never comes', () =>
  withServer({ env: OFFICIAL }, async (h) => {
    // what is said while the first hello is still being checked: something else, or the same hello again
    const seconds = {
      '1.2.8': ['a host', () => ({ t: 'host', room: ROOM, key: 'k', exp: h.clock.t + 60_000 })],
      '1.2.9': ['the hello again', (hello) => hello],
    };
    for (const [version, [what, second]] of Object.entries(seconds)) {
      const hash = sha256(`app.asar of ${version}`);
      h.net.builds[version] = build(version, hash);
      let release;
      h.net.hold = new Promise((resolve) => (release = resolve));
      const client = wsClient(h.port);
      await client.opened;
      const { nonce } = await client.next('challenge');
      const hello = { t: 'hello', proto: 2, version, hash, proof: makeProof(buildKey(SECRET, version), nonce, hash, version), token: null };
      // the build lookup is held up, so the hello is "being checked" for as long as we like
      client.send(hello);
      await sleep(100);
      client.send(second(hello));
      // not left open, whatever the server does next
      const closed = await over(client);
      assert.equal(closed.code, 1008, what);
      release();
      await sleep(100);
      assert.deepEqual(client.queue.filter((m) => m.t === 'welcome'), [], what);
    }
    assert.equal((await h.request('GET', '/internal/stats')).json.connections, 0);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM rooms').n, 0);
  }));

test('after the welcome the connection says what it likes, as before', () =>
  withServer({}, async (h) => {
    const app = await connectApp(h);
    app.ws.send('this is not json');
    app.send({ t: 'nonsense' });
    app.send({ t: 'hello', proto: 2, version: '1.2.0', hash: 'dev', proof: '', token: null });
    assert.deepEqual(await app.quiet(60), []);
    app.send({ t: 'join', room: ROOM });
    assert.equal((await app.next('err')).code, 'unknown');
    assert.equal(app.ws.readyState, 1);
  }));

test('a second hello after the welcome changes nothing', () =>
  withServer({}, async (h) => {
    const app = await connectApp(h);
    app.send({ t: 'hello', proto: 1, version: '0.0.1', hash: 'dev', proof: '', token: null });
    assert.deepEqual(await app.quiet(), []);
    app.send({ t: 'join', room: ROOM });
    assert.equal((await app.next('err')).code, 'unknown');
    app.close();
  }));

test('a connection that never says hello is closed', () =>
  withServer({ tune: (config) => (config.tuning.helloTimeoutMs = 150) }, async (h) => {
    const client = wsClient(h.port);
    await client.opened;
    await client.next('challenge');
    assert.equal((await client.closed).reason, 'no hello');
  }));

test('a token that is not valid is answered with signed_out and the app is welcomed as a guest', () =>
  withServer({}, async (h) => {
    for (const token of ['fsa_' + 'x'.repeat(43), 'short', 12345, {}, 'y'.repeat(300)]) {
      const app = await connectApp(h, { hello: { token } });
      assert.equal(app.reply.t, 'welcome');
      assert.equal(app.reply.signed_out, true);
      assert.equal(app.reply.account, null);
      assert.equal(app.reply.plan, 'free');
      app.close();
    }
  }));

test('a socket that stops answering pings is dropped, a normal one stays', () =>
  withServer({ tune: (config) => (config.tuning.pingIntervalMs = 100) }, async (h) => {
    const deaf = wsClient(h.port, '/ws', { autoPong: false });
    await deaf.opened;
    const alive = await connectApp(h);
    const gone = await Promise.race([deaf.closed.then(() => true), sleep(1500).then(() => false)]);
    assert.equal(gone, true);
    assert.equal(alive.ws.readyState, 1);
    alive.close();
  }));

test('a message over 64 KB closes the connection', () =>
  withServer({}, async (h) => {
    const app = await connectApp(h);
    app.send({ t: 'sig', room: ROOM, to: 'x', data: 'x'.repeat(70 * 1024) });
    assert.equal((await app.closed).code, 1009);
  }));

test('a connection that floods the server with messages is cut off', () =>
  withServer({ tune: (config) => Object.assign(config.tuning, { messageBurst: 10, messagesPerSecond: 1 }) }, async (h) => {
    const app = await connectApp(h);
    const room = (n) => sha256(`room ${n}`);
    for (let n = 0; n < 60; n++) app.send({ t: 'join', room: room(n) });
    await app.closed;
    // only what the bucket allowed was answered, the rest was dropped unread
    assert.ok(app.queue.length <= 10, `${app.queue.length} answers`);
  }));

// ---- official builds ----

test('with official builds required, the right hash and the right proof are welcomed', () =>
  withServer({ env: OFFICIAL }, async (h) => {
    const app = await connectApp(h, { official: { hash: HASH_120 } });
    assert.equal(app.reply.t, 'welcome');
    // a listed build needs no lookup at all
    assert.equal(h.net.calling((c) => c.path.endsWith('build.json')).length, 0);
    app.close();
  }));

test('the proof follows the contract: HMAC of nonce|hash|version keyed by the version key, which is itself an HMAC of the secret', () =>
  withServer({ env: OFFICIAL }, async (h) => {
    const app = await connectApp(h, { official: { hash: HASH_120, proof: 'placeholder' } });
    assert.equal(app.reply.code, 'unofficial');
    // computed here from the contract's words, not with the server's helpers
    const crypto = require('node:crypto');
    const key = crypto.createHmac('sha256', SECRET).update('friendsshare-build:1.2.0').digest('hex');
    const next = await connectApp(h, { official: { hash: HASH_120 } });
    assert.equal(next.reply.t, 'welcome');
    const probe = wsClient(h.port);
    await probe.opened;
    const { nonce } = await probe.next('challenge');
    const proof = crypto.createHmac('sha256', key).update(`${nonce}|${HASH_120}|1.2.0`).digest('hex');
    probe.send({ t: 'hello', proto: 2, version: '1.2.0', hash: HASH_120, proof, token: null });
    assert.equal((await probe.next((m) => m.t === 'welcome' || m.t === 'reject')).t, 'welcome');
    next.close();
    probe.close();
  }));

test('with official builds required, the hash published in build.json is welcomed, remembered and not looked up again', () =>
  withServer({ env: OFFICIAL }, async (h) => {
    const hash = sha256('app.asar of 1.2.1');
    h.net.builds['1.2.1'] = build('1.2.1', hash);
    const first = await connectApp(h, { hello: { version: '1.2.1' }, official: { hash } });
    assert.equal(first.reply.t, 'welcome');
    const second = await connectApp(h, { hello: { version: '1.2.1' }, official: { hash } });
    assert.equal(second.reply.t, 'welcome');
    const lookups = h.net.calling((c) => c.path.endsWith('/v1.2.1/build.json'));
    assert.equal(lookups.length, 1);
    assert.equal(lookups[0].url, 'https://github.com/Siekwie/FriendsShare/releases/download/v1.2.1/build.json');
    // kept in the database, so a restart does not forget it either
    assert.deepEqual(h.db.get('SELECT version, asar_sha256, exe_sha256 FROM builds'), { version: '1.2.1', asar_sha256: hash, exe_sha256: sha256('exe 1.2.1') });
    first.close();
    second.close();
  }));

test('with official builds required, a wrong hash is unofficial even with a proof that fits it', () =>
  withServer({ env: OFFICIAL }, async (h) => {
    h.net.builds['1.2.1'] = build('1.2.1', sha256('app.asar of 1.2.1'));
    const app = await connectApp(h, { hello: { version: '1.2.1' }, official: { hash: sha256('a modified app.asar') } });
    assert.deepEqual(app.reply, { t: 'reject', code: 'unofficial' });
    assert.equal((await app.closed).reason, 'unofficial');
  }));

test('with official builds required, a wrong proof is unofficial', () =>
  withServer({ env: OFFICIAL }, async (h) => {
    const nonce = 'f'.repeat(64);
    const forged = [
      makeProof(buildKey('some other secret', '1.2.0'), nonce, HASH_120, '1.2.0'),
      'not hex at all',
      '0'.repeat(64),
      makeProof(buildKey(SECRET, '1.2.0'), nonce, HASH_120, '1.2.0'), // right key, but for another connection's nonce
      makeProof(buildKey(SECRET, '1.3.0'), 'x', HASH_120, '1.2.0'),
    ];
    for (const proof of forged) {
      const app = await connectApp(h, { official: { hash: HASH_120, proof } });
      assert.deepEqual(app.reply, { t: 'reject', code: 'unofficial' }, proof);
    }
  }));

test('with official builds required, an empty proof or a build from source is unofficial', () =>
  withServer({ env: OFFICIAL }, async (h) => {
    const empty = await connectApp(h, { hello: { hash: HASH_120, proof: '' } });
    assert.equal(empty.reply.code, 'unofficial');
    const missing = await connectApp(h, { hello: { hash: HASH_120, proof: undefined } });
    assert.equal(missing.reply.code, 'unofficial');
    const dev = await connectApp(h, { hello: { hash: 'dev', proof: '' } });
    assert.equal(dev.reply.code, 'unofficial');
    // not even the right key helps a hash of "dev"
    const devProof = await connectApp(h, { official: { hash: 'dev' } });
    assert.equal(devProof.reply.code, 'unofficial');
  }));

test('an app run from source is admitted only when EXTRA_BUILDS lists "dev" for its version and it holds the key', () =>
  withServer({ env: { ...OFFICIAL, EXTRA_BUILDS: '1.2.0:dev' } }, async (h) => {
    const withKey = await connectApp(h, { official: { hash: 'dev' } });
    assert.equal(withKey.reply.t, 'welcome');
    // "dev" is never looked up among the published releases
    assert.equal(h.net.calling((c) => c.path.endsWith('build.json')).length, 0);
    const withoutKey = await connectApp(h, { hello: { hash: 'dev', proof: '' } });
    assert.equal(withoutKey.reply.code, 'unofficial');
    const otherVersion = await connectApp(h, { hello: { version: '1.2.1' }, official: { hash: 'dev' } });
    assert.equal(otherVersion.reply.code, 'unofficial');
    withKey.close();
  }));

test('a stranger cannot make the server look anything up: the proof is checked before any fetch', () =>
  withServer({ env: OFFICIAL }, async (h) => {
    h.net.builds['1.2.7'] = build('1.2.7', HASH_120);
    for (const version of ['1.2.7', '9.9.9']) {
      const app = await connectApp(h, { hello: { version, hash: HASH_120, proof: 'f'.repeat(64) } });
      assert.equal(app.reply.code, 'unofficial');
    }
    assert.equal(h.net.calling((c) => c.path.endsWith('build.json')).length, 0);
  }));

test('a version that is not published is a miss, remembered for a minute and tried again after that', () =>
  withServer({ env: OFFICIAL }, async (h) => {
    const hash = sha256('app.asar of 1.2.5');
    const lookups = () => h.net.calling((c) => c.path.endsWith('/v1.2.5/build.json')).length;
    const attempt = () => connectApp(h, { hello: { version: '1.2.5' }, official: { hash } });

    assert.equal((await attempt()).reply.code, 'unofficial');
    assert.equal((await attempt()).reply.code, 'unofficial');
    assert.equal(lookups(), 1);

    // the release shows up on GitHub; still remembered as a miss for the rest of the minute
    h.net.builds['1.2.5'] = build('1.2.5', hash);
    h.clock.advance(30_000);
    assert.equal((await attempt()).reply.code, 'unofficial');
    assert.equal(lookups(), 1);

    h.clock.advance(31_000);
    assert.equal((await attempt()).reply.t, 'welcome');
    assert.equal(lookups(), 2);
  }));

test('apps that ask about one version at the same moment cause a single lookup', () =>
  withServer({ env: OFFICIAL }, async (h) => {
    const hash = sha256('app.asar of 1.2.2');
    h.net.builds['1.2.2'] = build('1.2.2', hash);
    let release;
    h.net.hold = new Promise((resolve) => (release = resolve));
    const apps = Array.from({ length: 4 }, () => connectApp(h, { hello: { version: '1.2.2' }, official: { hash } }));
    await sleep(200);
    release();
    for (const app of await Promise.all(apps)) {
      assert.equal(app.reply.t, 'welcome');
      app.close();
    }
    assert.equal(h.net.calling((c) => c.path.endsWith('/v1.2.2/build.json')).length, 1);
  }));

test('a release that was rebuilt is picked up once the minute is over', () =>
  withServer({ env: OFFICIAL }, async (h) => {
    const before = sha256('app.asar, first build');
    const after = sha256('app.asar, second build');
    h.net.builds['1.2.3'] = build('1.2.3', before);
    assert.equal((await connectApp(h, { hello: { version: '1.2.3' }, official: { hash: before } })).reply.t, 'welcome');

    h.net.builds['1.2.3'] = build('1.2.3', after);
    assert.equal((await connectApp(h, { hello: { version: '1.2.3' }, official: { hash: after } })).reply.code, 'unofficial');
    h.clock.advance(61_000);
    assert.equal((await connectApp(h, { hello: { version: '1.2.3' }, official: { hash: after } })).reply.t, 'welcome');
    assert.equal(h.db.get('SELECT asar_sha256 FROM builds WHERE version = ?', '1.2.3').asar_sha256, after);
  }));

test('a build.json that does not describe the version it was fetched for is not trusted', () =>
  withServer({ env: OFFICIAL }, async (h) => {
    const hash = sha256('app.asar of 1.2.4');
    h.net.builds['1.2.4'] = build('1.2.0', hash); // the file says 1.2.0
    const app = await connectApp(h, { hello: { version: '1.2.4' }, official: { hash } });
    assert.equal(app.reply.code, 'unofficial');
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM builds').n, 0);
  }));

test('one line is logged for every rejected hello and none for accepted ones', () =>
  withServer({ env: OFFICIAL }, async (h) => {
    await (await connectApp(h, { official: { hash: HASH_120 } })).reply;
    await connectApp(h, { hello: { version: '1.1.1' } });
    await connectApp(h, { hello: { hash: 'dev' } });
    await connectApp(h, { hello: { version: '1.2.0\n[auth] forged line' } });
    assert.deepEqual(
      h.logs.filter((line) => line.startsWith('[match]')),
      ['[match] rejected outdated version=1.1.1', '[match] rejected unofficial version=1.2.0', '[match] rejected outdated version=invalid'],
    );
  }));

test('the old path is counted but not logged once per connection', () =>
  withServer({}, async (h) => {
    for (let n = 0; n < 5; n++) await (await rawUpgrade(h.port, '/')).closed;
    assert.equal(h.logs.filter((line) => line.startsWith('[match]')).length, 1);
    const stats = await h.request('GET', '/internal/stats');
    assert.equal(stats.json.rejected.outdated, 5);
  }));
