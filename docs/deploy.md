# Deploying and branching

## Branching: trunk-based

- `main` is the only long-lived branch and is always deployable. It is protected: changes land by
  pull request, with the `ci / check` and `ci / image` jobs green.
- Work happens on short-lived branches cut from `main` — `feat/<topic>`, `fix/<topic>`,
  `chore/<topic>` — that live hours to days, not weeks. Merge by **squash**, so each PR is one
  revertable commit on `main`.
- No `develop`, no `release/*`. A release is a tag on `main`: `v<major>.<minor>.<patch>`.
- Never force-push `main`. A bad merge is fixed by a revert PR, not by rewriting history.

## CI (`.github/workflows/ci.yml`)

Runs on every pull request and every push to `main`:

| Job | What | Why |
|---|---|---|
| `check` | `npm ci`, `typecheck`, `boundaries`, `test` | The contract, module boundaries and the IMEI sentinel test gate every merge. |
| `image` | builds `Dockerfile` and `Dockerfile.migrate` on an arm64 runner | Production is an ARM host; a broken image fails here, not on deploy. |

## Deploy (Coolify on the Oracle ARM host)

Coolify's GitHub App watches `main` and redeploys `docker-compose.prod.yml` on every push, so
**merging to `main` deploys**. Until the release blockers in the README are closed this host is
staging; when production is split out, it tracks tags instead of `main`.

- Migrations run in the one-shot `migrate` service before `api` and `worker` start. They must be
  expand/contract: the previous image has to keep working against the new schema, or a rollback
  (redeploying the previous commit in Coolify) breaks.
- Secrets live only in Coolify's environment: `POSTGRES_PASSWORD` (hex), `SERVER_PEPPER`,
  `IMEI_ENCRYPTION_KEYS`, `PUBLIC_BASE_URL`, and `IMEI24_USERNAME`/`IMEI24_API_KEY` once bought.
  Never in GitHub, never in Actions. Keep an offline copy of the pepper and the keyring: losing
  the keyring makes every stored IMEI unrecoverable.
- First deploy: run `npm run seed:service-tenant` in the `api` container's terminal and hand the
  printed key to check-this-phone-backend.
