# Deploy info

How imei-check gets from a commit to a running service: the branching strategy, the environments,
the pipeline, and every tool involved. The one-line version:

> **Merge to `main` → CI → staging deploys itself. Run `promote` → `release` fast-forwards →
> production.** Nothing is ever deployed that CI did not build and test first.

---

## 1. At a glance

```
 developer                GitHub                                   Oracle Cloud VM (ARM, Ubuntu)
 ─────────                ──────                                   ─────────────────────────────
 feat/xyz ──push──▶  PR ──▶ ci (check + image) ──green──▶ squash-merge to main
                                                              │
                                  ci on main ──success──▶ deploy-staging ──SSH (pinned key)──▶ coolify-deploy-staging
                                                                                                     │ localhost:8000
                                                                                                     ▼
                                                                                              Coolify ─▶ staging stack
                                                                                                     │   (api, worker,
                                  deploy-staging ◀── Coolify: running + healthy ──────────────────────┘    postgres)

 Actions → promote vX.Y.Z ──▶ release fast-forwards to main + tag ──▶ Coolify ─▶ production stack   (not live yet)
```

| Environment | Git branch | Deploys when | URL |
|---|---|---|---|
| **staging** | `main` | automatically, after `ci` passes on a push to `main` | none (private): `http://imei-check:3000` on the VM's internal network |
| **production** | `release` | someone runs the `promote` workflow | not configured yet (see §8) |

**imei-check is private.** It has no public URL. Its only caller is the trustmob-check backend,
which runs on the same VM, and the two talk over a Docker network that only their two `api`
containers join (§5.3).

---

## 2. Branching strategy: trunk-based

- **`main` is the trunk.** It is always deployable, and it is what staging runs.
- **Work on short-lived branches** cut from `main` (`feat/<topic>`, `fix/<topic>`, `chore/<topic>`)
  that live for hours or days, not weeks.
- **Everything reaches `main` by pull request, merged by squash.** Each PR becomes one revertable
  commit, and merged branches are deleted automatically.
- **`release` is the production branch, and nobody commits to it.** It only ever *fast-forwards* to
  a commit that is already on `main` and already ran on staging. The `promote` workflow is its only
  writer.
- **Versions are git tags** (`v<major>.<minor>.<patch>`), created by `promote` on the commit it
  sends to production.
- **A hotfix is a normal PR to `main` followed by a promote.** It is never a commit on `release`:
  that would put code in production that staging never ran.
- **Nothing is force-pushed.** A bad change is undone by a revert PR, not by rewriting history.

There is no `develop` branch and there are no `release/*` branches. With one trunk and continuous
deploys they only add merge work.

### Branch protection (enforced by GitHub, not by convention)

| Rule | `main` | `release` |
|---|---|---|
| Changes only through a pull request | ✅ | — (only `promote` pushes) |
| `check` and `image` must be green | ✅ (branch up to date too) | ✅ (on the pushed commit) |
| Linear history | ✅ | ✅ |
| Force-push / deletion | ❌ blocked | ❌ blocked |
| Unresolved review conversations block merge | ✅ | — |
| Merge method | squash only | fast-forward only |

Repository admins can still bypass these rules in an emergency. They are not enforced for admins.

---

## 3. Continuous integration: `.github/workflows/ci.yml`

This runs on every pull request and on every push to `main`.

| Job | Runner | What it does | Why it exists |
|---|---|---|---|
| `check` | `ubuntu-latest` | `npm ci` → `npm run typecheck` → `npm run boundaries` → `npm test` | Gates every merge on the wire contract, the module boundaries (dependency-cruiser) and the test suite, including the IMEI sentinel leak test. |
| `image` | `ubuntu-24.04-arm` | builds `Dockerfile` and `Dockerfile.migrate` | The VM is ARM64. A broken image fails here, not in the middle of a deploy. |

---

## 4. Continuous deployment

### 4.1 Staging: `.github/workflows/deploy-staging.yml`

- **Triggers:**
  - automatically, when `ci` completes **successfully** for a **push** to `main` (never for a PR
    run, never for a failed one);
  - by hand, from Actions → deploy-staging → Run workflow.
- **GitHub environment:** `staging`. Only `main` may deploy to it (deployment branch policy).
- **Steps:**
  1. **SSH to the VM.** The job logs in with the `STAGING_DEPLOY_KEY` secret and checks the VM's
     host key against `STAGING_SSH_KNOWN_HOSTS`, so it refuses to talk to an impostor.
  2. **Deploy.** The VM runs `coolify-deploy-staging`, which tells Coolify on `localhost` to deploy
     and waits up to 15 minutes. It exits non-zero if Coolify reports `failed` or `cancelled`, and
     the job fails with it.
  3. **Health check.** The same script then asks Coolify for the application's state until it is
     `running:healthy`, meaning the api answers `/healthz` and the worker's last poll tick
     succeeded, and fails after two minutes otherwise. There is no public URL to call.
- **Concurrency:** deploys are queued one at a time and never cancelled halfway.

**Why SSH rather than a Coolify webhook.** Coolify's UI and API are a root-equivalent control
panel for the whole VM, so port 8000 is never opened to the internet. GitHub therefore cannot call
Coolify. The job reaches the VM over SSH instead, with a key that can do exactly one thing:

```
# ~/.ssh/authorized_keys on the VM
restrict,command="/usr/local/bin/coolify-deploy-staging" ssh-ed25519 AAAA… github-actions-staging-deploy
```

- **`restrict`** means no shell, no port forwarding and no terminal.
- **`command=`** runs the deploy script whatever command the client asks for.
- **The script** ([`deploy/coolify-deploy-staging.sh`](deploy/coolify-deploy-staging.sh)) uses a
  Coolify token with **read + deploy** abilities only, stored at `/etc/coolify-deploy/token`
  (`root:ubuntu 640`). The token never leaves the VM.

If the deploy key leaked, the worst anyone could do with it is redeploy what is already on `main`.

### 4.2 Production: `.github/workflows/promote.yml`

- **Trigger:** manual only (Actions → promote → Run workflow), with a version such as `v0.3.0`.
- **It refuses unless:**
  - the version looks like `vX.Y.Z` and the tag does not exist yet,
  - `check` **and** `image` succeeded on `main`'s current commit,
  - `release` contains nothing that `main` lacks, which makes this a pure fast-forward.
- **Then:** it moves `release` to `main`'s commit, creates the tag, and writes a summary. Coolify's
  production app tracks `release`.

---

## 5. Runtime: what is running on the VM

### 5.1 Host

| | |
|---|---|
| Provider | **Oracle Cloud**, Ampere A1 (ARM64). Always Free allowance, with Pay-As-You-Go enabled so idle instances are not reclaimed |
| OS | Ubuntu, user `ubuntu` |
| Public IP | `144.24.200.242` |
| Platform | **Coolify** 4.3 (self-hosted PaaS), which runs everything in Docker |
| Reverse proxy | **Traefik** (Coolify's `coolify-proxy`), which routes each domain to its container and issues **Let's Encrypt** certificates |

### 5.2 One application = one compose stack

Coolify builds `docker-compose.prod.yml` from the git branch, on the VM itself (natively ARM64).

| Service | Image | Role |
|---|---|---|
| `postgres` | `postgres:17-alpine` | The database. Named volume `pgdata`. **Not published**: only the stack's own network can reach it. |
| `migrate` | `Dockerfile.migrate` (dbmate + `db/migrations`) | One-shot. It applies migrations and exits 0. `api` and `worker` wait for it. |
| `api` | `Dockerfile` | Fastify HTTP API on port 3000. **No domain, so Traefik routes nothing to it.** Also on the external internal network as `imei-check`. It has a Docker `HEALTHCHECK` on `/healthz`. |
| `worker` | `Dockerfile` (`apps/worker/dist/main.js`) | Background polling and jobs. It has no port. It is healthy while a poll tick has succeeded in the last 5 minutes (a heartbeat file, `apps/worker/src/heartbeat.ts`). |

Migrations run as their own step and never on app boot, so replicas can never race each other.
They must be **expand/contract**: the previous image has to keep working against the new schema,
or rolling back breaks. Promote to production only after a migration has run on staging.

### 5.3 Network exposure

| Port | Open to | Why |
|---|---|---|
| 22 | internet (key auth only) | SSH: admins and the pinned deploy key |
| 80 / 443 | internet | Traefik. 80 only redirects to 443 and answers Let's Encrypt challenges |
| 8000 | **nobody** | Coolify UI/API. Reach it with `ssh -L 8000:localhost:8000 ubuntu@144.24.200.242` → http://localhost:8000 |
| 5432 | **nobody** | Postgres stays inside Docker |
| 3000 (imei-check api) | **only the trustmob-check api container** | the internal Docker network below |

**Private service-to-service network.** Each Coolify app gets its own Docker network, so two apps
cannot see each other by default. One extra network per environment,
`imei-check-staging-internal`, is created once on the host
(`sudo docker network create imei-check-staging-internal`) and named in both apps' compose files:

```
 trustmob-check stack                          imei-check stack
 ┌───────────────────────────┐                 ┌──────────────────────────────┐
 │ api ──────────────────────┼── imei-check-  ─┼─▶ api  (alias: imei-check)   │
 │ admin-api   postgres      │   staging-      │    worker   postgres         │
 └───────────────────────────┘   internal      └──────────────────────────────┘
```

- **Only the two `api` containers join it.** Neither database, the worker or the admin API is on
  it, so trustmob-check cannot reach imei-check's Postgres, or the other way round.
- **trustmob-check calls** `IMEI_CHECK_BASE_URL=http://imei-check:3000`. Plain HTTP is fine: the
  traffic never leaves the host. The API key is still required on every request.
- **imei-check sets** `IMEI_INTERNAL_NETWORK=imei-check-staging-internal`. The compose file fails
  to deploy if it is unset or if the network does not exist.
- **No supplier callbacks.** `PUBLIC_BASE_URL` is empty, so no `feedback_url` is sent to imei24.
  Express answers still arrive within the request. Standard (2–24 h) orders settle through the
  worker's poll loop (5 min backoff, growing to 1 h) instead of an instant callback. To take
  callbacks later, publish only `/internal/providers/*/feedback` via Traefik and set
  `PUBLIC_BASE_URL`, never the whole API.

Two firewalls must agree: the Oracle **VCN Security List** (ingress rules) and the VM's own
**iptables**. Both allow only 22, 80 and 443. The iptables rules are saved with
`netfilter-persistent`.

---

## 6. Secrets: where each one lives

| Secret | Lives in | Never in |
|---|---|---|
| `POSTGRES_PASSWORD`, `SERVER_PEPPER`, `IMEI_ENCRYPTION_KEYS`, `IMEI24_USERNAME`/`IMEI24_API_KEY` | Coolify environment variables, **one set per environment** | git, GitHub, Actions logs |
| Coolify deploy token (read + deploy) | `/etc/coolify-deploy/token` on the VM | anywhere else |
| Staging deploy SSH private key | GitHub → environment `staging` → secret `STAGING_DEPLOY_KEY` | disk (the local copy was deleted after upload) |
| Service API key for check-this-phone-backend | printed once by `npm run seed:service-tenant`, stored by the caller | git |

Non-secret deploy settings are GitHub **variables** on the `staging` environment:
`STAGING_SSH_TARGET` and `STAGING_SSH_KNOWN_HOSTS`.

Keep an **offline copy** (password manager) of every environment's `SERVER_PEPPER` and
`IMEI_ENCRYPTION_KEYS`:

- **If the keyring is lost,** every stored IMEI becomes unrecoverable.
- **If the pepper changes,** the whole cache becomes useless.

Staging and production must never share them. `docker-compose.prod.yml` marks the required ones
as `${VAR:?}`, so a deploy with a missing secret fails before anything starts.

---

## 7. Everyday operations

| Task | How |
|---|---|
| Ship a change to staging | Open a PR, wait for green, squash-merge. Staging deploys itself. |
| Redeploy staging without a change | Actions → deploy-staging → Run workflow |
| Release to production | Actions → promote → Run workflow → `vX.Y.Z` |
| Roll back | Revert PR on `main` (then promote for production). In an emergency: Coolify → the app → Deployments → redeploy an earlier one |
| Open the Coolify UI | `ssh -L 8000:localhost:8000 ubuntu@144.24.200.242`, then http://localhost:8000 |
| Look at logs | Coolify → the app → Logs, or on the VM `sudo docker logs <container>` |
| Call imei-check by hand | It has no public URL. On the VM: `sudo docker run --rm --network imei-check-staging-internal curlimages/curl -s http://imei-check:3000/healthz` |
| First deploy of a new environment | Run `npm run seed:service-tenant` in the `api` container's terminal. It prints the caller's API key once. |
| HTTPS certificate stuck on "TRAEFIK DEFAULT CERT" | Usually issuance failed while ports 80/443 were closed. Open them, then `sudo docker restart coolify-proxy` so Traefik retries. |

---

## 8. Not done yet

- **Production is not configured.** The Coolify `production` environment exists but is empty.
  Setting it up means:
  - a second compose app tracking `release`, with its own domain,
  - its **own** secrets and `seed:service-tenant` key,
  - its own GitHub environment and pinned deploy key if it deploys via SSH like staging.

  It must not take real IMEIs until the release blockers in the README are closed: an imei24
  account and recorded responses, the lexicon, and the matching check-this-phone-backend and
  Android changes.
- **No scheduled database backups yet.** Configure Coolify → the Postgres resource → Backups to an
  S3-compatible bucket (Oracle Object Storage or Cloudflare R2) before production holds real data.

---

## 9. Tools used

| Tool | Used for |
|---|---|
| **Git + GitHub** | Source of truth, pull requests, branch protection, environments, secrets and variables |
| **GitHub Actions** | `ci` (tests + ARM image build), `deploy-staging`, `promote` |
| **GitHub CLI (`gh`)** | Creating PRs, auto-merge, setting environment secrets and variables from the terminal |
| **Docker / Docker Compose** | Packaging: one app image (`Dockerfile`), one migration image, one compose stack per environment, and the external network that links the two `api` containers |
| **dbmate** | Postgres migrations (`db/migrations`), run as a one-shot container |
| **PostgreSQL 17** | The database, one per environment |
| **Node.js 22 + Fastify** | The `api` and `worker` processes |
| **Oracle Cloud Infrastructure** | The ARM64 VM, VCN Security List (network firewall) |
| **Coolify** | Self-hosted PaaS on the VM: builds from git, runs the compose stacks, manages env vars, logs and redeploys |
| **Traefik** | Reverse proxy in front of every app, with automatic Let's Encrypt HTTPS |
| **Let's Encrypt** | Free TLS certificates, renewed automatically |
| **sslip.io** | Free wildcard DNS (`*.144.24.200.242.sslip.io` → the VM). Used by the trustmob-check public API; imei-check itself has no domain. |
| **OpenSSH** | Admin access, the Coolify tunnel, and the pinned deploy key (`authorized_keys` `restrict,command=`) |
| **iptables + netfilter-persistent** | The VM's own firewall, kept across reboots |
