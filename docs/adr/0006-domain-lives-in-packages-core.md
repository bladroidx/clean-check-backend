# 0006 — The domain lives in `packages/core`, not in `apps/api`

**Status:** Accepted · 2026-09-13
**Applies to:** `packages/core`, `apps/api`, `apps/worker`, `.dependency-cruiser.cjs`
**Supersedes:** the layout sketch in the design note, which listed only
`contract ← identity ← providers ← apps`

## Context

The original layout put the repositories, the field cache, the charge matrix and `assemble.ts`
inside `apps/api`. That was correct while there was one process.

`apps/worker` broke it. The worker has to settle a standard supplier order that arrives hours
later, and settling one means doing exactly what the API does: build a `SectionResult` from a
provider outcome, apply the charge matrix, write the section, refund what the matrix says is not
chargeable. All of that lived in `apps/api`.

Two bad options presented themselves:

- **`apps/worker` imports `apps/api`.** It compiles. It also makes the API unshippable without the
  worker, couples two processes with deliberately different failure modes, and violates the rule
  in `CLAUDE.md` that nothing depends on `apps/`.
- **Duplicate the logic.** The charge matrix in two files is the charge matrix diverging in two
  files. The day one of them stops refunding an abandoned order, the other still does, and the
  discrepancy shows up as an accounting drift nobody can reconstruct.

## Decision

Extract the domain into **`packages/core`**: repositories (the interfaces, the Postgres
implementation and the in-memory one), the field cache and its TTL table, the charge matrix,
metrics, coverage metadata, and `report/assemble.ts`.

The direction is now:

```
contract ← identity ← providers ← core ← apps/api
                                       ← apps/worker
```

`apps/*` keep only what is genuinely composition: HTTP routing, auth, rate limiting, the
enumeration guard, provider construction from config, the orchestrator, and the two process
entrypoints.

Two dependency-cruiser rules make this load-bearing rather than aspirational:

- `apps-do-not-depend-on-apps` — an app may not import a *different* app.
- `core-is-below-apps` — `packages/core` may not reach back up into a composition.

## Alternatives rejected

**Leave it in `apps/api` and let the worker import it.** Rejected above: it inverts the graph and
makes `assemble.ts` untestable without booting a server.

**Put the domain in `packages/providers`.** Rejected: `providers` is about speaking to suppliers
and knows nothing about tenants, credits or caching. Folding the ledger into it would mean a
provider adapter could, in principle, charge someone.

**A third app that both import.** Rejected as the same problem wearing a different name.

## Consequences

- `assemble.ts` is now reachable from both processes and has exactly one definition, which is what
  ADR-0002's "conversion happens in exactly one file" actually requires once there are two
  processes.
- `packages/core` depends on `pg` and `prom-client`, so it is not dependency-free the way
  `contract` is. That is fine and deliberate: `contract` is the thing every consumer and the
  published schema are generated from, and it keeps its zero-dependency rule. `core` is our own
  domain and may have infrastructure.
- The in-memory repository implementation moved with it, which is what lets the ledger concurrency
  cases and the charge matrix be tested in the unit lane with no database at all.
- `packages/core/src/db/pg.ts` is excluded from coverage thresholds: it is exercised by the
  integration lane, and counting it in the unit lane would either lower the bar for everything
  else or force a Postgres container into every `npm test`.

## Enforcement

- `npm run boundaries` fails on either new rule.
- `apps/worker` declares no dependency on `@imei-check/api`; its `package.json` and `tsconfig.json`
  reference `packages/core` only.
