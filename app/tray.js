// The tray icon, and the Windows notifications that go with running in the background.
const { Tray, Menu, Notification, nativeImage } = require('electron');
const path = require('path');

const image = (name) => nativeImage.createFromPath(path.join(__dirname, name));

// A notification that gets garbage collected before it is clicked never reports the click, so keep
// each one until it is gone.
const live = new Set();

// Shows a Windows notification. onClick runs when the person clicks it.
function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const toast = new Notification({ title, body, icon: image('icon.png') });
  live.add(toast);
  toast.on('click', () => {
    live.delete(toast);
    if (onClick) onClick();
  });
  toast.on('close', () => live.delete(toast));
  toast.on('failed', () => live.delete(toast));
  toast.show();
}

// open() brings the window back, quit() ends the app. getAutostart() -> { available, checked } is
// asked again whenever the menu is rebuilt (see refresh), setAutostart(on) applies a click on it.
// Returns { refresh, destroy }, or null when there is no tray icon, in which case the caller must
// not hide the window: nothing would bring it back.
function createTray({ open, quit, getAutostart, setAutostart }) {
  const icon = image('tray.png');
  // an empty image would give an icon nobody can see
  if (icon.isEmpty()) return null;
  let tray;
  try {
    tray = new Tray(icon);
  } catch {
    return null;
  }
  tray.setToolTip('FriendsShare');
  tray.on('click', () => open());
  tray.on('double-click', () => open());

  function refresh() {
    const autostart = getAutostart();
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open FriendsShare', click: () => open() },
        {
          label: 'Start with Windows',
          type: 'checkbox',
          checked: autostart.checked,
          enabled: autostart.available,
          click: (item) => {
            try {
              setAutostart(item.checked);
            } catch {
              // the checkbox already flipped; put it back to what is really set
              refresh();
              notify('FriendsShare', 'Could not change the Windows startup entry.');
            }
          },
        },
        { type: 'separator' },
        { label: 'Quit', click: () => quit() },
      ])
    );
  }
  refresh();
  return { refresh, destroy: () => tray.destroy() };
}

module.exports = { createTray, notify };
