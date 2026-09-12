---
name: normalisation-lexicon
description: Turn a provider's free-text or HTML blob into typed fields in imei-check — the extract/alias/lexicon stack, the polarity trap, and the rule that an unrecognised value never falls through to a benign default. Use when adding a provider service, when a lexicon miss fires, or when a supplier changes their wording.
---

<role>
This skill owns the three layers between a supplier's blob and a typed field. It is the dirtiest
code in the repo and the place where the product's credibility is actually decided.
</role>

<context>
```
raw blob ──▶ extract.ts ──▶ aliases.ts ──▶ lexicon.ts ──▶ NormalisedFields
             tags/lines      ~200 key       value strings
             → k/v pairs     spellings      → typed enums
                             → ~25 fields
```

A representative blob:
```html
Model: iPhone 13 Pro<br>IMEI: 3531…<br>iCloud Lock: ON<br>Blacklist Status: Clean<br>
Estimated Purchase Date: 2022-03-14<br>Sold By: Apple Store UK
```
And the same service, three weeks later, from the same supplier:
```html
Model: iPhone 13 Pro<br>Find My: Enabled<br>Blacklist: No records found<br>
```
Both are normal. The second must not produce a green report.
</context>

<rules>
1. **An unrecognised value NEVER falls through to a benign default.** It returns `undefined` from
   the lexicon, which the assembler turns into
   `inconclusive(unrecognised_provider_value, remedy: retry_later)`, increments
   `imei_lexicon_miss_total{provider,field}`, and logs the sanitised string.
2. **Lexicons are keyed `(provider, service, field)` with a global default underneath.** Not global
   only — see the polarity trap.
3. **Match on a normalised value** (trim, casefold, collapse whitespace, strip trailing punctuation)
   but **never on a substring**. `"not blacklisted"` contains `"blacklisted"`.
4. **Aliases are data, not regex cleverness.** A new key spelling is a line in `aliases.ts` plus a
   fixture, never a looser pattern.
5. **Never infer a field from another field.** A missing `blacklist` is not "clean because the
   device was found".
6. **Extraction never interprets.** `extract.ts` returns strings; it has no opinion about meaning.
7. **A lexicon addition ships with the fixture that motivated it.** Otherwise the next refactor
   deletes it as dead data.
</rules>

<workflow>
1. **Get the real blob.** Record a fixture first — see `fixture-recording`.
2. **Extract**: strip tags, split on `<br>|\r?\n`, split each line at the **first** `:`, normalise
   the key (casefold, strip non-alphanumeric).
3. **Alias**: map the normalised key to a canonical field. Unknown keys are collected and reported,
   not dropped silently — a new key may be a new capability the supplier started returning.
4. **Interpret**: look the value up in the lexicon for `(provider, service, field)`, falling back to
   the global lexicon for that field. Miss → `undefined`.
5. **Add the miss to the metric and the log**, sanitised.
6. **Write the test**: the new value maps correctly, *and* a near-miss of it maps to `undefined`.
7. `npm test -- providers` and paste the real output.
</workflow>

<examples>
<example name="the-polarity-trap">
```ts
// GOOD state          BAD state
"Find My iPhone: OFF"  "Find My iPhone: ON"
"SIM Lock: Unlocked"   "SIM Lock: Locked"
"Blacklist: Clean"     "Blacklist: ON"
```
`ON` is good in one field and bad in another; `OFF` likewise. A single global true/false lexicon
gets `activation_lock` exactly backwards — which reports a locked, probably-stolen handset as fine.
This is why lexicons are per-field:

```ts
export const LEXICONS = {
  activation_lock: { locked: ['on','enabled','locked','yes'], unlocked: ['off','disabled','clean','no'] },
  blacklist:       { blocked: ['blacklisted','blocked','lost','stolen','barred','listed','on'],
                     clean:   ['clean','clear','not blacklisted','off','no'] },
  sim_lock:        { locked: ['locked','sim locked'], unlocked: ['unlocked','sim unlocked','clean'] },
} as const;
```
Note `'clean'` means *unlocked* under `sim_lock` and *not blocked* under `blacklist`, and appears
in neither `activation_lock` list. Per-field is the only way that is expressible.
</example>

<example name="handling-a-miss">
```ts
export function interpret<T extends string>(
  field: Field, provider: string, service: string, raw: string,
): T | undefined {
  const value = raw.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!]+$/, '');
  const table = OVERRIDES[`${provider}:${service}:${field}`] ?? LEXICONS[field];
  for (const [typed, values] of Object.entries(table)) {
    if (values.includes(value)) return typed as T;         // exact, never substring
  }
  metrics.lexiconMiss.inc({ provider, field });
  log.warn({ provider, service, field, value: sanitise(value) }, 'lexicon miss');
  return undefined;                                        // → inconclusive, never a default
}
```
</example>

<example name="the-coverage-test-that-catches-a-reword">
Every value string appearing in any fixture must resolve, or be listed in
`unrecognised.expected.json`:
```ts
it('every fixture value resolves or is a declared unknown', () => {
  for (const { provider, service, field, value } of allFixtureValues()) {
    const known = interpret(field, provider, service, value) !== undefined;
    expect(known || declaredUnknown(provider, field, value)).toBe(true);
  }
});
```
This fails the build the day a supplier rewords "Clean" — which is exactly when you want to hear
about it, rather than from a customer.
</example>
</examples>

<format_constraints>
```
LEXICON WORK — <provider>/<service>
 FIELDS      <field>: <n> known values (+<n> added)
 MISSES      <field> ← "<sanitised value>" — <added|declared unknown>
 POLARITY    <field> verified against <fixture>
 TESTS       coverage test <PASS|FAIL> · near-miss test <path>
```
</format_constraints>
