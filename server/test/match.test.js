// Matchmaking after the welcome: hosting, joining, relaying, the folder limit and the device cap.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withServer, startServer, connectApp, appLogin, sha256, makePro, BILLING_ENV, START } = require('./helpers');

const room = (n) => sha256(`share code ${n}`);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// the app registering a folder, and the server's answer
function host(h, app, r, { key = `key of ${r.slice(0, 8)}`, exp = h.clock.t + HOUR } = {}) {
  app.send({ t: 'host', room: r, key, exp });
  return app.next((m) => m.room === r && (m.t === 'hosted' || m.t === 'err'));
}
function join(app, r) {
  app.send({ t: 'join', room: r });
  return app.next((m) => m.room === r && (m.t === 'joined' || m.t === 'err'));
}

const LIMITED = { env: BILLING_ENV };

test('a friend joins a hosted room and the handshake messages pass in both directions', () =>
  withServer({}, async (h) => {
    const owner = await connectApp(h);
    const friend = await connectApp(h);
    assert.deepEqual(await host(h, owner, room(1)), { t: 'hosted', room: room(1) });
    assert.deepEqual(await join(friend, room(1)), { t: 'joined', room: room(1), host: owner.id });

    friend.send({ t: 'sig', room: room(1), to: owner.id, data: { sdp: { type: 'offer', sdp: 'v=0' } } });
    assert.deepEqual(await owner.next('sig'), { t: 'sig', room: room(1), from: friend.id, data: { sdp: { type: 'offer', sdp: 'v=0' } } });
    owner.send({ t: 'sig', room: room(1), to: friend.id, data: { ice: { candidate: 'c1' } } });
    assert.deepEqual(await friend.next('sig'), { t: 'sig', room: room(1), from: owner.id, data: { ice: { candidate: 'c1' } } });
    owner.close();
    friend.close();
  }));

test('someone who did not join the room cannot relay anything to or from its owner', () =>
  withServer({}, async (h) => {
    const owner = await connectApp(h);
    const friend = await connectApp(h);
    const stranger = await connectApp(h);
    const otherOwner = await connectApp(h);
    await host(h, owner, room(1));
    await host(h, otherOwner, room(2));
    await join(friend, room(1));

    // a stranger addresses the owner, with the right room and with a wrong one
    stranger.send({ t: 'sig', room: room(1), to: owner.id, data: 'hello' });
    stranger.send({ t: 'sig', room: room(2), to: owner.id, data: 'hello' });
    // the owner addresses somebody who never joined
    owner.send({ t: 'sig', room: room(1), to: stranger.id, data: 'hello' });
    // a friend of another room cannot reach this room's owner either, nor can friends talk to each other
    const other = await connectApp(h);
    await join(other, room(2));
    other.send({ t: 'sig', room: room(1), to: owner.id, data: 'hello' });
    friend.send({ t: 'sig', room: room(1), to: other.id, data: 'hello' });
    other.send({ t: 'sig', room: room(1), to: friend.id, data: 'hello' });
    for (const app of [owner, friend, stranger, other]) assert.deepEqual(await app.quiet(60), [], 'nothing should arrive');
  }));

test('only the room named in a sig counts: a friend of room 1 cannot use room 2 to reach its owner', () =>
  withServer({}, async (h) => {
    const ownerOne = await connectApp(h);
    const ownerTwo = await connectApp(h);
    const friend = await connectApp(h);
    await host(h, ownerOne, room(1));
    await host(h, ownerTwo, room(2));
    await join(friend, room(1));
    friend.send({ t: 'sig', room: room(2), to: ownerTwo.id, data: 'sneaky' });
    assert.deepEqual(await ownerTwo.quiet(60), []);
  }));

test('a second owner key for the same room is refused with taken, the first owner keeps it', () =>
  withServer({}, async (h) => {
    const first = await connectApp(h);
    const second = await connectApp(h);
    const friend = await connectApp(h);
    await host(h, first, room(1), { key: 'the real key' });
    assert.deepEqual(await host(h, second, room(1), { key: 'another key' }), { t: 'err', room: room(1), code: 'taken' });
    assert.deepEqual(await join(friend, room(1)), { t: 'joined', room: room(1), host: first.id });
  }));

test('the same key from a reconnected app takes the room over, and the old connection no longer relays', () =>
  withServer({}, async (h) => {
    const before = await connectApp(h);
    const friend = await connectApp(h);
    await host(h, before, room(1), { key: 'k' });
    const after = await connectApp(h);
    assert.equal((await host(h, after, room(1), { key: 'k' })).t, 'hosted');
    assert.deepEqual(await join(friend, room(1)), { t: 'joined', room: room(1), host: after.id });

    before.send({ t: 'sig', room: room(1), to: friend.id, data: 'stale' });
    assert.deepEqual(await friend.quiet(60), []);
    // the old connection closing must not take the new owner offline
    await h.disconnect(before);
    assert.deepEqual(await join(friend, room(1)), { t: 'joined', room: room(1), host: after.id });
  }));

test('unhost forgets the room for good, so its code can be claimed by anyone again', () =>
  withServer({}, async (h) => {
    const owner = await connectApp(h);
    const friend = await connectApp(h);
    await host(h, owner, room(1), { key: 'old key' });
    owner.send({ t: 'unhost', room: room(1) });
    assert.deepEqual(await owner.quiet(60), []);
    assert.deepEqual(await join(friend, room(1)), { t: 'err', room: room(1), code: 'unknown' });
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM rooms').n, 0);

    const newcomer = await connectApp(h);
    assert.equal((await host(h, newcomer, room(1), { key: 'a different key' })).t, 'hosted');
  }));

test('only the connection that hosts a room can unhost it', () =>
  withServer({}, async (h) => {
    const owner = await connectApp(h);
    const stranger = await connectApp(h);
    const friend = await connectApp(h);
    await host(h, owner, room(1));
    stranger.send({ t: 'unhost', room: room(1) });
    await stranger.quiet(60);
    assert.equal((await join(friend, room(1))).t, 'joined');
  }));

test('a friend asking for a room whose owner is away is told offline, and hears online when the owner arrives', () =>
  withServer({}, async (h) => {
    const first = await connectApp(h);
    const friend = await connectApp(h);
    await host(h, first, room(1), { key: 'k' });
    await h.disconnect(first);

    assert.deepEqual(await join(friend, room(1)), { t: 'err', room: room(1), code: 'offline' });
    assert.deepEqual(await friend.quiet(60), []);

    const back = await connectApp(h);
    await host(h, back, room(1), { key: 'k' });
    assert.deepEqual(await friend.next('online'), { t: 'online', room: room(1) });
    // one notice per wait: the owner registering again says nothing more
    await host(h, back, room(1), { key: 'k' });
    assert.deepEqual(await friend.quiet(60), []);
    // and the friend joins again, as the app does
    assert.deepEqual(await join(friend, room(1)), { t: 'joined', room: room(1), host: back.id });
  }));

test('a room nobody has registered yet is unknown, and the friend hears online when it appears', () =>
  withServer({}, async (h) => {
    const friend = await connectApp(h);
    const second = await connectApp(h);
    assert.deepEqual(await join(friend, room(1)), { t: 'err', room: room(1), code: 'unknown' });
    assert.deepEqual(await join(second, room(1)), { t: 'err', room: room(1), code: 'unknown' });
    const owner = await connectApp(h);
    await host(h, owner, room(1));
    assert.deepEqual(await friend.next('online'), { t: 'online', room: room(1) });
    assert.deepEqual(await second.next('online'), { t: 'online', room: room(1) });
  }));

test('a friend who left the room, or disconnected, hears nothing when the owner arrives', () =>
  withServer({}, async (h) => {
    const left = await connectApp(h);
    const gone = await connectApp(h);
    const stays = await connectApp(h);
    for (const app of [left, gone, stays]) await join(app, room(1));
    left.send({ t: 'leave', room: room(1) });
    await h.disconnect(gone);
    await left.quiet(30);

    const owner = await connectApp(h);
    await host(h, owner, room(1));
    assert.deepEqual(await stays.next('online'), { t: 'online', room: room(1) });
    assert.deepEqual(await left.quiet(60), []);
  }));

test('someone who is only waiting for a room cannot exchange signaling with its owner', () =>
  withServer({}, async (h) => {
    const friend = await connectApp(h);
    const owner = await connectApp(h);
    await join(friend, room(1));
    await host(h, owner, room(1));
    await friend.next('online');
    // told online, but not joined yet
    friend.send({ t: 'sig', room: room(1), to: owner.id, data: 'early' });
    owner.send({ t: 'sig', room: room(1), to: friend.id, data: 'early' });
    assert.deepEqual(await owner.quiet(60), []);
    assert.deepEqual(await friend.quiet(60), []);
  }));

test('a registered room survives a restart of the server', async () => {
  const first = await startServer();
  const owner = await connectApp(first);
  await host(first, owner, room(1), { key: 'k', exp: first.clock.t + 10 * DAY });
  await first.disconnect(owner);
  await first.server.close();

  const second = await startServer({ dir: first.dir });
  try {
    const friend = await connectApp(second);
    // known, but its owner is not here yet
    assert.deepEqual(await join(friend, room(1)), { t: 'err', room: room(1), code: 'offline' });
    const thief = await connectApp(second);
    assert.deepEqual(await host(second, thief, room(1), { key: 'not the key' }), { t: 'err', room: room(1), code: 'taken' });
    const owner2 = await connectApp(second);
    assert.equal((await host(second, owner2, room(1), { key: 'k' })).t, 'hosted');
    assert.equal((await friend.next('online')).t, 'online');
  } finally {
    await second.close();
  }
});

test('rooms of the old rooms.json move into the database once and the file is set aside', async () => {
  const stillValid = START + 10 * DAY;
  const prepare = (dataDir) => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, 'rooms.json'),
      JSON.stringify({
        [room(1)]: { keyHash: sha256('old key'), exp: stillValid },
        [room(2)]: { keyHash: sha256('expired key'), exp: START - 1000 },
        [room(3)]: { keyHash: 'not a hash', exp: stillValid },
        'not a room': { keyHash: sha256('x'), exp: stillValid },
      }),
    );
  };
  const h = await startServer({ prepare, tune: undefined });
  try {
    const dataDir = path.join(h.dir, 'data');
    assert.equal(fs.existsSync(path.join(dataDir, 'rooms.json')), false);
    assert.equal(fs.existsSync(path.join(dataDir, 'rooms.json.imported')), true);
    assert.deepEqual(h.db.all('SELECT room FROM rooms'), [{ room: room(1) }]);
    assert.ok(h.logs.includes('[db] imported 1 rooms from rooms.json'));

    const thief = await connectApp(h);
    assert.equal((await host(h, thief, room(1), { key: 'someone else' })).code, 'taken');
    const owner = await connectApp(h);
    assert.equal((await host(h, owner, room(1), { key: 'old key' })).t, 'hosted');
  } finally {
    await h.close();
  }
});

test('a rooms.json that cannot be read is set aside and the server still starts', async () => {
  const h = await startServer({ prepare: (dataDir) => (fs.mkdirSync(dataDir, { recursive: true }), fs.writeFileSync(path.join(dataDir, 'rooms.json'), '{ this is not json')) });
  try {
    assert.equal(fs.existsSync(path.join(h.dir, 'data', 'rooms.json.unreadable')), true);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM rooms').n, 0);
  } finally {
    await h.close();
  }
});

test('hosting in the past is expired, and a room that ran out cannot be joined', () =>
  withServer({}, async (h) => {
    const owner = await connectApp(h);
    const friend = await connectApp(h);
    assert.deepEqual(await host(h, owner, room(1), { exp: h.clock.t - 1 }), { t: 'err', room: room(1), code: 'expired' });

    await host(h, owner, room(2), { exp: h.clock.t + HOUR });
    assert.equal((await join(friend, room(2))).t, 'joined');
    h.clock.advance(2 * HOUR);
    assert.deepEqual(await join(friend, room(2)), { t: 'err', room: room(2), code: 'expired' });

    // the regular cleanup forgets it altogether
    h.server.runCleanup();
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM rooms').n, 0);
    assert.deepEqual(await join(friend, room(2)), { t: 'err', room: room(2), code: 'unknown' });
  }));

test('a registration that ran out can be taken over with a different key', () =>
  withServer({}, async (h) => {
    const old = await connectApp(h);
    await host(h, old, room(1), { key: 'old', exp: h.clock.t + HOUR });
    h.clock.advance(2 * HOUR);
    const fresh = await connectApp(h);
    assert.equal((await host(h, fresh, room(1), { key: 'new' })).t, 'hosted');
  }));

test('the expiry a client asks for is capped, so rooms cannot pile up for ever', () =>
  withServer({}, async (h) => {
    const owner = await connectApp(h);
    await host(h, owner, room(1), { exp: h.clock.t + 10 * 365 * DAY });
    assert.equal(h.db.get('SELECT exp FROM rooms').exp, h.clock.t + 400 * DAY);
  }));

test('malformed host and join messages are ignored without an answer', () =>
  withServer({}, async (h) => {
    const app = await connectApp(h);
    const exp = h.clock.t + HOUR;
    app.send({ t: 'host', room: room(1), key: 5, exp });
    app.send({ t: 'host', room: room(1), key: '', exp });
    app.send({ t: 'host', room: room(1), key: 'k'.repeat(101), exp });
    app.send({ t: 'host', room: room(1), key: 'k', exp: 'tomorrow' });
    app.send({ t: 'host', room: room(1), key: 'k', exp: null });
    app.send({ t: 'host', room: 'not a room', key: 'k', exp });
    app.send({ t: 'host', room: room(1).toUpperCase(), key: 'k', exp });
    app.send({ t: 'join', room: 42 });
    app.send({ t: 'nonsense', room: room(1) });
    app.ws.send('this is not json');
    app.ws.send(Buffer.from([1, 2, 3]));
    assert.deepEqual(await app.quiet(80), []);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM rooms').n, 0);
    // and the connection still works
    assert.equal((await host(h, app, room(2))).t, 'hosted');
  }));

test('when an owner disconnects its room is offline, not forgotten', () =>
  withServer({}, async (h) => {
    const owner = await connectApp(h);
    const friend = await connectApp(h);
    await host(h, owner, room(1));
    await h.disconnect(owner);
    assert.equal((await join(friend, room(1))).code, 'offline');
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM rooms').n, 1);
  }));

// ---- the folder limit ----

test('on the free plan five folders are allowed at a time, hosted and joined counted together', () =>
  withServer(LIMITED, async (h) => {
    const owner = await connectApp(h);
    const other = await connectApp(h);
    assert.equal(owner.reply.limit, 5);
    await host(h, other, room(10));
    await host(h, other, room(11));
    await host(h, other, room(12));

    for (const n of [1, 2, 3]) assert.equal((await host(h, owner, room(n))).t, 'hosted');
    assert.equal((await join(owner, room(10))).t, 'joined');
    assert.equal((await join(owner, room(11))).t, 'joined');
    // the sixth, whichever way round
    assert.deepEqual(await host(h, owner, room(4)), { t: 'err', room: room(4), code: 'limit' });
    assert.deepEqual(await join(owner, room(12)), { t: 'err', room: room(12), code: 'limit' });
    // a refused room was not registered
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM rooms WHERE room = ?', room(4)).n, 0);
  }));

test('the limit is the same when the five are all joined or all hosted', () =>
  withServer(LIMITED, async (h) => {
    const app = await connectApp(h);
    for (let n = 1; n <= 5; n++) assert.equal((await host(h, app, room(n))).t, 'hosted');
    assert.equal((await host(h, app, room(6))).code, 'limit');
    const joiner = await connectApp(h);
    for (let n = 1; n <= 5; n++) assert.equal((await join(joiner, room(n))).t, 'joined');
    assert.equal((await join(joiner, room(6))).code, 'limit');
  }));

test('leave and unhost free a slot', () =>
  withServer(LIMITED, async (h) => {
    const owner = await connectApp(h);
    const app = await connectApp(h);
    await host(h, owner, room(10));
    for (let n = 1; n <= 4; n++) await host(h, app, room(n));
    assert.equal((await join(app, room(10))).t, 'joined');
    assert.equal((await host(h, app, room(5))).code, 'limit');

    app.send({ t: 'leave', room: room(10) });
    assert.equal((await host(h, app, room(5))).t, 'hosted');
    assert.equal((await host(h, app, room(6))).code, 'limit');

    app.send({ t: 'unhost', room: room(1) });
    assert.equal((await host(h, app, room(6))).t, 'hosted');
  }));

test('a room that is only waited for takes a slot too, and leave gives it back', () =>
  withServer(LIMITED, async (h) => {
    const app = await connectApp(h);
    for (let n = 1; n <= 5; n++) assert.equal((await join(app, room(n))).code, 'unknown');
    assert.equal((await join(app, room(6))).code, 'limit');
    // a refused join does not leave a wait behind: when the room appears nobody is told
    const owner = await connectApp(h);
    await host(h, owner, room(6));
    assert.deepEqual((await app.quiet(60)).filter((m) => m.room === room(6)), []);

    app.send({ t: 'leave', room: room(1) });
    assert.equal((await join(app, room(6))).t, 'joined');
  }));

test('a room that already counts needs no new slot when it is announced or joined again', () =>
  withServer(LIMITED, async (h) => {
    const owner = await connectApp(h);
    const app = await connectApp(h);
    await host(h, owner, room(20));
    for (let n = 1; n <= 3; n++) await host(h, app, room(n));
    await join(app, room(20));
    await join(app, room(21)); // unknown, waited for: five slots used
    assert.equal((await host(h, app, room(1))).t, 'hosted');
    assert.equal((await join(app, room(20))).t, 'joined');
    assert.equal((await join(app, room(21))).code, 'unknown');
    assert.equal((await host(h, app, room(9))).code, 'limit');
  }));

test('a wait that ended with an online notice can be turned into a join even when the limit is reached', () =>
  withServer(LIMITED, async (h) => {
    const app = await connectApp(h);
    for (let n = 1; n <= 5; n++) await join(app, room(n));
    const owner = await connectApp(h);
    await host(h, owner, room(3));
    await app.next('online');
    // the slot stayed reserved while the app was told
    assert.equal((await join(app, room(3))).t, 'joined');
  }));

test('a hosted and a joined copy of the same code are two folders', () =>
  withServer(LIMITED, async (h) => {
    const app = await connectApp(h);
    assert.equal((await host(h, app, room(1))).t, 'hosted');
    assert.equal((await join(app, room(1))).t, 'joined');
    for (let n = 2; n <= 4; n++) await host(h, app, room(n));
    assert.equal((await host(h, app, room(5))).code, 'limit');
  }));

test('a connection of a paying account has no folder limit', () =>
  withServer(LIMITED, async (h) => {
    const { token } = await appLogin(h);
    makePro(h, h.accountId('ada@example.com'));
    const app = await connectApp(h, { hello: { token } });
    assert.equal(app.reply.plan, 'pro');
    assert.equal(app.reply.limit, null);
    assert.equal(app.reply.account.email, 'ada@example.com');
    for (let n = 1; n <= 12; n++) assert.equal((await host(h, app, room(n))).t, 'hosted');
    app.close();
  }));

test('there is only an abuse cap for connections without a limit', () =>
  withServer({ ...LIMITED, tune: (config) => (config.tuning.maxRoomsPerConnection = 3) }, async (h) => {
    const { token } = await appLogin(h);
    makePro(h, h.accountId('ada@example.com'));
    const app = await connectApp(h, { hello: { token } });
    for (let n = 1; n <= 3; n++) assert.equal((await host(h, app, room(n))).t, 'hosted');
    assert.equal((await host(h, app, room(4))).code, 'limit');
  }));

test('without billing there is no limit at all', () =>
  withServer({}, async (h) => {
    const app = await connectApp(h);
    assert.equal(app.reply.limit, null);
    for (let n = 1; n <= 12; n++) assert.equal((await host(h, app, room(n))).t, 'hosted');
    for (let n = 20; n <= 30; n++) assert.equal((await join(app, room(n))).code, 'unknown');
  }));

test('ENFORCE_LIMIT turns the limit on even without billing', () =>
  withServer({ env: { ENFORCE_LIMIT: '1', FREE_LIMIT: '2' } }, async (h) => {
    const app = await connectApp(h);
    assert.equal(app.reply.limit, 2);
    assert.equal(app.reply.billing, false);
    await host(h, app, room(1));
    await host(h, app, room(2));
    assert.equal((await host(h, app, room(3))).code, 'limit');
  }));

test('Stripe set up without any way to sign in behaves like billing off: no billing, no limit', () =>
  withServer({ env: { ...BILLING_ENV, GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' } }, async (h) => {
    const app = await connectApp(h);
    assert.equal(app.reply.billing, false);
    assert.equal(app.reply.limit, null);
    for (let n = 1; n <= 8; n++) assert.equal((await host(h, app, room(n))).t, 'hosted');
    const me = (await h.request('GET', '/api/me')).json;
    assert.equal(me.billing, false);
    assert.deepEqual(me.providers, { github: false, google: false });
    const checkout = await h.request('POST', '/api/billing/checkout', { json: { interval: 'month' } });
    assert.equal(checkout.status, 503);
    assert.equal(checkout.json.error, 'billing_off');
    // the page keys say the same
    assert.match((await h.request('GET', '/')).text, /<p id="when-off">billing off<\/p>/);
  }));

// ---- devices ----

test('a paying account can connect from five devices at once, the sixth is welcomed as free', () =>
  withServer(LIMITED, async (h) => {
    const { token } = await appLogin(h);
    makePro(h, h.accountId('ada@example.com'));
    const devices = [];
    for (let n = 1; n <= 5; n++) {
      const device = await connectApp(h, { hello: { token } });
      assert.equal(device.reply.plan, 'pro', `device ${n}`);
      devices.push(device);
    }
    const sixth = await connectApp(h, { hello: { token } });
    assert.equal(sixth.reply.plan, 'free');
    assert.equal(sixth.reply.limit, 5);
    assert.equal(sixth.reply.account.email, 'ada@example.com', 'still signed in, only the plan differs');
    assert.equal(sixth.reply.signed_out, false);
    assert.equal((await host(h, sixth, room(1))).t, 'hosted');

    // a device leaves: the next one to connect is Pro again
    await h.disconnect(devices[0]);
    const seventh = await connectApp(h, { hello: { token } });
    assert.equal(seventh.reply.plan, 'pro');
  }));

test('a signed-in free account is told its limit, and its account', () =>
  withServer(LIMITED, async (h) => {
    const { token } = await appLogin(h, { name: 'Ada Lovelace' });
    const app = await connectApp(h, { hello: { token } });
    assert.equal(app.reply.plan, 'free');
    assert.equal(app.reply.limit, 5);
    assert.deepEqual(app.reply.account, { name: 'Ada Lovelace', email: 'ada@example.com', avatar: 'https://avatars.githubusercontent.com/u/1' });
    assert.equal(app.reply.billing, true);
  }));

test('a failure while handling one message is logged and does not take the server down', () =>
  withServer({}, async (h) => {
    const app = await connectApp(h);
    const other = await connectApp(h);
    const run = h.db.run;
    h.db.run = () => {
      throw new Error('disk full');
    };
    app.send({ t: 'host', room: room(1), key: 'k', exp: h.clock.t + HOUR });
    assert.deepEqual(await app.quiet(80), []);
    assert.ok(h.logs.includes('[match] a host message could not be handled: disk full'));
    h.db.run = run;
    // both connections and the server carry on
    assert.equal((await host(h, app, room(1))).t, 'hosted');
    assert.equal((await join(other, room(1))).t, 'joined');
    assert.equal((await h.request('GET', '/healthz')).status, 200);
  }));
