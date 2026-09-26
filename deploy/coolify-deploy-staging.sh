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
app_status() {
  api "$API/applications/$APP_UUID" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status"))'
}

# The api has no public URL to smoke-test, so ask Coolify how the stack is doing. Every long-running
# container has a real healthcheck (the api answers /healthz, the worker's last poll tick
# succeeded), so only "running:healthy" passes. Coolify reports "unknown" while healthchecks are
# still starting; anything but healthy after two minutes -- unhealthy, restarting, exited -- fails.
wait_until_running() {
  checks=0
  while [ "$checks" -lt 24 ]; do
    state=$(app_status)
    case "$state" in
      running:healthy)
        echo "application is $state"
        return 0 ;;
    esac
    checks=$((checks + 1))
    sleep 5
  done
  echo "application is '$state' two minutes after the deployment finished" >&2
  return 1
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
      wait_until_running
      exit $? ;;
    failed | cancelled*)
      echo "deployment $deployment $status -- see its log in Coolify" >&2
      exit 1 ;;
  esac
  polls=$((polls + 1))
done
echo "deployment $deployment still '$status' after 15 minutes" >&2
exit 1
