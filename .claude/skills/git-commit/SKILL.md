---
name: git-commit
description: Stage, review and commit work in the imei-check repo with a well-formed message — including first-time repo setup, the .gitignore that keeps peppers, provider keys and .env out of history, splitting mixed work into reviewable commits, and preparing branches and pull requests. Use whenever changes need committing or the repo needs its git setup.
---

<role>
You create clean, reviewable history for **imei-check**. You stage deliberately, write messages that
explain *why*, and you never commit a secret.
</role>

<context>
This repo handles provider API keys, a server pepper and tenant salts. A secret in git history is
not fixed by a follow-up commit — it is fixed by rotating the secret, and it stays in every clone.
</context>

<rules>
1. **Scan before staging, every time.** Provider keys, `SERVER_PEPPER`, `.env`, `*.pem`, a real IMEI
   in a doc or an OpenAPI example.
2. **Never `git add -A` without reading `git status` first.**
3. **One logical change per commit.** A migration, its code and its test belong together; a
   drive-by reformat does not.
4. **Message explains *why*.** The diff already says what.
5. **A fixture commits with the test that consumes it.**
6. **Never `--no-verify`.** If a hook is wrong, fix the hook.
7. **Never force-push a shared branch.**
8. **A schema change commits with its regenerated snapshot.**
</rules>

<workflow>
1. `git status` and `git diff` — read them.
2. Secret scan the staged set:
   `git diff --cached | rg -n 'api[_-]?key|apiaccesskey|PEPPER|SALT|Bearer [A-Za-z0-9]{16,}|-----BEGIN|\b\d{15}\b'`
3. Split if the change is mixed. Stage with `git add -p` when a file holds two ideas.
4. Write the message: subject in the imperative under 72 chars, body explaining why, and the
   consequence if it matters.
5. Commit. Push only when asked.
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
<example name="the-gitignore-that-matters">
```gitignore
.env
.env.*
!.env.example
*.pem
secrets*.json
provider-credentials*
coverage/
node_modules/
dist/
*.tsbuildinfo
```
`!.env.example` is deliberate — the example documents the variable names, never their values.
</example>
</examples>

<format_constraints>
```
COMMIT
 STAGED     <n> files
 SCAN       secrets <clean|HITS> · IMEI-shaped <clean|HITS>
 SPLIT      <n> commits: <subjects>
 MESSAGE    <subject>
```
Never commit with an unresolved scan hit.
</format_constraints>
