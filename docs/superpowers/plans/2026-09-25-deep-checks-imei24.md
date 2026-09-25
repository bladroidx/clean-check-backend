# Free /v1/checks, paid /v1/deep_checks on imei24, encrypted IMEI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split checks into a free offline `/v1/checks` and a paid `/v1/deep_checks` answered by
pro.imei24.com over DHRU, and store every check's IMEI encrypted with an audited admin reveal.

**Architecture:** One orchestrator (`runCheck`) gains `tier: 'free' | 'deep'`; the free call site
is never handed a router. imei24 is a `DhruLegacyProvider` wrapped by two decorators in
`packages/core` (a cross-process advisory lock and a daily spend cap). Order polling moves into
`packages/core` so the API's 10 s wait window and the worker share one implementation. IMEI
encryption is one module in `packages/core/src/crypto`.

**Tech Stack:** Node ≥ 20, TypeScript, Fastify 5, zod, vitest, Postgres (dbmate migrations),
`node:crypto` AES-256-GCM.

**Spec:** `docs/superpowers/specs/2026-09-25-deep-checks-imei24-design.md` and
`docs/adr/0007-encrypted-imei-at-rest.md`. Read both before starting any task.

## Global Constraints

- Four-arm contract (CLAUDE.md): every section is `pass|fail|inconclusive|unavailable`; HTTP 200 whenever well-formed and authorised; `inconclusive` always carries a `remedy`.
- A section may only be `pass` on a positive lexicon match. imei24 lexicons ship with **no known-good phrases**.
- Never fail over after a definite negative answer (router rule, unchanged).
- Raw IMEI never in a log, metric, error message, response (except the reveal response), plaintext column, or any repo file. **Never write the sentinel IMEI digits into docs or source**; tests import `SENTINEL` from `apps/api/test/helpers.ts`.
- `provider_calls` row is written BEFORE the HTTP call (router `onCallStart`, unchanged).
- Nothing depends on `apps/`; shared code goes in `packages/core` (ADR-0006, `npm run boundaries`).
- `IMEI24_BASE_URL` default `https://pro.imei24.com`, must be `https:`.
- `DEEP_CHECK_WAIT_MS` default `10000`, max `12000`.
- `IMEI24_DAILY_SPEND_USD` default `10`.
- Default deep capabilities: `['blacklist.gsma']`.
- Scopes: `checks:write` (all check routes), `imei:reveal` (reveal route only). A key holding both is refused.
- `IMEI_ENCRYPTION_KEYS` = `"<version>:<base64 32 bytes>[,...]"`; required when `DATABASE_URL` is set; current = highest version.
- New `Reason` arms: `requires_deep_check` (unavailable), `spend_cap_reached` (unavailable).
- Commit after every task with the attribution trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work on branch `deep-checks-imei24`.
- Gates at the end: `npm test`, `npm run typecheck`, `npm run boundaries`, `npm run lint`.

## Review Focus

1. **A Luhn-valid IMEI whose TAC is unknown** sent to `/v1/deep_checks` → blacklist still routes to #486 (`*`) and is answered; nothing crashes on a missing brand. (Task 5 test.)
2. **Two deep checks for the same IMEI within seconds** → one imei24 order; the second attaches to the open order. (Task 10 test.)
3. **imei24 answers "Your APIKEY is workign in other session"** (their spelling) → `unavailable(rate_limited_upstream)`, never parsed for fields. (Task 3 test.)
4. **`Warranty Date;null` / `Model;` lines** → absent, not a value and not a crash. (Task 2 test.)
5. **A check row created before the migration** (no `imei_encrypted`) → reveal returns 404 `imei_not_stored`, not 500. (Task 12 test.)

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/contract/src/enums.ts` | + `requires_deep_check`, `spend_cap_reached` |
| `packages/providers/src/types.ts` | + FailureReason `spend_cap_reached`; `poll(orderReference, service, signal)` |
| `packages/providers/src/normalise/extract.ts` | `;` separator |
| `packages/providers/src/dhru/legacy.ts` | lexicon by (provider, lexicon); poll uses given service; "other session" |
| `packages/providers/src/router.ts` | `plan()` groups capabilities into fewest services; `run({ service, capabilities })` |
| `packages/providers/src/normalise/imei24-lexicons.ts` | imei24 lexicons (known-bad only) |
| `packages/providers/catalogue/imei24.yaml` | service catalogue |
| delete `dhru/rest.ts`, `imei24.ts`, `alpha.yaml`, `beta.yaml` + their tests/fixtures | alpha/beta/guessed adapter removed |
| `packages/core/src/providers/build.ts` | `buildProviders()` moved from `apps/api` so the worker can use it |
| `packages/core/src/providers/guarded.ts` | `GuardedProvider`: advisory lock + spend cap decorator |
| `packages/core/src/db/*` | `ProviderLock`, `ImeiRevealRepo`, new columns, `openForImei`, `costSinceForProvider` |
| `packages/core/src/orders/settle.ts` | order polling/settling shared by API wait loop and worker |
| `packages/core/src/crypto/imei-cipher.ts` | AES-256-GCM keyring |
| `db/migrations/20260925000001_deep_checks_encrypted_imei.sql` | schema |
| `apps/api/src/orchestrator/run-check.ts` | `tier` |
| `apps/api/src/routes/checks.ts` | free `/v1/checks`, `/v1/capabilities` |
| `apps/api/src/routes/deep-checks.ts` | `/v1/deep_checks`, wait window, `GET /v1/deep_checks/:id` |
| `apps/api/src/routes/admin.ts` | reveal route |
| `apps/api/src/auth/plugin.ts` | `requireScope` |
| `scripts/seed-admin-key.mjs`, `scripts/imei-reveal.mjs` | operator tools |
| `docs/privacy.md`, `CLAUDE.md`, bruno | docs |

---

### Task 1: Contract reasons and failure mapping

**Files:**
- Modify: `packages/contract/src/enums.ts` (Reason enum, ~line 31)
- Modify: `packages/providers/src/types.ts` (`FailureReason`)
- Modify: `packages/core/src/report/assemble.ts` (`failureReason`, ~line 366)
- Test: `packages/core/test/assemble.test.ts`

**Interfaces:**
- Produces: `Reason` includes `'requires_deep_check' | 'spend_cap_reached'`; `FailureReason` includes `'spend_cap_reached'`; `assembleSection` maps `failed/spend_cap_reached` → `unavailable(spend_cap_reached)`.

- [ ] **Step 1: Write the failing test** — append to `packages/core/test/assemble.test.ts`:

```ts
describe('spend cap', () => {
  it('maps a spend-cap failure to unavailable(spend_cap_reached)', () => {
    const section = assembleSection({
      capability: 'blacklist.gsma',
      outcome: { kind: 'failed', reason: 'spend_cap_reached', detail: 'daily supplier spend cap reached' },
      coverage: { region_model: 'reporting_networks', regions: [], sources: [], notes: [] } as never,
      checkedAt: new Date('2026-09-25T00:00:00Z'),
    });
    expect(section.outcome).toBe('unavailable');
    expect(section.reason).toBe('spend_cap_reached');
  });
});
```

(Use the same coverage fixture the file already uses for other cases instead of the literal above if one exists — search the file for `coverage:`.)

- [ ] **Step 2: Run it** — `npx vitest run packages/core/test/assemble.test.ts` → FAIL (type error / wrong reason).

- [ ] **Step 3: Implement**
  - `enums.ts` Reason: add after `'not_implemented',`:
    ```ts
      'requires_deep_check',
      'spend_cap_reached',
    ```
  - `types.ts` FailureReason: add `| 'spend_cap_reached'`.
  - `assemble.ts` `failureReason`: add `'spend_cap_reached'` to the return union and a case:
    ```ts
        case 'spend_cap_reached':
          // Our own budget guard, not the supplier and not the caller. Distinct so it pages us.
          return 'spend_cap_reached';
    ```

- [ ] **Step 4: Run** `npx vitest run packages/core packages/contract` → PASS. Run `npm run schema:emit && npm run schema:diff` and confirm the diff reports only the two added enum values (additive).

- [ ] **Step 5: Commit** — `git add -A packages/contract packages/providers/src/types.ts packages/core && git commit -m "Add requires_deep_check and spend_cap_reached reasons"` (+ trailer).

---

### Task 2: `;`-separated pairs

**Files:**
- Modify: `packages/providers/src/normalise/extract.ts` (`extractPairs`)
- Test: `packages/providers/test/lexicon.test.ts`

- [ ] **Step 1: Failing test** — append:

```ts
import { extractPairs } from '../src/normalise/extract.js';

describe('extractPairs with imei24 semicolon lines', () => {
  it('splits Label;Value and keeps colons inside values', () => {
    const pairs = extractPairs('Mark;Alcatel \nModel;Idol3-4.7\nProduction Date;2015-09-21\nPurchase Date: 2023-01-04 10:33');
    expect(pairs).toEqual([
      { label: 'Mark', value: 'Alcatel' },
      { label: 'Model', value: 'Idol3-4.7' },
      { label: 'Production Date', value: '2015-09-21' },
      { label: 'Purchase Date', value: '2023-01-04 10:33' },
    ]);
  });

  it('drops empty values and keeps literal null for the lexicon to treat as absent', () => {
    expect(extractPairs('Model;\nWarranty Date;null')).toEqual([{ label: 'Warranty Date', value: 'null' }]);
  });

  it('scrubs an echoed IMEI line', () => {
    const [pair] = extractPairs(`IMEI;${'8'.repeat(15)}`);
    expect(pair?.value).toBe('[REDACTED-IMEI]');
  });
});
```

- [ ] **Step 2: Run** `npx vitest run packages/providers/test/lexicon.test.ts` → FAIL.

- [ ] **Step 3: Implement** — in `extractPairs`, replace the colon lookup:

```ts
    // Earliest of ':' or ';'. DHRU sellers use "Label: Value"; imei24 uses "Label;Value".
    // Earliest, not either: "Purchase Date: 2023-01-04 10:33" must not split on a later one.
    const colon = trimmed.indexOf(':');
    const semi = trimmed.indexOf(';');
    const split = colon === -1 ? semi : semi === -1 ? colon : Math.min(colon, semi);
    if (split <= 0 || split === trimmed.length - 1) continue;

    const label = trimmed.slice(0, split).trim();
    const value = trimmed.slice(split + 1).trim();
```

Update the doc comment above the function to mention `;`.

- [ ] **Step 4: Run** `npx vitest run packages/providers` → PASS (existing DHRU fixtures must still pass).

- [ ] **Step 5: Commit** — "Parse imei24 Label;Value lines".

---

### Task 3: DHRU adapter fixes and removal of alpha/beta/guessed adapter

**Files:**
- Modify: `packages/providers/src/types.ts` (`Provider.poll` signature)
- Modify: `packages/providers/src/dhru/legacy.ts`
- Modify: `packages/providers/src/dhru/transport.ts` (`classifyBusy`)
- Modify: `packages/providers/src/normalise/lexicon.ts` (`Lexicon` gets `lexiconId`)
- Modify: `packages/providers/src/normalise/lexicons.ts`
- Modify: `packages/providers/src/index.ts`
- Delete: `packages/providers/src/dhru/rest.ts`, `packages/providers/src/imei24.ts`, `packages/providers/test/imei24.test.ts`, `packages/providers/test/webhook.test.ts` (REST-only), `packages/providers/test/fixtures/dhru/rest-*.json`, `packages/providers/catalogue/alpha.yaml`, `packages/providers/catalogue/beta.yaml`
- Modify: `packages/providers/test/dhru-fixtures.test.ts` (drop REST cases; provider id `imei24`)
- Test: `packages/providers/test/dhru-fixtures.test.ts`

**Interfaces:**
- Produces: `Provider.poll?(orderReference: string, service: CatalogueService, signal: AbortSignal): Promise<ProviderOutcome>`.
- Produces: `Lexicon` = `{ providerId: string; lexiconId: string; entries: FieldLexicon[] }`. `LexiconMiss.serviceId` keeps carrying the lexicon id (metric label stays `service_id`).
- Produces: legacy adapter finds the lexicon by `l.providerId === this.id && l.lexiconId === service.lexiconId`.
- Produces: `classifyBusy(message: string): boolean` in transport.ts.

- [ ] **Step 1: Failing tests** — in `dhru-fixtures.test.ts`, set `providerId: 'imei24'` on the test services, construct the provider with `providerId: 'imei24'` and lexicons re-keyed to `providerId: 'imei24'` (see Step 3 — the existing `DHRU_BLACKLIST`/`DHRU_APPLE` keep `providerId: 'dhru'`, so the test builds `{ ...DHRU_BLACKLIST, providerId: 'imei24', lexiconId: 'blacklist' }`). Add:

```ts
it('uses the ORDER service lexicon when polling, not services[0]', async () => {
  const provider = new DhruLegacyProvider({
    providerId: 'imei24', baseUrl: 'https://x.test', username: 'u', apiAccessKey: 'k',
    services: [blacklistService, appleService],
    lexicons: [
      { ...DHRU_BLACKLIST, providerId: 'imei24', lexiconId: 'blacklist' },
      { ...DHRU_APPLE, providerId: 'imei24', lexiconId: 'apple-basic' },
    ],
  });
  const outcome = provider.interpret(fixture('legacy-apple-locked.json'), appleService);
  expect(outcome.kind).toBe('answered');
  if (outcome.kind !== 'answered') throw new Error('unreachable');
  expect(outcome.fields.some((f) => f.field === 'lock.activation.status')).toBe(true);
});

it('refuses a lexicon registered for a different provider', () => {
  const provider = new DhruLegacyProvider({
    providerId: 'imei24', baseUrl: 'https://x.test', username: 'u', apiAccessKey: 'k',
    services: [blacklistService],
    lexicons: [{ ...DHRU_BLACKLIST, providerId: 'someone-else', lexiconId: 'blacklist' }],
  });
  const outcome = provider.interpret(fixture('legacy-blacklist-clean.json'), blacklistService);
  expect(outcome).toMatchObject({ kind: 'failed', reason: 'malformed_response' });
});

it('maps the one-job-at-a-time refusal to rate_limited, never to fields', () => {
  const provider = /* same construction as the first test */ makeProvider();
  const body = JSON.stringify({ ERROR: [{ MESSAGE: 'Your APIKEY is workign in other session. You can start again later' }] });
  expect(provider.interpret(body, blacklistService)).toMatchObject({ kind: 'failed', reason: 'rate_limited' });
  const flat = JSON.stringify({ STATUS: 'error', MESSAGE: 'Your APIKEY is working in other session' });
  expect(provider.interpret(flat, blacklistService)).toMatchObject({ kind: 'failed', reason: 'rate_limited' });
});
```

Extract a local `makeProvider()` helper in the test file for the repeated construction.

- [ ] **Step 2: Run** `npx vitest run packages/providers` → FAIL.

- [ ] **Step 3: Implement**
  - `lexicon.ts` `Lexicon`: rename `serviceId` → `lexiconId`; in `normalise`, `serviceId: lexicon.lexiconId`.
  - `lexicons.ts`: rename the `serviceId:` keys to `lexiconId:`; `lexiconFor(providerId, lexiconId)` filters on both.
  - `transport.ts`:
    ```ts
    /** imei24 runs one job per API key; a second concurrent call is refused with this text. */
    export function classifyBusy(message: string): boolean {
      return /work(i|)g?n?\s+in\s+other\s+session|other\s+session/i.test(message);
    }
    ```
    (The regex must match both `workign` and `working`; the test pins both.)
  - `legacy.ts` `interpret`:
    - in the `ERROR` branch, before `classifyRejection`:
      ```ts
      if (classifyBusy(message)) return { kind: 'failed', reason: 'rate_limited', detail: 'supplier is busy with another job' };
      ```
    - imei24's instant-style body is flat (`{"STATUS":"error","MESSAGE":...}`), not wrapped. After `parseEnvelope`, add:
      ```ts
      const flat = envelope as Record<string, unknown>;
      if (String(flat['STATUS'] ?? '').toLowerCase() === 'error') {
        const message = scrub(String(flat['MESSAGE'] ?? 'provider error'));
        if (classifyBusy(message)) return { kind: 'failed', reason: 'rate_limited', detail: 'supplier is busy with another job' };
        const rejection = classifyRejection(message);
        return rejection !== undefined
          ? { kind: 'rejected', reason: rejection, detail: message }
          : { kind: 'failed', reason: 'http_error', detail: message };
      }
      ```
    - lexicon lookup: `this.config.lexicons.find((l) => l.providerId === this.id && l.lexiconId === service.lexiconId)`.
    - `poll(orderReference: string, service: CatalogueService, signal: AbortSignal)`: delete the `services[0]` lookup; use `service`.
  - `types.ts`: change the `poll?` signature as in Interfaces.
  - `index.ts`: remove `export * from './dhru/rest.js';` and `export * from './imei24.js';`.
  - Delete the files listed above. Fix every compile error that follows from the removal (`npm run typecheck` lists them); in `apps/api/src/providers/build.ts` delete the alpha/beta/imei24 blocks for now (Task 6 rewrites this file).

- [ ] **Step 4: Run** `npx vitest run packages/providers && npm run typecheck` → PASS. `apps/worker` poll call will fail typecheck until Task 8 — if so, temporarily pass the service by looking it up: `provider.catalogue().find((s) => s.serviceId === order.serviceId)`, abandoning the order when not found. (Task 8 replaces this file anyway.)

- [ ] **Step 5: Commit** — "Remove alpha/beta and the guessed imei24 adapter; fix poll lexicon and busy handling".

---

### Task 4: imei24 catalogue and lexicons

**Files:**
- Create: `packages/providers/catalogue/imei24.yaml`
- Create: `packages/providers/src/normalise/imei24-lexicons.ts`
- Modify: `packages/providers/src/normalise/lexicons.ts` (`BUILTIN_LEXICONS` includes imei24 ones)
- Create: `packages/providers/test/fixtures/imei24/` (doc-derived, see Step 1)
- Test: `packages/providers/test/imei24-catalogue.test.ts`

**Interfaces:**
- Produces: lexicons with `providerId: 'imei24'` and `lexiconId` ∈ `imei24-blacklist | imei24-apple | imei24-samsung | imei24-mdm | imei24-warranty`.
- Produces: catalogue services (`provider_id: imei24`) with IDs `486, 690, 783, 487, 678, 428, 437, 429, 467, 485, 707, 709, 488`.

- [ ] **Step 1: Failing test + fixtures**

Fixtures (doc-derived, labelled as such in a `README.md` in the folder — **"derived from pro.imei24.com API docs 2026-09-25, NOT recorded responses; replace when real ones are recorded"**):

`instant-model.json`:
```json
{"SUCCESS":[{"STATUS":"Available","RESULT":"IMEI;[REDACTED-IMEI]\nProvider ID;6039Y-2ACFMK7\nMark;Alcatel \nModel;Idol3-4.7\nProduction Date;2015-09-21\nWarranty Date;null\nColor;DARK GRAY\n"}]}
```
`blacklist-clean-wording.json`:
```json
{"SUCCESS":[{"STATUS":"Available","RESULT":"Model;iPhone 13\nBlacklist Status;Clean\n"}]}
```
`blacklist-blacklisted.json`:
```json
{"SUCCESS":[{"STATUS":"Available","RESULT":"Model;iPhone 13\nBlacklist Status;Blacklisted\n"}]}
```
`busy.json`:
```json
{"STATUS":"error","MESSAGE":"Your APIKEY is workign in other session. You can start again later"}
```
`not-found.json`:
```json
{"STATUS":"error","IMEI":"[REDACTED-IMEI]","REFID":71970,"MESSAGE":"info not found, try later"}
```

`packages/providers/test/imei24-catalogue.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCatalogueFile } from '../src/catalogue.js';
import { DhruLegacyProvider } from '../src/dhru/legacy.js';
import { BUILTIN_LEXICONS } from '../src/normalise/lexicons.js';

const CATALOGUE = join(import.meta.dirname, '..', 'catalogue', 'imei24.yaml');
const FIX = join(import.meta.dirname, 'fixtures', 'imei24');
const services = loadCatalogueFile(CATALOGUE);
const provider = new DhruLegacyProvider({
  providerId: 'imei24', baseUrl: 'https://pro.imei24.com', username: 'u', apiAccessKey: 'k',
  services, lexicons: BUILTIN_LEXICONS,
});
const svc = (id: string) => {
  const s = services.find((x) => x.serviceId === id);
  if (s === undefined) throw new Error(`no service ${id}`);
  return s;
};
const body = (name: string) => readFileSync(join(FIX, name), 'utf8');

describe('imei24 catalogue', () => {
  it('loads, every service is imei24, credits are 0, every lexicon exists', () => {
    expect(services.length).toBeGreaterThanOrEqual(13);
    for (const s of services) {
      expect(s.providerId).toBe('imei24');
      expect(s.credits).toBe(0);
      expect(BUILTIN_LEXICONS.some((l) => l.providerId === 'imei24' && l.lexiconId === s.lexiconId)).toBe(true);
    }
  });

  it('486 is the only wildcard blacklist service', () => {
    const wild = services.filter((s) => s.appliesToTacPrefixes.includes('*'));
    expect(wild.map((s) => s.serviceId)).toEqual(['486']);
  });
});

describe('imei24 lexicons ship with no known-good phrases', () => {
  it('a "Clean" blacklist answer is a MISS, not a pass', () => {
    const outcome = provider.interpret(body('blacklist-clean-wording.json'), svc('486'));
    expect(outcome.kind).toBe('answered');
    if (outcome.kind !== 'answered') throw new Error('unreachable');
    expect(outcome.fields.find((f) => f.field === 'blacklist.status')).toBeUndefined();
    expect(outcome.misses.map((m) => m.field)).toContain('blacklist.status');
  });

  it('"Blacklisted" is a known-bad value', () => {
    const outcome = provider.interpret(body('blacklist-blacklisted.json'), svc('486'));
    if (outcome.kind !== 'answered') throw new Error('unexpected ' + outcome.kind);
    expect(outcome.fields).toContainEqual(expect.objectContaining({ field: 'blacklist.status', value: 'blocked' }));
  });

  it('busy and not-found bodies', () => {
    expect(provider.interpret(body('busy.json'), svc('486'))).toMatchObject({ kind: 'failed', reason: 'rate_limited' });
    expect(provider.interpret(body('not-found.json'), svc('486'))).toMatchObject({ kind: 'rejected', reason: 'device_not_found' });
  });

  it('literal null warranty date is absent, model is text', () => {
    const outcome = provider.interpret(body('instant-model.json'), svc('428'));
    if (outcome.kind !== 'answered') throw new Error('unexpected ' + outcome.kind);
    expect(outcome.fields.some((f) => f.field === 'warranty.purchase_date')).toBe(false);
    expect(outcome.misses).toEqual([]);
  });
});
```

- [ ] **Step 2: Run** → FAIL (no catalogue).

- [ ] **Step 3: Implement**

`packages/providers/src/normalise/imei24-lexicons.ts`:
```ts
import type { Lexicon } from './lexicon.js';

/**
 * imei24 lexicons.
 *
 * KNOWN-BAD phrases only, taken from imei24's service names and API docs. There is deliberately
 * no known-good phrase anywhere in this file: none has been observed in a recorded response yet,
 * and a guessed "Clean" is the exact failure the parsing rule exists to prevent. Until fixtures
 * are recorded (spec §8), every good-looking answer is a miss -> inconclusive, which is safe.
 */

const BLACKLIST = {
  field: 'blacklist.status',
  labels: ['Blacklist Status', 'Blacklist', 'GSMA Status', 'Blacklist status', 'Lost/Stolen', 'Status'],
  values: [
    { match: 'blacklisted', value: 'blocked' },
    { match: 'lost', value: 'blocked' },
    { match: 'stolen', value: 'blocked' },
    { match: 'lost stolen', value: 'blocked' },
    { match: 'barred', value: 'blocked' },
  ],
} as const;

const IDENTITY = [
  { field: 'identity.manufacturer', labels: ['Mark', 'Brand', 'Manufacturer'] },
  { field: 'identity.model', labels: ['Model', 'Model Description', 'Device'] },
] as const;

const PURCHASE = {
  field: 'warranty.purchase_date',
  labels: ['Purchase Date', 'Estimated Purchase Date', 'Warranty Date', 'Warranty Start Date'],
} as const;

export const IMEI24_LEXICONS: readonly Lexicon[] = [
  { providerId: 'imei24', lexiconId: 'imei24-blacklist', entries: [BLACKLIST, ...IDENTITY] },
  {
    providerId: 'imei24',
    lexiconId: 'imei24-apple',
    entries: [
      BLACKLIST,
      {
        field: 'lock.activation.status',
        labels: ['Find My iPhone', 'FMI', 'FMI Status', 'iCloud Status', 'iCloud Lock'],
        values: [{ match: 'on', value: 'on' }, { match: 'enabled', value: 'on' }],
      },
      {
        field: 'lock.carrier.status',
        labels: ['SIM Lock', 'Simlock', 'SIM Lock Status', 'Carrier Lock'],
        values: [{ match: 'locked', value: 'locked' }],
      },
      { field: 'lock.carrier.network', labels: ['Carrier', 'Initial Carrier', 'Network'] },
      PURCHASE,
      ...IDENTITY,
    ],
  },
  {
    providerId: 'imei24',
    lexiconId: 'imei24-samsung',
    entries: [
      BLACKLIST,
      {
        field: 'lock.carrier.status',
        labels: ['SIM Lock', 'Simlock', 'Carrier Lock', 'Network Lock'],
        values: [{ match: 'locked', value: 'locked' }],
      },
      { field: 'lock.carrier.network', labels: ['Carrier', 'Sold By', 'Network'] },
      PURCHASE,
      ...IDENTITY,
    ],
  },
  {
    providerId: 'imei24',
    lexiconId: 'imei24-mdm',
    entries: [
      {
        field: 'lock.mdm.status',
        labels: ['MDM', 'MDM Status', 'MDM Lock'],
        values: [{ match: 'on', value: 'on' }, { match: 'enrolled', value: 'on' }],
      },
      ...IDENTITY,
    ],
  },
  { providerId: 'imei24', lexiconId: 'imei24-warranty', entries: [PURCHASE, ...IDENTITY] },
];
```
If `FieldLexicon.field` is typed as `CanonicalField`, the `as const` literals satisfy it; if TypeScript complains about readonly arrays, type the constants explicitly as `FieldLexicon`.

`lexicons.ts`: `import { IMEI24_LEXICONS } from './imei24-lexicons.js';` and `export const BUILTIN_LEXICONS: readonly Lexicon[] = [DHRU_BLACKLIST, DHRU_APPLE, ...IMEI24_LEXICONS];`. Export `imei24-lexicons.js` from `index.ts`.

`packages/providers/catalogue/imei24.yaml` — header comment as in `alpha.yaml` (service IDs are the only routing key; prices from the 2026-09-25 price list; 1 credit = 1 USD; `credits: 0` because billing is removed). Brand TAC prefixes: **leave as a short, clearly-commented starter list** and generate the full list in Task 6 from the TAC directory. Services:

```yaml
provider_id: imei24
services:
  - service_id: "486"
    display_name: "Global Blacklist checker"
    capabilities: [blacklist.gsma]
    fields: [blacklist.status, identity.manufacturer, identity.model]
    lexicon: imei24-blacklist
    cost_usd: 0.10
    credits: 0
    async: true
    timeout_ms: 8000
    applies_to_tac_prefixes: ["*"]
    enabled: true
  - service_id: "690"
    display_name: "Apple check warranty|FMI status| Blacklist status | Carrier and Simlock"
    capabilities: [blacklist.gsma, lock.activation, lock.carrier, warranty.purchase_date]
    fields: [blacklist.status, lock.activation.status, lock.carrier.status, lock.carrier.network, warranty.purchase_date, identity.manufacturer, identity.model]
    lexicon: imei24-apple
    cost_usd: 0.12
    credits: 0
    async: true
    timeout_ms: 8000
    applies_to_tac_prefixes: {APPLE}
    enabled: true
  - service_id: "678"
    display_name: "Apple check MDM status ON/OFF (Instant)"
    capabilities: [lock.mdm]
    fields: [lock.mdm.status, identity.model]
    lexicon: imei24-mdm
    cost_usd: 1.50
    credits: 0
    async: true
    timeout_ms: 8000
    applies_to_tac_prefixes: {APPLE}
    enabled: true
  - service_id: "783"
    display_name: "Samsung Worldwide warranty and blacklist check"
    capabilities: [blacklist.gsma, warranty.purchase_date]
    fields: [blacklist.status, warranty.purchase_date, identity.manufacturer, identity.model]
    lexicon: imei24-samsung
    cost_usd: 0.10
    credits: 0
    async: true
    timeout_ms: 8000
    applies_to_tac_prefixes: {SAMSUNG}
    enabled: true
  - service_id: "487"
    display_name: "Samsung Worldwide warranty and carrier check - v1"
    capabilities: [lock.carrier, warranty.purchase_date]
    fields: [lock.carrier.status, lock.carrier.network, warranty.purchase_date, identity.model]
    lexicon: imei24-samsung
    cost_usd: 0.10
    credits: 0
    async: true
    timeout_ms: 8000
    applies_to_tac_prefixes: {SAMSUNG}
    enabled: true
  # Per-brand warranty, all 0.10, lexicon imei24-warranty, capabilities [warranty.purchase_date],
  # fields [warranty.purchase_date, identity.model]:
  #   428 Motorola, 437 Huawei, 429 LG, 467 Sony, 485 Lenovo, 707 Oppo, 709 Vivo, 488 HTC
```
Write the eight per-brand entries out in full (same shape as 487 with their own ids, display names from the price list, and `{BRAND}` prefix placeholders). `{APPLE}`, `{SAMSUNG}`, `{BRAND}` are replaced in Task 6 — in this task use `["35310411"]` for Apple and `["35847191"]` for Samsung (the test directory TACs) and `["00000000"]` for the other brands so the file parses. Mark each with `# prefixes generated in Task 6`.

- [ ] **Step 4: Run** `npx vitest run packages/providers` → PASS.

- [ ] **Step 5: Commit** — "Add imei24 catalogue and known-bad-only lexicons".

---

### Task 5: Router — fewest services for a capability set

**Files:**
- Modify: `packages/providers/src/router.ts`
- Test: `packages/providers/test/router.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PlannedCall { readonly capabilities: readonly Capability[]; readonly candidates: ReadonlyArray<{ provider: Provider; service: CatalogueService }> }
  Router.plan(capabilities: readonly Capability[], tac: string): { calls: PlannedCall[]; uncovered: Capability[] }
  Router.runCall(args: { call: PlannedCall; imeiDigits: string; signal: AbortSignal }): Promise<RouteResult & { capabilities: readonly Capability[] }>
  ```
  `candidates(capability, tac)` stays (used by `/v1/capabilities`), now sorted brand-specific first, then cost.
  `run({ capability, ... })` stays as a thin wrapper: `plan([capability])` then `runCall`.

- [ ] **Step 1: Failing tests** — append to `router.test.ts` (reuse its existing fake-provider helper; build a provider whose `catalogue()` returns the services below and whose `supports` uses `coversTac`):

```ts
const wild = svc({ serviceId: '486', capabilities: ['blacklist.gsma'], appliesToTacPrefixes: ['*'], costUsd: 0.1 });
const apple = svc({ serviceId: '690', capabilities: ['blacklist.gsma', 'lock.activation', 'lock.carrier', 'warranty.purchase_date'], appliesToTacPrefixes: ['353104'], costUsd: 0.12 });

it('one Apple service covers four capabilities in ONE call', () => {
  const router = routerWith([wild, apple]);
  const { calls, uncovered } = router.plan(['blacklist.gsma', 'lock.activation', 'lock.carrier', 'warranty.purchase_date'], '35310411');
  expect(calls).toHaveLength(1);
  expect(calls[0]?.candidates[0]?.service.serviceId).toBe('690');
  expect(uncovered).toEqual([]);
});

it('brand-specific beats cheaper wildcard for the same capability', () => {
  const router = routerWith([wild, { ...apple, costUsd: 0.5 }]);
  const { calls } = router.plan(['blacklist.gsma'], '35310411');
  expect(calls[0]?.candidates.map((c) => c.service.serviceId)).toEqual(['690', '486']);
});

it('an unknown TAC falls back to the wildcard and reports the rest as uncovered', () => {
  const router = routerWith([wild, apple]);
  const { calls, uncovered } = router.plan(['blacklist.gsma', 'lock.activation'], '99999999');
  expect(calls.map((c) => c.candidates[0]?.service.serviceId)).toEqual(['486']);
  expect(uncovered).toEqual(['lock.activation']);
});

it('runCall executes once for a multi-capability service', async () => {
  const provider = fakeProvider([wild, apple], { kind: 'answered', fields: [], misses: [] });
  const router = new Router({ providers: [provider], breakers: new BreakerRegistry() });
  const { calls } = router.plan(['blacklist.gsma', 'lock.activation'], '35310411');
  await router.runCall({ call: calls[0]!, imeiDigits: 'x', signal: AbortSignal.timeout(1000) });
  expect(provider.executed).toHaveLength(1);
});
```
(Name the helpers after whatever `router.test.ts` already has; add `svc`, `routerWith`, `fakeProvider` if missing.)

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** in `router.ts`:

```ts
import { coversTac } from './catalogue.js';

function specificity(service: CatalogueService): number {
  return service.appliesToTacPrefixes.includes('*') ? 0 : 1;
}

function ranked(a: { service: CatalogueService }, b: { service: CatalogueService }): number {
  return specificity(b.service) - specificity(a.service) || a.service.costUsd - b.service.costUsd;
}

// in class Router:
private servicesFor(tac: string): Array<{ provider: Provider; service: CatalogueService }> {
  const out: Array<{ provider: Provider; service: CatalogueService }> = [];
  for (const provider of this.options.providers) {
    for (const service of provider.catalogue()) {
      if (service.enabled && coversTac(service, tac)) out.push({ provider, service });
    }
  }
  return out;
}

candidates(capability: Capability, tac: string) {
  return this.servicesFor(tac).filter((c) => c.service.capabilities.includes(capability)).sort(ranked);
}

/**
 * Greedy set cover: repeatedly take the service that answers the most still-uncovered requested
 * capabilities (ties: brand-specific, then cheaper). One Apple all-in-one then costs one order,
 * not four -- imei24 charges again for every repeat.
 */
plan(capabilities: readonly Capability[], tac: string): { calls: PlannedCall[]; uncovered: Capability[] } {
  const pool = this.servicesFor(tac);
  let remaining = [...new Set(capabilities)];
  const calls: PlannedCall[] = [];
  while (remaining.length > 0) {
    const scored = pool
      .map((c) => ({ ...c, covers: remaining.filter((cap) => c.service.capabilities.includes(cap)) }))
      .filter((c) => c.covers.length > 0)
      .sort((a, b) => b.covers.length - a.covers.length || ranked(a, b));
    const best = scored[0];
    if (best === undefined) break;
    // Failover candidates: other services that cover the SAME set, ranked.
    const candidates = pool
      .filter((c) => best.covers.every((cap) => c.service.capabilities.includes(cap)))
      .sort(ranked);
    calls.push({ capabilities: best.covers, candidates });
    remaining = remaining.filter((cap) => !best.covers.includes(cap));
  }
  return { calls, uncovered: remaining };
}
```

Refactor the body of `run` into `runCall`: iterate `call.candidates` instead of `this.candidates(...)`; `onCallStart`'s `capability` gets `call.capabilities[0]`; the `Attempt.capability` likewise; `execute` receives `capability: call.capabilities[0]`. Return `{ capability: call.capabilities[0], capabilities: call.capabilities, attempts, outcome: last, service: lastService }`. When `call.candidates` is empty return the existing `no_provider_configured` outcome. `run({capability,...})` becomes:
```ts
const { calls } = this.plan([args.capability], args.tac);
const call = calls[0] ?? { capabilities: [args.capability], candidates: [] };
return this.runCall({ call, imeiDigits: args.imeiDigits, signal: args.signal });
```
Keep the "THE RULE" comment and `if (outcome.kind !== 'failed') break;` unchanged.

- [ ] **Step 4: Run** `npx vitest run packages/providers apps/api` → PASS (existing router tests, including "does not fail over after a fail outcome", must still pass).

- [ ] **Step 5: Commit** — "Route a capability set to the fewest services".

---

### Task 6: Provider construction in core, config, TAC-generated brand prefixes

**Files:**
- Create: `packages/core/src/providers/build.ts`
- Delete: `apps/api/src/providers/build.ts` (move `feedbackUrlFor` into `apps/api/src/config.ts` or keep a tiny `apps/api/src/providers/feedback-url.ts`)
- Modify: `apps/api/src/config.ts`, `apps/api/src/server.ts`, `packages/core/src/index.ts`
- Modify: `packages/providers/catalogue/imei24.yaml` (real brand prefixes)
- Create: `scripts/imei24-brand-prefixes.mjs`
- Test: `packages/core/test/build-providers.test.ts`, `apps/api/test/config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Imei24Credentials { readonly baseUrl: string; readonly username: string; readonly apiKey: string }
  export function buildProviders(opts: { catalogueDir: string; imei24?: Imei24Credentials }): BuiltProviders
  // BuiltProviders = { providers: Provider[]; catalogue: CatalogueService[]; skipped: {providerId, reason}[] }
  ```
- Config adds: `IMEI24_USERNAME`, `IMEI24_API_KEY`, `IMEI24_BASE_URL` (default + https), `IMEI24_DAILY_SPEND_USD` (default 10), `DEEP_CHECK_WAIT_MS` (default 10000, max 12000), `IMEI_ENCRYPTION_KEYS` (optional here; enforced in Task 11). Removes `ALPHA_*`, `BETA_*`.
- Produces: `imei24CredentialsFrom(config): Imei24Credentials | undefined` in `apps/api/src/config.ts`.

- [ ] **Step 1: Failing tests**

`packages/core/test/build-providers.test.ts`:
```ts
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildProviders } from '../src/providers/build.js';

const DIR = join(import.meta.dirname, '..', '..', 'providers', 'catalogue');

describe('buildProviders', () => {
  it('skips imei24 by name when credentials are absent', () => {
    const built = buildProviders({ catalogueDir: DIR });
    expect(built.providers).toEqual([]);
    expect(built.skipped).toEqual([{ providerId: 'imei24', reason: 'IMEI24_USERNAME/IMEI24_API_KEY not set' }]);
  });
  it('builds imei24 as a DHRU provider when configured', () => {
    const built = buildProviders({ catalogueDir: DIR, imei24: { baseUrl: 'https://pro.imei24.com', username: 'ops@example.com', apiKey: 'k' } });
    expect(built.providers.map((p) => p.id)).toEqual(['imei24']);
    expect(built.catalogue.every((s) => s.providerId === 'imei24')).toBe(true);
  });
});
```

Append to `apps/api/test/config.test.ts` (follow its existing `loadConfig({...})` pattern and its valid-pepper constant):
```ts
it('rejects a non-https IMEI24_BASE_URL', () => {
  expect(() => loadConfig({ ...base, IMEI24_BASE_URL: 'http://pro.imei24.com' })).toThrow(/IMEI24_BASE_URL/);
});
it('rejects a wait window above 12 s', () => {
  expect(() => loadConfig({ ...base, DEEP_CHECK_WAIT_MS: '15000' })).toThrow(/DEEP_CHECK_WAIT_MS/);
});
it('defaults', () => {
  const c = loadConfig(base);
  expect(c.IMEI24_BASE_URL).toBe('https://pro.imei24.com');
  expect(c.DEEP_CHECK_WAIT_MS).toBe(10000);
  expect(c.IMEI24_DAILY_SPEND_USD).toBe(10);
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

`packages/core/src/providers/build.ts`:
```ts
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_LEXICONS, DhruLegacyProvider, loadCatalogueFile, type CatalogueService, type Provider } from '@imei-check/providers';

/**
 * Builds the provider set. Shared by the API and the worker (ADR-0006: nothing depends on apps/).
 *
 * A provider whose credentials are absent is NOT built -- and is named in `skipped` so /readyz
 * and the startup log say so. Zero providers is the supported free-only mode.
 */
export interface Imei24Credentials { readonly baseUrl: string; readonly username: string; readonly apiKey: string }
export interface BuiltProviders {
  readonly providers: Provider[];
  readonly catalogue: readonly CatalogueService[];
  readonly skipped: ReadonlyArray<{ providerId: string; reason: string }>;
}

export function buildProviders(opts: { catalogueDir: string; imei24?: Imei24Credentials }): BuiltProviders {
  const byProvider = loadCatalogues(opts.catalogueDir);
  const catalogue = [...byProvider.values()].flat();
  const providers: Provider[] = [];
  const skipped: Array<{ providerId: string; reason: string }> = [];

  const imei24 = byProvider.get('imei24') ?? [];
  if (opts.imei24 === undefined) {
    skipped.push({ providerId: 'imei24', reason: 'IMEI24_USERNAME/IMEI24_API_KEY not set' });
  } else if (imei24.length === 0) {
    skipped.push({ providerId: 'imei24', reason: 'no imei24 catalogue found' });
  } else {
    // imei24 documents DHRU compatibility: site address, account email as username, API key.
    providers.push(new DhruLegacyProvider({
      providerId: 'imei24',
      baseUrl: opts.imei24.baseUrl.replace(/\/+$/, ''),
      username: opts.imei24.username,
      apiAccessKey: opts.imei24.apiKey,
      services: imei24,
      lexicons: BUILTIN_LEXICONS,
    }));
  }
  return { providers, catalogue, skipped };
}

export function loadCatalogues(dir: string): Map<string, CatalogueService[]> { /* body moved verbatim from apps/api/src/providers/build.ts */ }
```
Export from `packages/core/src/index.ts`. Check `packages/core/package.json` has `@imei-check/providers` as a dependency (it already imports it; confirm).

`apps/api/src/config.ts`: remove `ALPHA_*`, `BETA_*`; replace the IMEI24 lines with:
```ts
  IMEI24_BASE_URL: z
    .string()
    .url()
    .refine((u) => u.startsWith('https://'), { message: 'must be https: the request body carries the API key and the IMEI' })
    .default('https://pro.imei24.com'),
  /** The imei24 account email (DHRU "username"). */
  IMEI24_USERNAME: z.string().optional(),
  IMEI24_API_KEY: z.string().optional(),
  /** Hard stop on supplier spend per UTC day, across API and worker. */
  IMEI24_DAILY_SPEND_USD: z.coerce.number().positive().default(10),
  /**
   * How long POST /v1/deep_checks waits for slow orders before handing off to polling. Must stay
   * below every caller's timeout: the Android app reads for 15 s and check-this-phone-backend
   * gives up after 20 s. A window longer than that means the phone times out while we still pay.
   */
  DEEP_CHECK_WAIT_MS: z.coerce.number().int().min(0).max(12_000).default(10_000),
  /** `version:base64key[,version:base64key]` -- ADR-0007. Enforced when DATABASE_URL is set. */
  IMEI_ENCRYPTION_KEYS: z.string().optional(),
```
and
```ts
export function imei24CredentialsFrom(config: Config): Imei24Credentials | undefined {
  if (!config.IMEI24_USERNAME || !config.IMEI24_API_KEY) return undefined;
  return { baseUrl: config.IMEI24_BASE_URL, username: config.IMEI24_USERNAME, apiKey: config.IMEI24_API_KEY };
}
```
`server.ts`: `const built = buildProviders({ catalogueDir: config.PROVIDER_CATALOGUE_DIR, ...(imei24CredentialsFrom(config) ? { imei24: imei24CredentialsFrom(config)! } : {}) });` (assign to a const first to avoid the non-null assertion). Keep the `skipped` warn loop.

`scripts/imei24-brand-prefixes.mjs`: reads `testdata/tac-seed.json` (the bundled TAC source; check `TAC_SOURCE_FILE` default in config for the path and its shape by opening it), groups TACs by manufacturer (case-insensitive: `apple`, `samsung`, `motorola`, `huawei`, `lg`, `sony`, `lenovo`, `oppo`, `vivo`, `htc`), and prints a YAML list of 8-digit TACs per brand. Replace the placeholder prefixes in `imei24.yaml` with its output. If a brand has zero TACs in the seed, set that service `enabled: false` with `disabled_reason: "no TACs for brand in bundled directory"`. Add `"imei24:prefixes": "node scripts/imei24-brand-prefixes.mjs"` to root `package.json`.

- [ ] **Step 4: Run** `npx vitest run packages/core apps/api/test/config.test.ts packages/providers && npm run typecheck && npm run boundaries` → PASS.

- [ ] **Step 5: Commit** — "Build imei24 from core; config for spend cap, wait window, https".

---

### Task 7: Lock and spend-cap decorator

**Files:**
- Modify: `packages/core/src/db/types.ts`, `memory.ts`, `pg.ts`
- Create: `packages/core/src/providers/guarded.ts`
- Test: `packages/core/test/guarded-provider.test.ts`

**Interfaces:**
- Produces (db/types.ts):
  ```ts
  export interface ProviderLock {
    /** Runs fn holding the named cross-process lock, or returns undefined if it could not be taken within waitMs. */
    withLock<T>(name: string, waitMs: number, fn: () => Promise<T>): Promise<{ acquired: true; value: T } | { acquired: false }>;
  }
  // Repositories gains: readonly locks: ProviderLock;
  // ProviderCallRepo gains: costSinceForProvider(providerId: string, since: Date): Promise<number>;
  ```
- Produces (guarded.ts):
  ```ts
  export interface GuardOptions { readonly lock: ProviderLock; readonly lockWaitMs: number; readonly dailySpendUsd: number; readonly costSince: (providerId: string, since: Date) => Promise<number>; readonly now?: () => Date }
  export class GuardedProvider implements Provider { constructor(inner: Provider, options: GuardOptions) }
  ```

- [ ] **Step 1: Failing test** `packages/core/test/guarded-provider.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { CatalogueService, ExecuteRequest, Provider, ProviderOutcome } from '@imei-check/providers';
import { MemoryRepositories } from '../src/db/memory.js';
import { GuardedProvider } from '../src/providers/guarded.js';

const service = { serviceId: '486', providerId: 'imei24', costUsd: 0.1 } as CatalogueService;
const req = (signal = AbortSignal.timeout(5000)) => ({ capability: 'blacklist.gsma', service, imeiDigits: 'x', signal, referenceId: 'r' }) as ExecuteRequest;

class Slow implements Provider {
  readonly id = 'imei24';
  active = 0; maxActive = 0; calls = 0;
  constructor(private readonly ms: number) {}
  catalogue() { return [service]; }
  supports() { return service; }
  async execute(): Promise<ProviderOutcome> {
    this.calls += 1; this.active += 1; this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise((r) => setTimeout(r, this.ms));
    this.active -= 1;
    return { kind: 'answered', fields: [], misses: [] };
  }
}

describe('GuardedProvider', () => {
  it('never runs two imei24 calls at once', async () => {
    const repos = new MemoryRepositories();
    const inner = new Slow(30);
    const p = new GuardedProvider(inner, { lock: repos.locks, lockWaitMs: 1000, dailySpendUsd: 10, costSince: async () => 0 });
    await Promise.all([p.execute(req()), p.execute(req()), p.execute(req())]);
    expect(inner.maxActive).toBe(1);
    expect(inner.calls).toBe(3);
  });

  it('gives up with rate_limited when the lock is not free within the wait', async () => {
    const repos = new MemoryRepositories();
    const inner = new Slow(200);
    const p = new GuardedProvider(inner, { lock: repos.locks, lockWaitMs: 20, dailySpendUsd: 10, costSince: async () => 0 });
    const [a, b] = await Promise.all([p.execute(req()), p.execute(req())]);
    expect([a.kind, b.kind].sort()).toEqual(['answered', 'failed']);
    expect([a, b].find((o) => o.kind === 'failed')).toMatchObject({ reason: 'rate_limited' });
  });

  it('refuses new orders once today spend exceeds the cap, and never calls the supplier', async () => {
    const repos = new MemoryRepositories();
    const inner = new Slow(1);
    const p = new GuardedProvider(inner, { lock: repos.locks, lockWaitMs: 100, dailySpendUsd: 10, costSince: async () => 10.05 });
    expect(await p.execute(req())).toMatchObject({ kind: 'failed', reason: 'spend_cap_reached' });
    expect(inner.calls).toBe(0);
  });

  it('polling is not blocked by the spend cap (it costs nothing)', async () => {
    /* inner with poll() returning answered; costSince 999; expect poll result answered */
  });
});
```
Write the last test out fully (give `Slow` a `poll` method).

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

Memory lock (`memory.ts`):
```ts
class MemoryProviderLock implements ProviderLock {
  private readonly tails = new Map<string, Promise<void>>();
  async withLock<T>(name: string, waitMs: number, fn: () => Promise<T>) {
    const previous = this.tails.get(name) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = previous.then(() => mine);
    this.tails.set(name, tail);
    let timer: NodeJS.Timeout | undefined;
    const acquired = await Promise.race([
      previous.then(() => true),
      new Promise<boolean>((r) => (timer = setTimeout(() => r(false), waitMs))),
    ]);
    clearTimeout(timer);
    if (!acquired) {
      // Hand our slot straight to whoever queued behind us once the holder finishes.
      void previous.then(release);
      return { acquired: false as const };
    }
    try {
      return { acquired: true as const, value: await fn() };
    } finally {
      release();
      if (this.tails.get(name) === tail) this.tails.delete(name);
    }
  }
}
```
Memory `costSinceForProvider`: sum `providerCostUsd` of rows with matching `providerId` and `startedAt >= since`.

Pg lock (`pg.ts`) — dedicated connection so the session-level lock is released on the same session:
```ts
class PgProviderLock implements ProviderLock {
  constructor(private readonly pool: pg.Pool) {}
  async withLock<T>(name: string, waitMs: number, fn: () => Promise<T>) {
    const client = await this.pool.connect();
    const deadline = Date.now() + waitMs;
    try {
      for (;;) {
        const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [name]);
        if (rows[0]?.ok === true) break;
        if (Date.now() >= deadline) return { acquired: false as const };
        await new Promise((r) => setTimeout(r, 100));
      }
      try {
        return { acquired: true as const, value: await fn() };
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [name]);
      }
    } finally {
      client.release();
    }
  }
}
```
Pg `costSinceForProvider`: `SELECT COALESCE(SUM(provider_cost_usd),0) AS total FROM provider_calls WHERE provider_id = $1 AND started_at >= $2`.
Add `locks` to both `Repositories` implementations.

`guarded.ts`:
```ts
import type { CatalogueService, ExecuteRequest, ParsedWebhook, Provider, ProviderOutcome, WebhookInput } from '@imei-check/providers';
import type { ProviderLock } from '../db/types.js';

/**
 * Wraps a supplier with the two guards imei24 needs and a router cannot express:
 *
 * 1. ONE call at a time per API key, across API and worker processes (imei24: "You can do ONE JOB
 *    in time"). Every call -- place, poll, balance -- holds the lock for one HTTP request only.
 * 2. A daily spend cap on NEW orders. imei24 charges again for every repeat, so a bug or a leaked
 *    service key would otherwise spend without limit. Polling is free and never capped.
 *
 * Both refusals are `failed`, never a field: nothing here can make a section pass.
 */
export interface GuardOptions {
  readonly lock: ProviderLock;
  readonly lockWaitMs: number;
  readonly dailySpendUsd: number;
  readonly costSince: (providerId: string, since: Date) => Promise<number>;
  readonly now?: () => Date;
}

export class GuardedProvider implements Provider {
  readonly id: string;
  constructor(private readonly inner: Provider, private readonly options: GuardOptions) {
    this.id = inner.id;
  }
  catalogue(): readonly CatalogueService[] { return this.inner.catalogue(); }
  supports(capability: Parameters<Provider['supports']>[0], tac: string) { return this.inner.supports(capability, tac); }

  async execute(request: ExecuteRequest): Promise<ProviderOutcome> {
    const now = (this.options.now ?? (() => new Date()))();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    // The router wrote this call's own provider_calls row BEFORE execute, so `spent` already
    // includes it: exceeding means this call is the one that would cross the line.
    const spent = await this.options.costSince(this.id, dayStart);
    if (spent > this.options.dailySpendUsd) {
      return { kind: 'failed', reason: 'spend_cap_reached', detail: 'daily supplier spend cap reached' };
    }
    return this.locked(() => this.inner.execute(request));
  }

  async poll(orderReference: string, service: CatalogueService, signal: AbortSignal): Promise<ProviderOutcome> {
    const inner = this.inner;
    if (inner.poll === undefined) return { kind: 'failed', reason: 'transport_error', detail: 'provider cannot poll' };
    return this.locked(() => inner.poll!(orderReference, service, signal));
  }

  async health(signal: AbortSignal) {
    const inner = this.inner;
    if (inner.health === undefined) return { reachable: false };
    const result = await this.options.lock.withLock(`provider:${this.id}`, this.options.lockWaitMs, () => inner.health!(signal));
    return result.acquired ? result.value : { reachable: true };
  }

  private async locked(fn: () => Promise<ProviderOutcome>): Promise<ProviderOutcome> {
    const result = await this.options.lock.withLock(`provider:${this.id}`, this.options.lockWaitMs, fn);
    return result.acquired
      ? result.value
      : { kind: 'failed', reason: 'rate_limited', detail: 'supplier is busy with another job' };
  }
}
```
Do not implement `parseWebhook` (imei24 has none). Replace the non-null assertions with local consts if lint forbids them. Export from `packages/core/src/index.ts`.

- [ ] **Step 4: Run** `npx vitest run packages/core` → PASS.

- [ ] **Step 5: Commit** — "Serialise imei24 calls and cap daily spend".

---

### Task 8: Shared order settlement; worker builds providers

**Files:**
- Create: `packages/core/src/orders/settle.ts`
- Modify: `apps/worker/src/jobs/poll-orders.ts` (thin wrapper), `apps/worker/src/main.ts`
- Modify: `packages/core/src/db/types.ts` (+ `OrderRepo.openForCheck` already exists; add `OrderRow.imeiHash`), memory/pg
- Test: `apps/worker/test/jobs.test.ts`, `packages/core/test/settle.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SettleDeps { repos: Repositories; providers: readonly Provider[]; tacDirectory: TacDirectory; metrics: Metrics; now?: () => Date; log?: (e: Record<string, unknown>, m: string) => void }
  export async function pollOrders(deps: SettleDeps, orders: readonly OrderRow[]): Promise<PollSummary>
  export async function pollDueOrders(deps: SettleDeps): Promise<PollSummary>   // worker: duePolls(BATCH) then pollOrders
  export { backoffFor }
  ```
- `OrderRow` gains `readonly imeiHash: string` (Task 9 adds the column; memory stores it).

- [ ] **Step 1: Failing test** `packages/core/test/settle.test.ts` — an order whose provider `poll` receives the **order's** service:
```ts
it('polls with the service recorded on the order', async () => {
  const seen: string[] = [];
  const provider = {
    id: 'imei24', catalogue: () => [s486, s690], supports: () => undefined,
    execute: async () => ({ kind: 'failed', reason: 'timeout' }) as const,
    poll: async (_ref: string, svc: CatalogueService) => { seen.push(svc.serviceId); return { kind: 'pending', orderReference: 'o' } as const; },
  };
  const repos = new MemoryRepositories();
  await repos.orders.insert(order({ serviceId: '690', nextPollAt: new Date(0) }));
  await pollDueOrders({ repos, providers: [provider], tacDirectory: emptyTac, metrics: new Metrics(false) });
  expect(seen).toEqual(['690']);
});
it('abandons an order whose service is no longer in the catalogue', async () => { /* expect unavailable(awaiting_provider_timed_out) section written */ });
```
Write `order()`, `s486`, `s690`, `emptyTac` helpers in the file (`emptyTac = { lookup: () => undefined, version: 't', size: 0, attribution: undefined }`).

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** — move the body of `apps/worker/src/jobs/poll-orders.ts` (`pollOrders`, `abandon`, `completeIfDone`, `backoffFor`, constants) into `packages/core/src/orders/settle.ts`, changing:
  - `pollOrders(deps, orders)` iterates the given list; `pollDueOrders(deps)` = `pollOrders(deps, await deps.repos.orders.duePolls(now, BATCH))`.
  - service lookup: `const service = provider?.catalogue().find((s) => s.serviceId === order.serviceId);` — if `provider?.poll === undefined || service === undefined || order.orderReference === undefined` → abandon.
  - `provider.poll(order.orderReference, service, AbortSignal.timeout(30_000))`.
  - On `answered`, also write the fields to the field cache (`new FieldCache(deps.repos.cache).write({... imeiHash: order.imeiHash ...})`) — the synchronous path does this and the async one never did; without it a repeat check re-buys the answer.
  - `completeIfDone` also recomputes the check `verdict` from all stored sections (`deriveVerdict` from `@imei-check/contract`) and sets `status: 'complete'`.
  `apps/worker/src/jobs/poll-orders.ts` becomes `export { pollDueOrders as pollOrders, backoffFor } from '@imei-check/core';` (keep existing worker tests compiling; update them for the new `poll` signature and `imeiHash`).
  `apps/worker/src/main.ts`: build providers with `buildProviders({ catalogueDir: process.env.PROVIDER_CATALOGUE_DIR ?? <same default as api>, imei24 })` where `imei24` comes from `IMEI24_USERNAME`/`IMEI24_API_KEY`/`IMEI24_BASE_URL` (validate https, same message), wrap each in `GuardedProvider` with `lockWaitMs: 5_000`, `dailySpendUsd: Number(process.env.IMEI24_DAILY_SPEND_USD ?? 10)`, `costSince: (id, since) => repos.providerCalls.costSinceForProvider(id, since)`. Load the TAC directory the way the API does if a loader exists in core/identity; otherwise keep the stub and note coverage text is generic. Delete the `const providers: [] = []` stub and its comment.

- [ ] **Step 4: Run** `npx vitest run packages/core apps/worker && npm run typecheck && npm run boundaries` → PASS.

- [ ] **Step 5: Commit** — "Share order settlement between API and worker; worker polls imei24".

---

### Task 9: Migration and repository columns

**Files:**
- Create: `db/migrations/20260925000001_deep_checks_encrypted_imei.sql`
- Modify: `packages/core/src/db/pg.ts` (`REQUIRED_SCHEMA_VERSION = '20260925000001'`, insert/select new columns), `memory.ts`, `types.ts`
- Modify: `db/schema.sql` only if the repo tracks it (it is currently untracked — leave it alone)
- Test: `packages/core/test/repositories.test.ts`, `packages/core/test/schema-version.test.ts`

**Interfaces:**
- `CheckRecord` gains `readonly tier: 'free' | 'deep'; readonly imeiEncrypted: Buffer | undefined; readonly imeiKeyVersion: number | undefined`.
- `CheckRepo.byId(tenantId, id, tier?)` — when `tier` given, returns undefined for the other tier.
- `OrderRepo.openForImei(imeiHash: string, serviceId: string): Promise<OrderRow | undefined>`.
- `ImeiRevealRepo { record(row: { id: string; checkId: string; actor: string; reason: string; revealedAt: Date }): Promise<void>; forCheck(checkId: string): Promise<readonly {...}[]> }`; `Repositories.reveals`.
- `CheckRepo.encryptedImei(id: string): Promise<{ imeiEncrypted: Buffer; imeiKeyVersion: number } | undefined>` — the ONLY read path for the ciphertext; `byId` does not return it.

- [ ] **Step 1: Failing tests** — in `repositories.test.ts` (memory implementation):
```ts
it('byId filters by tier', async () => {
  const repos = new MemoryRepositories();
  await repos.checks.insert(checkRecord({ id: 'c1', tier: 'free' }));
  expect(await repos.checks.byId('t', 'c1', 'deep')).toBeUndefined();
  expect(await repos.checks.byId('t', 'c1', 'free')).toBeDefined();
});
it('openForImei finds only a pending order for the same imei and service', async () => { /* insert pending + answered; assert */ });
it('encryptedImei is not exposed on byId', async () => {
  const repos = new MemoryRepositories();
  await repos.checks.insert(checkRecord({ id: 'c2', imeiEncrypted: Buffer.from('x'), imeiKeyVersion: 1 }));
  expect(Object.keys((await repos.checks.byId('t', 'c2'))!)).not.toContain('imeiEncrypted');
  expect(await repos.checks.encryptedImei('c2')).toEqual({ imeiEncrypted: Buffer.from('x'), imeiKeyVersion: 1 });
});
```
`schema-version.test.ts`: whatever it asserts about the latest migration file vs `REQUIRED_SCHEMA_VERSION` must pass with the new file.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** — migration:
```sql
-- Deep checks and encrypted IMEI (ADR-0007).
--
-- Locks: ADD COLUMN with a constant DEFAULT or NULL is catalogue-only on PostgreSQL 11+; the new
-- table and trigger touch nothing existing; the partial index is built CONCURRENTLY below the
-- transaction marker. Safe on a live database.

-- migrate:up

-- Existing rows were paid checks, so 'deep' is the truthful backfill.
ALTER TABLE checks ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'deep'
  CHECK (tier IN ('free', 'deep'));
-- AES-256-GCM: nonce(12) || ciphertext || tag(16), AAD = check id. NULL on pre-ADR-0007 rows.
ALTER TABLE checks ADD COLUMN IF NOT EXISTS imei_encrypted   bytea;
ALTER TABLE checks ADD COLUMN IF NOT EXISTS imei_key_version int;

-- HMAC(SERVER_PEPPER, digits), for attaching a second check to an order already running.
ALTER TABLE provider_orders ADD COLUMN IF NOT EXISTS imei_hash text;

CREATE TABLE imei_reveals (
  id          text PRIMARY KEY,
  check_id    text NOT NULL,
  actor       text NOT NULL,           -- 'api:<key id>' | 'cli'
  reason      text NOT NULL,
  revealed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_imei_reveals_check ON imei_reveals (check_id);

CREATE FUNCTION imei_reveals_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'imei_reveals is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER imei_reveals_no_mutation BEFORE UPDATE OR DELETE ON imei_reveals
  FOR EACH ROW EXECUTE FUNCTION imei_reveals_is_append_only();

-- migrate:down

DROP TRIGGER IF EXISTS imei_reveals_no_mutation ON imei_reveals;
DROP FUNCTION IF EXISTS imei_reveals_is_append_only();
DROP TABLE IF EXISTS imei_reveals;
ALTER TABLE provider_orders DROP COLUMN IF EXISTS imei_hash;
ALTER TABLE checks DROP COLUMN IF EXISTS imei_key_version;
ALTER TABLE checks DROP COLUMN IF EXISTS imei_encrypted;
ALTER TABLE checks DROP COLUMN IF EXISTS tier;
```
And a second file `db/migrations/20260925000002_open_order_imei_index.sql` (dbmate `-- migrate:up transaction:false`):
```sql
-- migrate:up transaction:false
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_provider_orders_open_imei
  ON provider_orders (imei_hash, service_id) WHERE status = 'pending';
-- migrate:down transaction:false
DROP INDEX CONCURRENTLY IF EXISTS idx_provider_orders_open_imei;
```
Set `REQUIRED_SCHEMA_VERSION = '20260925000002'`.
Pg repos: add `tier, imei_encrypted, imei_key_version` to the checks INSERT; `byId` adds `AND ($3::text IS NULL OR tier = $3)` and maps `tier`; new `encryptedImei`; orders INSERT includes `imei_hash`; `openForImei` = `SELECT * FROM provider_orders WHERE imei_hash = $1 AND service_id = $2 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`; row mapper maps `imei_hash`. `PgImeiRevealRepo.record` = plain INSERT. Memory mirrors all of it; memory `byId` must strip `imeiEncrypted`/`imeiKeyVersion` from its returned object (store them in a side map).
Fix every construction of `CheckRecord`/`OrderRow` the compiler flags (run-check.ts: pass `tier: 'deep'`, `imeiEncrypted: undefined`, `imeiKeyVersion: undefined` for now; orders: `imeiHash: request.imeiHash`).

- [ ] **Step 4: Run** `npx vitest run packages/core apps && npm run typecheck` → PASS.

- [ ] **Step 5: Commit** — "Schema for check tier, encrypted IMEI, reveal audit, open-order lookup".

---

### Task 10: Orchestrator tiers; free `/v1/checks`; `/v1/deep_checks` with wait window

**Files:**
- Modify: `apps/api/src/orchestrator/run-check.ts`
- Modify: `apps/api/src/routes/checks.ts` (free route + capabilities)
- Create: `apps/api/src/routes/deep-checks.ts`
- Create: `apps/api/src/routes/check-shared.ts` (idempotency + rate/concurrency wrapper + `reportFromRecord` used by both GET routes — moved out of checks.ts)
- Modify: `apps/api/src/services.ts` (`DEFAULT_DEEP_CAPABILITIES`, `waitMs`, wrap providers in `GuardedProvider`, `tacDirectory` not needed)
- Modify: `apps/api/src/app.ts` (register deep route), `apps/api/src/server.ts` (pass `waitMs`, spend cap)
- Modify: every existing test that POSTs a paid capability to `/v1/checks` → `/v1/deep_checks` (`checks.test.ts`, `orchestrator.test.ts`, `security.test.ts`, `sentinel.test.ts`, `routes.test.ts` — grep `'/v1/checks'`)
- Test: `apps/api/test/tiers.test.ts` (new)

**Interfaces:**
- `RunCheckRequest` gains `readonly tier: 'free' | 'deep'`.
- `RunCheckDeps.router` becomes `readonly router?: Router` — `runCheck` throws `Error('deep tier requires a router')` if `tier === 'deep'` and router is undefined; the free route never passes one.
- `RunCheckDeps` gains `readonly cipher?: ImeiCipher` (Task 11 makes it required; until then `imeiEncrypted: undefined`).
- `AppServices` gains `readonly deepDefaultCapabilities: readonly Capability[]` (= `['blacklist.gsma']`), `readonly deepWaitMs: number`, `readonly tacDirectory` is not added (routes use `app.tacDirectory`).
- `OFFLINE_CAPABILITIES = ['identity.model']` exported from run-check.ts.

- [ ] **Step 1: Failing tests** `apps/api/test/tiers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { CheckReport } from '@imei-check/contract';
import { CLEAN, FakeProvider, idempotencyKey, makePaidApp, service } from './paid-helpers.js';
import { SENTINEL, UNKNOWN_TAC_IMEI } from './helpers.js';

const post = (h: Awaited<ReturnType<typeof makePaidApp>>, url: string, body: unknown, key = idempotencyKey()) =>
  h.app.inject({ method: 'POST', url, headers: { ...h.auth(), 'idempotency-key': key }, payload: body as Record<string, unknown> });

describe('free /v1/checks', () => {
  it('answers identity.model and never touches a provider', async () => {
    const provider = new FakeProvider('fake', CLEAN);
    const h = await makePaidApp({ providers: [provider] });
    const res = await post(h, '/v1/checks', { imei: SENTINEL });
    expect(res.statusCode).toBe(200);
    const report = res.json<CheckReport>();
    expect(Object.keys(report.sections)).toEqual(['identity.model']);
    expect(provider.executed).toEqual([]);
  });

  it('a paid capability is unavailable(requires_deep_check), not dropped', async () => {
    const provider = new FakeProvider('fake', CLEAN);
    const h = await makePaidApp({ providers: [provider] });
    const report = (await post(h, '/v1/checks', { imei: SENTINEL, capabilities: ['identity.model', 'blacklist.gsma'] })).json<CheckReport>();
    expect(report.sections['blacklist.gsma']).toMatchObject({ outcome: 'unavailable', reason: 'requires_deep_check' });
    expect(provider.executed).toEqual([]);
  });
});

describe('paid /v1/deep_checks', () => {
  it('defaults to blacklist only', async () => {
    const h = await makePaidApp();
    const report = (await post(h, '/v1/deep_checks', { imei: SENTINEL })).json<CheckReport>();
    expect(Object.keys(report.sections)).toEqual(['blacklist.gsma']);
  });

  it('refuses identity.model with 400', async () => {
    const h = await makePaidApp();
    const res = await post(h, '/v1/deep_checks', { imei: SENTINEL, capabilities: ['identity.model'] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('capability_not_in_tier');
  });

  it('an unknown TAC still gets the wildcard blacklist service', async () => {
    const h = await makePaidApp();
    const res = await post(h, '/v1/deep_checks', { imei: UNKNOWN_TAC_IMEI });
    expect(res.json<CheckReport>().sections['blacklist.gsma']?.outcome).toBe('pass');
  });

  it('the same idempotency key on both routes is not a conflict', async () => {
    const h = await makePaidApp();
    const key = idempotencyKey();
    expect((await post(h, '/v1/checks', { imei: SENTINEL }, key)).statusCode).toBe(200);
    expect((await post(h, '/v1/deep_checks', { imei: SENTINEL }, key)).statusCode).toBe(200);
  });

  it('GET routes only return their own tier', async () => {
    const h = await makePaidApp();
    const free = (await post(h, '/v1/checks', { imei: SENTINEL })).json<CheckReport>();
    const deep = (await post(h, '/v1/deep_checks', { imei: SENTINEL })).json<CheckReport>();
    const get = (url: string) => h.app.inject({ method: 'GET', url, headers: h.auth() });
    expect((await get(`/v1/deep_checks/${free.check_id}`)).statusCode).toBe(404);
    expect((await get(`/v1/checks/${deep.check_id}`)).statusCode).toBe(404);
    expect((await get(`/v1/deep_checks/${deep.check_id}`)).statusCode).toBe(200);
  });

  it('requesting warranty.status also fetches warranty.purchase_date', async () => {
    const provider = new FakeProvider('fake', { kind: 'answered', fields: [{ field: 'warranty.purchase_date', value: '2024-01-02T00:00:00.000Z' }], misses: [] },
      [service({ providerId: 'fake', serviceId: 'w', capabilities: ['warranty.purchase_date'], fields: ['warranty.purchase_date'] })]);
    const h = await makePaidApp({ providers: [provider] });
    const report = (await post(h, '/v1/deep_checks', { imei: SENTINEL, capabilities: ['warranty.status'] })).json<CheckReport>();
    expect(Object.keys(report.sections).sort()).toEqual(['warranty.purchase_date', 'warranty.status']);
    expect(report.sections['warranty.status']?.outcome).not.toBe('unavailable');
  });
});

describe('wait window and hand-off', () => {
  it('a pending order that answers inside the window is returned final', async () => {
    const provider = new FakeProvider('fake', { kind: 'pending', orderReference: 'o1' },
      [service({ providerId: 'fake', async: true })]);
    provider.pollOutcomes = [{ kind: 'pending', orderReference: 'o1' }, { kind: 'answered', fields: [{ field: 'blacklist.status', value: 'clean' }], misses: [] }];
    const h = await makePaidApp({ providers: [provider], deepWaitMs: 2000, pollIntervalMs: 10 });
    const report = (await post(h, '/v1/deep_checks', { imei: SENTINEL })).json<CheckReport>();
    expect(report.sections['blacklist.gsma']?.outcome).toBe('pass');
    expect(report.status).toBe('complete');
  });

  it('a still-pending order is inconclusive(awaiting_provider) and GET later reflects the worker', async () => {
    const provider = new FakeProvider('fake', { kind: 'pending', orderReference: 'o2' }, [service({ providerId: 'fake', async: true })]);
    provider.pollOutcomes = [{ kind: 'pending', orderReference: 'o2' }];
    const h = await makePaidApp({ providers: [provider], deepWaitMs: 50, pollIntervalMs: 10 });
    const report = (await post(h, '/v1/deep_checks', { imei: SENTINEL })).json<CheckReport>();
    expect(report.sections['blacklist.gsma']).toMatchObject({ outcome: 'inconclusive', reason: 'awaiting_provider' });
    expect(report.status).toBe('partial');
  });

  it('a second deep check for the same IMEI attaches to the open order instead of placing another', async () => {
    const provider = new FakeProvider('fake', { kind: 'pending', orderReference: 'o3' }, [service({ providerId: 'fake', async: true })]);
    provider.pollOutcomes = [{ kind: 'pending', orderReference: 'o3' }];
    const h = await makePaidApp({ providers: [provider], deepWaitMs: 0 });
    await post(h, '/v1/deep_checks', { imei: SENTINEL });
    await post(h, '/v1/deep_checks', { imei: SENTINEL });
    expect(provider.executed).toHaveLength(1);
  });
});
```

Extend `paid-helpers.ts`: `FakeProvider` gets `pollOutcomes: ProviderOutcome[] = []` and
`async poll() { return this.pollOutcomes.length > 1 ? this.pollOutcomes.shift()! : this.pollOutcomes[0] ?? this.outcome; }`
and `supports(capability, tac)` uses `coversTac`. `makePaidApp` accepts `deepWaitMs` (default 0) and `pollIntervalMs` (default 250) and passes them to `buildServices`. Scope on the test key becomes `['checks:write']` (unchanged).

- [ ] **Step 2: Run** `npx vitest run apps/api/test/tiers.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`run-check.ts`:
- Add `tier` to the insert (`tier: request.tier`).
- Free tier: for every requested capability not in `OFFLINE_CAPABILITIES`:
  ```ts
  sections.set(capability, unavailable({
    capability, checkedAt: startedAt, coverage: coverageFor(capability, deps.tacDirectory),
    reason: 'requires_deep_check',
    detail: 'This check needs a paid lookup. Request it from POST /v1/deep_checks.',
  }));
  ```
  and skip steps 2–5 entirely. Assert at the top: `if (request.tier === 'deep' && deps.router === undefined) throw new Error('deep tier requires a router');`.
- Deep tier: `paid` = requested minus offline minus derived, plus `warranty.purchase_date` when `warranty.status` is requested (and add it to `request.capabilities` view used for sections). Cache step unchanged. Replace the per-capability `router.run` loop with:
  ```ts
  const toBuy = paid.filter((c) => !cached.has(c));
  const { calls, uncovered } = deps.router.plan(toBuy, tac);
  for (const capability of uncovered) {
    sections.set(capability, assembleSection({ capability, outcome: { kind: 'failed', reason: 'no_provider_configured', detail: 'No data source is configured for this check.' }, coverage: coverageFor(capability, deps.tacDirectory), checkedAt: startedAt }));
  }
  for (const call of calls) {
    // Attach to an order already running for this IMEI and service: imei24 charges every repeat.
    const head = call.candidates[0];
    const open = head !== undefined ? await deps.repos.orders.openForImei(request.imeiHash, head.service.serviceId) : undefined;
    const routed = open !== undefined
      ? { capability: call.capabilities[0]!, capabilities: call.capabilities, attempts: [], service: head!.service,
          outcome: { kind: 'pending' as const, orderReference: open.orderReference ?? '' } }
      : await deps.router.runCall({ call, imeiDigits: request.imei.digits, signal: request.signal });
    for (const capability of call.capabilities) {
      /* existing per-capability body: metrics, assembleSection, cache write (once per call, not per
         capability -- hoist it above this loop), and for pending: insert one OrderRow PER capability
         with the same orderReference, providerId/serviceId from routed.service, imeiHash. */
    }
  }
  ```
  Keep the absorbed-cost metric once per call. Keep derived step 5.
- Remove `DEFAULT_CAPABILITIES` usage from the free route; free default = `['identity.model']`.

`services.ts`:
- `DEFAULT_CAPABILITIES` → rename `FREE_DEFAULT_CAPABILITIES = ['identity.model']`, add `DEEP_DEFAULT_CAPABILITIES = ['blacklist.gsma']`.
- `BuildServicesOptions` gains `deepWaitMs?: number` (default 10_000), `pollIntervalMs?: number` (default 1_000), `dailySpendUsd?: number` (default 10), `lockWaitMs?: number` (default = deepWaitMs).
- Wrap each provider: `const guarded = options.providers.map((p) => new GuardedProvider(p, { lock: options.repos.locks, lockWaitMs, dailySpendUsd, costSince: (id, since) => options.repos.providerCalls.costSinceForProvider(id, since) }));` — use `guarded` for the router AND for `services.providers`.
- The `onCallStart` hook's `tenantId: 'pending'` is a pre-existing bug; leave it (out of scope) but do not copy it.

`check-shared.ts`: move from `checks.ts` the rate-limit / Luhn / idempotency / concurrency sequence into
```ts
export async function handleCheckPost(args: { request; reply; services; app; tier: 'free' | 'deep'; capabilities: readonly Capability[]; run: (ctx: { tenant: Tenant; imei: Imei; idempotencyKey: string | undefined }) => Promise<CheckReport> }): Promise<unknown>
```
with the idempotency key passed to the repo as `` `${tier}:${key}` `` and the digest salted with the tier. Also move the GET body into `reportFromRecord(services, record)` which rebuilds `summary.reasons` via the same `reasonsFor` used by `run-check.ts` (export it from run-check.ts) — the current GET returns `reasons: []`, which reads as "nothing to say".

`checks.ts`: `POST /v1/checks` → `handleCheckPost({ tier: 'free', capabilities: body.capabilities ?? FREE_DEFAULT_CAPABILITIES, run: (ctx) => runCheck({ repos, cache, tacDirectory: app.tacDirectory, metrics }, { ...ctx, tier: 'free', ... }) })` — **no router in deps**. `GET /v1/checks/:id` → `byId(tenant.id, id, 'free')`. Summary text: "Free check: offline data only. Never contacts a supplier." Tags: `free`. `POST /v1/capabilities`: add `tier: offline || derived ? 'free' : 'deep'` per capability (`derived` = `warranty.status` is `deep` because it needs a purchase date), `cost_usd` of the first candidate (or `0`), keep `credits: 0`. Update the `CapabilitiesResponse` zod schema in `packages/contract/src/envelope.ts` with `tier: z.enum(['free','deep'])` and `cost_usd: z.number().nonnegative()` (additive).

`deep-checks.ts`:
```ts
export function deepCheckRoutes(services: AppServices): FastifyPluginAsyncZod {
  return async (app) => {
    app.post('/v1/deep_checks', { preHandler: app.requireTenant, schema: { summary: 'Paid check via imei24. Waits up to DEEP_CHECK_WAIT_MS, then hand off to GET.', tags: ['paid'], headers: IdempotentHeaders, body: CheckRequest, response: { 200: CheckReport, 400: ErrorResponse, 401: ErrorResponse, 409: ErrorResponse, 429: ErrorResponse } } },
      async (request, reply) => {
        const requested = request.body.capabilities ?? services.deepDefaultCapabilities;
        if (requested.some((c) => OFFLINE_CAPABILITIES.includes(c))) {
          return reply.code(400).send({ error: { code: 'capability_not_in_tier', message: 'identity.model is answered by POST /v1/checks; deep checks return paid sections only.', request_id: request.id } });
        }
        return handleCheckPost({ request, reply, services, app, tier: 'deep', capabilities: requested,
          run: async (ctx) => {
            const first = await runCheck({ repos: services.repos, router: services.router, cache: services.cache, tacDirectory: app.tacDirectory, metrics: services.metrics }, { ...ctx, tier: 'deep', capabilities: requested, /* rest as today */ });
            if (first.status !== 'partial') return first;
            await waitForOrders(services, app.tacDirectory, first.check_id, services.deepWaitMs, services.pollIntervalMs);
            const record = await services.repos.checks.byId(ctx.tenant.id, first.check_id, 'deep');
            return record === undefined ? first : reportFromRecord(services, record, ctx.tenant);
          } });
      });
    app.get('/v1/deep_checks/:id', { /* same as GET /v1/checks/:id with tier 'deep' */ });
  };
}

/** Polls this check's open orders until they settle or the window closes. Never exceeds `waitMs`. */
async function waitForOrders(services: AppServices, tacDirectory: TacDirectory, checkId: string, waitMs: number, intervalMs: number): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const open = await services.repos.orders.openForCheck(checkId);
    if (open.length === 0) return;
    await pollOrders({ repos: services.repos, providers: services.providers, tacDirectory, metrics: services.metrics }, open);
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await new Promise((r) => setTimeout(r, Math.min(intervalMs, remaining)));
  }
}
```
The **idempotency record stores the final report** returned by `run` (so a retry after the window replays the post-wait answer). Replace the `pending` detail text in `assemble.ts` with: `'The supplier accepted the order and will answer shortly. Poll GET /v1/deep_checks/{check_id}.'` (keep remedy `retry_later`).
Register `deepCheckRoutes(services)` in `app.ts` next to `checkRoutes`. Swagger tag descriptions: `free` → "No supplier calls. Requires an API key when a database is configured."; `paid` → "Calls imei24. Costs supplier money; charges callers nothing."

Existing tests: replace `/v1/checks` with `/v1/deep_checks` wherever a test exercises a provider; remove `'identity.model'` from their `capabilities` lists (400 now) and move the offline-tier tests in `orchestrator.test.ts` to target `/v1/checks`. Do not weaken any assertion.

- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run boundaries` → all PASS.

- [ ] **Step 5: Commit** — "Free /v1/checks and paid /v1/deep_checks with a 10 s wait window".

---

### Task 11: IMEI encryption

**Files:**
- Create: `packages/core/src/crypto/imei-cipher.ts`
- Modify: `packages/core/src/index.ts`, `apps/api/src/config.ts` (enforce keys when `DATABASE_URL` set), `apps/api/src/server.ts`, `apps/api/src/services.ts` (`cipher`), `apps/api/src/orchestrator/run-check.ts`
- Modify: `.dependency-cruiser.cjs` (rule: only `imei-cipher.ts` may import `createCipheriv`/`createDecipheriv` — dependency-cruiser works on modules, so the rule is "no file under `packages/*/src` or `apps/*/src` except `imei-cipher.ts` imports `node:crypto` **and** matches `/Cipheriv/`" — implement it as a vitest test instead: `packages/core/test/cipher-boundary.test.ts` greps `packages/*/src` and `apps/*/src` for `createCipheriv|createDecipheriv` and allows only the cipher file)
- Test: `packages/core/test/imei-cipher.test.ts`, `apps/api/test/config.test.ts`, `apps/api/test/tiers.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export class ImeiCipher {
    static fromKeyring(spec: string): ImeiCipher          // "1:<b64>,2:<b64>"; throws on any key != 32 bytes or duplicate version
    readonly currentVersion: number
    encrypt(digits: string, checkId: string): { ciphertext: Buffer; keyVersion: number }
    decrypt(ciphertext: Buffer, keyVersion: number, checkId: string): string   // throws ImeiDecryptError
  }
  export class ImeiDecryptError extends Error {}
  ```
- `AppServices.cipher: ImeiCipher`; `RunCheckDeps.cipher: ImeiCipher` (required).

- [ ] **Step 1: Failing tests** `packages/core/test/imei-cipher.test.ts`:
```ts
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ImeiCipher, ImeiDecryptError } from '../src/crypto/imei-cipher.js';

const k = () => randomBytes(32).toString('base64');
const DIGITS = '8'.repeat(15);

describe('ImeiCipher', () => {
  it('round-trips and never contains the digits', () => {
    const c = ImeiCipher.fromKeyring(`1:${k()}`);
    const { ciphertext, keyVersion } = c.encrypt(DIGITS, 'chk_1');
    expect(ciphertext.toString('latin1')).not.toContain(DIGITS);
    expect(c.decrypt(ciphertext, keyVersion, 'chk_1')).toBe(DIGITS);
  });
  it('fresh nonce per encryption', () => {
    const c = ImeiCipher.fromKeyring(`1:${k()}`);
    expect(c.encrypt(DIGITS, 'a').ciphertext.equals(c.encrypt(DIGITS, 'a').ciphertext)).toBe(false);
  });
  it('ciphertext moved to another check fails', () => {
    const c = ImeiCipher.fromKeyring(`1:${k()}`);
    const { ciphertext } = c.encrypt(DIGITS, 'chk_1');
    expect(() => c.decrypt(ciphertext, 1, 'chk_2')).toThrow(ImeiDecryptError);
  });
  it('tampering fails', () => {
    const c = ImeiCipher.fromKeyring(`1:${k()}`);
    const { ciphertext } = c.encrypt(DIGITS, 'x');
    ciphertext[14] ^= 1;
    expect(() => c.decrypt(ciphertext, 1, 'x')).toThrow(ImeiDecryptError);
  });
  it('rotation: encrypts with the highest version, still decrypts the old one', () => {
    const k1 = k();
    const old = ImeiCipher.fromKeyring(`1:${k1}`).encrypt(DIGITS, 'x');
    const c = ImeiCipher.fromKeyring(`1:${k1},2:${k()}`);
    expect(c.currentVersion).toBe(2);
    expect(c.decrypt(old.ciphertext, 1, 'x')).toBe(DIGITS);
  });
  it('refuses a short key and never echoes it', () => {
    const short = Buffer.alloc(16).toString('base64');
    expect(() => ImeiCipher.fromKeyring(`1:${short}`)).toThrow(/32 bytes/);
    try { ImeiCipher.fromKeyring(`1:${short}`); } catch (e) { expect(String(e)).not.toContain(short); }
  });
  it('error messages never contain digits', () => {
    const c = ImeiCipher.fromKeyring(`1:${k()}`);
    try { c.decrypt(Buffer.alloc(40), 1, 'x'); } catch (e) { expect(String(e)).not.toMatch(/\d{14,}/); }
  });
});
```
Config test: with `DATABASE_URL` set and no `IMEI_ENCRYPTION_KEYS` → throws `/IMEI_ENCRYPTION_KEYS/`. Tiers test: after a free and a deep check, `repos.checks.encryptedImei(id)` decrypts to `SENTINEL` with `services.cipher`.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** `imei-cipher.ts`:
```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * The ONE place an IMEI is encrypted or decrypted (ADR-0007).
 *
 * AES-256-GCM, fresh 12-byte nonce per row, AAD = check id so a ciphertext copied onto another
 * row fails authentication. Layout: nonce(12) || ciphertext || tag(16). Nothing here ever logs,
 * throws or returns key material or digits in a message.
 */
const NONCE = 12;
const TAG = 16;

export class ImeiDecryptError extends Error {
  constructor() {
    super('IMEI ciphertext could not be decrypted (wrong key version, wrong check, or tampered)');
    this.name = 'ImeiDecryptError';
  }
}

export class ImeiCipher {
  private constructor(private readonly keys: ReadonlyMap<number, Buffer>, readonly currentVersion: number) {}

  static fromKeyring(spec: string): ImeiCipher {
    const keys = new Map<number, Buffer>();
    for (const part of spec.split(',').map((p) => p.trim()).filter(Boolean)) {
      const sep = part.indexOf(':');
      const version = Number(part.slice(0, sep));
      if (sep <= 0 || !Number.isInteger(version) || version < 1) throw new Error('IMEI_ENCRYPTION_KEYS: each entry must be "<version>:<base64 key>"');
      if (keys.has(version)) throw new Error(`IMEI_ENCRYPTION_KEYS: version ${version} appears twice`);
      const key = Buffer.from(part.slice(sep + 1), 'base64');
      if (key.length !== 32) throw new Error(`IMEI_ENCRYPTION_KEYS: version ${version} must decode to exactly 32 bytes`);
      keys.set(version, key);
    }
    if (keys.size === 0) throw new Error('IMEI_ENCRYPTION_KEYS: no keys');
    return new ImeiCipher(keys, Math.max(...keys.keys()));
  }

  encrypt(digits: string, checkId: string): { ciphertext: Buffer; keyVersion: number } {
    const key = this.keys.get(this.currentVersion)!;
    const nonce = randomBytes(NONCE);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(checkId, 'utf8'));
    const body = Buffer.concat([cipher.update(digits, 'utf8'), cipher.final()]);
    return { ciphertext: Buffer.concat([nonce, body, cipher.getAuthTag()]), keyVersion: this.currentVersion };
  }

  decrypt(ciphertext: Buffer, keyVersion: number, checkId: string): string {
    const key = this.keys.get(keyVersion);
    if (key === undefined || ciphertext.length < NONCE + TAG + 1) throw new ImeiDecryptError();
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, ciphertext.subarray(0, NONCE));
      decipher.setAAD(Buffer.from(checkId, 'utf8'));
      decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG));
      return Buffer.concat([decipher.update(ciphertext.subarray(NONCE, ciphertext.length - TAG)), decipher.final()]).toString('utf8');
    } catch {
      throw new ImeiDecryptError();
    }
  }
}
```
(Replace the `!` with an explicit check if lint forbids it.)
Config: `.superRefine` on the schema — if `DATABASE_URL` is set, `IMEI_ENCRYPTION_KEYS` must be present and `ImeiCipher.fromKeyring` must not throw (report its message under path `IMEI_ENCRYPTION_KEYS`).
`run-check.ts`: `const { ciphertext, keyVersion } = deps.cipher.encrypt(request.imei.digits, checkId);` → `imeiEncrypted: ciphertext, imeiKeyVersion: keyVersion` on insert (both tiers). `server.ts`/`services.ts`: build the cipher from config and pass through; `paid-helpers.ts` uses a fixed test keyring built from `randomBytes(32)`.
`.env.example` (if present) gets `IMEI_ENCRYPTION_KEYS=1:<generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))">`.

- [ ] **Step 4: Run** `npm test && npm run typecheck` → PASS.

- [ ] **Step 5: Commit** — "Encrypt the IMEI on every check (ADR-0007)".

---

### Task 12: Scopes, reveal route, operator scripts

**Files:**
- Modify: `apps/api/src/auth/plugin.ts` (`requireScope`), `apps/api/src/app.ts`
- Create: `apps/api/src/routes/admin.ts`
- Create: `packages/core/src/crypto/reveal.ts` (`revealImei` shared by route and CLI)
- Create: `scripts/seed-admin-key.mjs`, `scripts/imei-reveal.mjs`; root `package.json` scripts `seed:admin-key`, `imei:reveal`
- Modify: `apps/api/src/lib/log.ts` (the reveal route's response is never logged — confirm the `res` serializer is an allowlist without body; add a test)
- Test: `apps/api/test/admin-reveal.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // plugin.ts
  app.requireScope(scope: 'checks:write' | 'imei:reveal'): preHandler  // runs after requireTenant
  // request.apiKeyScopes: readonly string[]
  // core/crypto/reveal.ts
  export async function revealImei(deps: { repos: Repositories; cipher: ImeiCipher; now?: () => Date }, args: { tenantId: string; checkId: string; actor: string; reason: string }): Promise<{ kind: 'revealed'; imei: string } | { kind: 'not_found' } | { kind: 'not_stored' }>
  ```

- [ ] **Step 1: Failing tests** `apps/api/test/admin-reveal.test.ts` — extend `makePaidApp` to also mint an admin key (`scopes: ['imei:reveal']`) and expose `adminAuth()`:
```ts
describe('POST /v1/admin/checks/:id/imei/reveal', () => {
  it('service key is refused 403', async () => {
    const h = await makePaidApp();
    const check = (await postFree(h)).json<CheckReport>();
    const res = await reveal(h, check.check_id, h.auth(), 'customer dispute #42 needs device id');
    expect(res.statusCode).toBe(403);
  });
  it('admin key reveals, audits first, no-store', async () => {
    const h = await makePaidApp();
    const check = (await postFree(h)).json<CheckReport>();
    const res = await reveal(h, check.check_id, h.adminAuth(), 'customer dispute #42 needs device id');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ check_id: check.check_id, imei: SENTINEL });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(await h.repos.reveals.forCheck(check.check_id)).toHaveLength(1);
    expect(h.logs.raw()).not.toContain(SENTINEL);
  });
  it('admin key cannot run checks', async () => {
    const h = await makePaidApp();
    const res = await h.app.inject({ method: 'POST', url: '/v1/checks', headers: { ...h.adminAuth(), 'idempotency-key': 'k' }, payload: { imei: SENTINEL } });
    expect(res.statusCode).toBe(403);
  });
  it('audit write failure means nothing is decrypted', async () => {
    const h = await makePaidApp();
    const check = (await postFree(h)).json<CheckReport>();
    h.repos.reveals.record = async () => { throw new Error('db down'); };
    const res = await reveal(h, check.check_id, h.adminAuth(), 'customer dispute #42 needs device id');
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain(SENTINEL);
  });
  it('a pre-ADR-0007 check says not stored, not 500', async () => {
    const h = await makePaidApp();
    await h.repos.checks.insert(/* CheckRecord with imeiEncrypted undefined, id 'chk_old' */);
    const res = await reveal(h, 'chk_old', h.adminAuth(), 'customer dispute #42 needs device id');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('imei_not_stored');
  });
  it('reason under 10 chars is 400', async () => { /* ... */ });
  it('a key holding both scopes is refused', async () => { /* insert key scopes ['checks:write','imei:reveal'] -> 403 on both routes */ });
  it('11th reveal in a minute is 429', async () => { /* ... */ });
});
```
Write `postFree`, `reveal` helpers and every elided body in full.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**
  - `plugin.ts`: `AuthDeps.lookup` returns `scopes` too; decorate `apiKeyScopes`. In `requireTenant`, if scopes include both `checks:write` and `imei:reveal` → 403 `key_scope_conflict`. Add:
    ```ts
    app.decorate('requireScope', (scope: string) => async (request: FastifyRequest, reply: FastifyReply) => {
      if (!(request.apiKeyScopes ?? []).includes(scope)) {
        return reply.code(403).send({ error: { code: 'insufficient_scope', message: `This key lacks the '${scope}' scope.`, request_id: request.id } });
      }
      return undefined;
    });
    ```
  - `app.ts`: every existing authenticated route (free lookups, checks, deep checks, capabilities) gets `requireScope('checks:write')` after `requireTenant`. `/metrics` unchanged.
  - `reveal.ts`: look up `checks.byId(tenantId, checkId)` → `not_found`; `checks.encryptedImei(checkId)` → `not_stored`; `await repos.reveals.record({ id: 'rev_' + randomUUID(), checkId, actor, reason, revealedAt: now })` (throws propagate — nothing decrypted); then `cipher.decrypt(...)`.
  - `admin.ts`: `POST /v1/admin/checks/:id/imei/reveal`, preHandlers `requireTenant`, `requireScope('imei:reveal')`; body `z.object({ reason: z.string().trim().min(10).max(500) })`; rate limit via `services.limiter.take(\`reveal:${request.apiKeyId}\`, { capacity: 10, refillPerSecond: 10 / 60 })` (match the limiter's actual option names in `apps/api/src/abuse/ratelimit.ts`); `reply.header('cache-control', 'no-store')`; tag `admin`, `hide: true` in OpenAPI.
  - Log: in `lib/log.ts` confirm the `res` serializer emits only status code; add a tripwire test asserting the reveal response body never appears in logs (the sentinel check above covers it).
  - `scripts/seed-admin-key.mjs`: copy `seed-service-tenant.mjs`, mint a key with `scopes: ['imei:reveal']`, label `'admin: imei reveal'`, print it once.
  - `scripts/imei-reveal.mjs`: `node --env-file-if-exists=.env scripts/imei-reveal.mjs <check_id> --reason "<text>"`; uses `PgRepositories`, `ImeiCipher.fromKeyring(process.env.IMEI_ENCRYPTION_KEYS)`, `revealImei(..., { actor: 'cli', tenantId: process.env.SEED_TENANT_ID ?? 'ten_check_this_phone' })`; prints only the IMEI on success; exit 1 with a digit-free message otherwise.

- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run boundaries` → PASS.

- [ ] **Step 5: Commit** — "Admin-scoped, audited IMEI reveal route and CLI".

---

### Task 13: Sentinel, docs, Bruno, final gate

**Files:**
- Modify: `apps/api/test/sentinel.test.ts`
- Create: `docs/privacy.md`
- Modify: `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/adr/0007-encrypted-imei-at-rest.md` (Status → Accepted), `docs/adr/0003-no-raw-imei-at-rest.md` (add "Amended by ADR-0007" line), `README.md` (env vars), `bruno/Paid/*` (add `Deep check.bru`, point paid requests at `/v1/deep_checks`), `.env.example` if present

- [ ] **Step 1: Sentinel** — add cases that run the sentinel through `/v1/checks`, `/v1/deep_checks` (with the imei24 fixtures from Task 4 served by a fake transport that echoes the IMEI in `RESULT` and in `MESSAGE`), and the reveal route; then assert:
  - no sentinel digits in any log line;
  - no sentinel digits in any response except the reveal response;
  - every in-memory repository row serialised with `JSON.stringify` (Buffers as base64) contains no sentinel digits;
  - the repo scan still passes (the plan and spec files must not contain the digits — they don't).

- [ ] **Step 2: Run** `npm run test:sentinel` → PASS. Deliberately break it once (log `request.body` in the deep route), confirm it FAILS, revert.

- [ ] **Step 3: Docs**
  - `docs/privacy.md`: what is stored (hashes; encrypted IMEI for the partition retention window; reveal audit), who can decrypt (admin-scoped key or CLI, audited), processors (**imei24 / pro.imei24.com receives the raw IMEI and service id only, no user or tenant identifier; no DPA yet; jurisdiction unknown — release blocker**), DSAR erasure procedure (`UPDATE checks SET imei_encrypted = NULL, imei_key_version = NULL WHERE imei_hash = $1`).
  - `CLAUDE.md` Privacy: "Raw IMEI is never stored **in plaintext**… Every check stores it AES-256-GCM encrypted (ADR-0007); only an `imei:reveal` key or the CLI can decrypt, audited." Money: mention imei24 spend cap. Commands: `seed:admin-key`, `imei:reveal`, `imei24:prefixes`. Routes: free vs deep.
  - ADR-0007 status Accepted; ADR-0003 header gains `**Amended by:** ADR-0007 (encrypted IMEI column)`.
  - README env table: `IMEI24_USERNAME`, `IMEI24_API_KEY`, `IMEI24_BASE_URL`, `IMEI24_DAILY_SPEND_USD`, `DEEP_CHECK_WAIT_MS`, `IMEI_ENCRYPTION_KEYS`; remove `ALPHA_*`, `BETA_*`.

- [ ] **Step 4: Full gate** — `npm run lint && npm run typecheck && npm run boundaries && npm test && npm run schema:emit && npm run schema:diff`. Everything green. Paste the diff verdict into the commit body.

- [ ] **Step 5: Commit** — "Extend the sentinel, document privacy and the deep-check split".

---

## Self-review notes

- Spec §2 routes → Tasks 10, 12. §3 orchestrator → 10. §4 transport/catalogue/lexicons/parsing/poll → 2, 3, 4, 6. Selection → 5. §5 lock/window/spend/dedupe → 7, 8, 10. §6 data → 9. ADR-0007 → 9, 11, 12. §7 tests → spread; §8 blockers stay open (documented in 13).
- Out of scope by decision: check-this-phone-backend changes; recording real imei24 fixtures (needs credits + key — operator task).
