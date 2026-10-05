// Networking: the matchmaking connection and the direct (WebRTC) connections between friends.
//
// A share code never leaves the two apps. The matchmaking server only sees a room name, the SHA-256
// of the code, and relays the WebRTC handshake. Once the direct channel is open both sides prove
// they know the code, tied to the encryption keys of that channel, so nobody in between (the
// matchmaking server included) can sit in the middle.
//
// Channel protocol, friend -> owner:  {t:'auth',mac}  {t:'list'}  {t:'get',path,offset}
//                   owner -> friend:  {t:'auth',mac}  {t:'files',files}... {t:'manifest',name,expiresAt}
//                                     binary chunks... {t:'end'}   or   {t:'fail',reason}
const p2p = (() => {
  // STUN only tells each side its public address. There is deliberately no TURN relay: file data
  // must not travel through a server.
  const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
  const CHUNK = 64 * 1024;
  const HIGH_WATER = 8 * 1024 * 1024;
  const LOW_WATER = 1024 * 1024;
  const MANIFEST_BATCH = 300;
  const JOIN_TIMEOUT = 10000;
  const CONNECT_TIMEOUT = 30000;

  const MESSAGES = {
    server: 'No connection to the matchmaking server. Check your internet connection.',
    offline: "Your friend's app is not running right now. It will sync once they are online.",
    unknown: "Code not found. Check the code, and that your friend's app is running.",
    expired: 'This share has expired.',
    direct: "Could not connect directly to your friend's PC. One of your networks blocks direct connections.",
    lost: 'The connection was lost. Sync again to continue where it stopped.',
    auth: 'The other side does not know this share code.',
    read: 'Your friend\'s app could not read a file.',
    changed: 'A file changed while it was downloading. Sync again.',
  };
  const fail = (code) => Object.assign(new Error(MESSAGES[code] || code), { code });

  const enc = new TextEncoder();
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const sha256 = async (text) => hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
  async function hmac(key, text) {
    const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return hex(await crypto.subtle.sign('HMAC', k, enc.encode(text)));
  }

  const events = { status: () => {}, host: () => {} };

  // ---- matchmaking connection ----

  let ws = null;
  let online = false;
  let retries = 0;
  // room -> { resolve, reject } of a join that waits for the server's answer
  const pendingJoins = new Map();

  function connect(url) {
    ws = new WebSocket(url);
    ws.onopen = () => {
      online = true;
      retries = 0;
      events.status(true);
      for (const [room, share] of hosted) announce(room, share);
    };
    ws.onmessage = (e) => onSignal(JSON.parse(e.data));
    ws.onclose = () => {
      if (online) events.status(false);
      online = false;
      for (const p of pendingJoins.values()) p.reject(fail('server'));
      pendingJoins.clear();
      setTimeout(() => connect(url), Math.min(30000, 1000 * 2 ** retries++));
    };
  }

  const signal = (msg) => online && ws.send(JSON.stringify(msg));

  function onSignal(m) {
    const pending = pendingJoins.get(m.room);
    if (m.t === 'joined' && pending) {
      pendingJoins.delete(m.room);
      pending.resolve(m.host);
    } else if (m.t === 'err' && pending) {
      pendingJoins.delete(m.room);
      pending.reject(fail(m.code));
    } else if (m.t === 'sig') {
      let peer = peers.get(`${m.room}|${m.from}`);
      // a friend starts a connection to one of our folders
      if (!peer && hosted.has(m.room) && m.data.sdp?.type === 'offer') {
        peer = createPeer(m.room, m.from, hosted.get(m.room).code, false);
        peer.pc.ondatachannel = (e) => attachChannel(peer, e.channel);
        hostActivity(peer);
      }
      if (peer) onPeerSignal(peer, m.data).catch(() => closePeer(peer));
    }
  }

  function join(room) {
    if (!online) return Promise.reject(fail('server'));
    return new Promise((resolve, reject) => {
      pendingJoins.set(room, { resolve, reject });
      signal({ t: 'join', room });
      setTimeout(() => pendingJoins.delete(room) && reject(fail('server')), JOIN_TIMEOUT);
    });
  }

  // ---- direct connections ----

  // "room|remoteId" -> peer
  const peers = new Map();

  function createPeer(room, remoteId, code, isGuest) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const peer = { pc, dc: null, room, remoteId, code, isGuest, authed: false, closed: false, chain: Promise.resolve(), waiter: null, sent: 0 };
    peer.ready = new Promise((resolve, reject) => Object.assign(peer, { onReady: resolve, onDead: reject }));
    peer.ready.catch(() => {});
    peers.set(`${room}|${remoteId}`, peer);
    pc.onicecandidate = (e) => e.candidate && signal({ t: 'sig', room, to: remoteId, data: { ice: e.candidate } });
    pc.onconnectionstatechange = () => ['failed', 'closed'].includes(pc.connectionState) && closePeer(peer);
    return peer;
  }

  function closePeer(peer, code = 'lost') {
    if (peer.closed) return;
    peer.closed = true;
    peers.delete(`${peer.room}|${peer.remoteId}`);
    peer.onDead(fail(code));
    peer.waiter?.reject(fail(code));
    peer.waiter = null;
    peer.onDrain?.();
    try {
      peer.dc?.close();
      peer.pc.close();
    } catch {}
    if (!peer.isGuest) hostActivity(peer);
  }

  async function onPeerSignal(peer, data) {
    const { pc } = peer;
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        await pc.setLocalDescription(await pc.createAnswer());
        signal({ t: 'sig', room: peer.room, to: peer.remoteId, data: { sdp: pc.localDescription } });
      }
    } else if (data.ice) {
      await pc.addIceCandidate(data.ice).catch(() => {});
    }
  }

  function attachChannel(peer, dc) {
    peer.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = LOW_WATER;
    dc.onbufferedamountlow = () => peer.onDrain?.();
    dc.onclose = () => closePeer(peer);
    dc.onopen = async () => sendJson(peer, { t: 'auth', mac: await authMac(peer, peer.isGuest ? 'guest' : 'host') });
    // one message at a time, in order, even though handling them is asynchronous
    dc.onmessage = (e) => {
      peer.chain = peer.chain.then(() => onPeerMessage(peer, e.data)).catch(() => closePeer(peer));
    };
  }

  const sendJson = (peer, msg) => peer.dc.send(JSON.stringify(msg));

  // Proof of knowing the share code, bound to the certificates of this very connection.
  function authMac(peer, role) {
    const fingerprint = (desc) => (/a=fingerprint:\S+ (\S+)/.exec(desc.sdp) || [])[1].toUpperCase();
    const local = fingerprint(peer.pc.localDescription);
    const remote = fingerprint(peer.pc.remoteDescription);
    const [guest, host] = peer.isGuest ? [local, remote] : [remote, local];
    return hmac(peer.code, `${role}|${guest}|${host}`);
  }

  async function onPeerMessage(peer, data) {
    if (typeof data !== 'string') return peer.isGuest && peer.authed && guestChunk(peer, data);
    const m = JSON.parse(data);
    if (m.t === 'auth') {
      if (m.mac !== (await authMac(peer, peer.isGuest ? 'host' : 'guest'))) return closePeer(peer, 'auth');
      peer.authed = true;
      peer.onReady();
    } else if (peer.authed) {
      await (peer.isGuest ? guestMessage(peer, m) : hostMessage(peer, m));
    }
  }

  // ---- owner side: serve a folder ----

  // room -> share, for every folder of ours with a valid code
  let hosted = new Map();

  const announce = (room, share) => signal({ t: 'host', room, key: share.hostKey, exp: share.expiresAt });

  // Tells the matchmaking server which folders can be reached here. Codes that are gone (replaced
  // or removed) are withdrawn and their connections closed.
  async function setHostShares(shares) {
    const next = new Map();
    for (const share of shares) {
      if (share.role === 'host' && share.code && share.expiresAt > Date.now()) next.set(await sha256(share.code), share);
    }
    for (const room of hosted.keys()) {
      if (next.has(room)) continue;
      signal({ t: 'unhost', room });
      for (const peer of [...peers.values()]) if (peer.room === room) closePeer(peer);
    }
    for (const [room, share] of next) if (!hosted.has(room)) announce(room, share);
    hosted = next;
  }

  function hostActivity(peer) {
    const share = hosted.get(peer.room);
    if (!share) return;
    const friends = [...peers.values()].filter((p) => p.room === peer.room && !p.isGuest).length;
    events.host({ shareId: share.id, friends, sent: peer.sent });
  }

  const drained = (peer) =>
    new Promise((resolve) => {
      peer.onDrain = () => {
        peer.onDrain = null;
        resolve();
      };
    });

  async function hostMessage(peer, m) {
    const share = hosted.get(peer.room);
    if (!share || share.expiresAt <= Date.now()) return sendJson(peer, { t: 'fail', reason: 'expired' });
    if (m.t === 'list') {
      const files = await api.listFiles(share.id);
      for (let i = 0; i < files.length; i += MANIFEST_BATCH) sendJson(peer, { t: 'files', files: files.slice(i, i + MANIFEST_BATCH) });
      sendJson(peer, { t: 'manifest', name: share.name, expiresAt: share.expiresAt });
    } else if (m.t === 'get') {
      let h = null;
      try {
        const file = await api.openRead(share.id, m.path);
        h = file.h;
        for (let pos = Number(m.offset) || 0; pos < file.size && !peer.closed; ) {
          const chunk = await api.read(h, pos, CHUNK);
          if (!chunk.byteLength) break;
          if (peer.dc.bufferedAmount > HIGH_WATER) await drained(peer);
          if (peer.closed) break;
          peer.dc.send(chunk);
          pos += chunk.byteLength;
          peer.sent += chunk.byteLength;
          hostActivity(peer);
        }
        if (!peer.closed) sendJson(peer, { t: 'end' });
      } catch {
        if (!peer.closed) sendJson(peer, { t: 'fail', reason: 'read' });
      } finally {
        if (h) api.close(h);
      }
    }
  }

  // ---- friend side: download a folder ----

  // Sends a request and waits for the owner's closing answer ('manifest' or 'end').
  function request(peer, msg) {
    return new Promise((resolve, reject) => {
      if (peer.closed) return reject(fail('lost'));
      peer.waiter = { resolve, reject };
      sendJson(peer, msg);
    });
  }

  function answer(peer, value, error) {
    const waiter = peer.waiter;
    peer.waiter = null;
    if (error) waiter?.reject(error);
    else waiter?.resolve(value);
  }

  function guestMessage(peer, m) {
    if (m.t === 'files') peer.files.push(...m.files);
    else if (m.t === 'manifest') answer(peer, m);
    else if (m.t === 'end') answer(peer);
    else if (m.t === 'fail') answer(peer, null, fail(m.reason));
  }

  async function guestChunk(peer, data) {
    const sink = peer.sink;
    if (!sink) return;
    await api.write(sink.h, data);
    sink.received += data.byteLength;
    sink.onBytes(data.byteLength);
  }

  // Downloads everything that is missing or different from a friend's folder. Nothing is ever
  // deleted locally. Files in share.excluded are skipped. onProgress gets { file, done, total } in
  // bytes, counting only the files that will be downloaded. With options.listOnly nothing is
  // downloaded; the fresh remote list is stored either way so the UI can show it.
  async function sync(share, onProgress, options = {}) {
    const room = await sha256(share.code);
    const hostId = await join(room);
    const peer = createPeer(room, hostId, share.code, true);
    peer.files = [];
    const timer = setTimeout(() => closePeer(peer, 'direct'), CONNECT_TIMEOUT);
    try {
      attachChannel(peer, peer.pc.createDataChannel('files'));
      await peer.pc.setLocalDescription(await peer.pc.createOffer());
      signal({ t: 'sig', room, to: hostId, data: { sdp: peer.pc.localDescription } });
      await peer.ready;
      clearTimeout(timer);

      const manifest = await request(peer, { t: 'list' });
      await api.updateShare(share.id, { name: manifest.name, expiresAt: manifest.expiresAt, remote: peer.files });
      if (options.listOnly) return { downloaded: 0, files: peer.files.length, listOnly: true };
      const local = new Map((await api.listFiles(share.id)).map((f) => [f.path, f]));
      const excluded = new Set(share.excluded);
      const wanted = peer.files.filter((f) => {
        if (excluded.has(f.path)) return false;
        const mine = local.get(f.path);
        // a finished download carries the original's modified time (to the precision of the disk)
        return !mine || mine.size !== f.size || Math.abs(mine.mtime - f.mtime) > 2000;
      });

      const total = wanted.reduce((sum, f) => sum + f.size, 0);
      let done = 0;
      for (const f of wanted) {
        const { h, offset } = await api.openWrite(share.id, f.path, f.size, f.mtime);
        done += offset;
        onProgress({ file: f.path, done, total });
        peer.sink = {
          h,
          received: offset,
          onBytes: (n) => onProgress({ file: f.path, done: (done += n), total }),
        };
        try {
          if (offset < f.size || f.size === 0) await request(peer, { t: 'get', path: f.path, offset });
          if (peer.sink.received !== f.size) throw fail('changed');
          await api.finish(h);
        } catch (err) {
          await api.close(h);
          throw err;
        } finally {
          peer.sink = null;
        }
      }
      await api.updateShare(share.id, { lastSync: Date.now() });
      return { downloaded: wanted.length, files: peer.files.length };
    } finally {
      clearTimeout(timer);
      closePeer(peer);
    }
  }

  return {
    connect,
    setHostShares,
    sync,
    on: (name, fn) => (events[name] = fn),
  };
})();
