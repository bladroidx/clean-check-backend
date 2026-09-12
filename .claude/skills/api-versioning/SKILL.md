---
name: api-versioning
description: Manage imei-check's published API compatibility — emitting JSON Schema from zod, diffing against the frozen snapshot, classifying additive versus breaking changes, sunsetting a path version, and the special hazard of adding an enum arm that a shipped Kotlin client cannot deserialise. Use before publishing any schema change.
---

<role>
This skill decides whether a change can ship on the current version. The consumer that constrains
everything is a shipped Android app on someone's phone that you cannot force-update.
</role>

<context>
`packages/contract` emits `snapshots/v<major>.<minor>.json` from the same zod definitions the server
validates with. CI diffs the emitted schema against the committed snapshot.

`schema_version` in the body tracks additive change; `/vN` in the path tracks breaking change.
</context>

<rules>
1. **Adding an enum arm is BREAKING for an exhaustive consumer.** Kotlin sealed-type
   deserialisation fails closed, and the Android client's `when` over `Reason`/`Outcome` is
   exhaustive by design. Treat every new `Outcome`, `Reason`, `Remedy` or `Capability` value as
   breaking unless the client contract documents an `unknown` fallback **and** a test proves it.
2. **Additive-only on a minor**: a new optional field, a new optional section, a longer `caveats`
   array, a new example.
3. **Breaking**: removed field · narrowed type · new required field · changed semantics for the
   same name · new enum arm (see 1) · a field becoming nullable.
4. **Never reuse a name with different semantics.** Add a new field, deprecate the old.
5. **A sunset needs a date, a header and a migration note** — `Sunset: <date>` and `Deprecation:
   true` on every response from the old path, from the day the new one ships.
6. **The snapshot is committed and reviewed.** A schema change with no snapshot diff in the PR is a
   schema change nobody reviewed.
7. **Examples in the OpenAPI document are published output** — never a real IMEI, never a real key.
</rules>

<workflow>
1. `npm -w @imei-check/contract run schema:emit`
2. `npm run schema:diff` — compare against the committed snapshot.
3. Classify every delta with the table below.
4. Additive → bump `schema_version` minor, commit the new snapshot, done.
5. Breaking → decide: block it, or open `/vN`, keep `/v(N-1)` serving, add `Sunset`, and write the
   migration note in `docs/api-changelog.md`.
6. **Check the Kotlin side.** If an arm was added, name the file in `../check-this-phone` that needs
   the matching arm and say so in the report. Do not edit that repo.
7. Run the contract tests and paste real output.
</workflow>

<examples>
<example name="classification">
| Change | Class | Action |
|---|---|---|
| `coverage.data_as_of` added, optional | additive | 1.0 → 1.1 |
| `caveats` gains an entry | additive | none |
| `Reason` gains `carrier_declined_lookup` | **breaking** | `/v2` or a proven client fallback |
| `credits_charged` int → decimal | **breaking** | `/v2` |
| `finding.severity` becomes required | **breaking** | `/v2` |
| `imei_masked` mask char `•` → `*` | **breaking** in practice | clients string-match; treat as breaking |
</example>

<example name="the-sunset-response">
```
HTTP/1.1 200 OK
Deprecation: true
Sunset: Wed, 01 Apr 2027 00:00:00 GMT
Link: <https://docs.example.com/api/v2-migration>; rel="deprecation"
```
Ship these headers the day `/v2` opens, not the month before shutdown.
</example>
</examples>

<format_constraints>
```
SCHEMA DIFF — <sha> vs snapshots/<v>.json
 ADDITIVE  <path> — <change>
 BREAKING  <path> — <change> — <which client breaks, how>
 VERDICT   schema_version <X.Y → X.Z> | REQUIRES /vN | BLOCKED: <why>
 SNAPSHOT  committed <y/n>
 CROSS-REPO check-this-phone/<path> — needs <arm> (not applied)
```
</format_constraints>
