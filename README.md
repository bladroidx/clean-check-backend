# imei-check

A provider-agnostic HTTP API that answers *"is this phone clean?"* from an IMEI — validity and
device identity, GSMA blacklist, carrier/SIM-lock/Find My, and Apple warranty.

It is the backend the Android app at [`../check-this-phone`](../check-this-phone) defers to in its
`PLAN.md` Phase 6, and it is usable by any other client.

## What makes it different

> **We resell grey-market data. The product is honesty about it.**

The lost/stolen answer comes from the GSMA Device Registry, sold under contract to operators,
manufacturers, insurers and inventory managers. We are downstream of resellers. So we do not compete
on data — we compete on a stable schema, on `coverage` metadata that states what an answer actually
covers, and on never turning *"we don't know"* into *"it's fine"*.

Concretely, three things no competitor ships:

1. **Four arms, not a boolean.** Every section is `pass` · `fail` · `inconclusive` · `unavailable`,
   each carrying its evidence. There is no `{"clean": true}` — a wrong boolean either helps sell
   stolen goods or defames a seller.
2. **`coverage` on every answer**, including the ones we could not give: which registries, which
   regions enforce them, and the caveats that make a "clean" result a true statement rather than a
   misleading one.
3. **No raw IMEI anywhere durable** — masked or HMAC-hashed only, enforced by a sentinel test rather
   than by review.

## Quick start

```bash
npm ci
npm test                                             # 104 tests
npm run build

SERVER_PEPPER="$(head -c 48 /dev/urandom | base64)" npm run dev
```

```bash
curl -s localhost:3000/healthz
curl -s localhost:3000/v1/tac/35310411 | jq
curl -s -X POST localhost:3000/v1/imei/validate \
  -H 'content-type: application/json' \
  -d '{"imei":"IMEI (slot 1): 353104112345676"}' | jq
```

Interactive docs at `/docs`, generated OpenAPI at `/openapi.json`.

Or the whole stack: `docker compose up --build` (Postgres + migrations + API).

## Status — M0 complete

| | |
|---|---|
| ✅ **M0 walking skeleton** | Free tier, contract, identity, schema, Docker, migrations. **Costs nothing to run.** |
| ⬜ M1 | API keys, credits, one DHRU provider, `blacklist.gsma`, field cache |
| ⬜ M2 | Second provider, failover, circuit breaker, async orders + webhooks |
| ⬜ M3 | `lock.carrier` / `lock.activation` / Apple GSX; wire up the Android app |
| ⬜ M4 | Apply for GSMA Device Check direct, behind the same `Provider` interface |

Shipping today, all free and offline:

- `POST /v1/imei/validate` — parse, Luhn, mask, TAC identity
- `GET /v1/tac/:tac` — one TAC (deliberately no bulk endpoint; see ADR-0005)
- `GET /v1/attributions`, `/healthz`, `/readyz`, `/openapi.json`, `/docs`

## Layout

```
packages/contract    zod → types → OpenAPI, plus the seven envelope invariants. Zero deps but zod.
packages/identity    Imei parse/Luhn/mask/hash + the TAC directory. Pure: no I/O, no clock, no env.
apps/api             Fastify. Composition only.
db/migrations        Plain SQL, dbmate, applied as a separate init step — never on app boot.
docs/adr             Why things are the way they are.
testdata             Golden IMEI vectors, shared with check-this-phone.
```

Direction is `contract ← identity ← apps`, and nothing depends on `apps/`. Enforced by
`npm run boundaries` — the analogue of the Android app's Konsist `ModuleBoundaryTest`.

## The rules that matter

Read [`CLAUDE.md`](CLAUDE.md) first; it is the short version. The long version is in `docs/adr/`:

- [0001](docs/adr/0001-four-arm-wire-contract.md) — four arms, and no boolean verdict
- [0002](docs/adr/0002-provider-abstraction.md) — adapters never build a section
- [0003](docs/adr/0003-no-raw-imei-at-rest.md) — no raw IMEI at rest, in a log, or in telemetry
- [0004](docs/adr/0004-cache-at-the-field-level.md) — cache fields, not responses, asymmetric TTLs
- [0005](docs/adr/0005-tac-data-licensing.md) — Osmocom with attribution, no bulk endpoint

Two you can break by accident, so they are tested rather than documented:

**An unrecognised provider value is `inconclusive`, never a benign default.** The day a supplier
rewords "Clean" to "No records found", we must return "we could not read the answer" — not green.

**Never fail over after a definite negative answer.** If provider A says blacklisted, shopping for
one who says clean is a fraud vector.

## Tooling

`.claude/` carries 10 agents, 11 skills, 11 commands and 2 workflows tuned to this codebase.
The ones worth knowing:

```
/quality      full gate: lint, types, boundaries, tests, leak sweep, schema diff
/leaks        IMEI leak sweep and GDPR posture
/adversarial  try to make the API report a stolen phone as clean
/provider     add or repair a supplier integration
/smoke        bring the stack up and exercise it with real curls
```

## Try the API in Bruno

[Bruno](https://www.usebruno.com) is a free, offline API client. Collections are plain files, so
this one lives in the repo and is version-controlled alongside the code.

**1. Install Bruno** — [download](https://www.usebruno.com/downloads), or:

```bash
brew install bruno                  # macOS
sudo snap install bruno             # Linux
winget install Bruno.Bruno          # Windows
```

**2. Start the API:**

```bash
npm ci && npm run build
SERVER_PEPPER="$(head -c 48 /dev/urandom | base64)" npm run dev
```

**3. Open the collection** — in Bruno, **Collection → Open Collection**, and pick the `bruno/`
folder in this repo.

**4. Pick the environment** — top-right dropdown → **Local**. It sets `baseUrl` to
`http://localhost:3000` and holds the test IMEIs.

**5. Hit Run** on any request. Start with `Health / healthz`, then `Free tier / Validate — known
device`.

### What's in it

| Folder | Requests |
|---|---|
| **Health** | `healthz`, `readyz` |
| **Free tier** | validate a known device · an unknown TAC · a checksum failure · dual-SIM clipboard text · wrong length · TAC lookup · TAC not found |
| **Meta** | attributions, OpenAPI document |

Every request carries assertions, so the collection doubles as an executable check of the rules
this service must never break — an unknown TAC is `inconclusive` and never `pass`; no response
contains the full 15-digit number; every section carries `coverage` and `checked_at`; `/readyz`
never depends on a provider.

### Run the whole collection from the terminal

No GUI needed, and it works in CI:

```bash
npm run api:test
```

```
Requests   11 (11 Passed)
Tests      14/14
Assertions 26/26
```

### Notes

- **Test IMEIs live only in `bruno/environments/Local.bru`**, referenced as `{{validImei}}` and so
  on. That is deliberate: `apps/api/test/sentinel.test.ts` sweeps the whole repo for 15-digit
  numbers, and that one file is allowlisted with its contents pinned.
- All the numbers are synthetic — Luhn-valid, allocated to no real handset.
- Nothing here needs an API key yet. The free tier takes none, and paid capabilities land in M1.
- Prefer curl or an OpenAPI-aware client? `/openapi.json` serves the generated document and
  `/docs` serves a browsable UI.

## Development

```bash
npm run typecheck        # tsc --build + the test project
npm test                 # everything
npm run test:sentinel    # the IMEI leak sweep on its own
npm run boundaries       # module graph
npm run schema:emit      # regenerate packages/contract/snapshots/v1.0.json
npm run schema:diff      # classify the delta as additive or breaking
```

`SERVER_PEPPER` must be at least 32 bytes or the process refuses to boot, and says why. The IMEI
space is ~10^14 and enumerable in seconds, so a short pepper pseudonymises nothing.
