#!/usr/bin/env bash
# The real-Postgres lane: a throwaway Postgres (same major as production), every migration applied
# by the same dbmate image the deploy uses, then the tests that skip themselves without
# TEST_DATABASE_URL. Nothing here touches a database you care about -- the container is removed on
# exit, pass or fail.
#
# Files run one at a time (--no-file-parallelism): they share one database and TRUNCATE it.
set -euo pipefail

cd "$(dirname "$0")/.."

NAME="imei-check-it-$$"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Docker picks a free host port: a fixed one collides with whatever else runs Postgres locally.
docker run -d --rm --name "$NAME" -e POSTGRES_PASSWORD=it -e POSTGRES_DB=imei \
  -p "127.0.0.1::5432" postgres:17-alpine >/dev/null
PORT="$(docker port "$NAME" 5432/tcp | head -n1 | sed 's/.*://')"
URL="postgres://postgres:it@127.0.0.1:${PORT}/imei?sslmode=disable"

docker run --rm --network host -v "$PWD/db/migrations:/db/migrations:ro" -e DATABASE_URL="$URL" \
  ghcr.io/amacneil/dbmate:2 --wait --no-dump-schema up

TEST_DATABASE_URL="$URL" npx vitest run --no-file-parallelism \
  packages/core/test/pg-integration.test.ts \
  apps/api/test/pg-deep-check.test.ts
