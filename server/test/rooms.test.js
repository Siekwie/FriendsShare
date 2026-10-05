// What one address, and the whole table, may register: the room budget per address, the cap on all
// rooms with its clean-up of the least recently used, and taking back one's own registration.
const test = require('node:test');
const assert = require('node:assert/strict');
const { withServer, connectApp, sha256, START } = require('./helpers');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const room = (n) => sha256(`share code ${n}`);

// the app registering a folder, and the server's answer
function host(h, app, r, { key = `key of ${r.slice(0, 8)}`, exp = h.clock.t + HOUR } = {}) {
  app.send({ t: 'host', room: r, key, exp });
  return app.next((m) => m.room === r && (m.t === 'hosted' || m.t === 'err'));
}
function join(app, r) {
  app.send({ t: 'join', room: r });
  return app.next((m) => m.room === r && (m.t === 'joined' || m.t === 'err'));
}

const PROXIED = { TRUST_PROXY: '1' };
// a connection that the server takes for one from this address (in these tests it sits behind a proxy)
const from = (address) => ({ options: { headers: { 'X-Forwarded-For': address } } });
const count = (h) => h.db.get('SELECT COUNT(*) AS n FROM rooms').n;
const has = (h, r) => h.db.get('SELECT 1 AS yes FROM rooms WHERE room = ?', r) !== undefined;
const blockRoom = (h, r) => h.request('POST', '/internal/block', { json: { room: r }, origin: null });
const tableFull = (h) => h.logs.filter((line) => line.includes('the table of rooms is full') && line.includes('were forgotten'));
const tableStuck = (h) => h.logs.filter((line) => line.includes('the table of rooms is full') && line.includes('no new room is taken'));

// rooms first .. first+n-1 one after the other, each a moment after the one before
async function fill(h, app, n, first = 1) {
  for (let i = first; i < first + n; i++) {
    assert.equal((await host(h, app, room(i))).t, 'hosted', `room ${i}`);
    h.clock.advance(1);
  }
}
const smallTable = (max) => (config) => {
  config.maxRooms = max;
  config.roomsPerAddressHour = 100_000;
};

// ---- the budget of an address ----

test('an address may register ROOMS_PER_ADDRESS_HOUR rooms the database has not seen in an hour, then it gets limit', () =>
  withServer({ env: PROXIED, tune: (config) => (config.roomsPerAddressHour = 3) }, async (h) => {
    const a = await connectApp(h, from('203.0.113.1'));
    for (let n = 1; n <= 3; n++) assert.equal((await host(h, a, room(n))).t, 'hosted');
    assert.deepEqual(await host(h, a, room(4)), { t: 'err', room: room(4), code: 'limit' });
    assert.equal(has(h, room(4)), false, 'a refused room is not registered');
    assert.equal((await h.request('GET', '/internal/stats')).json.hosted_rooms, 3);

    // known rooms, registered again with the same key (as an app does after every reconnect), cost nothing
    for (let round = 0; round < 5; round++) for (let n = 1; n <= 3; n++) assert.equal((await host(h, a, room(n))).t, 'hosted');
    // the budget belongs to the address, not to the connection
    const sameAddress = await connectApp(h, from('203.0.113.1'));
    assert.equal((await host(h, sameAddress, room(5))).code, 'limit');
    const other = await connectApp(h, from('203.0.113.2'));
    assert.equal((await host(h, other, room(5))).t, 'hosted', 'another address has its own');
    // an hour later it is back
    h.clock.advance(HOUR + 1000);
    assert.equal((await host(h, a, room(4))).t, 'hosted');
  }));

test('an IPv6 address shares its budget with the rest of its /64', () =>
  withServer({ env: PROXIED, tune: (config) => (config.roomsPerAddressHour = 2) }, async (h) => {
    const a = await connectApp(h, from('2001:db8:1:2::1'));
    const b = await connectApp(h, from('2001:db8:1:2:ffff::9'));
    const c = await connectApp(h, from('2001:db8:1:3::1'));
    assert.equal((await host(h, a, room(1))).t, 'hosted');
    assert.equal((await host(h, b, room(2))).t, 'hosted');
    assert.equal((await host(h, a, room(3))).code, 'limit');
    assert.equal((await host(h, c, room(3))).t, 'hosted');
  }));

test('the default budget is 60 new rooms an hour', () =>
  withServer({ env: PROXIED }, async (h) => {
    assert.equal(h.config.roomsPerAddressHour, 60);
    assert.equal(h.config.maxRooms, 200000);
    assert.equal(h.config.wsMaxPerAddress, 40);
    assert.equal(h.config.wsUpgradesPerMinute, 120);
    const a = await connectApp(h, from('203.0.113.1'));
    for (let n = 1; n <= 60; n++) assert.equal((await host(h, a, room(n))).t, 'hosted', `room ${n}`);
    assert.equal((await host(h, a, room(61))).code, 'limit');
  }));

test('a registration that is refused for another reason does not use up the budget', () =>
  withServer({ env: PROXIED, tune: (config) => (config.roomsPerAddressHour = 2) }, async (h) => {
    const owner = await connectApp(h, from('203.0.113.1'));
    await host(h, owner, room(1), { key: 'the owner' });
    await blockRoom(h, room(3));
    const a = await connectApp(h, from('203.0.113.9'));
    for (let n = 0; n < 5; n++) {
      assert.equal((await host(h, a, room(1), { key: 'a thief' })).code, 'taken');
      assert.equal((await host(h, a, room(2), { exp: h.clock.t - 1 })).code, 'expired');
      assert.equal((await host(h, a, room(3))).code, 'blocked');
    }
    assert.equal((await host(h, a, room(4))).t, 'hosted');
    assert.equal((await host(h, a, room(5))).t, 'hosted');
    assert.equal((await host(h, a, room(6))).code, 'limit');
  }));

test('a lapsed registration that somebody takes over is not a new room', () =>
  withServer({ env: PROXIED, tune: (config) => (config.roomsPerAddressHour = 1) }, async (h) => {
    const first = await connectApp(h, from('203.0.113.1'));
    await host(h, first, room(1), { key: 'old', exp: h.clock.t + HOUR });
    h.clock.advance(2 * HOUR);
    const second = await connectApp(h, from('203.0.113.9'));
    // the row exists, so nothing is added to the table, and the budget of 1 is still whole
    assert.equal((await host(h, second, room(1), { key: 'new' })).t, 'hosted');
    assert.equal((await host(h, second, room(2))).t, 'hosted');
    assert.equal((await host(h, second, room(3))).code, 'limit');
  }));

// ---- the cap on all rooms ----

test('when the table is full, the rooms registered longest ago whose owner is away are forgotten, about 1% at a time', () =>
  withServer({ tune: smallTable(200) }, async (h) => {
    const bulk = await connectApp(h);
    await fill(h, bulk, 200);
    await h.disconnect(bulk);
    assert.equal(count(h), 200);

    const newcomer = await connectApp(h);
    assert.equal((await host(h, newcomer, room(201))).t, 'hosted');
    // 1% of 200 is 2: the two oldest went, and the new room came
    assert.equal(count(h), 199);
    assert.deepEqual([1, 2, 3, 201].map((n) => has(h, room(n))), [false, false, true, true]);
    assert.deepEqual(tableFull(h), ['[match] the table of rooms is full (200): 2 rooms that nobody registered for the longest time were forgotten']);

    // there is space for one more now, and no clean-up for it
    assert.equal((await host(h, newcomer, room(202))).t, 'hosted');
    assert.equal(count(h), 200);
    assert.equal(tableFull(h).length, 1);
    // full again: the next two oldest go
    assert.equal((await host(h, newcomer, room(203))).t, 'hosted');
    assert.equal(count(h), 199);
    assert.deepEqual([3, 4, 5].map((n) => has(h, room(n))), [false, false, true]);
    assert.equal(tableFull(h).length, 2);
  }));

test('a table of 1000 rooms drops 10 at a time', () =>
  withServer({ tune: smallTable(1000) }, async (h) => {
    // straight into the table: the point is the size of the batch, not the protocol
    const insert = h.db.raw.prepare('INSERT INTO rooms (room, key_hash, exp, last_seen) VALUES (?, ?, ?, ?)');
    h.db.raw.exec('BEGIN');
    for (let n = 1; n <= 1000; n++) insert.run(room(n), sha256(`key ${n}`), h.clock.t + HOUR, h.clock.t + n);
    h.db.raw.exec('COMMIT');
    h.server.runCleanup(); // counts the table again
    const app = await connectApp(h);
    assert.equal((await host(h, app, room(1001))).t, 'hosted');
    assert.equal(count(h), 991);
    assert.deepEqual([10, 11].map((n) => has(h, room(n))), [false, true]);
  }));

test('a room whose owner is connected is never forgotten to make space', () =>
  withServer({ tune: smallTable(200) }, async (h) => {
    const keeper = await connectApp(h);
    const bulk = await connectApp(h);
    await fill(h, keeper, 1); // the oldest of all, and its owner stays
    await fill(h, bulk, 199, 2);
    await h.disconnect(bulk);
    const newcomer = await connectApp(h);
    assert.equal((await host(h, newcomer, room(201))).t, 'hosted');
    assert.deepEqual([1, 2, 3, 4].map((n) => has(h, room(n))), [true, false, false, true], 'the live room stayed, the two oldest of the others went');
    // and the keeper is still reachable
    const friend = await connectApp(h);
    assert.deepEqual(await join(friend, room(1)), { t: 'joined', room: room(1), host: keeper.id });
  }));

test('registering a room again makes it recent', () =>
  withServer({ tune: smallTable(200) }, async (h) => {
    const bulk = await connectApp(h);
    await fill(h, bulk, 200);
    assert.equal(h.db.get('SELECT last_seen FROM rooms WHERE room = ?', room(1)).last_seen, START);
    await h.disconnect(bulk);
    h.clock.advance(HOUR);
    // the owner of the two oldest comes back: they are the newest now
    const back = await connectApp(h);
    assert.equal((await host(h, back, room(1))).t, 'hosted');
    assert.equal((await host(h, back, room(2))).t, 'hosted');
    assert.equal(h.db.get('SELECT last_seen FROM rooms WHERE room = ?', room(1)).last_seen, h.clock.t);
    await h.disconnect(back);
    const newcomer = await connectApp(h);
    assert.equal((await host(h, newcomer, room(201))).t, 'hosted');
    assert.deepEqual([1, 2, 3, 4, 5].map((n) => has(h, room(n))), [true, true, false, false, true]);
  }));

test('when every room in a full table has its owner connected nothing can be forgotten, and a new room gets limit', () =>
  withServer({ tune: smallTable(3) }, async (h) => {
    const owners = [await connectApp(h), await connectApp(h), await connectApp(h)];
    for (let n = 0; n < 3; n++) assert.equal((await host(h, owners[n], room(n + 1))).t, 'hosted');
    const late = await connectApp(h);
    assert.deepEqual(await host(h, late, room(4)), { t: 'err', room: room(4), code: 'limit' });
    assert.equal(count(h), 3);
    assert.equal((await host(h, owners[0], room(1))).t, 'hosted', 'a known room can still be registered again');
    // one owner leaves: its room can be forgotten, and the new one is taken in
    await h.disconnect(owners[1]);
    assert.equal((await host(h, late, room(4))).t, 'hosted');
    assert.deepEqual([1, 2, 3, 4].map((n) => has(h, room(n))), [true, false, true, true]);
  }));

test('the table is counted properly: rooms given up or expired make space again', () =>
  withServer({ tune: smallTable(5) }, async (h) => {
    const app = await connectApp(h);
    await fill(h, app, 5);
    // two are given up by their owner: space for two more without anything being forgotten
    app.send({ t: 'unhost', room: room(1) });
    app.send({ t: 'unhost', room: room(2) });
    await app.quiet(60);
    assert.equal(count(h), 3);
    assert.equal((await host(h, app, room(6))).t, 'hosted');
    assert.equal((await host(h, app, room(7))).t, 'hosted');
    assert.equal(count(h), 5);
    assert.deepEqual([tableFull(h), tableStuck(h)], [[], []]);
    // full, and every owner is connected: nothing can be forgotten; said once, not once per attempt
    for (let n = 8; n < 12; n++) assert.equal((await host(h, app, room(n))).code, 'limit');
    assert.equal(tableStuck(h).length, 1);
    assert.deepEqual(tableFull(h), []);
    h.clock.advance(61_000);
    assert.equal((await host(h, app, room(12))).code, 'limit');
    assert.equal(tableStuck(h).length, 2);

    // time passes, the cleanup forgets what expired, and there is space again
    h.clock.advance(2 * HOUR);
    h.server.runCleanup();
    assert.equal(count(h), 0);
    const fresh = await connectApp(h);
    for (let n = 20; n < 25; n++) assert.equal((await host(h, fresh, room(n))).t, 'hosted');
    assert.deepEqual([tableFull(h), tableStuck(h).length], [[], 2]);
  }));

test('the expiry a client asks for is still capped at 400 days, and the registration is remembered', () =>
  withServer({}, async (h) => {
    const owner = await connectApp(h);
    await host(h, owner, room(1), { exp: h.clock.t + 10 * 365 * DAY });
    assert.deepEqual(h.db.get('SELECT exp, last_seen FROM rooms'), { exp: h.clock.t + 400 * DAY, last_seen: h.clock.t });
  }));

// ---- taking back a registration ----

test('a stale earlier owner cannot take back the room of the owner who took it over', () =>
  withServer({}, async (h) => {
    const stale = await connectApp(h);
    const newer = await connectApp(h);
    await host(h, stale, room(1), { key: 'key of the first owner', exp: h.clock.t + HOUR });
    h.clock.advance(2 * HOUR); // the first registration ran out, and nobody cleaned up yet
    assert.equal((await host(h, newer, room(1), { key: 'key of the second owner', exp: h.clock.t + HOUR })).t, 'hosted');
    const secondHash = sha256('key of the second owner');

    // while the new owner is connected the old connection cannot touch the room
    stale.send({ t: 'unhost', room: room(1) });
    await stale.quiet(60);
    assert.equal(h.db.get('SELECT key_hash FROM rooms WHERE room = ?', room(1)).key_hash, secondHash);

    // the new owner goes away, its row stays; the old connection (which still thinks the room is
    // its own) asks again, and still cannot delete a row that belongs to somebody else's key
    await h.disconnect(newer);
    const staleAgain = await connectApp(h);
    stale.send({ t: 'unhost', room: room(1) });
    await stale.quiet(60);
    assert.equal(h.db.get('SELECT key_hash FROM rooms WHERE room = ?', room(1)).key_hash, secondHash);

    // the second owner still has the room: its key registers it, the first owner's key is taken
    const second = await connectApp(h);
    assert.equal((await host(h, second, room(1), { key: 'key of the second owner' })).t, 'hosted');
    assert.equal((await host(h, staleAgain, room(1), { key: 'key of the first owner' })).code, 'taken');
  }));

test('the reviewer\'s sequence: a lapsed owner sends unhost after the new owner has left, and the row survives', () =>
  withServer({}, async (h) => {
    const a = await connectApp(h);
    const b = await connectApp(h);
    await host(h, a, room(1), { key: 'keyA', exp: h.clock.t + HOUR });
    h.clock.advance(2 * HOUR);
    assert.equal((await host(h, b, room(1), { key: 'keyB', exp: h.clock.t + HOUR })).t, 'hosted');
    await h.disconnect(b);
    assert.equal(has(h, room(1)), true);
    a.send({ t: 'unhost', room: room(1) });
    await a.quiet(100);
    assert.equal(has(h, room(1)), true, 'still there');
    assert.equal(h.db.get('SELECT key_hash FROM rooms WHERE room = ?', room(1)).key_hash, sha256('keyB'));
  }));

test('a connection that another connection of the same app took the room over from cannot give the room up from under it', () =>
  withServer({}, async (h) => {
    const first = await connectApp(h);
    const second = await connectApp(h);
    const friend = await connectApp(h);
    await host(h, first, room(1), { key: 'the one key' });
    // the app reconnected and the old socket does not know yet: the same key takes the room over
    assert.equal((await host(h, second, room(1), { key: 'the one key' })).t, 'hosted');
    // the old connection gives its registration up, but the room is the second one's now
    first.send({ t: 'unhost', room: room(1) });
    await first.quiet(60);
    assert.equal(has(h, room(1)), true, 'the row stays');
    assert.deepEqual(await join(friend, room(1)), { t: 'joined', room: room(1), host: second.id });
    // the second connection can still give it up for good
    second.send({ t: 'unhost', room: room(1) });
    await second.quiet(60);
    assert.equal(has(h, room(1)), false);
  }));

test('an owner who gives a room up still deletes it, with the key it registered it with', () =>
  withServer({}, async (h) => {
    const owner = await connectApp(h);
    await host(h, owner, room(1), { key: 'k' });
    owner.send({ t: 'unhost', room: room(1) });
    await owner.quiet(60);
    assert.equal(has(h, room(1)), false);
    // and a second unhost, or one for a room that was never hosted here, does nothing
    owner.send({ t: 'unhost', room: room(1) });
    owner.send({ t: 'unhost', room: room(9) });
    assert.deepEqual(await owner.quiet(60), []);
  }));
