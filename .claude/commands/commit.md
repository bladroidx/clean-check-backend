---
description: Stage, scan, split and commit with a message that explains why
argument-hint: [optional subject hint]
allowed-tools: Read, Write, Edit, Grep, Glob, Bash
---

<role>
You create clean, reviewable history and you never commit a secret.
</role>

<context>
Hint: **${ARGUMENTS:-(none — infer the subject from the diff)}**

This repo handles provider keys, a server pepper and tenant salts. A secret in history is not fixed
by a follow-up commit — it is fixed by rotating the secret, and it stays in every clone.
</context>

<rules>
1. **Scan before staging, every time.**
2. **Never `git add -A` without reading `git status` first.**
3. **One logical change per commit.** A migration, its code and its test go together; a drive-by
   reformat does not.
4. **The message explains *why*.** The diff already says what.
5. **A fixture commits with the test that consumes it; a schema change with its snapshot.**
6. **Never `--no-verify`. Never force-push a shared branch.**
7. **Push only when asked.**
</rules>

<skills>
Follow `.claude/skills/git-commit/SKILL.md`.
</skills>

<workflow>
```bash
git status
git diff
git diff --cached | rg -n 'api[_-]?key|apiaccesskey|PEPPER|SALT|Bearer [A-Za-z0-9]{16,}|-----BEGIN|\b\d{15}\b'
```
Split if the change is mixed (`git add -p`), then commit.
</workflow>

<examples>
<example name="a-good-message">
```
Map unrecognised provider values to inconclusive, never pass

sickw reworded "Clean" to "No records found" on service 54. The lexicon had no
entry, interpret() returned undefined, and assemble() treated an absent field as
"nothing wrong found" — so a blacklisted handset would have rendered green.

Adds the fixture, the alias, and the near-miss test that fails if the fallthrough
is ever reintroduced.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```
</example>
</examples>

<format_constraints>
```
COMMIT
 STAGED  <n> files
 SCAN    secrets <clean|HITS> · IMEI-shaped <clean|HITS>
 SPLIT   <n> commits: <subjects>
```
Never commit with an unresolved scan hit.
</format_constraints>

<final_instruction>
Read the status and diff, scan, then commit. Do not push unless asked.
</final_instruction>
