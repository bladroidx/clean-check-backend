# Deploying and branching

## Branching: trunk-based

- `main` is the trunk and is always deployable (it is staging). It is protected: changes land by
  pull request, with the `ci / check` and `ci / image` jobs green.
- Work happens on short-lived branches cut from `main` — `feat/<topic>`, `fix/<topic>`,
  `chore/<topic>` — that live hours to days, not weeks. Merge by **squash**, so each PR is one
  revertable commit on `main`.
- `release` is the production branch. Nobody commits to it: it only ever fast-forwards to a
  commit that is already on `main`, via the **promote** workflow (Actions → promote → Run, with a
  version like `v0.4.0`). The workflow refuses unless main's head passed CI and `release` holds
  nothing main lacks, then moves `release` and tags the commit `v<major>.<minor>.<patch>`.
- A hotfix is a normal PR to `main`, then a promote. Never a commit on `release`.
- Never force-push `main` or `release` (both protected). A bad merge is fixed by a revert PR, not by
  rewriting history.

## CI (`.github/workflows/ci.yml`)

Runs on every pull request and every push to `main`:

| Job | What | Why |
|---|---|---|
| `check` | `npm ci`, `typecheck`, `boundaries`, `test` | The contract, module boundaries and the IMEI sentinel test gate every merge. |
| `image` | builds `Dockerfile` and `Dockerfile.migrate` on an arm64 runner | Production is an ARM host; a broken image fails here, not on deploy. |

## Deploy (Coolify on the Oracle ARM host)

Two Coolify environments, each deploying `docker-compose.prod.yml` on every push to its branch:

| Environment | Branch | Deploys when |
|---|---|---|
| staging | `main` | a PR is merged |
| production | `release` | the promote workflow runs |

Staging and production have separate databases and separate secrets: never share a pepper or a
keyring between them. Production must not take real IMEIs until the release blockers in the
README are closed.

- Migrations run in the one-shot `migrate` service before `api` and `worker` start. They must be
  expand/contract: the previous image has to keep working against the new schema, or a rollback
  (redeploying the previous commit in Coolify) breaks. Promote after the migration has run on
  staging.
- Secrets live only in Coolify's environment: `POSTGRES_PASSWORD` (hex), `SERVER_PEPPER`,
  `IMEI_ENCRYPTION_KEYS`, `PUBLIC_BASE_URL`, and `IMEI24_USERNAME`/`IMEI24_API_KEY` once bought.
  Never in GitHub, never in Actions. Keep an offline copy of the pepper and the keyring: losing
  the keyring makes every stored IMEI unrecoverable.
- First deploy: run `npm run seed:service-tenant` in the `api` container's terminal and hand the
  printed key to check-this-phone-backend.
