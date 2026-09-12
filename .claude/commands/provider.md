---
description: Add, repair or harden a provider integration end to end
argument-hint: <provider>[/<service_id>] [capability] — e.g. sickw/30 lock.activation
allowed-tools: Read, Write, Edit, Grep, Glob, Bash
---

<role>
You integrate a supplier so that every way they can fail produces the right arm, and none of them
produces a `pass`.
</role>

<context>
Target: **${ARGUMENTS:-(none given — ask which provider and capability)}**

Adapters return `ProviderOutcome`, never a `SectionResult`. The conversion lives only in
`apps/api/src/report/assemble.ts`.
</context>

<rules>
1. **Catalogue before code** — capabilities come from checked-in YAML, never from a seller-authored
   service name.
2. **Fixtures before parser** — you cannot normalise output you have not seen.
3. **An unrecognised value is `inconclusive`, never a benign default.**
4. **Never fail over after a definite negative answer.**
5. **`supports()` filters before spending.**
6. **Write the `provider_calls` row before the HTTP call.**
7. **Never log or persist a raw supplier body** outside `provider_call_bodies`.
</rules>

<skills>
Follow `.claude/skills/provider-adapter-authoring/SKILL.md`, with
`.claude/skills/normalisation-lexicon/SKILL.md` for the three layers and
`.claude/skills/fixture-recording/SKILL.md` for capture and scrubbing.
</skills>

<workflow>
1. Catalogue the service (`imeiservicelist` / `GET /products`) into `src/catalogue/<provider>.yaml`.
2. Record the 15-case fixture matrix.
3. Transport — reuse `dhru/legacy.ts` or `dhru/rest.ts`.
4. Normalise — extract → alias → lexicon.
5. Async lifecycle if needed: `pending` → `provider_orders` → webhook + poller → 24 h expiry.
6. Breaker, router registration, drift-job entry.
7. `npm test -- providers` and paste real output.
</workflow>

<examples>
<example name="the-matrix-that-must-be-complete">
```
clean · blacklisted · icloud-on · icloud-off · carrier-locked · carrier-unlocked
unknown-imei · malformed-html · waf-html-200 · xml-when-json-requested
success-wrapping-error · credit-exhausted · upstream-rate-limited · timeout
unrecognised-status          ← assert inconclusive, never pass
```
</example>
</examples>

<format_constraints>
```
PROVIDER — <provider>/<service_id>
 CATALOGUE <capabilities> · subject <x> · cost <n>cr/$<n> · p95 <ms>
 FIXTURES  <n>/15 — MISSING <cases>
 LEXICON   <field>: <n> values · miss → inconclusive [VERIFIED <test:line>]
 ASYNC     webhook · poller · expiry · reservation release [VERIFIED]
 TESTS     <command> → <real output>
```
</format_constraints>

<final_instruction>
If no provider was named, ask which provider and capability, then begin at step 1.
</final_instruction>
