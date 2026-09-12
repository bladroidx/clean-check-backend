---
description: Attack the service's honesty — find what makes it report a stolen phone as clean
argument-hint: [surface, e.g. lexicon | cache | failover | billing — omit for all]
allowed-tools: Read, Write, Edit, Grep, Glob, Bash
---

<role>
You try to make this service lie. Not crash — lie. A crash is visible and gets fixed; a confident
wrong answer gets a stolen phone sold.
</role>

<context>
Surface: **${ARGUMENTS:-all of them}**

Every attack is a variation on one question: **what sequence of events makes an unknown render as
green?**
</context>

<rules>
1. **A reproduction, not an opinion.** Every claim ships as a failing test or a paste-able curl.
2. **Attack the seams** — adapter/assembler, cache/clock, reservation/settlement.
3. **Assume the supplier is hostile or broken**, not merely slow.
4. **Time is an input.** Freeze it, skew it, cross every TTL boundary from both sides.
5. **Rank by consequence.** A stolen phone reading clean outranks a 500.
6. **Do not fix what you find** unless asked. Report it.
</rules>

<skills>
Read `.claude/skills/four-arm-contract/SKILL.md` for the invariants you are breaking and
`.claude/skills/normalisation-lexicon/SKILL.md` for the fallthrough paths.
</skills>

<workflow>
1. **Lexicon fuzz** — `"Clean "`, `"CLEAN."`, `"No records found"`, `"-"`, `""`, `"N/A"`,
   `"Not Found"`, a reworded sentence, another language, an HTML entity. All must be `inconclusive`.
2. **Polarity** — `ON`/`OFF` into every boolean-ish field; check the sign per field, not globally.
3. **Failover shopping** — A says `blacklisted`; open A's circuit on the next call; assert the
   section stays `fail` and never retries into B.
4. **Cache boundary** — write `clean` at T; test TTL−1s and TTL+1s; assert `cached`, `age_seconds`
   and `checked_at` are truthful at both.
5. **Assembly matrix** — every `ProviderOutcome` kind × capability; exactly one path may yield `pass`.
6. **Partial / async** — kill a provider mid-check; expire an order; assert `unavailable`, released
   credits, and `summary.verdict: undetermined` rather than green.
7. **Billing race** — two concurrent checks on the last credit; assert one wins and `SUM(delta)=balance`.
8. **Enumeration** — sweep a TAC range; assert the detector trips and spend is zero.
9. **Leak sweep** — sentinel IMEI through every path just exercised.
</workflow>

<examples>
<example name="a-real-finding">
CRITICAL — a stolen phone reads clean. `fixtures/sickw/54/reworded-clean.json` returns
`Blacklist Status: No records found`; `lexicon.ts:41` has no entry; `normalise()` returns
`undefined`; `assemble.ts:77` treats that as "field absent" and omits the section. The client
renders a report with no blacklist row, which a buyer reads as "nothing wrong found".
Test added: `test/adversarial/lexicon-fallthrough.test.ts` (failing).
</example>
<example name="not-a-finding">
"It returns 200 when every section is unavailable." Deliberate — a 5xx is indistinguishable to a
naive client from "nothing wrong found". Check the client's rendering instead.
</example>
</examples>

<format_constraints>
```
ADVERSARIAL PASS — <sha>
CRITICAL (n) — a wrong answer a user would act on
 1. <what lies> — <repro> — <test added>
HIGH (n) · MEDIUM (n)
SURVIVED (n) — <attack> blocked by <file:line>
NOT REPRODUCED (n) — <hypothesis> — <why it did not hold>
```
Report attacks attempted, not only those that landed.
</format_constraints>

<final_instruction>
Begin at step 1 for the named surface. Show real output for every reproduction.
</final_instruction>
