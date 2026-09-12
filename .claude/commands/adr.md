---
description: Write an ADR or a capability spec before the code exists
argument-hint: <the decision or capability to document>
allowed-tools: Read, Write, Edit, Grep, Glob, Bash
---

<role>
You write the decision record that makes a choice reviewable later. An unspecified capability
produces an unexplainable answer, and this product's whole value is that its answers can be
explained.
</role>

<context>
Subject: **${ARGUMENTS:-(none given — ask what decision needs recording)}**

ADRs live in `docs/adr/NNNN-kebab-title.md`, specs in `docs/specs/`. Existing ADRs:
`0001-four-arm-wire-contract` · `0002-provider-abstraction` · `0003-no-raw-imei-at-rest` ·
`0004-cache-at-the-field-level` · `0005-tac-data-licensing`.
</context>

<rules>
1. **Record the decision *and* the alternative you rejected**, with the reason. An ADR with no
   rejected option is a description, not a decision.
2. **State the consequences you are accepting**, including the bad ones. An ADR that lists only
   benefits will be reversed by the first person who hits the cost.
3. **A new capability spec needs the full four-arm matrix** — every condition, its arm, its
   evidence and the sentence a user reads. Not just the happy path.
4. **Name the enforcement.** A rule with no test or lint behind it is an intention.
5. **Supersede, never edit.** A changed decision is a new ADR marked `Supersedes NNNN`; the old one
   stays `Superseded by NNNN`.
6. **Cross-repo decisions get an ADR in both repos**, or they are not decisions.
7. **Date every ADR** and give it a status: Proposed · Accepted · Superseded.
</rules>

<skills>
Read `.claude/skills/four-arm-contract/SKILL.md` before writing any capability spec — the arm
matrix is mandatory content, not a section you may skip.
</skills>

<workflow>
1. Read the existing ADRs so you do not contradict one silently.
2. Draft: Context → Decision → Alternatives rejected → Consequences → Enforcement.
3. For a capability spec, add the four-arm matrix and the coverage metadata it will emit.
4. Check whether `../check-this-phone` needs a matching record; name the file, do not edit it.
5. Number it, date it, set the status.
</workflow>

<examples>
<example name="the-arm-matrix-a-spec-must-contain">
| Condition | Arm | Reason | Evidence | User-facing sentence |
|---|---|---|---|---|
| Positive match, known-good | `pass` | — | flag + registries consulted | "No block-list entry in the registries we can see." |
| Positive match, known-bad | `fail` | — | flag + reported date | "Reported lost or stolen." |
| Value not in lexicon | `inconclusive` | `unrecognised_provider_value` | the sanitised value | "We could not read the answer we were given." |
| Timeout | `unavailable` | `provider_timeout` | attempt count, elapsed | "We could not reach the registry." |
</example>
<example name="a-consequence-worth-writing-down">
"Accepted: the global cross-tenant cache leaks that *someone* checked this IMEI recently, via
`age_seconds`. We accept it — it reveals nothing about who, and removing it would require lying
about freshness, which is the one thing this product cannot do."
</example>
</examples>

<format_constraints>
```
# NNNN — <title>

**Status:** Proposed | Accepted | Superseded by NNNN · <date>
**Applies to:** <packages, tables, routes>

## Context
## Decision
## Alternatives rejected
## Consequences
## Enforcement
```
</format_constraints>

<final_instruction>
If no subject was given, ask what decision needs recording. Otherwise draft it now.
</final_instruction>
