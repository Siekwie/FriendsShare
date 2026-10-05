# FriendsShare

A small desktop app for sending friends the files that are too big for Discord or email.

1. Create a folder in the app and put files into it.
2. Click **Generate code** and send the code to a friend.
3. The friend clicks **Add code**, pastes it, and their app downloads the folder.

Files go directly from one PC to the other. They are never uploaded to a server.

## How it works

- **Share code**: a random UUID. Whoever has it can download the folder until the code expires
  (365 days unless you pick something shorter). **New code** replaces it and locks out the old one.
- **Matchmaking server** (`server/`): introduces the two apps to each other so they can open a
  direct WebRTC connection. It only ever sees the SHA-256 of a code and the connection handshake,
  never the code, file names or file data.
- **Direct connection**: encrypted by WebRTC. Both apps additionally prove to each other that they
  know the code, bound to the keys of that connection, so the server cannot sit in the middle.
- **Sync**: after adding a code the friend's app only fetches the file list; the friend ticks the
  files they want (all are ticked by default) and clicks **Download selected**. From then on it
  downloads the ticked files that are missing or changed, on start, every 10 minutes and on
  **Sync now**. Files that newly appear on the owner's side are ticked by default; unticking a file
  that is already downloaded does not delete it. Interrupted downloads continue where they stopped.
  Files deleted by the owner are not deleted on the friend's side.
- **Updates**: the circle at the bottom left turns green when a newer release exists. Click it and
  the app downloads the new version and restarts.

Limits worth knowing:

- Both apps must be running at the same time for files to transfer.
- There is no relay on purpose. If both of you are behind strict (symmetric) NATs, for example some
  mobile or university networks, a direct connection cannot be made and the sync fails.

Folders live in `Documents\FriendsShare`.

## Development

```bash
npm install
npm start        # run the app
npm test         # local server + two app instances, checks that a folder syncs
npm run dist     # build dist/FriendsShare.exe (portable)
```

`FS_SIGNAL=ws://127.0.0.1:8080` points the app at a local server (`npm run server`), and `FS_HOME=<dir>`
keeps all of an instance's settings and folders in one directory, so several can run side by side.

## Server

The app uses the matchmaking server at `wss://friendsshare.wiest-lab.eu`. It is a small Docker
container behind a Caddy reverse proxy; `deploy/deploy.sh <ssh-host>` (from Git Bash) deploys the
committed `HEAD`.

## License

The source is public, but this is not free software for businesses.

FriendsShare is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE.md). In short: as
a private person you may use, modify and share it for any noncommercial purpose. Commercial use,
including selling it or offering it (or a modified version) as a paid or hosted service, is reserved
to the author. Ask if you want a commercial license.

Required Notice: Copyright (c) 2026 Siekwie (https://github.com/Siekwie/FriendsShare)
