#!/usr/bin/env bash
# Deploys the server (website, accounts, matchmaking) and its admin interface from the committed
# HEAD: uploads the source, rebuilds the image, restarts the two containers and waits until both
# report healthy. Uncommitted changes are not deployed.
#
#   deploy/deploy.sh <ssh-host>      (or set DEPLOY_HOST; run from Git Bash on Windows)
#
# The server keeps /srv/friendsshare/.env (secrets, never in git; see deploy/env.example) and
# /srv/friendsshare/data (accounts and registered share rooms, never any shared files).
set -euo pipefail

HOST="${1:-${DEPLOY_HOST:?usage: deploy/deploy.sh <ssh-host>}}"
DIR=/srv/friendsshare
SITES=/srv/proxy/caddy/sites

cd "$(git rev-parse --show-toplevel)"
[ -z "$(git status --porcelain)" ] || echo "Note: uncommitted changes are left out, only HEAD is deployed." >&2
echo "Deploying $(git rev-parse --short HEAD) to $HOST:$DIR"

git archive --format=tar HEAD server deploy | ssh "$HOST" "set -e
  sudo mkdir -p $DIR && sudo chown \$(id -un): $DIR
  rm -rf $DIR/app.new && mkdir -p $DIR/app.new $DIR/data
  tar -x -C $DIR/app.new
  rm -rf $DIR/app && mv $DIR/app.new $DIR/app
  # the container runs as the unprivileged 'node' user (uid 1000)
  sudo chown 1000:1000 $DIR/data"

ssh "$HOST" "set -e
  cd $DIR
  test -f .env || { echo 'Missing $DIR/.env (see deploy/env.example)' >&2; exit 1; }
  docker compose -f app/deploy/compose.yml --project-directory . up -d --build --remove-orphans
  docker image prune -f >/dev/null
  if ! cmp -s app/deploy/friendsshare.caddy $SITES/friendsshare.caddy; then
    cp app/deploy/friendsshare.caddy $SITES/friendsshare.caddy
    docker exec caddy caddy reload --config /etc/caddy/Caddyfile
  fi
  healthy() { [ \"\$(docker inspect -f '{{.State.Health.Status}}' \$1 2>/dev/null)\" = healthy ]; }
  for i in \$(seq 1 45); do
    healthy friendsshare && healthy friendsshare-admin && { echo 'friendsshare and friendsshare-admin are healthy'; exit 0; }
    sleep 2
  done
  for c in friendsshare friendsshare-admin; do
    healthy \$c && continue
    echo \"\$c did not become healthy:\" >&2
    docker logs --tail 40 \$c >&2
  done
  exit 1"
