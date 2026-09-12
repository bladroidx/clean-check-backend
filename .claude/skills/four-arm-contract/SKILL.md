---
name: four-arm-contract
description: Author and verify imei-check response sections against the four-arm contract — choosing between pass, fail, inconclusive and unavailable, attaching evidence and coverage, setting checked_at honestly, and enforcing the seven envelope invariants. Use when writing or reviewing anything that produces a SectionResult, adds a capability, or maps a provider outcome onto the wire.
---

<role>
This skill is the procedure for producing an honest answer. A section is not done when it returns
`pass` — it is done when it returns the *right one of four* arms, carries the evidence that produced
it, states what it covers, and is tested on every arm.
</role>

<context>
```ts
type SectionResult = {
  capability: Capability;
  outcome: 'pass' | 'fail' | 'inconclusive' | 'unavailable';
  checked_at: string;        // when the DATA was obtained. Never serialisation time.
  coverage: Coverage;        // mandatory on ALL four arms
  evidence: Measurement[];
  finding?: Finding;         // fail only
  reason?: Reason;           // inconclusive | unavailable only
  remedy?: Remedy;           // inconclusive only
  source: { provider: string; service_id: string; cached: boolean; credits: number };
  freshness: { cached: boolean; age_seconds: number; ttl_seconds: number };
};
```

This mirrors `ProbeResult` in `../check-this-phone/core/model/.../ProbeResult.kt`, whose own
doc-comment is the design brief: *"Four arms, and all four are real answers."*
</context>

<rules>
1. **`unavailable` is never an error and never silently a `pass`.**
2. **`inconclusive` is not `fail`.** A supplier having a bad day must not condemn a good phone.
3. **Evidence on every arm, `pass` included.** Port of `require(!evidence.isEmpty)`.
4. **`coverage` and `checked_at` on every arm.** On `unavailable`, `coverage` describes what a
   successful answer *would* have covered.
5. **HTTP 200 whenever the request was well-formed and authorised.**
6. **`pass` requires a positive match.** Absence of a bad word is not evidence of a good state.
7. **No top-level boolean verdict.** `green|amber|red|undetermined`, always with reasons.
</rules>

<workflow>
1. **Pick the arm from the matrix below.** If two seem to fit, pick the more conservative one — the
   order of conservatism is `unavailable` > `inconclusive` > `fail` > `pass`.
2. **Attach evidence** — the actual measured values, structured, not a pre-formatted sentence.
3. **Fill `coverage`** — registries, regions, region model, the provider's own freshness claim if
   given, and the caveats that apply to this capability in this region.
4. **Set `checked_at` to when the data was obtained** — the provider call, or the original call for
   a cached answer. Never `new Date()` at serialisation.
5. **Set `freshness`** honestly: `cached`, true `age_seconds`, the `ttl_seconds` in force.
6. **Write the test for all four arms**, not the one you implemented.
7. **Run `assertEnvelopeInvariants()`** — it is exported from `packages/contract` and is meant to be
   called at runtime in dev, not only in tests.
</workflow>

<examples>
<example name="the-arm-selection-matrix">
| Situation | Arm | Reason |
|---|---|---|
| Positive lexicon match on a known-good value | `pass` | — |
| Positive lexicon match on a known-bad value | `fail` | + `finding` |
| Provider answered, value not in lexicon | `inconclusive` | `unrecognised_provider_value` |
| Provider answered "not in our registry" | `inconclusive` | `device_not_found_in_registry` |
| Async order still open | `inconclusive` | `awaiting_provider` |
| Async order past the 24 h expiry | `unavailable` | `awaiting_provider_timed_out` |
| Provider timed out / transport failed | `unavailable` | `provider_timeout` |
| Circuit open | `unavailable` | `circuit_open` |
| No provider configured for this capability | `unavailable` | `provider_not_configured` |
| Apple-only capability on an Android TAC | `unavailable` | `capability_not_supported_for_device` |
| Tenant out of credits for this capability | `unavailable` | `insufficient_credits` |

The boundary that matters: **"we asked and got a non-answer" is `inconclusive`; "we never got an
answer" is `unavailable`.** Getting it backwards renders "not in the registry" as a green tick.
</example>

<example name="evidence-on-a-pass">
```ts
{
  capability: 'blacklist.gsma',
  outcome: 'pass',
  checked_at: providerCall.finishedAt.toISOString(),
  evidence: [
    { label: 'Block-list entry', type: 'flag', value: false },
    { label: 'Reporting networks consulted', type: 'numeric', value: 122, unit: 'count' },
  ],
  coverage: {
    registries: ['gsma_imei_db'],
    region_model: 'reporting_networks',
    caveats: [
      'A handset reported stolen in the last 24-72 hours may not yet appear.',
      'Networks in CN, RU and much of MEA do not report to the GSMA IMEI DB; a clean result says nothing about those markets.',
    ],
  },
}
```
The two caveats are not legal boilerplate. They are the difference between a true statement and a
misleading one, and they are why this API is worth paying for.
</example>

<example name="the-mistake-to-watch-for">
```ts
const blocked = fields.blacklist === 'blacklisted';
return blocked ? fail(...) : pass(...);          // WRONG
```
Every unrecognised value — `"No records found"`, `"-"`, `""`, a reworded sentence, a WAF page
parsed to nothing — lands in `pass`. Correct form asks the lexicon and handles the miss:
```ts
const status = lexicon.blacklist.match(provider, service, raw);
if (status === undefined) return inconclusive('unrecognised_provider_value', 'retry_later', evidence);
return status === 'blocked' ? fail(...) : pass(...);
```
</example>
</examples>

<format_constraints>
When reporting section work:
```
SECTION <capability>
 ARMS IMPLEMENTED  pass <y/n> · fail <y/n> · inconclusive <reasons> · unavailable <reasons>
 EVIDENCE          <labels>
 COVERAGE          registries <list> · caveats <n>
 CHECKED_AT        <source of the timestamp>
 TESTS             <path> — arms covered <n>/4
```
</format_constraints>
