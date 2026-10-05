// The window: list of folders on the left, the selected one on the right.
const EXPIRY_CHOICES = [1, 7, 30, 90, 365];
const RESYNC_EVERY = 10 * 60 * 1000;

let state = { shares: [] };
let selectedId = null;
// guest share id -> { kind: 'syncing' | 'ok' | 'error', text, done, total }
const status = new Map();
// host share id -> { friends, sent }
const hostInfo = new Map();
const syncing = new Set();

const $ = (sel) => document.querySelector(sel);

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

async function reload() {
  state = await api.getState();
  if (!selected()) selectedId = null;
  p2p.setHostShares(state.shares);
  renderSidebar();
  renderDetail();
}

function select(id) {
  selectedId = id;
  renderSidebar();
  renderDetail();
}

function renderSidebar() {
  for (const role of ['host', 'guest']) {
    const items = state.shares
      .filter((s) => s.role === role)
      .map((s) => el('li', { class: s.id === selectedId ? 'selected' : '', title: s.name, onclick: () => select(s.id) }, s.name));
    if (!items.length) items.push(el('li', { class: 'empty' }, role === 'host' ? 'Nothing shared yet' : 'No codes added yet'));
    $(`#list-${role}`).replaceChildren(...items);
  }
}

function renderDetail() {
  const share = selected();
  const main = $('#detail');
  if (!share) {
    main.replaceChildren(
      el('div', { class: 'welcome' },
        el('h1', {}, 'Share big files with friends'),
        el('p', {}, 'Create a folder, put files in it and generate a share code. A friend who enters the code gets a copy of the folder.'),
        el('p', {}, 'Files travel directly from your PC to theirs and are never stored on a server. Both of you need to have FriendsShare running while they transfer.'))
    );
    return;
  }
  const head = el('div', { class: 'head' },
    el('div', {}, el('h1', {}, share.name), el('div', { class: 'path', title: share.dir || '' }, share.dir || 'Not downloaded yet')),
    el('button', { onclick: () => api.openShare(share.id), disabled: !share.dir }, 'Open folder'),
    el('button', { class: 'danger', onclick: () => removeShare(share) }, 'Remove'));
  const filesCard = el('div', { class: 'card' },
    el('div', { class: 'row' },
      el('h2', { class: 'grow', id: 'files-title' }, 'Files'),
      share.role === 'host' && el('button', { onclick: () => addFiles(share) }, 'Add files')),
    share.role === 'host' && el('div', { class: 'hint', id: 'import-hint' }, 'Drop files or folders anywhere on this window, or put them into the folder yourself.'),
    el('div', { class: 'files', id: 'files' }));
  main.replaceChildren(head, share.role === 'host' ? hostCard(share) : guestCard(share), filesCard);
  renderStatus();
  refreshFiles();
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
      isExpired(share) ? `Expired on ${formatDate(share.expiresAt)}. Generate a new code to share again.` : `Valid until ${formatDate(share.expiresAt)}. Keep FriendsShare open so friends can download.`),
    el('div', { class: 'hint status', id: 'status' }),
    el('div', { class: 'row gap' }, el('span', { class: 'muted grow' }, 'Replace with a new code valid for'), expirySelect(), el('button', { onclick: generate }, 'New code')));
}

function guestCard(share) {
  return el('div', { class: 'card' },
    el('div', { class: 'row' },
      el('h2', { class: 'grow' }, 'Sync'),
      el('button', { class: 'primary', id: 'btn-sync', onclick: () => syncShare(share.id) }, 'Sync now')),
    el('div', { class: 'status', id: 'status' }),
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
    line.textContent = info?.friends ? `${info.friends === 1 ? 'A friend is' : `${info.friends} friends are`} connected, ${formatBytes(info.sent)} sent.` : '';
    return;
  }
  const st = status.get(share.id) || { kind: '', text: share.lastSync ? '' : 'Not synced yet.' };
  line.className = `status ${st.kind}`;
  line.textContent = st.text;
  $('#btn-sync').disabled = syncing.has(share.id);
  const bar = $('#progress');
  bar.hidden = !(st.kind === 'syncing' && st.total);
  if (st.total) bar.value = st.done / st.total;
}

async function refreshFiles() {
  const share = selected();
  if (!share) return;
  const files = share.dir ? await api.listFiles(share.id) : [];
  if (selectedId !== share.id || !$('#files')) return;
  const total = files.reduce((sum, f) => sum + f.size, 0);
  $('#files-title').textContent = files.length ? `Files (${files.length}, ${formatBytes(total)})` : 'Files';
  $('#files').replaceChildren(
    ...(files.length
      ? files.map((f) => el('div', { class: 'file' }, el('span', { title: f.path }, f.path), el('span', {}, formatBytes(f.size))))
      : [el('div', { class: 'file muted' }, share.role === 'host' ? 'This folder is empty.' : 'Nothing here yet.')]));
}

async function importInto(share, run) {
  const hint = $('#import-hint');
  const before = hint?.textContent;
  if (hint) hint.textContent = 'Copying…';
  try {
    await run();
  } catch (err) {
    alert(`Could not add the files: ${err.message}`);
  }
  if (hint?.isConnected) hint.textContent = before;
  refreshFiles();
}

const addFiles = (share) => importInto(share, () => api.pickFiles(share.id));

async function removeShare(share) {
  const what = share.role === 'host' ? 'Stop sharing this folder? Its code stops working.' : 'Remove this folder from the list?';
  if (!confirm(`${what}\n\nThe files stay on your disk.`)) return;
  await api.removeShare(share.id);
  status.delete(share.id);
  await reload();
}

async function syncShare(id) {
  const share = state.shares.find((s) => s.id === id);
  if (!share || share.role !== 'guest' || syncing.has(id)) return;
  syncing.add(id);
  const show = (st) => {
    status.set(id, st);
    if (selectedId === id) renderStatus();
  };
  show({ kind: 'syncing', text: 'Connecting to your friend…' });
  let last = { t: performance.now(), done: 0, shown: 0, speed: 0 };
  try {
    const result = await p2p.sync(share, ({ file, done, total }) => {
      const now = performance.now();
      if (now - last.shown < 200) return;
      if (now - last.t >= 1000) last = { ...last, speed: ((done - last.done) / (now - last.t)) * 1000, t: now, done };
      last.shown = now;
      show({ kind: 'syncing', done, total, text: `${file} · ${formatBytes(done)} of ${formatBytes(total)}${last.speed ? ` · ${formatBytes(last.speed)}/s` : ''}` });
    });
    syncing.delete(id);
    status.set(id, { kind: 'ok', text: result.downloaded ? `Synced. ${result.downloaded} file${result.downloaded === 1 ? '' : 's'} downloaded.` : 'Up to date.' });
  } catch (err) {
    syncing.delete(id);
    status.set(id, { kind: 'error', text: err.message });
  }
  await reload();
}

const syncAll = () => state.shares.filter((s) => s.role === 'guest' && !isExpired(s)).forEach((s) => syncShare(s.id));

// ---- dialogs and window events ----

$('#btn-new').onclick = () => {
  $('#new-name').value = '';
  $('#dlg-new').returnValue = '';
  $('#dlg-new').showModal();
};
$('#dlg-new').onclose = async (e) => {
  const name = $('#new-name').value.trim();
  if (e.target.returnValue !== 'ok' || !name) return;
  const share = await api.createShare(name);
  await reload();
  select(share.id);
};

$('#btn-join').onclick = () => {
  $('#join-code').value = '';
  $('#join-error').textContent = '';
  $('#dlg-join').showModal();
};
$('#dlg-join').querySelector('form').onsubmit = async (e) => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  try {
    const share = await api.joinShare($('#join-code').value);
    $('#dlg-join').close();
    await reload();
    select(share.id);
    syncShare(share.id);
  } catch (err) {
    $('#join-error').textContent = err.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
  }
};

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
window.addEventListener('focus', refreshFiles);

p2p.on('status', (online) => {
  $('#conn').textContent = online ? 'Online' : 'Offline, reconnecting…';
  $('#conn').classList.toggle('online', online);
  if (online) syncAll();
});
p2p.on('host', ({ shareId, friends, sent }) => {
  const info = hostInfo.get(shareId) || { sent: 0 };
  hostInfo.set(shareId, { friends, sent: Math.max(info.sent, sent) });
  if (selectedId === shareId) renderStatus();
});

(async () => {
  await reload();
  p2p.connect(state.signalUrl);
  setInterval(syncAll, RESYNC_EVERY);
  // a code that runs out while the app is open stops being served
  setInterval(() => p2p.setHostShares(state.shares), 60 * 1000);
})();
