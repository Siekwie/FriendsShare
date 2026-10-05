# FriendsShare

Send your friends the files that are too big for Discord or email. No size limit, because nothing
is uploaded anywhere: files go directly from your PC to theirs.

**[friendsshare.wiest-lab.eu](https://friendsshare.wiest-lab.eu)** ·
**[Download for Windows](https://github.com/Siekwie/FriendsShare/releases/latest/download/FriendsShare.exe)**

1. Create a folder in the app (or pick one you already have) and put files into it.
2. Click **Generate code** and send the code to a friend.
3. The friend clicks **Add code**, pastes it, picks what they want and downloads it.

## Free and Pro

|  | Free | Pro |
| --- | --- | --- |
| Size of files and folders | unlimited | unlimited |
| Folders at a time (shared and received together) | 5 | unlimited |
| Account | not needed | GitHub or Google sign-in |
| Price | free | €0.99 a month billed yearly, or €1.99 monthly |

Removing a folder from the list frees its slot and never deletes files. When Pro ends, folders
beyond the first five are paused, not removed.

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
  downloads the ticked files that are missing or changed: on start, every 10 minutes, on
  **Sync now**, and right away when the owner comes online. Interrupted downloads continue where
  they stopped. Files deleted by the owner are not deleted on the friend's side.
- **In the background**: closing the window keeps the app in the tray so friends can keep
  downloading; it can start with Windows.
- **Updates**: the circle at the bottom left turns green when a newer release exists. Click it and
  the app downloads the new version and restarts.

Limits worth knowing:

- Both apps must be running at the same time for files to transfer.
- There is no relay on purpose. If both of you are behind strict (symmetric) NATs, for example some
  mobile or university networks, a direct connection cannot be made and the sync fails.
- The two PCs connect directly, so they see each other's IP address.
- Windows only for now. The exe is not code-signed, so SmartScreen warns on the first start.

## Official builds and the official server

The server at `friendsshare.wiest-lab.eu` only talks to unmodified releases from this
repository. A release build carries a key that only the release workflow has
(`scripts/stamp-build.js`) and proves it when it connects; the server also compares the app's
fingerprint with the `build.json` published next to every release, and can require a minimum
version. The exe itself refuses to start when its code archive was altered.

This keeps honest people honest; it is not copy protection. A copy built from source works fully,
but not against the official server: run your own (below) and point the app at it.

## Development

```bash
npm install
npm --prefix server install
npm run server                                   # local server on :8080
FS_SIGNAL=ws://127.0.0.1:8080/ws npm start       # the app, talking to it
npm test                                         # the server's tests, then the app's (real app instances, hidden)
npm run dist                                     # build dist/FriendsShare.exe (portable, not "official")
```

`FS_HOME=<dir>` keeps all of an instance's settings and folders in one directory, so several can run
side by side. Official builds ignore both variables. To try sign-in locally, start the server with
`BASE_URL=http://127.0.0.1:8080` (the same host name the app uses) and the provider variables.

`npm run screenshots`, `npm run og` and `npm run icons` regenerate the website's pictures and the
icons from the real app and `assets/`.

## Running the server

`server/` is one Node process without a build step: the website (`server/site/`), sign-in,
Stripe billing and the matchmaking WebSocket. It needs Node 22 and a writable `DATA_DIR`
(SQLite database, daily snapshots in `DATA_DIR/backups`). Everything is switched on by
environment variables, listed in [deploy/env.example](deploy/env.example): without the Stripe
variables there is no Pro plan and no folder limit, without the sign-in variables no accounts,
without the operator variables no imprint, privacy and terms pages.

The official instance runs as a Docker container behind a Caddy reverse proxy:

```bash
deploy/deploy.sh <ssh-host>                        # deploy the committed HEAD
ssh <ssh-host> 'bash -s' < deploy/stripe-setup.sh  # Pro product, prices, webhook, portal
node deploy/setup-login.js github <ssh-host>       # "Sign in with GitHub": one click in the browser
node deploy/setup-login.js google <ssh-host>       # "Sign in with Google": guided, a few minutes
deploy/ops.sh <ssh-host> stats                     # who is connected, accounts, rooms
deploy/ops.sh <ssh-host> block <share code>        # after an abuse report; also unblock, blocked, logs
```

The server cannot see what people share, so blocking a reported code (its fingerprint) is all an
operator can do, and all the terms promise.

## License

The source is public, but this is not free software for businesses.

FriendsShare is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE.md). In short: as
a private person you may use, modify and share it for any noncommercial purpose. Commercial use,
including selling it or offering it (or a modified version) as a paid or hosted service, is reserved
to the author. Ask if you want a commercial license.

Required Notice: Copyright (c) 2026 Siekwie (https://github.com/Siekwie/FriendsShare)
