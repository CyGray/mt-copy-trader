# Pitfalls found in the XAUUSD provider study

Each item cost real time or nearly produced a wrong conclusion. Check them before trusting a number.

## Signals and parsing

- **Stored `parsed_ok` is wrong for signals.** The history writer uses the legacy `telegramParser.ts` (needs the
  word "NOW"). Re-parse text with `a1/parser_port.py` (matches `vipSignalParser.ts`, 3,317 / 3,317). Re-verify
  parity if `vipSignalParser.ts` changes (`worker/src/lib/vipSignalParser.ts` and its tests).
- **Edits.** The provider rewrites entry, stop and TP levels after posting (OOS2: 31 of 58 signals changed
  between first parseable and final version; median lag 516 s, p90 about 59 minutes). The final text is not
  what an engine could have acted on at posting time. Build both universes: `final` and `first`.
- **Edit-first delivery.** About 60% of messages reached the forwarder first as an edit. The engine handles a
  first-seen edit as a new signal (`handleSignal`) and later revisions through `handleRevision`. `handleRevision`
  (level changes after a trade exists) was **not simulated**.
- **Message ids absent from an export** (361 in the first export): do not assume a contiguous sequence.
- **Comma decimals** in a level (a "1,234" style number) are flagged `comma_decimal_truncated` by the hard
  flags because the parser can read only part of the number. Exclude flagged signals from the clean set.
- **Cancel or pull messages** make the final text a non-signal: those messages are not accepted signals.

## Prices and the engine

- Dukascopy is not Vantage: spread, latency and fills differ. Costs BASE / MID / PESS are a proxy. Median
  spread in the data was 0.56 USD; the Vantage spread in market hours was never measured.
- A single-tick price spike can trigger a stop that a broker would not fill; the persistence-filter sensitivity
  (2 ticks, 1 s) and the jump/reversion check (`c2_jumps.py`) bound this.
- Same-tick TP and SL: the engine takes SL first and flags it.
- 72 h horizon: open legs are marked to the last tick (`UNRESOLVED_MTM`). Weekend gaps and the Friday 20:45 UTC
  cut-off are a sensitivity, not the default.
- Any change to the engine needs both suites passed and a re-run of an old period with identical trades.

## Statistics

- Search over 196 variants then OOS: use Holm for the frozen set and a Reality Check for the search.
- Small n: OOS2's 58 signals can only detect about |0.4| R. A wide CI is "unknown", not "no effect".
- Drop-top-5-winners and day-clustered bootstrap are standard checks; the OOS TP4 result flipped to -0.4 to -0.85
  when the top five winners were dropped.
- Post-hoc splits (late edits, session, side) are hypotheses for the next test, not findings.
- Do not pool periods with opposite signs.

## Sizing and profiles

- Default safety: risk cap is min(50 USD, 1%); default `max_spread_price` 0.5 blocks most fills; draft profiles
  set 1.0, which three of four need to pass default safety.
- A profile that exceeds a safety limit or a hard ceiling is refused (`invalid_profile` skip), not clamped.
- `use_min_if_within_cap` can risk 2 to 4 times the target; use `skip`.
- Splits into 3 or more checkpoints are exact only from 0.04 lots; at 0.01 to 0.03 they merge.
- Margin, commission and swap are Unknown for Vantage.
- `validateProfile` rejects envelope keys such as `status`; the web routes strip them. The web preview does not
  run the safety check, so read `safetyIssues` separately.

## Environment

- **Firestore quota.** Free plan, daily reset. The AutoTrader's pollers (signal feed 3 s, admin commands 3 s,
  lifecycle 2 s, reconciler 15 s) can exhaust it; every read made by research competes with live trading.
- **Never** build into `worker/dist`, run `npm ci` / `npm prune` / `npm install` on the host, or restart services.
  Use `npm run typecheck`, or emit to a temp `--outDir`.
- **Weekend / market closed:** stale quotes and a wide stale spread; crypto symbols returned bid 0, ask 0.
- Dukascopy hourly files return HTTP 503 intermittently; retry, and record unresolved hours as unknown.
- **Forwarder down = no signals.** On 2026-10-25 the forwarder stopped on Telegram `401 AUTH_KEY_UNREGISTERED`
  (the session was invalidated) and the AutoTrader had been stopped cleanly 7 minutes earlier. A refresh test
  needs a live forwarder for the period; check `systemctl --user is-active bytrader-worker` first.
- Scratchpad directories are ephemeral; heavy data must be regenerated from scripts.
- A second agent (hub session `auto-trader`) may be changing the live system. Re-read state instead of trusting
  an earlier snapshot, and never undo its work.
