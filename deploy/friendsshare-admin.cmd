@echo off
rem Opens the FriendsShare admin interface (server/admin.js) in your browser.
rem
rem The interface has no login. It listens only on the server's own loopback, and the SSH
rem tunnel this script opens (your SSH key) is the only way in. The tunnel stays open while
rem this window does; Ctrl+C or closing the window closes it.
rem
rem   friendsshare-admin <ssh host> [local port]      (or set DEPLOY_HOST; the port defaults to 8792)
setlocal
set "SSH_HOST=%~1"
if "%SSH_HOST%"=="" set "SSH_HOST=%DEPLOY_HOST%"
if "%SSH_HOST%"=="" (
  echo usage: friendsshare-admin ^<ssh host^> [local port]
  exit /b 1
)
set "PORT=%~2"
if "%PORT%"=="" set "PORT=8792"

echo FriendsShare admin: http://localhost:%PORT%/
echo The tunnel stays open while this window does. Ctrl+C closes it.

rem the browser opens a moment later, when the tunnel is up
start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start http://localhost:%PORT%/"
ssh -N -o ExitOnForwardFailure=yes -L %PORT%:127.0.0.1:8792 %SSH_HOST%
