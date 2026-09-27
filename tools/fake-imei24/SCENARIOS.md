# fake-imei24

A fake imei24 (DHRU Fusion legacy API) for the local production-like stack in
`check-this-phone-backend/local-stack/`. Dev tooling only: outside the npm workspaces, never in the
service image, never imported by it. imei-check reaches it exactly as it reaches the real supplier,
over HTTPS via `IMEI24_BASE_URL`, trusting a throwaway CA through `NODE_EXTRA_CA_CERTS`. No real
money is spent and no IMEI leaves the machine.

Replies are the provider fixtures in `packages/providers/test/fixtures/`, served verbatim; only the
order id in the placement and pending fixtures is rewritten.

## Picking a scenario

The IMEI's **second-to-last digit** picks the scenario. No IMEI is written down anywhere, on
purpose (the sentinel test forbids it): generate one per scenario with

    node tools/fake-imei24/imei-for.mjs all

which prints a fresh, Luhn-valid IMEI per scenario with a random serial, so every run is a phone
imei-check has never seen (no cache hit, no open order to attach to). The default TAC is an iPhone
13 from `testdata/tac-seed.json`.

| Digit | Scenario | What the fake does | Expected `blacklist.gsma` section |
|---|---|---|---|
| 0 | instant blacklisted | answers "Blacklisted" | `fail`, verdict red |
| 1 | async, fast | "Order received", pending for 3 s, then "Blacklisted" | `fail` inside the 10 s wait, red |
| 2 | "Clean" wording | answers "Clean" | `inconclusive` (unrecognised value), amber |
| 3 | busy | imei24's one-job-at-a-time refusal | `unavailable` (rate limited) |
| 4 | timeout | replies after 15 s, past the 8 s service timeout | `unavailable` (timeout) |
| 5 | not found | "info not found, try later" | `unavailable` (no coverage) |
| 6 | async, slow | pending for 60 s, then "Blacklisted" | `inconclusive(awaiting_provider)`, then `fail` once the worker polls (about 5 min) |
| 7 | ambiguous label | a bare "Status;Blacklisted" line | `inconclusive` (a bare "Status" is deliberately not a blacklist label) |
| 8 | identity only | model data, no blacklist field | `inconclusive` |
| 9 | HTTP 429 | status 429, empty body | `unavailable` (rate limited) |

**No scenario produces a green verdict, and that is correct.** The imei24 lexicons ship with no
known-good phrases until real responses are recorded, so "Clean" (digit 2) is unrecognised and
comes back `inconclusive` -- the parsing rule in `CLAUDE.md` working, not a bug.

## Running

The local stack builds and runs it; nothing to do by hand. On its own:

    node --test tools/fake-imei24/test    # the fake's own tests

## Balance and prices

`accountinfo` reports a prepaid balance that starts at `FAKE_IMEI24_BALANCE` (default 100) and is
debited the *live* price of every accepted placement (busy and not-found are free; a timeout is
charged, as a real supplier may). `imeiservicelist` serves the catalogue prices multiplied by
`FAKE_IMEI24_PRICE_MULTIPLIER` (default 1).

Set the multiplier to `10` to play "imei24 silently repriced": the worker's balance reconcile logs
an error once the balance falls faster than recorded spend, and the next catalogue drift run
disables every service (`npm run service:override -- list`), after which deep checks come back
`unavailable(provider_not_configured)` without placing an order.
