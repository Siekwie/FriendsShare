#!/usr/bin/env bash
# Operator commands for the running server. They go through ssh and docker, because the server
# answers its /internal/ endpoints only from inside its own container, never through the proxy.
#
#   deploy/ops.sh <ssh-host> stats                    who is connected, how many accounts and rooms
#   deploy/ops.sh <ssh-host> block <code> [note]      block a share code (after an abuse report)
#   deploy/ops.sh <ssh-host> unblock <code>
#   deploy/ops.sh <ssh-host> blocked                  the block list
#   deploy/ops.sh <ssh-host> logs [lines]             the server's log
#
# <code> is the share code as it was reported, or the 64-character room fingerprint.
set -euo pipefail

HOST="${1:?usage: deploy/ops.sh <ssh-host> stats|block|unblock|blocked|logs}"
CMD="${2:-stats}"
NAME=friendsshare
URL=http://127.0.0.1:8080/internal

# share codes and fingerprints are hex and dashes; anything else is refused rather than escaped
target() {
  local value="${1:?give a share code or a room fingerprint}"
  [[ "$value" =~ ^[0-9A-Fa-f-]{32,64}$ ]] || { echo "That is neither a share code nor a room fingerprint." >&2; exit 1; }
  if [ "${#value}" = 64 ]; then printf '"room":"%s"' "$value"; else printf '"code":"%s"' "$value"; fi
}
post() { ssh "$HOST" "docker exec $NAME wget -qO- --header 'Content-Type: application/json' --post-data '$2' $URL/$1"; echo; }

case "$CMD" in
  stats) ssh "$HOST" "docker exec $NAME wget -qO- $URL/stats"; echo ;;
  blocked) ssh "$HOST" "docker exec $NAME wget -qO- $URL/blocked"; echo ;;
  block)
    note=$(printf '%s' "${4:-}" | tr -cd 'A-Za-z0-9 _.,:#-')
    post block "{$(target "${3:-}"),\"note\":\"$note\"}" ;;
  unblock) post unblock "{$(target "${3:-}")}" ;;
  logs) ssh "$HOST" "docker logs --tail ${3:-100} $NAME" ;;
  *) echo "unknown command: $CMD" >&2; exit 1 ;;
esac
