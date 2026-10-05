// Blocking share rooms after an abuse report: the operator's endpoints, who may call them, and
// what the matchmaking does about a blocked room.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { withServer, startServer, connectApp, sha256, dumpDatabase, announce, BILLING_ENV, START } = require('./helpers');
const { fromThisMachine } = require('../lib/http');

const HOUR = 3_600_000;
const CODE = '123e4567-e89b-12d3-a456-426614174000';
// what an app works out for that code: the SHA-256 of the text
const ROOM = crypto.createHash('sha256').update(CODE, 'utf8').digest('hex');

// The operator at the machine, with wget inside the container: no cookie, no Origin header.
const call = (h, method, path, body, headers) => h.request(method, path, { json: body, origin: null, headers });
const block = (h, body) => call(h, 'POST', '/internal/block', body);
const unblock = (h, body) => call(h, 'POST', '/internal/unblock', body);
const listing = (h) => call(h, 'GET', '/internal/blocked');
const stats = async (h) => (await call(h, 'GET', '/internal/stats')).json;

const room = (n) => sha256(`share code ${n}`);
const blockedErr = (r) => ({ t: 'err', room: r, code: 'blocked' });
const sentence = /^[A-Z].*\.$/;

// the apps' side
function host(h, app, r, { key = `key of ${r.slice(0, 8)}`, exp = h.clock.t + HOUR } = {}) {
  app.send({ t: 'host', room: r, key, exp });
  return app.next((m) => m.room === r && (m.t === 'hosted' || m.t === 'err'));
}
function join(app, r) {
  app.send({ t: 'join', room: r });
  return app.next((m) => m.room === r && (m.t === 'joined' || m.t === 'err'));
}

// ---- who may call ----

test('the operator endpoints answer the machine itself, and everybody else gets what any unknown address gets', () =>
  withServer({}, async (h) => {
    // from the machine itself
    const made = await block(h, { code: CODE });
    assert.equal(made.status, 200);
    assert.equal((await listing(h)).json.length, 1);
    assert.equal((await call(h, 'HEAD', '/internal/blocked')).status, 200);
    assert.equal((await unblock(h, { code: CODE })).status, 200);
    assert.deepEqual((await listing(h)).json, []);

    // through the proxy, or with any sign of one: nothing happens, and nothing says the route is there
    const forwarded = [{ 'x-forwarded-for': '203.0.113.9' }, { 'x-forwarded-for': '127.0.0.1' }, { forwarded: 'for=203.0.113.9' }, { 'x-real-ip': '203.0.113.9' }];
    const attempts = [
      ['POST', '/internal/block', { code: CODE }],
      ['POST', '/internal/unblock', { code: CODE }],
      ['GET', '/internal/blocked'],
      ['HEAD', '/internal/blocked'],
      ['GET', '/internal/stats'],
    ];
    for (const headers of forwarded) {
      for (const [method, path, body] of attempts) {
        const res = await call(h, method, path, body, headers);
        const unknown = await call(h, method, '/internal/nothing-here', body, headers);
        const what = `${method} ${path} with ${JSON.stringify(headers)}`;
        assert.equal(res.status, 404, what);
        assert.equal(res.text, unknown.text, what);
        assert.equal(res.headers['content-type'], unknown.headers['content-type'], what);
      }
    }
    assert.deepEqual((await listing(h)).json, [], 'blocking from outside did nothing');

    // and lifting a block from outside does nothing either
    await block(h, { code: CODE });
    for (const headers of forwarded) await call(h, 'POST', '/internal/unblock', { code: CODE }, headers);
    assert.deepEqual((await listing(h)).json.map((r) => r.room), [ROOM]);
  }));

test('another website cannot get a browser to block a room for it', () =>
  withServer({}, async (h) => {
    for (const headers of [{ origin: 'https://evil.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }]) {
      for (const path of ['/internal/block', '/internal/unblock']) {
        const res = await call(h, 'POST', path, { code: CODE }, headers);
        assert.equal(res.status, 403, `${path} ${JSON.stringify(headers)}`);
        assert.equal(res.json.error, 'forbidden');
      }
    }
    assert.deepEqual((await listing(h)).json, []);
    // a page of this site itself would be allowed, like any other call
    assert.equal((await h.request('POST', '/internal/block', { json: { code: CODE } })).status, 200);
  }));

// What anybody but the operator gets for an address under /internal: what any unknown address gets.
async function unknownLike(h, method, urlPath, body, headers) {
  const res = await call(h, method, urlPath, body, headers);
  const unknown = await call(h, method, '/internal/nothing-here', body, headers);
  return { res, same: res.status === 404 && res.text === unknown.text && res.headers['content-type'] === unknown.headers['content-type'] };
}

test('the guard is the path: a route added later under /internal is the machine\'s as well, without having to say so', () =>
  withServer({}, async (h) => {
    const routes = ['/internal/future', '/internal/future/deeper', '/internal/', '/internal'];
    for (const route of routes) {
      // as a route written in a hurry would be, with no flag of any kind
      h.server.router.add('GET', route, (ctx) => ctx.json(200, { secret: `SECRET-${route}` }));
      h.server.router.add('POST', route, (ctx) => ctx.json(200, { changed: route }));
    }
    for (const route of routes) {
      assert.equal((await call(h, 'GET', route)).json.secret, `SECRET-${route}`, `${route} from the machine`);
      assert.equal((await call(h, 'POST', route, {})).json.changed, route);
      assert.equal((await call(h, 'HEAD', route)).status, 200);
    }
    for (const headers of [{ 'x-forwarded-for': '203.0.113.9' }, { forwarded: 'for=203.0.113.9' }, { 'x-real-ip': '203.0.113.9' }, { 'x-forwarded-for': '' }]) {
      for (const route of routes) {
        for (const method of ['GET', 'POST', 'HEAD']) {
          const { res, same } = await unknownLike(h, method, route, method === 'POST' ? {} : undefined, headers);
          assert.ok(same, `${method} ${route} with ${JSON.stringify(headers)} -> ${res.status} ${res.text.slice(0, 40)}`);
          assert.ok(!res.text.includes('SECRET') && !res.text.includes('changed'));
        }
      }
    }
  }));

test('other spellings of an address under /internal reach nothing for the proxy either, and no site file from anybody', () =>
  withServer({}, async (h) => {
    h.server.router.add('GET', '/internal/future', (ctx) => ctx.json(200, { secret: 'FUTURE-SECRET' }));
    fs.mkdirSync(path.join(h.config.siteDir, 'Internal'), { recursive: true });
    fs.writeFileSync(path.join(h.config.siteDir, 'Internal', 'stats'), 'A FILE THAT MUST NOT BE SERVED');
    fs.writeFileSync(path.join(h.config.siteDir, 'Internal', 'page.html'), 'A PAGE THAT MUST NOT BE SERVED');
    const through = { 'x-forwarded-for': '203.0.113.9' };
    for (const target of [
      '/internal/stats', '/internal/future', '/Internal/stats', '/INTERNAL/stats', '/Internal/page.html', '/internal/page.html', '/internal/stats/', '/internal//stats', '/internal/./stats',
      '/internal/../internal/stats', '/%69nternal/stats', '/internal%2Fstats', '/%2e/internal/stats', '/internal/stats%00', '/internal/stats.', '/internal/stats?x=1', '/internal/future/..%2fstats',
    ]) {
      let res;
      try {
        res = await call(h, 'GET', target, undefined, through);
      } catch {
        continue; // the client library refused to send it at all
      }
      assert.ok([400, 404].includes(res.status), `${target} -> ${res.status}`);
      for (const marker of ['MUST NOT', 'FUTURE-SECRET', 'connections', 'started_at']) assert.ok(!res.text.includes(marker), `${target} leaked ${marker}`);
    }
    // the machine itself gets its routes under the exact spelling, and no site file under any
    assert.equal((await call(h, 'GET', '/internal/stats')).status, 200);
    assert.equal((await call(h, 'GET', '/internal/future')).json.secret, 'FUTURE-SECRET');
    for (const target of ['/Internal/stats', '/INTERNAL/stats', '/Internal/page.html', '/internal/page.html']) {
      const res = await call(h, 'GET', target);
      assert.equal(res.status, 404, target);
      assert.ok(!res.text.includes('MUST NOT'), target);
    }
  }));

test('every sign of a proxy counts, a header with nothing in it as much as one with an address', () =>
  withServer({}, async (h) => {
    const names = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'forwarded', 'x-real-ip', 'via', 'X-Forwarded-For', 'FORWARDED', 'Via'];
    for (const name of names) {
      for (const value of ['', ' ', '203.0.113.9', '127.0.0.1', 'for=127.0.0.1']) {
        const { res, same } = await unknownLike(h, 'GET', '/internal/stats', undefined, { [name]: value });
        assert.ok(same, `${name}: ${JSON.stringify(value)} -> ${res.status}`);
      }
      // the same header twice, however empty
      assert.ok((await unknownLike(h, 'GET', '/internal/stats', undefined, { [name]: ['', ''] })).same, `${name} twice`);
    }
    // written by hand, with the header cased and spaced as some client might
    for (const line of ['X-FORWARDED-FOR:', 'x-forwarded-for:\t', 'Forwarded:', 'X-Real-Ip:', 'Via:  ']) {
      const raw = await new Promise((resolve, reject) => {
        const socket = net.connect(h.port, '127.0.0.1', () => socket.write(`GET /internal/stats HTTP/1.1\r\nHost: localhost\r\n${line}\r\nConnection: close\r\n\r\n`));
        const chunks = [];
        socket.on('data', (chunk) => chunks.push(chunk));
        socket.on('error', reject);
        socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      assert.match(raw, /^HTTP\/1\.1 404 /, JSON.stringify(line));
      assert.ok(!raw.includes('connections'), JSON.stringify(line));
    }
    // and with none of them it is the machine, whatever else the request says: wget in the container sends little more than a Host
    assert.equal((await call(h, 'GET', '/internal/stats')).status, 200);
    assert.equal((await call(h, 'GET', '/internal/stats', undefined, { host: 'localhost:8080', 'user-agent': 'Wget', accept: '*/*' })).status, 200);
    assert.equal((await call(h, 'GET', '/internal/stats', undefined, { host: 'friendsshare.example.com' })).status, 200, 'the name it was called by is not what decides');
  }));

test('the machine itself means loopback at both ends of the connection, and no mention of forwarding', () => {
  const request = (remoteAddress, localAddress, headers = {}) => ({ socket: { remoteAddress, localAddress }, headers });
  for (const remote of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    for (const local of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(fromThisMachine(request(remote, local)), true, `${remote} -> ${local}`);
  }
  // Caddy, or anybody else on the network the container is in
  assert.equal(fromThisMachine(request('172.18.0.2', '172.18.0.3')), false);
  // a connection that says it is from loopback but came in over a real interface
  assert.equal(fromThisMachine(request('127.0.0.1', '172.18.0.3')), false);
  assert.equal(fromThisMachine(request('::1', '2001:db8::3')), false);
  // not known is not loopback
  for (const [remote, local] of [[undefined, undefined], ['127.0.0.1', undefined], [undefined, '127.0.0.1'], ['', ''], ['127.0.0.2', '127.0.0.1'], ['localhost', 'localhost']]) {
    assert.equal(fromThisMachine(request(remote, local)), false, `${remote} -> ${local}`);
  }
  for (const name of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'forwarded', 'x-real-ip', 'via']) {
    for (const value of ['', 'x', '127.0.0.1']) assert.equal(fromThisMachine(request('127.0.0.1', '127.0.0.1', { [name]: value })), false, `${name}: ${JSON.stringify(value)}`);
  }
  assert.equal(fromThisMachine(request('127.0.0.1', '127.0.0.1', { host: 'localhost', 'user-agent': 'Wget', cookie: 'a=b' })), true);
});

// ---- blocking ----

test('a share code becomes its room the way the apps do it, and the code itself is never kept', () =>
  withServer({}, async (h) => {
    const res = await block(h, { code: `  ${CODE.toUpperCase()}\n`, note: 'report 2026-10-05, ticket 17' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { room: ROOM, blocked: true });
    assert.match(res.headers['content-type'], /^application\/json/);
    assert.deepEqual(h.db.all('SELECT room, created_at, note FROM blocked_rooms'), [{ room: ROOM, created_at: START, note: 'report 2026-10-05, ticket 17' }]);

    const logged = h.logs.join('\n');
    assert.ok(!dumpDatabase(h).toLowerCase().includes(CODE), 'the code is not in the database');
    assert.ok(!logged.toLowerCase().includes(CODE), 'the code is not in the log');
    assert.ok(!logged.includes('ticket 17'), 'the note is not in the log');
    assert.ok(!logged.includes(ROOM), 'only a piece of the room is');
    assert.deepEqual(h.logs.filter((line) => line.startsWith('[operator]')), [`[operator] room ${ROOM.slice(0, 12)} blocked, 0 connections told`]);
  }));

test('a room can be named directly, in either case', () =>
  withServer({}, async (h) => {
    assert.deepEqual((await block(h, { room: ROOM })).json, { room: ROOM, blocked: true });
    const other = sha256('another room');
    assert.deepEqual((await block(h, { room: ` ${other.toUpperCase()} ` })).json, { room: other, blocked: true });
    assert.deepEqual((await listing(h)).json.map((r) => r.room).sort(), [ROOM, other].sort());
  }));

test('requests that do not name exactly one room are refused, and nothing is blocked by them', () =>
  withServer({}, async (h) => {
    const badTargets = [
      {}, { note: 'only a note' }, { code: CODE, room: ROOM }, { code: CODE, room: null }, { code: null, room: ROOM },
      { code: 5 }, { code: null }, { code: '' }, { code: '   ' }, { code: 'not a code' }, { code: [CODE] }, { code: { toString: 1 } },
      // a typo must not "work": it would block a room that no app can ever have
      { code: CODE.slice(1) }, { code: `${CODE}0` }, { code: CODE.replace(/-/g, '') }, { code: `${CODE} please` }, { code: CODE.replace('e', 'g') },
      { room: 5 }, { room: null }, { room: '' }, { room: 'abc' }, { room: ROOM.slice(1) }, { room: `${ROOM}0` }, { room: 'g'.repeat(64) }, { room: [ROOM] },
    ];
    for (const body of badTargets) {
      for (const path of ['/internal/block', '/internal/unblock']) {
        const res = await call(h, 'POST', path, body);
        assert.equal(res.status, 400, `${path} ${JSON.stringify(body)}`);
        assert.equal(res.json.error, 'bad_request');
        assert.match(res.json.message, sentence);
      }
    }
    for (const note of [5, { a: 1 }, ['x'], true, 'x'.repeat(501)]) {
      const res = await block(h, { code: CODE, note });
      assert.equal(res.status, 400, JSON.stringify(note).slice(0, 30));
      assert.match(res.json.message, sentence);
    }
    // not JSON, or not an object
    for (const body of ['', 'not json', '[]', 'null', '"text"', '{"code": ']) {
      const res = await h.request('POST', '/internal/block', { body, origin: null });
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.json.error, 'bad_request');
    }
    // too large to read: announced in the headers, and refused from them
    const big = await announce(h.port, 'POST', '/internal/block', { 'content-type': 'application/json' }, 70 * 1024);
    assert.equal(big.status, 413);
    assert.equal(big.json.error, 'too_large');
    assert.deepEqual((await listing(h)).json, []);
    assert.equal(h.logs.filter((line) => line.startsWith('[operator]')).length, 0);
  }));

test('the longest note is accepted, and a note is tidied up', () =>
  withServer({}, async (h) => {
    assert.equal((await block(h, { code: CODE, note: 'x'.repeat(500) })).status, 200);
    assert.equal(h.db.get('SELECT note FROM blocked_rooms').note.length, 500);
    await block(h, { room: room(1), note: '  line one\nline two\u0000\ttabbed  ' });
    assert.equal(h.db.get('SELECT note FROM blocked_rooms WHERE room = ?', room(1)).note, 'line one line two  tabbed');
    await block(h, { room: room(2), note: '   ' });
    assert.equal(h.db.get('SELECT note FROM blocked_rooms WHERE room = ?', room(2)).note, null);
    await block(h, { room: room(3), note: null });
    assert.equal(h.db.get('SELECT note FROM blocked_rooms WHERE room = ?', room(3)).note, null);
  }));

test('blocking a room again keeps its first date, and its note unless there is a new one', () =>
  withServer({}, async (h) => {
    await block(h, { code: CODE, note: 'first report' });
    const first = h.db.get('SELECT * FROM blocked_rooms');
    assert.deepEqual(first, { room: ROOM, created_at: START, note: 'first report' });
    h.clock.advance(HOUR);
    assert.equal((await block(h, { code: CODE })).status, 200);
    assert.deepEqual(h.db.get('SELECT * FROM blocked_rooms'), first);
    await block(h, { code: CODE, note: 'second report' });
    assert.deepEqual(h.db.get('SELECT * FROM blocked_rooms'), { ...first, note: 'second report' });
    await block(h, { code: CODE, note: '   ' });
    assert.equal(h.db.get('SELECT note FROM blocked_rooms').note, 'second report', 'an empty note says nothing new');
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM blocked_rooms').n, 1);
  }));

// ---- the list and unblocking ----

test('the list shows what is blocked, newest first', () =>
  withServer({}, async (h) => {
    const empty = await listing(h);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json, []);
    assert.match(empty.headers['content-type'], /^application\/json/);
    assert.equal(empty.headers['cache-control'], 'no-store');

    await block(h, { room: room(1), note: 'older' });
    h.clock.advance(HOUR);
    await block(h, { room: room(2) });
    h.clock.advance(HOUR);
    await block(h, { room: room(3), note: 'newest' });
    assert.deepEqual((await listing(h)).json, [
      { room: room(3), created_at: START + 2 * HOUR, note: 'newest' },
      { room: room(2), created_at: START + HOUR, note: null },
      { room: room(1), created_at: START, note: 'older' },
    ]);
    assert.equal((await stats(h)).blocked_rooms, 3);

    // blocked together: by name, so the order is stable
    await block(h, { room: 'f'.repeat(64) });
    await block(h, { room: '0'.repeat(64) });
    const sameMoment = (await listing(h)).json.filter((r) => r.created_at === START + 2 * HOUR);
    assert.deepEqual(sameMoment.map((r) => r.room), [...sameMoment.map((r) => r.room)].sort());
  }));

test('unblocking lifts the block by code or by room, and a room that was not blocked is not an error', () =>
  withServer({}, async (h) => {
    await block(h, { code: CODE });
    const lifted = await unblock(h, { code: `${CODE.toUpperCase()} ` });
    assert.equal(lifted.status, 200);
    assert.deepEqual(lifted.json, { room: ROOM, blocked: false });
    assert.deepEqual((await listing(h)).json, []);
    assert.equal((await stats(h)).blocked_rooms, 0);

    const never = sha256('never blocked');
    assert.deepEqual((await unblock(h, { room: never })).json, { room: never, blocked: false });

    // by room; a note in the body is simply ignored
    await block(h, { room: ROOM });
    assert.equal((await unblock(h, { room: ROOM, note: 'ignored' })).status, 200);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM blocked_rooms').n, 0);

    // logged when a block was lifted, not when there was nothing to lift
    assert.deepEqual(
      h.logs.filter((line) => line.includes('unblocked')),
      [`[operator] room ${ROOM.slice(0, 12)} unblocked`, `[operator] room ${ROOM.slice(0, 12)} unblocked`],
    );
  }));

// ---- the matchmaking ----

test('a blocked room cannot be hosted, whatever the other answer would have been', () =>
  withServer({}, async (h) => {
    const owner = await connectApp(h);
    await block(h, { room: room(1) });
    assert.deepEqual(await host(h, owner, room(1)), blockedErr(room(1)));
    assert.deepEqual(await host(h, owner, room(1), { exp: h.clock.t - 1 }), blockedErr(room(1)), 'not "expired"');
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM rooms').n, 0, 'nothing was registered');
    assert.equal((await stats(h)).hosted_rooms, 0);
    // a malformed host is still ignored in silence, as always
    owner.send({ t: 'host', room: room(1), key: '', exp: h.clock.t + HOUR });
    assert.deepEqual(await owner.quiet(60), []);
    // other rooms are not affected
    assert.equal((await host(h, owner, room(2))).t, 'hosted');
  }));

test('the room of a code is the room an app asks for', () =>
  withServer({}, async (h) => {
    const app = await connectApp(h);
    await block(h, { code: CODE });
    // an app that hosts or joins the code works out the SHA-256 of it and asks for that room
    assert.deepEqual(await host(h, app, sha256(CODE)), blockedErr(sha256(CODE)));
    assert.deepEqual(await join(app, sha256(CODE)), blockedErr(sha256(CODE)));
  }));

test('a blocked room cannot be joined: no wait is remembered and no slot is used', () =>
  withServer({}, async (h) => {
    const friend = await connectApp(h);
    await block(h, { room: room(1) });
    assert.deepEqual(await join(friend, room(1)), blockedErr(room(1)));
    assert.equal((await stats(h)).waiting, 0);

    // lifted, and the owner arrives: the friend was not waiting, so it hears nothing
    await unblock(h, { room: room(1) });
    const owner = await connectApp(h);
    assert.equal((await host(h, owner, room(1))).t, 'hosted');
    assert.deepEqual(await friend.quiet(80), []);
    assert.equal((await join(friend, room(1))).t, 'joined');
  }));

test('blocking a room while its owner is connected drops the registration at once and tells everybody in it', () =>
  withServer({}, async (h) => {
    const owner = await connectApp(h);
    const friend = await connectApp(h);
    const second = await connectApp(h);
    const bystander = await connectApp(h);
    await host(h, owner, room(1), { key: 'k1' });
    await host(h, owner, room(2), { key: 'k2' });
    await join(friend, room(1));
    await join(second, room(1));
    await join(bystander, room(2));
    friend.send({ t: 'sig', room: room(1), to: owner.id, data: 'before' });
    assert.equal((await owner.next('sig')).data, 'before');

    const res = await block(h, { room: room(1) });
    assert.deepEqual(res.json, { room: room(1), blocked: true });
    for (const app of [owner, friend, second]) assert.deepEqual(await app.next('err'), blockedErr(room(1)));
    assert.deepEqual(await bystander.quiet(80), [], 'somebody in another room is not told');
    assert.ok(h.logs.includes(`[operator] room ${room(1).slice(0, 12)} blocked, 3 connections told`));

    // the owner is gone from the room, so nothing is relayed any more, either way
    friend.send({ t: 'sig', room: room(1), to: owner.id, data: 'after' });
    owner.send({ t: 'sig', room: room(1), to: friend.id, data: 'after' });
    assert.deepEqual(await owner.quiet(60), []);
    assert.deepEqual(await friend.quiet(60), []);

    // the numbers see it at once; the owner's other room is untouched and still relays
    const now = await stats(h);
    assert.equal(now.hosted_rooms, 1);
    assert.equal(now.blocked_rooms, 1);
    bystander.send({ t: 'sig', room: room(2), to: owner.id, data: 'still fine' });
    assert.equal((await owner.next('sig')).data, 'still fine');

    // new attempts are answered with blocked, from the owner as well
    const newcomer = await connectApp(h);
    assert.deepEqual(await join(newcomer, room(1)), blockedErr(room(1)));
    assert.deepEqual(await host(h, owner, room(1), { key: 'k1' }), blockedErr(room(1)));

    // the record of the room stays, even if the owner now unhosts it
    assert.equal(h.db.get('SELECT key_hash FROM rooms WHERE room = ?', room(1)).key_hash, sha256('k1'));
    owner.send({ t: 'unhost', room: room(1) });
    await owner.quiet(60);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM rooms WHERE room = ?', room(1)).n, 1);
  }));

test('blocking tells one connection once, even when it is both the owner and a friend in the room', () =>
  withServer({}, async (h) => {
    const app = await connectApp(h);
    await host(h, app, room(1));
    assert.equal((await join(app, room(1))).t, 'joined');
    const res = await block(h, { room: room(1) });
    assert.equal(res.status, 200);
    assert.deepEqual(await app.next('err'), blockedErr(room(1)));
    assert.deepEqual(await app.quiet(60), []);
    assert.ok(h.logs.includes(`[operator] room ${room(1).slice(0, 12)} blocked, 1 connection told`));
  }));

test('friends who are waiting for a blocked room hear blocked, and are not told when its owner comes back', () =>
  withServer({}, async (h) => {
    const first = await connectApp(h);
    await host(h, first, room(1), { key: 'k' });
    await h.disconnect(first);
    const waiting = await connectApp(h);
    const other = await connectApp(h);
    assert.equal((await join(waiting, room(1))).code, 'offline');
    assert.equal((await join(other, room(2))).code, 'unknown');
    assert.equal((await stats(h)).waiting, 2);

    await block(h, { room: room(1) });
    assert.deepEqual(await waiting.next('err'), blockedErr(room(1)));
    assert.deepEqual(await other.quiet(60), [], 'the friend of another room is not told');
    assert.equal((await stats(h)).waiting, 1);

    await unblock(h, { room: room(1) });
    const back = await connectApp(h);
    assert.equal((await host(h, back, room(1), { key: 'k' })).t, 'hosted');
    assert.deepEqual(await waiting.quiet(80), [], 'no wait was left behind');
  }));

test('a friend who was told online but has not joined yet hears blocked as well', () =>
  withServer({}, async (h) => {
    const friend = await connectApp(h);
    assert.equal((await join(friend, room(1))).code, 'unknown');
    const owner = await connectApp(h);
    await host(h, owner, room(1));
    assert.equal((await friend.next('online')).room, room(1));
    await block(h, { room: room(1) });
    assert.deepEqual(await friend.next('err'), blockedErr(room(1)));
    assert.deepEqual(await join(friend, room(1)), blockedErr(room(1)));
  }));

test('a blocked room takes no slot, and the slot it had is given back', () =>
  withServer({ env: BILLING_ENV }, async (h) => {
    const owner = await connectApp(h);
    const friend = await connectApp(h);
    for (let n = 1; n <= 5; n++) assert.equal((await host(h, owner, room(n))).t, 'hosted');
    for (let n = 1; n <= 5; n++) assert.equal((await join(friend, room(n))).t, 'joined');
    assert.equal((await host(h, owner, room(6))).code, 'limit');
    assert.equal((await join(friend, room(6))).code, 'limit');

    await block(h, { room: room(5) });
    assert.deepEqual(await owner.next('err'), blockedErr(room(5)));
    assert.deepEqual(await friend.next('err'), blockedErr(room(5)));
    // one slot each is free again
    assert.equal((await host(h, owner, room(6))).t, 'hosted');
    assert.equal((await join(friend, room(6))).t, 'joined');
    assert.equal((await host(h, owner, room(7))).code, 'limit');
    assert.equal((await join(friend, room(7))).code, 'limit');

    // both are full again, and asking for the blocked room is still just "blocked", never a slot
    for (let n = 0; n < 5; n++) {
      assert.deepEqual(await host(h, owner, room(5)), blockedErr(room(5)));
      assert.deepEqual(await join(friend, room(5)), blockedErr(room(5)));
    }
    owner.send({ t: 'unhost', room: room(1) });
    friend.send({ t: 'leave', room: room(1) });
    // exactly one slot came free: the blocked attempts had used none
    assert.equal((await host(h, owner, room(7))).t, 'hosted');
    assert.equal((await host(h, owner, room(8))).code, 'limit');
    assert.equal((await join(friend, room(7))).t, 'joined');
    assert.equal((await join(friend, room(8))).code, 'limit');
  }));

test('the record of the room stays, so nobody can claim a blocked room, now or once the block is lifted', () =>
  withServer({}, async (h) => {
    const owner = await connectApp(h);
    const thief = await connectApp(h);
    const friend = await connectApp(h);
    await host(h, owner, room(1), { key: 'the owner key' });
    await block(h, { room: room(1) });
    await owner.next('err');

    // while it is blocked it is blocked for everybody, with whatever key
    assert.deepEqual(await host(h, thief, room(1), { key: 'a different key' }), blockedErr(room(1)));
    assert.deepEqual(await host(h, owner, room(1), { key: 'the owner key' }), blockedErr(room(1)));
    assert.equal(h.db.get('SELECT key_hash FROM rooms WHERE room = ?', room(1)).key_hash, sha256('the owner key'));

    // lifted: the key that registered it decides again
    await unblock(h, { room: room(1) });
    assert.deepEqual(await host(h, thief, room(1), { key: 'a different key' }), { t: 'err', room: room(1), code: 'taken' });
    assert.deepEqual(await host(h, owner, room(1), { key: 'the owner key' }), { t: 'hosted', room: room(1) });
    assert.deepEqual(await join(friend, room(1)), { t: 'joined', room: room(1), host: owner.id });
  }));

test('a room blocked while nobody is connected stays blocked when its owner comes back', () =>
  withServer({}, async (h) => {
    const first = await connectApp(h);
    await host(h, first, room(1), { key: 'k' });
    await h.disconnect(first);

    const res = await block(h, { room: room(1) });
    assert.equal(res.status, 200);
    assert.ok(h.logs.includes(`[operator] room ${room(1).slice(0, 12)} blocked, 0 connections told`));
    const back = await connectApp(h);
    assert.deepEqual(await host(h, back, room(1), { key: 'k' }), blockedErr(room(1)));
    // and a room that was never registered can be blocked ahead of time
    await block(h, { room: room(2) });
    assert.deepEqual(await host(h, back, room(2)), blockedErr(room(2)));
  }));

test('a block survives a restart of the server', async () => {
  const first = await startServer();
  try {
    const owner = await connectApp(first);
    await host(first, owner, room(1), { key: 'k' });
    await first.disconnect(owner);
    await block(first, { code: CODE, note: 'kept' });
    await block(first, { room: room(1) });
  } finally {
    await first.server.close();
  }

  const second = await startServer({ dir: first.dir });
  try {
    assert.deepEqual((await listing(second)).json.map((r) => r.room).sort(), [ROOM, room(1)].sort());
    assert.equal((await stats(second)).blocked_rooms, 2);
    const owner = await connectApp(second);
    const friend = await connectApp(second);
    assert.deepEqual(await host(second, owner, room(1), { key: 'k' }), blockedErr(room(1)));
    assert.deepEqual(await join(friend, room(1)), blockedErr(room(1)));
    assert.deepEqual(await join(friend, ROOM), blockedErr(ROOM));
    // and the other rooms of the same people are fine
    assert.equal((await host(second, owner, room(2))).t, 'hosted');
  } finally {
    await second.close();
  }
});

test('blocking and unblocking are the whole story: once lifted, hosting and joining work as before', () =>
  withServer({}, async (h) => {
    const owner = await connectApp(h);
    const friend = await connectApp(h);
    await host(h, owner, room(1), { key: 'k' });
    await join(friend, room(1));
    await block(h, { room: room(1) });
    await owner.next('err');
    await friend.next('err');
    await unblock(h, { room: room(1) });

    // the apps register again, as they do after hearing "blocked" and reconnecting
    assert.deepEqual(await host(h, owner, room(1), { key: 'k' }), { t: 'hosted', room: room(1) });
    assert.deepEqual(await join(friend, room(1)), { t: 'joined', room: room(1), host: owner.id });
    friend.send({ t: 'sig', room: room(1), to: owner.id, data: 'again' });
    assert.equal((await owner.next('sig')).data, 'again');
    assert.equal((await stats(h)).blocked_rooms, 0);
  }));

test('a failure while blocking leaves the connections alone and the answer an error', () =>
  withServer({}, async (h) => {
    const owner = await connectApp(h);
    await host(h, owner, room(1));
    const run = h.db.run;
    h.db.run = () => {
      throw new Error('disk full');
    };
    const res = await block(h, { room: room(1) });
    h.db.run = run;
    assert.equal(res.status, 500);
    assert.equal(res.json.error, 'internal');
    assert.deepEqual(await owner.quiet(60), [], 'nobody was told about a block that did not happen');
    assert.equal((await stats(h)).hosted_rooms, 1);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM blocked_rooms').n, 0);
  }));
