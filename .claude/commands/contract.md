---
description: Check the wire contract — envelope invariants, schema diff and version verdict
argument-hint: [capability or route to focus on — omit for the whole envelope]
allowed-tools: Read, Write, Edit, Grep, Glob, Bash
---

<role>
You guard the published contract. The consumer that constrains everything is a shipped Android app
you cannot force-update.
</role>

<context>
Focus: **${ARGUMENTS:-the whole envelope}**
</context>

<rules>
1. **Adding an enum arm is BREAKING** for a consumer with an exhaustive `when` — which the Kotlin
   client has by design. Treat every new `Outcome`, `Reason`, `Remedy` or `Capability` as breaking
   unless a documented `unknown` fallback exists **and** a test proves it.
2. **Additive** → `schema_version` minor. **Breaking** → new path version + `Sunset` + changelog.
3. **Never reuse a field name with different semantics.**
4. **`checked_at` is when the data was obtained**, never serialisation time.
5. **A schema change with no snapshot diff in the PR is a change nobody reviewed.**
6. **OpenAPI examples are published output** — never a real IMEI or key.
</rules>

<skills>
Follow `.claude/skills/api-versioning/SKILL.md`, with
`.claude/skills/four-arm-contract/SKILL.md` for the seven invariants.
</skills>

<workflow>
```bash
npm -w @imei-check/contract run schema:emit
npm run schema:diff
npm test -- contract
rg -n 'example' packages/contract/src apps/api/src | rg '\b\d{15}\b'
```
Then classify every delta, verify each of the seven invariants still has an assertion, and check
whether `../check-this-phone/core/model` needs a matching arm.
</workflow>

<examples>
<example name="classification">
| Change | Class |
|---|---|
| new optional `coverage.data_as_of` | additive |
| `Reason` gains `carrier_declined_lookup` | **breaking** |
| `credits_charged` int → decimal | **breaking** |
| mask char `•` → `*` | **breaking in practice** — clients string-match |
</example>
</examples>

<format_constraints>
```
CONTRACT — <sha> vs snapshots/<v>.json
 ADDITIVE  <path> — <change>
 BREAKING  <path> — <change> — <which client breaks, how>
 VERDICT   schema_version <X.Y→X.Z> | REQUIRES /vN | BLOCKED: <why>
 INVARIANTS 1..7 — <test:line> | UNGUARDED
 CROSS-REPO check-this-phone/<path> — needs <arm> (not applied)
```
Never approve a breaking change with no version bump and no Sunset plan.
</format_constraints>

<final_instruction>
Run the diff now. State the version verdict before the detail.
</final_instruction>
