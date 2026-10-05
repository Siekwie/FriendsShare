// The window: list of folders on the left, the selected one on the right.
const EXPIRY_CHOICES = [1, 7, 30, 90, 365];
const RESYNC_EVERY = 10 * 60 * 1000;
// a folder the server could not register for reasons that are not about the plan is tried again this often
const RETRY_REGISTER_EVERY = 10 * 60 * 1000;
// Coming back to the window reads the folder in view again, but not more often than this: on a folder
// of thousands of files that is a walk through all of them.
const FOCUS_REFRESH_AFTER = 15 * 1000;

let state = { shares: [], settings: { baseDir: '', tray: true, autostart: false } };
let selectedId = null;
// guest share id -> { kind: 'syncing' | 'ok' | 'warn' | 'error', text, done, total, skipped }
// ('warn' is a sync that left some files out, listed in `skipped`)
const status = new Map();
// host share id -> { friends, sent }
const hostInfo = new Map();
const syncing = new Set();

// The account as the main process keeps it (see account.js): signed in or not, and the plan and
// folder limit from the last welcome of the matchmaking server.
let account = { signedIn: false, account: null, plan: 'free', limit: null, billing: false, prices: null, signingIn: false, error: null };
// What the connection line says: { kind: 'connecting' | 'online' | 'offline' | 'outdated' | 'unofficial', min? }
let conn = { kind: 'connecting' };
// Folders over the limit of the plan are paused: not announced, not synced, nothing deleted. The
// oldest ones keep their place.
let paused = new Set();
// folders the server refused for the limit; paused until the next welcome, or until a folder is removed
const limited = new Set();
// Folders from a friend whose code was blocked: only a click on Sync now tries them again.
const blockedGuests = new Set();
// Own folders whose code was blocked: id -> that code. A new code is a new room, so it works again.
const blockedHosts = new Map();
// Own folders that the server did not register although the plan has room (an address can only
// register 60 new folders an hour, and the server's table can be full). Tried again later.
const unregistered = new Set();

// The file list of the folder in view, as the tree shows it: { id, role, kind: 'choice' | 'plain',
// built (see tree.build), missing }. 'choice' is a friend's folder with the owner's list, where each
// file and folder has a checkbox. Replaced whenever the folder is read again.
let view = null;
// when the folder in view was last read from the disk
let listedAt = 0;
let refreshCount = 0;
// the window was drawn again while the list had the keyboard focus: the next list takes it
let keepTreeFocus = false;
// share id -> which folders of its tree are open, how many entries of each are shown (see tree.rows),
// and the row with the keyboard focus. Outlives the tree, which is built again whenever the window draws.
const treeState = new Map();
// share id -> the friend's copy of the owner's file list. The main process keeps these in files of
// their own; the window asks for the one it needs, and gets a new one with every sync.
const remoteLists = new Map();
// notes of the folder in view whose list of files is open: "<share id>:<note>"
const openNotes = new Set();

const $ = (sel) => document.querySelector(sel);

// An error thrown in the main process arrives as "Error invoking remote method '...': Error: text".
const errorText = (err) => err.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '');

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== false && value != null) node.setAttribute(key, value);
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}

function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i && n < 100 ? 1 : 0)} ${units[i]}`;
}

const formatDate = (ms) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const selected = () => state.shares.find((s) => s.id === selectedId);
const isExpired = (share) => share.expiresAt != null && share.expiresAt <= Date.now();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const isPaused = (share) => paused.has(share.id);
const activeShares = () => state.shares.filter((s) => !paused.has(s.id));
// Every folder in the list counts against the limit of the plan, the ones you share and the ones from friends.
const atLimit = () => account.limit !== null && state.shares.length >= account.limit;
const isBlockedHost = (share) => share.role === 'host' && blockedHosts.get(share.id) === share.code;

async function reload() {
  state = await api.getState();
  account = state.account;
  for (const id of limited) if (!state.shares.some((s) => s.id === id)) limited.delete(id);
  for (const id of unregistered) if (!state.shares.some((s) => s.id === id)) unregistered.delete(id);
  if (!selected()) selectedId = null;
  refreshPaused();
  renderSidebar();
  renderDetail();
  renderAccount();
  watchExpiry();
}

// A code that runs out while the window is open: the card says "expired" by itself, and the folder
// stops being served at that moment, not at the next round.
let expiryTimer = null;
function watchExpiry() {
  clearTimeout(expiryTimer);
  const next = state.shares.filter((s) => s.expiresAt > Date.now()).sort((a, b) => a.expiresAt - b.expiresAt)[0];
  if (!next) return;
  // a timer cannot wait longer than about 24 days; a longer wait is cut in pieces
  expiryTimer = setTimeout(() => {
    if (isExpired(next)) {
      p2p.setHostShares(activeShares());
      if (selectedId === next.id) renderCard();
    }
    watchExpiry();
  }, Math.min(next.expiresAt - Date.now() + 100, 2 ** 31 - 1));
}

function select(id) {
  selectedId = id;
  // the window only holds the owner's list of the folder it shows (the rest is in the profile)
  for (const other of [...remoteLists.keys()]) if (other !== id) remoteLists.delete(other);
  renderSidebar();
  renderDetail();
}

// The oldest folders (by when they were added) keep their place under the limit of the plan; the
// rest are paused. Folders from before the date was kept count as the oldest, ties keep list order.
function computePaused() {
  const next = new Set();
  for (const share of state.shares) if (limited.has(share.id)) next.add(share.id);
  if (account.limit !== null) {
    [...state.shares].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).slice(account.limit).forEach((s) => next.add(s.id));
  }
  return next;
}

// Works out which folders are paused and tells the matchmaking server which ones can be reached. A
// folder that is not paused any more (a slot was freed, or the limit went away) starts by itself.
// -> whether any folder changed between paused and active
function refreshPaused() {
  const next = computePaused();
  const resumed = state.shares.filter((s) => paused.has(s.id) && !next.has(s.id));
  const changed = resumed.length > 0 || [...next].some((id) => !paused.has(id));
  paused = next;
  p2p.setHostShares(activeShares());
  if (p2p.isOnline()) for (const s of resumed) if (s.role === 'guest' && !isExpired(s)) syncShare(s.id);
  return changed;
}

function applyAccount(next) {
  account = next;
  const changed = refreshPaused();
  renderAccount();
  if (changed) {
    renderSidebar();
    renderDetail();
  }
}

function renderSidebar() {
  // the entries are rebuilt each time; keep the keyboard focus on the same folder
  const focused = document.activeElement?.closest('#list-host, #list-guest') ? document.activeElement.dataset.shareId : null;
  for (const role of ['host', 'guest']) {
    const items = state.shares
      .filter((s) => s.role === role)
      .map((s) =>
        el('li', { class: [s.id === selectedId && 'selected', isPaused(s) && 'paused'].filter(Boolean).join(' ') },
          // a real button, so Tab reaches it and Enter or Space open it; the path in the tooltip tells
          // apart two folders of the same name, now that one can live anywhere
          el('button', { type: 'button', class: 'item', 'data-share-id': s.id, 'aria-current': s.id === selectedId ? 'true' : false, title: s.dir ? `${s.name}\n${s.dir}` : s.name, onclick: () => select(s.id) },
            el('span', { class: 'name' }, s.name),
            isPaused(s) && el('span', { class: 'tag' }, 'paused'),
            !isPaused(s) && unregistered.has(s.id) && el('span', { class: 'tag', title: 'The server could not register this folder. It is tried again later.' }, 'not registered'))));
    if (!items.length) items.push(el('li', { class: 'empty' }, role === 'host' ? 'Nothing shared yet' : 'No codes added yet'));
    $(`#list-${role}`).replaceChildren(...items);
  }
  if (focused) $(`[data-share-id="${CSS.escape(focused)}"]`)?.focus();
}

// Why the app cannot connect, above everything else in the main area.
function noticeCard() {
  if (conn.kind === 'outdated') {
    const available = update.status === 'available';
    return el('div', { class: 'card notice', id: 'notice', role: 'alert' },
      el('h2', {}, 'This version is too old'),
      el('p', {}, `FriendsShare cannot connect with this version${conn.min ? `. Version ${conn.min} or newer is needed` : ''}. Sharing and syncing start again once you update.`),
      el('div', { class: 'row' },
        available && el('button', { class: 'primary', id: 'btn-notice-update', disabled: updating, onclick: installUpdate }, updating ? 'Updating…' : 'Update now'),
        !available && el('span', { class: 'muted' }, update.status === 'error' ? 'Could not look for an update.' : update.status === 'current' ? 'No newer version found yet.' : 'Looking for an update…'),
        !available && el('button', { onclick: checkUpdate }, 'Check again'),
        el('button', { onclick: openWebsite }, 'Open the website')));
  }
  if (conn.kind === 'unofficial') {
    return el('div', { class: 'card notice', id: 'notice', role: 'alert' },
      el('h2', {}, 'Not an official release'),
      el('p', {}, 'This copy of FriendsShare is not an official release, so it cannot use the FriendsShare service. Folders do not sync until you use the official app.'),
      el('button', { class: 'primary', id: 'btn-notice-download', onclick: openWebsite }, 'Download the official app'));
  }
  return null;
}

const openWebsite = () => api.openLink(state.siteUrl).catch((err) => alert(errorText(err)));

// Swaps the notice in place, or rebuilds the main area when one appears or goes away.
function renderNotice() {
  const old = $('#notice');
  const next = noticeCard();
  if (old && next) old.replaceWith(next);
  else if (old || next) renderDetail();
}

function renderDetail() {
  const share = selected();
  const main = $('#detail');
  const notice = noticeCard();
  if (!share) {
    main.replaceChildren(...[
      notice,
      el('div', { class: 'welcome' },
        el('h1', {}, 'Share big files with friends'),
        el('p', {}, 'Create a folder or share one you already have, then generate a share code. A friend who enters the code gets a copy of the folder.'),
        el('p', {}, 'Files travel directly from your PC to theirs and are never stored on a server. Both of you need to have FriendsShare running while they transfer.'))
    ].filter(Boolean));
    return;
  }
  const head = el('div', { class: 'head' },
    el('div', {}, el('h1', {}, share.name), el('div', { class: 'path', title: share.dir || '' }, share.dir || 'Not downloaded yet')),
    el('button', { onclick: () => openFolder(share), disabled: !share.dir }, 'Open folder'),
    el('button', { class: 'danger', onclick: () => removeShare(share) }, 'Remove'));
  const filesCard = el('div', { class: 'card' },
    el('div', { class: 'row' },
      el('h2', { class: 'grow', id: 'files-title' }, 'Files'),
      share.role === 'guest' && el('button', { class: 'small', id: 'btn-selectall', hidden: true, onclick: selectAllOrNone }, 'Select all / none'),
      share.role === 'host' && el('button', { id: 'btn-add', onclick: () => addFiles(share) }, 'Add files')),
    share.role === 'host' && el('div', { class: 'hint', id: 'import-hint' }, 'Drop files or folders anywhere on this window to copy them into the folder, or put them there yourself.'),
    el('div', { class: 'hint', id: 'files-note' }),
    el('div', { class: 'files', id: 'files', role: 'tree', 'aria-label': 'Files' }));
  // The whole main area is drawn again (after every sync, say): somebody who is moving through the
  // list with the keyboard keeps their place.
  const focusedRow = document.activeElement?.closest('#files .node');
  keepTreeFocus = !!focusedRow;
  if (focusedRow && view) uiState(view.id).focus = focusedRow.dataset.key;
  main.replaceChildren(...[notice, head, shareCard(share), filesCard].filter(Boolean));
  renderStatus();
  wireTree($('#files'));
  // the list that was shown last is still good enough to start from; it is read again right away
  if (view && view.id === share.id) renderFiles();
  else $('#files').replaceChildren(el('div', { class: 'empty-note' }, 'Reading the folder…'));
  refreshFiles();
}

// The card with the code (or the sync) of a folder, or why it is paused.
function shareCard(share) {
  const card = isPaused(share) ? pausedCard(share) : share.role === 'host' ? hostCard(share) : guestCard(share);
  card.dataset.shareCard = '';
  return card;
}

// Draws the card of the folder in view again, and nothing else.
function renderCard() {
  const share = selected();
  const old = $('[data-share-card]');
  if (!share || !old) return;
  old.replaceWith(shareCard(share));
  renderStatus();
}

// A folder over the limit of the plan: why, and what to do about it.
function pausedCard(share) {
  const { limit } = account;
  const what = share.role === 'host' ? 'shared' : 'synced';
  const error = el('div', { class: 'error', id: 'paused-error' });
  return el('div', { class: 'card paused-card', id: 'paused-card' },
    el('h2', {}, 'Paused'),
    el('p', {}, limit !== null
      ? `The free plan holds ${plural(limit, 'folder')} at a time, and the ${limit === 1 ? 'oldest one stays' : `${limit} oldest stay`} active. This folder is not ${what} until you remove another folder or upgrade to Pro. Nothing is deleted.`
      : `The folder limit of your plan is reached. This folder is not ${what} until you remove another folder or upgrade to Pro. Nothing is deleted.`),
    el('button', { class: 'primary', id: 'btn-paused-upgrade', onclick: () => upgrade((text) => (error.textContent = text)) }, 'Upgrade to Pro'),
    error);
}

function expirySelect() {
  return el('select', { id: 'expiry' },
    EXPIRY_CHOICES.map((days) => el('option', { value: days, selected: days === state.defaultExpiryDays }, days === 1 ? '1 day' : `${days} days`)));
}

function hostCard(share) {
  const generate = async () => {
    if (share.code && !isExpired(share) && !confirm('The current code stops working. Friends need the new code to keep syncing. Continue?')) return;
    await api.generateCode(share.id, Number($('#expiry').value));
    await reload();
  };
  if (!share.code) {
    return el('div', { class: 'card' },
      el('h2', {}, 'Share code'),
      el('div', { class: 'row' }, el('span', { class: 'muted grow' }, 'Code is valid for'), expirySelect(), el('button', { class: 'primary', onclick: generate }, 'Generate code')),
      el('div', { class: 'hint' }, 'Anyone with the code can download this folder until it expires.'));
  }
  const copy = async (e) => {
    await navigator.clipboard.writeText(share.code);
    e.target.textContent = 'Copied';
    setTimeout(() => (e.target.textContent = 'Copy'), 1500);
  };
  return el('div', { class: 'card' },
    el('h2', {}, 'Share code'),
    el('div', { class: 'row' }, el('div', { class: 'code' }, share.code), el('button', { class: 'primary', onclick: copy }, 'Copy')),
    el('div', { class: 'hint' + (isExpired(share) ? ' error' : '') },
      isExpired(share) ? `Expired on ${formatDate(share.expiresAt)}. Generate a new code to share again.` : `Valid until ${formatDate(share.expiresAt)}. Friends can download while FriendsShare is running.`),
    el('div', { class: 'hint status', id: 'status' }),
    el('div', { class: 'row gap' }, el('span', { class: 'muted grow' }, 'Replace with a new code valid for'), expirySelect(), el('button', { onclick: generate }, 'New code')));
}

function guestCard(share) {
  return el('div', { class: 'card' },
    el('div', { class: 'row' },
      el('h2', { class: 'grow' }, 'Sync'),
      el('button', { class: 'primary', id: 'btn-sync', onclick: () => syncShare(share.id, { download: true, manual: true }) }, share.chosen ? 'Sync now' : 'Download selected')),
    el('div', { class: 'status', id: 'status' }),
    // the files that were left out of the last sync, behind a "Show"
    el('div', { class: 'skipped', id: 'skipped' }),
    el('progress', { id: 'progress', max: 1, value: 0, hidden: true }),
    el('div', { class: 'hint' },
      [share.lastSync && `Last synced ${new Date(share.lastSync).toLocaleString()}.`, share.expiresAt && `Code ${isExpired(share) ? 'expired' : 'valid until'} ${formatDate(share.expiresAt)}.`]
        .filter(Boolean).join(' ')));
}

// Only touches the status line and progress bar, so it is cheap enough to call during transfers.
function renderStatus() {
  const share = selected();
  const line = $('#status');
  if (!share || !line) return;
  if (share.role === 'host') {
    const info = hostInfo.get(share.id);
    const blocked = isBlockedHost(share);
    const gone = view && view.id === share.id && view.missing;
    // a problem that keeps friends from the folder says so, whatever else is going on
    const problem = blocked
      ? `${p2p.message('blocked')} Click New code to share this folder again.`
      : unregistered.has(share.id)
        ? 'This folder could not be registered right now, so friends cannot reach it yet. FriendsShare tries again later.'
        : gone
          ? 'Friends cannot download this folder right now, because it cannot be found.'
          : null;
    line.className = `hint status${problem ? ' error' : ''}`;
    // `sent` is everything sent for this folder, to all friends together
    line.textContent = problem || (info?.friends ? `${info.friends === 1 ? 'A friend is' : `${info.friends} friends are`} connected, ${formatBytes(info.sent)} sent.` : '');
    return;
  }
  const st = status.get(share.id) || { kind: '', text: share.lastSync ? '' : 'Not synced yet.' };
  line.className = `status ${st.kind}`;
  line.textContent = st.text;
  renderSkipped(share, st);
  $('#btn-sync').disabled = syncing.has(share.id);
  const bar = $('#progress');
  bar.hidden = !(st.kind === 'syncing' && st.total);
  if (st.total) bar.value = st.done / st.total;
}

// A small "Show" that opens a list of paths, each with a note: the files that a sync left out, and
// the files of a friend's folder that cannot be downloaded at all. -> [the button, the list or false],
// to go after the words that explain them. shown() draws it again after a click.
function fileNote(id, key, items, shown) {
  const noteKey = `${id}:${key}`;
  const open = openNotes.has(noteKey);
  const list = items.slice(0, 200);
  return [
    el('button', { type: 'button', class: 'small', 'aria-expanded': String(open), onclick: () => {
      openNotes[open ? 'delete' : 'add'](noteKey);
      shown();
    } }, open ? 'Hide' : 'Show'),
    open && el('ul', { class: 'note-files' },
      ...list.map(({ path, note }) => el('li', {}, el('span', { class: 'path-text', title: path }, path), note && el('span', { class: 'why' }, note))),
      items.length > list.length && el('li', { class: 'why' }, `and ${items.length - list.length} more`)),
  ];
}

const SKIP_NOTES = { read: "could not be read on your friend's PC", changed: 'changed while it was downloading' };

// The files of the last sync that were left out. Only drawn again when something about them changed,
// because this is called many times a second during a transfer.
function renderSkipped(share, st) {
  const box = $('#skipped');
  const items = st.skipped || [];
  const signature = `${items.length}|${openNotes.has(`${share.id}:skipped`)}`;
  if (!box || box.dataset.signature === signature) return;
  box.dataset.signature = signature;
  box.replaceChildren(...(items.length
    ? [el('div', { class: 'note' }, el('span', { class: 'muted' }, 'They are tried again at the next sync. '),
       ...fileNote(share.id, 'skipped', items.map((s) => ({ path: s.path, note: SKIP_NOTES[s.why] || s.note })), () => {
         box.dataset.signature = '';
         renderSkipped(share, st);
       }))]
    : []));
}

// ---- the file list: a tree, for the owner and for the friend ----
//
// Folders and files are rows of a tree. The top level is shown, folders are closed, and a folder
// that is opened draws its entries when it is opened. A folder shows at most tree.PAGE entries at a
// time and then a "Show more" row, so that a folder of twenty thousand files is as light as a small
// one. The list is built from the whole folder (or the owner's whole list), but only what is open is
// ever drawn. A friend's folder has a checkbox on each row, ticked, unticked or (for a folder) mixed.

// The friend's copy of the owner's file list for a folder, or null when there is none yet.
async function remoteList(id) {
  if (!remoteLists.has(id)) {
    const saved = await api.getRemote(id);
    if (saved) remoteLists.set(id, saved.files);
  }
  return remoteLists.get(id) || null;
}

function uiState(id) {
  if (!treeState.has(id)) treeState.set(id, { open: new Set(), shown: new Map(), focus: null });
  return treeState.get(id);
}

// Reads the folder in view (and for a friend the owner's list) and draws the tree. Called when a
// folder is selected, when something changed, and when the window comes back to the front.
// options.fresh: not from the listing the main process kept for a few seconds.
async function refreshFiles(options = {}) {
  const share = selected();
  if (!share) return;
  const mine = ++refreshCount;
  let listing;
  let remote;
  try {
    listing = share.dir ? await api.listFiles(share.id, options.fresh ? { fresh: true } : undefined) : { files: [], missing: null };
    remote = share.role === 'guest' ? await remoteList(share.id) : null;
  } catch {
    // the folder was removed meanwhile: what is on the screen stays until the window is drawn again
    return;
  }
  // another folder was selected, or a newer read took over, while this one was running
  if (mine !== refreshCount || selectedId !== share.id || !$('#files')) return;
  listedAt = Date.now();
  let built;
  let kind = 'plain';
  if (remote && remote.length) {
    // what is on this disk but not in the owner's list is shown apart, without a choice
    const known = new Set(remote.map((f) => f.path));
    built = tree.build(remote, listing.files.filter((f) => !known.has(f.path)));
    tree.markDone(built.root, new Map(listing.files.map((f) => [f.path, f])));
    tree.choose(built.root, new Set(share.excluded));
    kind = 'choice';
  } else {
    built = tree.build(listing.files);
  }
  view = { id: share.id, role: share.role, kind, built, missing: listing.missing };
  renderFiles();
  // the owner's status line says when the folder cannot be found
  renderStatus();
}

// Draws the title, the notes and the rows of `view`.
function renderFiles() {
  const share = selected();
  if (!share || !view || view.id !== share.id || !$('#files')) return;
  const { built, kind } = view;
  const missing = share.role === 'host' && view.missing;
  const add = $('#btn-add');
  if (add) add.disabled = !!missing;
  const selectAll = $('#btn-selectall');
  if (selectAll) selectAll.hidden = kind !== 'choice';
  const note = $('#files-note');
  note.replaceChildren();
  if (missing) {
    keepTreeFocus = false;
    $('#files-title').textContent = 'Files';
    $('#files').replaceChildren(el('div', { class: 'missing', role: 'alert' },
      el('strong', {}, 'This folder cannot be found.'),
      el('p', {}, missing === 'denied' ? 'FriendsShare is not allowed to read it.' : 'It was moved or deleted, or its drive is not connected.'),
      el('p', {}, 'Friends cannot download it right now. Put it back where it was, or remove it from your list.')));
    return;
  }
  const { root } = built;
  $('#files-title').textContent = kind === 'choice'
    ? `Files (${root.wantedCount} of ${root.count} selected, ${formatBytes(root.wantedSize)})`
    : root.count ? `Files (${root.count}, ${formatBytes(root.size)})` : 'Files';
  // the owner's app chooses the names, and some cannot be written on Windows (see tree.unsafePath)
  if (built.bad.length) {
    const one = built.bad.length === 1;
    note.append(`${plural(built.bad.length, 'file')} cannot be downloaded: ${one ? 'its name is' : 'their names are'} not allowed on Windows. ${one ? 'It is' : 'They are'} skipped. `,
      ...fileNote(share.id, 'bad', built.bad.map((b) => ({ path: b.path, note: b.why })), renderFiles).filter(Boolean));
  }
  renderTree();
}

// Draws the rows again: those of the folders that are open, in the order of the tree. The focus and
// the scroll position stay where they were.
function renderTree() {
  const box = $('#files');
  const ui = uiState(view.id);
  const choice = view.kind === 'choice';
  const rows = tree.rows(view.built, ui.open, ui.shown);
  if (!rows.length) {
    box.replaceChildren(el('div', { class: 'empty-note' }, view.role === 'host' ? 'This folder is empty.' : 'Nothing here yet.'));
    return;
  }
  // One row is the one that Tab reaches, the one that had the focus last; the arrow keys go from row
  // to row from there.
  const keys = rows.map(tree.rowKey);
  // (the row that has the focus now is the truth, whatever the focus events said)
  const focused = box.contains(document.activeElement) ? document.activeElement.closest('.node') : null;
  if (focused) ui.focus = focused.dataset.key;
  const current = keys.includes(ui.focus) ? ui.focus : keys[0];
  const hadFocus = keepTreeFocus || !!focused;
  keepTreeFocus = false;
  const scroll = box.scrollTop;
  box.replaceChildren(...rows.map((row, i) => treeRow(row, keys[i], keys[i] === current, choice, ui)));
  box.scrollTop = scroll;
  if (hadFocus) box.querySelector('.node[tabindex="0"]').focus({ preventScroll: true });
}

const CHECKED = { all: 'true', none: 'false', mixed: 'mixed' };

// The checkbox of a row: a real one, so that the system draws it (also in high-contrast themes) and
// "mixed" is the usual dash. The row is what has the focus and says "checked" to a screen reader, so
// the box itself is out of both.
function checkbox(state) {
  const box = el('input', { type: 'checkbox', class: 'check', tabindex: -1, 'aria-hidden': 'true' });
  box.checked = state === 'all';
  box.indeterminate = state === 'mixed';
  return box;
}

function treeRow(row, key, current, choice, ui) {
  const base = { role: 'treeitem', tabindex: current ? 0 : -1, 'aria-level': row.depth + 1, 'data-key': key };
  // indent by CSS class: the page may not carry inline styles
  const indent = `d${Math.min(row.depth, 12)}`;
  if (row.more) {
    return el('div', { ...base, class: `node more ${indent}` },
      el('span', { class: 'chev' }),
      el('span', { class: 'name' }, `Show more (${row.hidden} more)`));
  }
  const n = row.node;
  const open = n.dir && ui.open.has(n.path);
  const pick = choice && !n.extra;
  const state = n.dir ? n.state : n.wanted ? 'all' : 'none';
  // what is on this disk already
  const mark = !choice || (n.dir && (n.extra || !n.count))
    ? ''
    : n.dir ? (n.done === n.count ? 'all downloaded' : n.done ? `${n.done} of ${n.count} downloaded` : '') : n.done ? 'downloaded' : '';
  return el('div', {
    ...base,
    class: `node ${n.dir ? 'dir' : 'file'} ${indent}`,
    'aria-setsize': row.of,
    'aria-posinset': row.index + 1,
    'aria-expanded': n.dir ? String(open) : null,
    'aria-checked': pick ? CHECKED[state] : null,
  },
    el('span', { class: `chev${open ? ' open' : ''}`, 'aria-hidden': 'true' }),
    pick && checkbox(state),
    el('span', { class: 'name', title: n.dir || !n.extra ? n.path : n.name }, n.name),
    choice && el('span', { class: 'done' }, mark),
    el('span', { class: 'meta' }, n.dir ? plural(n.count, 'file') : ''),
    el('span', { class: 'size' }, formatBytes(n.size)));
}

// the node of a key (see tree.rowKey)
function nodeFor(key) {
  const { root, extras } = view.built;
  if (extras && key.startsWith(extras.path)) {
    const rest = key.slice(extras.path.length + 1);
    return rest === '' ? extras : extras.kids.get(rest) || null;
  }
  return tree.find(root, key);
}

// What a row stands for: { node }, or { more: the folder that has more entries than are shown }.
function rowFor(key) {
  if (key.endsWith('/\u0000more')) {
    const path = key.slice(0, -'/\u0000more'.length);
    const dir = path === '' ? view.built.root : nodeFor(`${path}/`);
    return dir ? { more: dir } : null;
  }
  const node = nodeFor(key);
  return node ? { node } : null;
}

function toggleOpen(dir, key) {
  const ui = uiState(view.id);
  ui.open[ui.open.has(dir.path) ? 'delete' : 'add'](dir.path);
  ui.focus = key;
  renderTree();
}

function showMore(dir) {
  const ui = uiState(view.id);
  const before = ui.shown.get(dir.path) || tree.PAGE;
  ui.shown.set(dir.path, before + tree.PAGE);
  // the focus goes to the first entry that was not there before
  const first = tree.sortedKids(dir)[before];
  if (first) ui.focus = tree.entryOf(first);
  renderTree();
}

// A new list of excluded paths for the folder in view. Only that small list is written, and the
// tree is not read from the disk again: nothing on the disk changed.
function setChoice(share, list) {
  if (list === share.excluded || !view || view.kind !== 'choice') return;
  share.excluded = list;
  tree.choose(view.built.root, new Set(list));
  renderFiles();
  api.updateShare(share.id, { excluded: list }).catch((err) => alert(errorText(err)));
}

// A click, or Space, on a file or folder of a friend's folder: a folder that is not ticked all the
// way (nothing or only some of it) is ticked, a ticked one is unticked.
function toggleNode(node) {
  const share = selected();
  if (!share || !view || view.kind !== 'choice') return;
  setChoice(share, tree.setWanted(share.excluded || [], node, node.dir ? node.state !== 'all' : !node.wanted));
}

// all ticked -> untick all, otherwise tick all
function selectAllOrNone() {
  const share = selected();
  if (!share || !view || view.kind !== 'choice') return;
  const { root } = view.built;
  setChoice(share, root.state === 'all' ? tree.selectNone(share.excluded || [], root) : tree.selectAll(share.excluded || [], root));
}

// One listener each for all the rows of the list: there are many, and they are drawn again often.
function wireTree(box) {
  box.addEventListener('click', (e) => {
    const row = e.target.closest('.node');
    const target = row && view && rowFor(row.dataset.key);
    if (!target) return;
    uiState(view.id).focus = row.dataset.key;
    // the list is drawn again from what is chosen, so the box must not also change by itself
    if (e.target.closest('.check')) e.preventDefault();
    if (target.more) return showMore(target.more);
    const { node } = target;
    // a file is ticked by a click anywhere on its row, a folder by a click on its checkbox; a click
    // on the rest of a folder opens or closes it
    if (view.kind === 'choice' && !node.extra && (!node.dir || e.target.closest('.check'))) toggleNode(node);
    else if (node.dir) toggleOpen(node, row.dataset.key);
  });
  box.addEventListener('focusin', (e) => {
    const row = e.target.closest('.node');
    if (!row || !view) return;
    uiState(view.id).focus = row.dataset.key;
    box.querySelector('.node[tabindex="0"]')?.setAttribute('tabindex', '-1');
    row.setAttribute('tabindex', '0');
  });
  box.addEventListener('keydown', onTreeKey);
}

// Tab reaches the list, Up and Down go from row to row, Right and Left open and close a folder (or
// go into it and to its parent), Enter opens and closes, Space ticks, Home and End go to the ends.
function onTreeKey(e) {
  const row = e.target.closest('.node');
  if (!row || e.target !== row || !view || e.ctrlKey || e.metaKey || e.altKey) return;
  const rows = [...e.currentTarget.querySelectorAll('.node')];
  const at = rows.indexOf(row);
  const level = (r) => Number(r.getAttribute('aria-level'));
  const key = row.dataset.key;
  const target = rowFor(key);
  const dir = target && target.node && target.node.dir ? target.node : null;
  const open = !!dir && uiState(view.id).open.has(dir.path);
  const go = (r) => r && r.focus();
  switch (e.key) {
    case 'ArrowDown': go(rows[at + 1]); break;
    case 'ArrowUp': go(rows[at - 1]); break;
    case 'Home': go(rows[0]); break;
    case 'End': go(rows[rows.length - 1]); break;
    case 'ArrowRight':
      if (dir && !open) toggleOpen(dir, key);
      else if (open && rows[at + 1] && level(rows[at + 1]) > level(row)) go(rows[at + 1]);
      break;
    case 'ArrowLeft':
      if (open) toggleOpen(dir, key);
      else go(rows.slice(0, at).reverse().find((r) => level(r) < level(row)));
      break;
    case 'Enter':
      if (target && target.more) showMore(target.more);
      else if (dir) toggleOpen(dir, key);
      break;
    case ' ':
      if (target && target.more) showMore(target.more);
      else if (target && view.kind === 'choice' && !target.node.extra) toggleNode(target.node);
      else if (dir) toggleOpen(dir, key);
      break;
    default:
      return;
  }
  e.preventDefault();
}

async function importInto(share, run) {
  const hint = $('#import-hint');
  const before = hint?.textContent;
  if (hint) hint.textContent = 'Copying…';
  try {
    await run();
  } catch (err) {
    alert(`Could not add the files: ${errorText(err)}`);
  }
  if (hint?.isConnected) hint.textContent = before;
  refreshFiles({ fresh: true });
}

const addFiles = (share) => importInto(share, () => api.pickFiles(share.id));

async function openFolder(share) {
  try {
    await api.openShare(share.id);
  } catch (err) {
    alert(errorText(err));
  }
}

// Naming the folder and where it is matters for one that was shared in place: it is the person's own.
async function removeShare(share) {
  const what = share.role === 'host' ? `Stop sharing "${share.name}"? Its code stops working.` : `Remove "${share.name}" from the list?`;
  const files = share.dir ? `Nothing is deleted. The files stay in ${share.dir}.` : 'Nothing was downloaded yet.';
  if (!confirm(`${what}\n\n${files}`)) return;
  // the server forgets the folder (frees its slot, and any wait for the owner) before another one asks for it
  if (share.role === 'guest' && share.code) await p2p.leave(share.code);
  await api.removeShare(share.id);
  status.delete(share.id);
  blockedGuests.delete(share.id);
  blockedHosts.delete(share.id);
  unregistered.delete(share.id);
  remoteLists.delete(share.id);
  treeState.delete(share.id);
  if (view && view.id === share.id) view = null;
  // a slot is free now: folders the server refused for the limit get another try
  limited.clear();
  await reload();
}

// What a sync says when it is over: "Synced. 12 files downloaded, 2 could not be read on your
// friend's PC." The files that were left out are listed apart (see renderSkipped).
function syncText({ listOnly, downloaded, skipped }) {
  if (listOnly) return 'Choose what to download, then click Download selected.';
  if (!downloaded && !skipped.length) return 'Up to date.';
  const count = (why) => skipped.filter((s) => s.why === why).length;
  const parts = [];
  if (downloaded) parts.push(`${plural(downloaded, 'file')} downloaded`);
  // the first thing said is a number of files, the others only a number
  const n = (k) => (parts.length ? `${k}` : plural(k, 'file'));
  if (count('read')) parts.push(`${n(count('read'))} could not be read on your friend's PC`);
  if (count('changed')) parts.push(`${n(count('changed'))} changed while downloading`);
  if (count('name')) parts.push(`${n(count('name'))} ${count('name') === 1 ? 'has a name' : 'have names'} that Windows does not allow`);
  if (count('local')) parts.push(`${n(count('local'))} could not be saved on this PC`);
  return `Synced. ${parts.join(', ')}.`;
}

// Until the friend clicked the download button once, a sync only fetches the file list.
// options.download is that click: it makes the choice final and from then on syncs download.
// options.manual is a click on the button too; only that tries a blocked code again.
async function syncShare(id, options = {}) {
  const share = state.shares.find((s) => s.id === id);
  if (!share || share.role !== 'guest' || syncing.has(id) || isPaused(share)) return;
  if (blockedGuests.has(id)) {
    if (!options.manual) return;
    blockedGuests.delete(id);
  }
  syncing.add(id);
  const show = (st) => {
    status.set(id, st);
    if (selectedId === id) renderStatus();
  };
  show({ kind: 'syncing', text: 'Connecting to your friend…' });
  let last = { t: performance.now(), done: 0, shown: 0, speed: 0 };
  let downloaded = 0;
  let skipped = 0;
  try {
    if (options.download && !share.chosen) {
      share.chosen = true;
      await api.updateShare(id, { chosen: true });
    }
    const result = await p2p.sync(share, ({ file, done, total }) => {
      const now = performance.now();
      if (now - last.shown < 200) return;
      if (now - last.t >= 1000) last = { ...last, speed: ((done - last.done) / (now - last.t)) * 1000, t: now, done };
      last.shown = now;
      show({ kind: 'syncing', done, total, text: `${file} · ${formatBytes(done)} of ${formatBytes(total)}${last.speed ? ` · ${formatBytes(last.speed)}/s` : ''}` });
    }, { listOnly: !share.chosen });
    syncing.delete(id);
    downloaded = result.downloaded;
    skipped = result.skipped.length;
    // the list the owner just sent is what the tree shows from now on (it was stored as well); a
    // folder that is not in view does not keep it in the window
    if (selectedId === id) remoteLists.set(id, result.remote);
    else remoteLists.delete(id);
    status.set(id, { kind: skipped ? 'warn' : 'ok', text: syncText(result), skipped: result.skipped });
  } catch (err) {
    syncing.delete(id);
    if (err.code === 'limit') {
      // the server holds no more folders for this plan: paused, not an error
      limited.add(id);
      status.delete(id);
    } else {
      if (err.code === 'blocked') blockedGuests.add(id);
      status.set(id, { kind: 'error', text: errorText(err) });
    }
  }
  await reload();
  // the main process shows a notification if the window is hidden or minimized
  if (downloaded) api.syncDone(state.shares.find((s) => s.id === id)?.name || share.name, downloaded, skipped);
}

const syncAll = () => state.shares.filter((s) => s.role === 'guest' && !isExpired(s)).forEach((s) => syncShare(s.id));

// ---- dialogs and window events ----

// Cancel is a plain button, not a submit button: the first submit button of a form is the one Enter
// presses, and that has to be Create / Add.
for (const button of document.querySelectorAll('dialog [data-cancel]')) button.onclick = () => button.closest('dialog').close();

// At the limit of the plan, adding a folder (either kind) opens this instead of the dialog for it.
function showLimit() {
  $('#limit-text').textContent = `The free plan holds ${plural(account.limit, 'folder')} at a time. Remove a folder from the list (its files stay on your disk) or upgrade to Pro for unlimited folders.`;
  $('#limit-error').textContent = '';
  $('#dlg-limit').showModal();
}
$('#btn-limit-upgrade').onclick = () => upgrade((text) => ($('#limit-error').textContent = text));

// Two ways to add a folder of your own: a new empty one in the base folder, or one that exists.
$('#btn-new').onclick = () => {
  if (atLimit()) return showLimit();
  $('#new-name').value = '';
  $('#new-error').textContent = '';
  $('#new-base').textContent = state.settings.baseDir;
  $('#dlg-new').showModal();
};
$('#dlg-new').querySelector('form').onsubmit = async (e) => {
  e.preventDefault();
  const name = $('#new-name').value.trim();
  if (!name) {
    $('#new-error').textContent = 'Enter a name for the folder.';
    return;
  }
  try {
    const share = await api.createShare(name);
    $('#dlg-new').close();
    await reload();
    select(share.id);
  } catch (err) {
    $('#new-error').textContent = errorText(err);
  }
};
// the main process shows the folder picker; null means it was cancelled
$('#btn-existing').onclick = async () => {
  $('#new-error').textContent = '';
  try {
    const share = await api.addExistingFolder();
    if (!share) return;
    $('#dlg-new').close();
    await reload();
    select(share.id);
  } catch (err) {
    $('#new-error').textContent = errorText(err);
  }
};

$('#btn-join').onclick = () => {
  if (atLimit()) return showLimit();
  $('#join-code').value = '';
  $('#join-error').textContent = '';
  $('#dlg-join').showModal();
};
$('#dlg-join').querySelector('form').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const share = await api.joinShare($('#join-code').value);
    $('#dlg-join').close();
    await reload();
    select(share.id);
    syncShare(share.id);
  } catch (err) {
    $('#join-error').textContent = errorText(err);
  }
};

// ---- settings: every change is applied at once, there is nothing to save ----

function fillSettings() {
  const { settings } = state;
  $('#set-basedir').textContent = settings.baseDir;
  $('#set-basedir').title = settings.baseDir;
  $('#set-tray').checked = settings.tray;
  $('#set-autostart').checked = settings.autostart;
  $('#set-autostart').disabled = !state.canAutostart;
  $('#autostart-hint').textContent = state.canAutostart
    ? 'FriendsShare then starts in the tray, without opening its window.'
    : 'Only available in the FriendsShare.exe download.';
  $('#about-version').textContent = `FriendsShare v${state.version}`;
}

async function changeSettings(apply) {
  $('#settings-error').textContent = '';
  try {
    const settings = await apply();
    if (settings) state.settings = settings;
  } catch (err) {
    $('#settings-error').textContent = errorText(err);
  }
  // also puts a checkbox back that could not be changed
  fillSettings();
}

$('#btn-settings').onclick = () => {
  $('#settings-error').textContent = '';
  fillSettings();
  $('#dlg-settings').showModal();
};
$('#set-tray').onchange = (e) => changeSettings(() => api.setSettings({ tray: e.target.checked }));
$('#set-autostart').onchange = (e) => changeSettings(() => api.setSettings({ autostart: e.target.checked }));
$('#btn-basedir').onclick = () => changeSettings(() => api.pickBaseDir());
// the tray menu can change "Start with Windows" while this dialog is open
api.onSettingsChanged((settings) => {
  state.settings = settings;
  fillSettings();
});
// the window blocks navigation, so links go to the system browser through the main process
for (const link of document.querySelectorAll('a[data-link]')) {
  link.onclick = (e) => {
    e.preventDefault();
    api.openLink(link.href).catch((err) => alert(errorText(err)));
  };
}

// ---- account: the row in the sidebar and its dialog (sign-in is only needed for Pro) ----

// "Free · 3 of 5 folders" when the plan has a limit, "Free" without one, "Pro"
function planText() {
  if (account.plan === 'pro') return 'Pro';
  if (account.limit !== null) return `Free · ${Math.min(state.shares.length, account.limit)} of ${plural(account.limit, 'folder')}`;
  return 'Free';
}

// A round picture of the account, or a neutral person when there is none. A picture that cannot
// be loaded is dropped, which leaves the person.
function fillAvatar(box, url) {
  if (box.dataset.src === (url || '')) return box;
  box.dataset.src = url || '';
  const person = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  person.setAttribute('viewBox', '0 0 24 24');
  person.setAttribute('fill', 'currentColor');
  person.setAttribute('aria-hidden', 'true');
  person.innerHTML = '<circle cx="12" cy="8.6" r="4.2" /><path d="M3.7 21c.5-4.7 3.8-7.2 8.3-7.2s7.8 2.5 8.3 7.2z" />';
  box.replaceChildren(person);
  if (url) {
    const img = el('img', { src: url, alt: '', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.remove());
    box.append(img);
  }
  return box;
}

function renderAccount() {
  const name = account.signedIn ? account.account?.name || 'Your account' : 'Sign in';
  $('#acct-name').textContent = name;
  $('#acct-plan').textContent = planText();
  $('#btn-account').title = account.signedIn ? [name, account.account?.email].filter(Boolean).join('\n') : 'Sign in to get Pro';
  fillAvatar($('#acct-avatar'), account.signedIn ? account.account?.avatar : null);
  if ($('#dlg-account').open) renderAccountDialog();
}

function renderAccountDialog() {
  const dialog = $('#dlg-account');
  const body = $('#acct-body');
  const hadFocus = dialog.contains(document.activeElement) && document.activeElement !== dialog.querySelector('[data-cancel]');
  $('#acct-error').textContent = account.error || '';
  if (!account.signedIn) {
    const { prices } = account;
    body.replaceChildren(...[
      el('p', {}, 'The free plan needs no account. Sign in to get Pro.'),
      account.billing && prices && el('p', { id: 'acct-price' }, `Pro: unlimited folders for ${prices.yearly_per_month} a month, billed yearly, or ${prices.monthly} monthly.`),
      account.signingIn && el('p', { id: 'acct-waiting' }, 'Waiting for your browser…'),
      account.signingIn
        ? el('div', { class: 'buttons' },
            // a second click just opens the same page again, for a tab that got lost
            el('button', { type: 'button', id: 'acct-reopen', onclick: signIn }, 'Open the page again'),
            el('button', { type: 'button', id: 'acct-cancel', onclick: cancelSignIn }, 'Cancel'))
        : el('div', { class: 'buttons' }, el('button', { type: 'button', id: 'acct-signin', class: 'primary', onclick: signIn }, 'Sign in')),
    ].filter(Boolean));
  } else {
    const who = account.account || { name: 'Your account', email: null, avatar: null };
    body.replaceChildren(
      el('div', { class: 'profile' },
        fillAvatar(el('span', { class: 'avatar big' }), who.avatar),
        el('div', {}, el('div', { class: 'name', id: 'acct-who' }, who.name), who.email && el('div', { class: 'email' }, who.email))),
      el('p', { class: 'plan-line' }, `Plan: ${planText()}`),
      el('div', { class: 'buttons' },
        account.plan === 'pro'
          ? el('button', { type: 'button', id: 'acct-manage', onclick: () => upgrade(showAccountError) }, 'Manage subscription')
          : account.billing && el('button', { type: 'button', id: 'acct-upgrade', class: 'primary', onclick: () => upgrade(showAccountError) }, 'Upgrade to Pro'),
        el('button', { type: 'button', id: 'acct-signout', onclick: signOut }, 'Sign out')));
  }
  // the button that had the focus may be gone now
  if (hadFocus && !dialog.contains(document.activeElement)) body.querySelector('button')?.focus();
}

const showAccountError = (text) => ($('#acct-error').textContent = text);

function openAccountDialog() {
  renderAccountDialog();
  if (!$('#dlg-account').open) $('#dlg-account').showModal();
  $('#acct-body button')?.focus();
}
$('#btn-account').onclick = openAccountDialog;
// a failure that was shown is not shown again the next time the dialog opens
$('#dlg-account').addEventListener('close', () => {
  if (account.error && !account.signingIn) api.cancelSignIn().then(applyAccount).catch(() => {});
});

// Each of these ends with the new state of the account, which re-draws the row and the dialog.
async function signIn() {
  try {
    applyAccount(await api.signIn());
  } catch (err) {
    showAccountError(errorText(err));
  }
}
async function cancelSignIn() {
  try {
    applyAccount(await api.cancelSignIn());
  } catch (err) {
    showAccountError(errorText(err));
  }
}
async function signOut() {
  try {
    applyAccount(await api.signOut());
  } catch (err) {
    showAccountError(errorText(err));
  }
}

// "Upgrade to Pro" and "Manage subscription": the account page on the website, in the browser,
// signed in already. Without a sign-in the person signs in first (the account dialog shows the
// wait), and the page opens when that is done. show(text) puts a failure where the button is.
async function upgrade(show) {
  if (!account.signedIn) {
    $('#dlg-limit').close();
    openAccountDialog();
    show = showAccountError;
  }
  show('');
  try {
    applyAccount(await api.openAccountPage());
  } catch (err) {
    show(errorText(err));
  }
}

window.addEventListener('dragover', (e) => {
  e.preventDefault();
  $('#detail').classList.toggle('dragging', selected()?.role === 'host');
});
window.addEventListener('dragleave', (e) => !e.relatedTarget && $('#detail').classList.remove('dragging'));
window.addEventListener('drop', (e) => {
  e.preventDefault();
  $('#detail').classList.remove('dragging');
  const share = selected();
  const paths = [...e.dataTransfer.files].map((f) => api.pathOf(f)).filter(Boolean);
  if (share?.role === 'host' && paths.length) importInto(share, () => api.importPaths(share.id, paths));
});
// Back in the window: the folder in view may have changed meanwhile. It is read again, only that one
// and not more often than every few seconds (see FOCUS_REFRESH_AFTER).
window.addEventListener('focus', () => {
  if (Date.now() - listedAt > FOCUS_REFRESH_AFTER) refreshFiles();
});

// ---- the matchmaking connection ----

const CONN_TEXT = { connecting: 'Connecting…', online: 'Online', offline: 'Offline, reconnecting…', outdated: 'Update needed', unofficial: 'Unofficial copy' };

function setConn(next) {
  conn = next;
  const line = $('#conn');
  line.textContent = CONN_TEXT[conn.kind];
  line.dataset.state = conn.kind;
  line.classList.toggle('online', conn.kind === 'online');
  renderNotice();
}

p2p.on('conn', (next) => {
  setConn(next);
  if (next.kind === 'online') syncAll();
  // too old to connect: look for the update right away
  if (next.kind === 'outdated') checkUpdate();
});

// The welcome is the truth about plan, limit and account. It comes before any folder is registered,
// so only the folders that fit under the limit are. A new connection is a fresh start for the
// folders the server refused for the limit.
p2p.on('welcome', async (message) => {
  limited.clear();
  // every folder is registered again on this connection, and the ones that are refused say so again
  if (unregistered.size) {
    unregistered.clear();
    renderSidebar();
    renderStatus();
  }
  try {
    applyAccount(await api.accountWelcome(message));
  } catch {}
});

// Bought, cancelled or ran out while connected: start over, so the folders are registered again
// under the new plan.
p2p.on('plan', async ({ plan, limit }) => {
  try {
    applyAccount(await api.accountPlan(plan, limit));
  } catch {}
  p2p.reconnect();
});

// The owner of a folder we were waiting for came online: no need to wait for the next round.
p2p.on('online', async (room) => {
  for (const share of state.shares) {
    if (share.role === 'guest' && share.code && (await p2p.room(share.code)) === room) return syncShare(share.id);
  }
});

// The server refused one of our own folders.
p2p.on('hostError', ({ shareId, code }) => {
  const share = state.shares.find((s) => s.id === shareId);
  if (!share) return;
  if (code === 'limit' && account.limit === null) {
    // The welcome said there is no limit, so this has nothing to do with the plan: an address can
    // only register 60 new folders an hour, and the server's table can be full. Nothing to upgrade;
    // it is tried again on the next connection and every few minutes (see retryUnregistered).
    unregistered.add(shareId);
    renderSidebar();
    if (selectedId === shareId) renderStatus();
  } else if (code === 'limit') {
    // paused; it starts again by itself when a slot is free
    limited.add(shareId);
    if (refreshPaused()) {
      renderSidebar();
      renderDetail();
    }
  } else if (code === 'blocked') {
    // the code was blocked: not announced again until a new code replaces it
    blockedHosts.set(shareId, share.code);
    if (selectedId === shareId) renderStatus();
  }
});

// The server says something about a friend's folder that no sync was waiting for: a code it blocked
// while we waited for the owner. Not tried again until the person clicks Sync now.
p2p.on('roomError', async ({ room, code }) => {
  if (code !== 'blocked') return;
  for (const share of state.shares) {
    if (share.role !== 'guest' || !share.code || (await p2p.room(share.code)) !== room) continue;
    blockedGuests.add(share.id);
    if (!syncing.has(share.id)) {
      status.set(share.id, { kind: 'error', text: p2p.message('blocked') });
      if (selectedId === share.id) renderStatus();
    }
    return;
  }
});

// The server took a folder of ours (it says so for every registration, a new try included).
p2p.on('hostOk', ({ shareId }) => {
  if (!unregistered.delete(shareId)) return;
  renderSidebar();
  if (selectedId === shareId) renderStatus();
});

// Asks the server again for the folders it did not take. They are not asked about again by
// themselves, which would be asking every time anything changes.
function retryUnregistered() {
  for (const id of unregistered) p2p.retryHost(id);
}

// `sent` is what was sent for the folder in all, to every friend
p2p.on('host', ({ shareId, friends, sent }) => {
  hostInfo.set(shareId, { friends, sent });
  if (selectedId === shareId) renderStatus();
});

api.onAccountChanged((next) => applyAccount(next));
// the token changed (signed in or out): hello again, with or without it
api.onReconnect(() => p2p.reconnect());

// Self-update: the main process talks to GitHub; this is just the circle next to the connection state.
const UPDATE_CHECK_EVERY = 4 * 3600 * 1000;
let update = { status: 'current' };
let updating = false;

function renderUpdate(pct) {
  const btn = $('#btn-update');
  btn.className = `upd${updating ? ' busy' : update.status === 'available' ? ' available' : ''}`;
  btn.textContent = updating ? (pct != null ? `${pct}%` : '…') : update.status === 'available' ? '↓' : '';
  btn.disabled = updating;
  btn.title = updating
    ? 'Downloading update…'
    : update.status === 'available'
      ? `Update to v${update.latest}`
      : update.status === 'error'
        ? `Could not check for updates (v${update.current})`
        : `Up to date (v${update.current})`;
}

async function checkUpdate() {
  if (updating) return;
  update = await api.checkUpdate();
  renderUpdate();
  // a version that is too old offers the update where it says so
  renderNotice();
}

// The circle and the "Update now" in the notice for a version that is too old do the same.
async function installUpdate() {
  // restarting also cuts off friends who are downloading from this PC
  const transferring = syncing.size || [...hostInfo.values()].some((info) => info.friends);
  if (transferring && !confirm('Files are still transferring. Update and restart anyway?')) return;
  updating = true;
  renderUpdate();
  renderNotice();
  try {
    await api.installUpdate();
  } catch (err) {
    alert(errorText(err));
  }
  updating = false;
  renderUpdate();
  renderNotice();
}

$('#btn-update').addEventListener('click', async () => {
  if (update.status !== 'available') return checkUpdate();
  installUpdate();
});
api.onUpdateProgress((pct) => renderUpdate(pct));

(async () => {
  await reload();
  checkUpdate();
  setInterval(checkUpdate, UPDATE_CHECK_EVERY);
  p2p.connect(state.signalUrl);
  setInterval(syncAll, RESYNC_EVERY);
  // a code that runs out while the app is open stops being served (watchExpiry does it at the moment
  // it runs out; this is the net under it)
  setInterval(() => p2p.setHostShares(activeShares()), 60 * 1000);
  setInterval(retryUnregistered, RETRY_REGISTER_EVERY);
})();
