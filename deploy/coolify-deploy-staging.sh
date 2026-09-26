#!/bin/sh
# Forced command for the GitHub Actions deploy key on the staging VM. authorized_keys pins the key
# to this script (`restrict,command="/usr/local/bin/coolify-deploy-staging"`), so the key can
# trigger a staging deploy and nothing else: no shell, no forwarding, no other command.
#
# It talks to Coolify on localhost, so the Coolify API port never opens to the internet and the
# Coolify token (read + deploy abilities only) never leaves this host.
#
# Install: sudo install -m 755 deploy/coolify-deploy-staging.sh /usr/local/bin/coolify-deploy-staging
set -eu

APP_UUID=4pviwaoqxr0jmb75hxqvosf4
API=http://localhost:8000/api/v1
TOKEN_FILE=/etc/coolify-deploy/token
TIMEOUT_POLLS=90 # x 10 s = 15 min

TOKEN=$(cat "$TOKEN_FILE")

api() {
  curl -fsS -m 30 -H "Authorization: Bearer $TOKEN" -H 'Accept: application/json' \
    -H 'Content-Type: application/json' "$@"
}
deployment_uuid() {
  python3 -c 'import json,sys; print(json.load(sys.stdin)["deployments"][0]["deployment_uuid"])'
}
deployment_status() {
  python3 -c 'import json,sys; print(json.load(sys.stdin).get("status"))'
}

deployment=$(api -X POST "$API/deploy" -d "{\"uuid\":\"$APP_UUID\"}" \
  | deployment_uuid)
echo "queued Coolify deployment $deployment"

polls=0
while [ "$polls" -lt "$TIMEOUT_POLLS" ]; do
  sleep 10
  status=$(api "$API/deployments/$deployment" | deployment_status)
  case "$status" in
    finished)
      echo "deployment $deployment finished"
      exit 0 ;;
    failed | cancelled*)
      echo "deployment $deployment $status -- see its log in Coolify" >&2
      exit 1 ;;
  esac
  polls=$((polls + 1))
done
echo "deployment $deployment still '$status' after 15 minutes" >&2
exit 1
