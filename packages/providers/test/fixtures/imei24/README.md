# imei24 fixtures

These fixtures are **derived from pro.imei24.com API docs 2026-09-25, NOT recorded responses;
replace when real ones are recorded.** They exist only so `imei24-catalogue.test.ts` can exercise
`DhruLegacyProvider.interpret` and the imei24 lexicons before a single real call has been made.

Per `.claude/skills/fixture-recording/SKILL.md`, a lexicon rule should ordinarily be derived from a
recorded fixture, never from documentation — documentation describes what a supplier meant to send,
not what they actually sent. That is exactly why `imei24-lexicons.ts` ships with **no known-good
phrases**: none has been observed yet, so every good-looking value in these fixtures is expected to
come back as a lexicon miss, not a pass.

No fixture in this folder contains real IMEI digits. Every IMEI value is the literal placeholder
`[REDACTED-IMEI]`.
