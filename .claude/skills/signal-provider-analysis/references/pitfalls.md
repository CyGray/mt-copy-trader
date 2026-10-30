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

## New channels (learned 2026-10-27, GAB FX and LUCAS GOLD LEGEND)

- **Check that a channel posts signals at all before planning a study.** GAB FX posted 0 entry signals ("signals
  only inside circle"): a free channel can be a sales funnel. Classify every message first (`a1/parser_multi.py`
  `classify_message`, checked against hand labels).
- **The name says nothing about the instrument.** "GAB FX" and the Lucas channel both quote gold and call 0.10 USD
  a "pip". Infer the symbol from the price level and flag `symbol_inferred`.
- **Several signals per message** ("SIGNAL 3" BUY and "SIGNAL 4" SELL together). Universe ids are
  `message_id * 100 + label`. The live executor's trade-set id is per message, so a second signal would collide.
- **"open" as the last target** means a runner with no price. S_TP4 strategies then skip (`tp_missing`).
- **Zone signals are limit-style.** Both Lucas signals were posted 3-20 USD away from the market: E1/E3 fill 0%,
  only E2 (`pending_at_range`) fills.
- **Pips annotations catch typos.** "STOPLOSS: 4018 (50pips - 70pips)" lets the parser check the stop
  (`sl_annotation_mismatch`). The first published 4028 failed the check and was corrected 27 min later.
- **Marketing recaps quote best cases.** The channel's "+360 pips" ran from the zone's best price to the
  day's top tick; a SELL that hit its stop was posted as "+60 pips" and "returned to breakeven". Never use
  provider claims as outcomes; check them against ticks.
- **A public `t.me/s/<handle>` with the same title can be a different channel** (different ids, bulk-posted
  media). A mirror counts only if message ids and text match the private store.
- **History starts when the account joins.** No store holds earlier messages. The fast path is a Telegram
  Desktop JSON export by the owner (`a1/load_tdesktop_export.py`). It holds final text only: edit history is
  Unknown and `date` is local time, so use `date_unixtime`.
- **Live stack is Go since 2026-10-25.** Read `state.sqlite` with `mode=ro` (`a1/export_go_store.py`). The
  live Go parser (`internal/domain/parser.go`, `ParseGoldSignal`) is a separate implementation: test new formats
  against it too, and validate draft profiles against a copy of the Go `domain` package as well as the
  TypeScript validators (`profiles/` in the 2026-10-27 study).
- **Never run another session's Telegram tool.** A hub session built a `dialogsreader` that opens the stored
  session; a second client can invalidate the forwarder's session.
- **Bridge `tick_time_msc` is broker server time, not UTC.** Vantage MT5 server time was GMT+3 on 2026-10-27
  (`PING`: `server_time - gmt_time = 10800`). Subtract the offset before comparing with Dukascopy or Telegram times.
- **Next pre-registration: make `sl_annotation_mismatch` a hard flag** (audit F2, 2026-10-27). It was info-only
  in the first two-channel study because the hard-flag list had been pre-registered unchanged.
- **Simulate the provider's live instructions, not only the posted levels** (`analysis/lucas/lucas_followup.py` of the
  2026-10-27 study). Apply every revision at its own time plus latency; report every reading of ambiguous text.
  Lucas rewrote a "move stop" instruction after the dip that had stopped it out; the final text is hindsight.
- **Audit claims on the closing side, from the fill.** Lucas's sell claims quoted prices only the bid reached
  (0 of 9 reachable on the ask). A "price reached" check must start at the first possible fill, not at signal time.
- **Check price at posting.** -1004427167750 posted BUYs with price already past TP1; dannygen posted a SELL with
  price already beyond its stop. A "TP1 HIT" minutes later then proves nothing.
- **Public previews can be bulk-repost farms**: count distinct timestamps. 698 posts in 116 timestamps means post
  time is not signal time.
- **Channel or group?** Use the stored raw message (`Post` true, no `FromID`) before analysing a chat.
- **"0 signals" may only mean "not in the recorded window".** GAB FX looked signal-free on 1 recorded day and had
  303 gold signals in its full history. State the window with every count.
- **Edits after the outcome.** GAB edited 124 of 126 signals (median 25 min after posting), 66 after the trade
  had ended. Only the final text survives a history fetch, so a replay is a best case for the provider.
- **Bought engagement and scam funnels.** Views jumping from single digits to thousands overnight, identical
  reaction counts per emoji, poll voters far below viewers, and "trading bot" deposit offers. Report them as
  Inferred, from Verified counts.
- **Tick vs M1 validation needs the same fill minute.** Entering 20 s after the post on ticks but at the next
  minute's open on M1 bars moves fills by 1 to 3 USD and makes the bars look wrong (50-70% agreement). With the
  same fill minute: 100% same exit type, ticks 0.2 to 0.5 USD worse per leg (stop slippage).
- **Tightest trail "wins" = no trend to ride.** If the best trail is the smallest tested, the runner is really a
  fixed take-profit. Say so instead of calling it a trailing strategy.
- **Pick on early months, score on later.** The GAB ladder's best case (+1.2 USD per signal over May-Oct) lost
  in every lot size when the trail was chosen on May-Jul and scored on Aug-Oct.
- **Go parser `expandShortRange`** turns "4010.5 - 4008" into 44008. Do not feed full-price descending ranges to it.
