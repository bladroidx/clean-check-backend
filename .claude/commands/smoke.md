---
description: Bring the stack up locally and exercise the API end to end with real curls
argument-hint: [route or capability to focus on — omit for the full happy path]
allowed-tools: Read, Write, Edit, Grep, Glob, Bash
---

<role>
You prove the service actually works by running it and calling it, not by reading it.
</role>

<context>
Focus: **${ARGUMENTS:-the free tier and every fake-imei24 deep-check scenario}**

The production-like stack lives in the backend repo:
`../check-this-phone/check-this-phone-backend/local-stack/` (`./up.sh`, `./down.sh`). It runs
imei-check (api + worker, `NODE_ENV=production`), the check-this-phone backend, two throwaway
Postgres databases, and **fake-imei24** (`tools/fake-imei24/`): a local HTTPS fake of the DHRU API
that replays the provider fixtures. `IMEI24_BASE_URL` points at the fake, so nothing is spent.

**An `imc_test_` key does NOT make a call safe.** The prefix routes nothing: with real imei24
credentials a test key spends real money. Safety comes only from `IMEI24_BASE_URL` pointing at the
fake — check it before every run.

The fake picks its scenario from the IMEI's second-to-last digit; see
`tools/fake-imei24/SCENARIOS.md`. Get fresh IMEIs with `node tools/fake-imei24/imei-for.mjs all` —
never write one into a file.
</context>

<rules>
1. **Never smoke with real supplier credentials.** Confirm `IMEI24_BASE_URL=https://fake-imei24:8443`
   in the stack's `.env` first; `up.sh` refuses to start otherwise.
2. **Paste real output**, including the failure cases. A smoke run that only shows the happy path
   has tested the least interesting third of the service.
3. **Check the arms that are reachable.** `pass` on `blacklist.gsma` is NOT reachable by design:
   the imei24 lexicons have no known-good phrases until real responses are recorded, so "Clean"
   comes back `inconclusive`. Seeing `pass` there is a bug — report it loudly.
4. **Never smoke against a shared or production database.** The stack's databases are tmpfs.
5. **Tear down** what you brought up.
</rules>

<workflow>
```bash
cd ../check-this-phone/check-this-phone-backend/local-stack && ./up.sh
KEY=$(grep '^IMEI_CHECK_API_KEY=' .env | cut -d= -f2)
curl -s 127.0.0.1:3020/healthz; curl -s 127.0.0.1:3020/readyz

# free tier
IMEI=$(node ../../../clean-check-phone/tools/fake-imei24/imei-for.mjs 2 | awk '{print $2}')
curl -s -X POST 127.0.0.1:3020/v1/checks -H "authorization: Bearer $KEY" \
  -H "idempotency-key: smoke-free-$RANDOM" -H 'content-type: application/json' \
  -d "{\"imei\":\"$IMEI\"}" | jq

# one deep check per scenario (0-9), each on a fresh IMEI
for s in 0 1 2 3 4 5 6 7 8 9; do
  IMEI=$(node ../../../clean-check-phone/tools/fake-imei24/imei-for.mjs $s | awk '{print $2}')
  curl -s -X POST 127.0.0.1:3020/v1/deep_checks -H "authorization: Bearer $KEY" \
    -H "idempotency-key: smoke-$s-$RANDOM" -H 'content-type: application/json' \
    -d "{\"imei\":\"$IMEI\",\"capabilities\":[\"blacklist.gsma\"]}" \
    | jq -c "{s: $s, verdict: .summary.verdict, gsma: .sections[\"blacklist.gsma\"] | {outcome, reason}}"
done

# no IMEI in any log
docker compose logs imei-api imei-worker ctp-api fake-imei24 | grep -cE '(^|[^0-9.])[0-9]{15}([^0-9]|$)'
./down.sh
```
</workflow>

<examples>
<example name="what-to-check-in-the-output">
- scenario 0 and 1 are `fail` / red; 2, 7 and 8 are `inconclusive` / amber; 3, 4 and 9 are
  `unavailable` / undetermined; 6 is `inconclusive(awaiting_provider)` first
- every response is HTTP **200**, and `billing.credits_charged` is `0`
- `checked_at` is a real provider timestamp, not the serialisation moment
- `imei_masked` appears; the full 15 digits appear nowhere in the body or the logs
</example>
</examples>

<format_constraints>
```
SMOKE — <sha>
 UP        <services> · migrations <n> applied
 FREE      /v1/checks <status> · identity <arm>
 DEEP      scenario <d> → <arm>(<reason>) · verdict <v>     (one line per scenario)
 ARMS SEEN fail <y/n> · inconclusive <y/n> · unavailable <y/n> · pass on blacklist <must be n>
 LEAK      full IMEI in body/logs: <none|FOUND>
 DOWN      <clean|left running: why>
```
</format_constraints>

<final_instruction>
Bring it up, run the calls, paste real output including failures, then tear down.
</final_instruction>
