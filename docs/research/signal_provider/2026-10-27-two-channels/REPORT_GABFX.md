# GAB FX (channel -1003740937489): data audit and limits

**Verdict: Unknown, no data. There is nothing to trade: this channel posts no entry signals.** Its own text
says "SIGNALS ONLY INSIDE CIRCLE", meaning a separate paid group. Pre-registration: `PREREGISTRATION_GABFX.md`
(sha256 `2ab3fc2bc60217be4f921088ffd8ad5e44d188f1a94c1102181db434c224c42e`). Labels: **Verified** (observed),
**Modeled**, **Inferred**, **Unknown**.

## 1. Data audit

| Item | Value | Label |
|---|---|---|
| Source | Go forwarder SQLite store, `telegram_messages`, read-only | Verified |
| Window | 2026-10-26 00:05Z to 23:15Z (one day) | Verified |
| Messages / revisions | 28 messages (ids 5692-5719, no gaps), 37 revisions; 6 messages edited (median lag 268 s, max 6,200 s) | Verified |
| Earlier history | Firestore 0 docs; Node forwarder journal (2026-09-23 to 10-25) 0 events; no export on disk | Verified |
| Public mirror | `t.me/GABFXS001`, named in the posts, is a personal contact page with no channel preview; three handle guesses (`gabfx`, `gab_fx`, `gabfxsignals`) have no public preview | Verified |
| Instrument | Despite the name, the only levels posted are gold (zone map 4026-4030 / 4004-4000); "pips" are used for gold | Verified |

Message classes (hand-labelled, every message):

| Class | Messages |
|---|---|
| entry signal | **0** |
| zone map with levels but no stop or targets ("US SESSION MASTERMIND MAPPING") | 1 |
| result claims without a published signal ("170 PIPS. TP HIT. DONE INSIDE CIRCLE", "4K profit", "28,000 USD flipped to over 75,000") | 5 |
| marketing (1-on-1 mentoring, "10 slots left", bootcamp, contact handle) | 4 |
| third-party promotion: forwarded crypto "TRADING BOT" plan (USD 300 → 5,500 in 3 days; 1 BTC → 7 BTC in 5 days) | 1 |
| engagement (greetings) | 2 |
| media only (photo albums) | 15 |

Parser check: 0 signals expected, 0 parsed (no false positive on the zone map, which lacks a stop).
Message-class accuracy 0.82: the misses are marketing versus claim versus engagement wording, none involving
a signal. The brief asked for at least 50 hand labels per channel. The channel has only 28 messages, so all
28 were labelled (deviation).

## 2. Performance, strategy, robustness, sizing

Not applicable: no signal exists to simulate. The pipeline ran end to end on this channel and correctly produced
an empty universe (`universe_*.csv`: 0 rows).

## 3. Red flags (Verified as posted; the conclusion is Inferred)

- Profit claims ("120/170/180/200 pips", account "flipped" from 28,000 to 75,000 USD) are made about trades that
  were never published in this channel, so they cannot be checked. One claim was edited three times within six
  minutes (150 → 180 → 170 pips).
- A forwarded "trading bot" offer promising 18 to 16 times the money in 3 days. Returns like this are a
  hallmark of investment fraud.
- The main call to action is paid access (1-on-1, "circle", bootcamp), not verifiable trading results.

Conclusion (Inferred): this channel is a sales funnel. On this evidence the study does not recommend paying for
the "circle" or trading anything from this source.

## 4. What would change the verdict

An export of the paid group's history (`OWNER_ACTION.md`, option A), with at least 160 signals, run through the
pre-registered protocol. The symbol-generalised pipeline (FX decoding, per-symbol costs and contract sizes) is
ready in case that group trades forex.
