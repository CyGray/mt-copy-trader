# Wildcard: every other chat the account receives (2026-10-27)

> **Correction 2026-10-28:** statements here that GAB FX posts no signals describe only the 1 day the forwarder
> had recorded. Its full history has 303 gold signals, and its own May-Oct signals lose money (`REPORT_GAB_LIVE.md`).
> The owner's ladder plan is in `REPORT_GAB_LADDER.md`; it runs on the demo account since 2026-10-29
> (`deploy_gab_demo/README.md`).

Owner authorisation: check other **channels** (not personal chats), first a preliminary "is it a signal channel?"
check, then a deep analysis where it is. Everything was read-only: the Go store (`mode=ro`), Firestore
(budgeted, 777 reads in this pass, 779 over the whole study, 0 writes) and public market data. No Telegram connection.

## 1. Inventory and channel test

A chat counts as a channel when its messages are channel posts (`Post = true`, no author `FromID`), checked in the
stored raw message.

| Chat id | Where stored | Kind (Verified) | Messages seen | Prelim: signal channel? |
|---|---|---|---|---|
| -1003271337051 | Go store, Firestore | channel | earlier provider (own study) | already studied: no edge |
| -1002371904451 | Go store | channel | LUCAS GOLD LEGEND | see `REPORT_LUCAS_DEEP.md` |
| -1003740937489 | Go store | channel | GAB FX | no (0 signals; `REPORT_GABFX.md`) |
| **-1004426286726** | Go store + Firestore (680 docs) | channel ("dannygenwealth" VIP funnel) | 725 messages, 2026-09-23..10-27 | **no**: 1 signal in 725 messages |
| **-1004427167750** | Firestore only (14 docs) | channel | 12 messages, 2026-10-12..14 | **yes**, but only 3 signals were ever received |
| -1004479116422 | Firestore only | **not a channel** (messages from another peer; members chatting) | 15 | excluded |
| -1003546335047 | Go store + Firestore | **group** (3,027 user-authored messages) | n/a | excluded (not a channel) |
| -1003684806144 | Go store + Firestore | **group** (user-authored) | n/a | excluded (not a channel) |
| 8677602067 | Go store | personal chat | n/a | excluded |

Blocked chats (`telegram.blocked_chat_ids`) are not stored and could not be checked.

## 2. -1004426286726 ("dannygenwealth"): not a signal channel

- 725 messages over five weeks: VIP onboarding ("FREE VIP", "opening 5 spots"), TikTok live links, member
  testimonials, and boasts ("Boooommm TP4 hit", "VIPs are in from 4019.5, up 60 pips") with no stop or targets.
- Exactly **one** complete signal (2026-10-15 13:18Z: SELL 4155, SL 4165, 8 TPs). **When posted, the market bid
  was 4166.94, already above its stop** (Verified on Dukascopy). It could not be traded: every entry model
  skips it. Verdict: no tradable signal stream; do not pay for the VIP on this evidence.

## 3. -1004427167750: a real signal channel, with only 3 signals received

Format (schematic, placeholder levels): `XAUUSD BUY NOW <a> <b>`, then `TP¹`…`TP⁵` lines, `TP. Open` and `SL <s>`,
followed later by short "TP1 HIT 40+ pips" claim posts. Parser `analysis/other/parse_other.py`, with a typo rule fixed before the outcomes
were looked at: "6160" is rebuilt to 4160 when within 10 USD of the first number. It fired on 2 of the 3 signals.
The account received nothing from this channel after 2026-10-14. It is not in the Go forwarder's channel state,
which suggests the account left it (Inferred).

**Price at posting (Verified, Dukascopy):**

| Signal | Zone / stop / TP1 | Entry-side price at posting |
|---|---|---|
| 2026-10-13 01:17 BUY | 4160-4162 / 4154 / 4166 | 4168.65: 6.65 above the zone and **already past TP1** |
| 2026-10-13 01:29 SELL | 4158-4160 / 4166 / 4154 | 4156.06: 1.94 below the zone (already moved toward TP1) |
| 2026-10-14 01:22 BUY | 4148-4150 / 4142 / 4154 | 4154.07: 4.07 above the zone and **already past TP1** |

The "TP1 HIT 40+ pips" posts that followed within minutes were true of a move that had happened before the signal
appeared. The 01:17 BUY was announced as "TP1 HIT" at 01:20, then fell into its zone and hit its stop at about
01:31. In between, at 01:29, the channel posted the opposite SELL. It never mentioned the stopped BUY.

**Pilot (Modeled, pre-registered fixed set, MID costs; n = 3, descriptive only):**

| Entry model | Fills | S_TP1 | S_TP2 | S_TP4\|M5 | Q_25x4 |
|---|---|---|---|---|---|
| E2 `pending_at_range` | 3 / 3 | -0.01 R | -0.35 R | +0.32 R | -0.14 R |
| E1 market within 2 USD | 1 / 3 | +0.21 R | -1.02 R | -0.01 R | -0.71 R |

Per signal (E2): one stop loss, one break-even or stop, one full win. Three trades say nothing about an edge.
**Verdict: Unknown, insufficient data. Pattern: signals posted after the move.**

## 4. What generalises

- Free "signal" channels in this account are, almost without exception, sales funnels: the signal count per
  message is tiny (GAB 0 of 36, dannygen 1 of 725, Lucas 2 of 54).
- Three recurring defects, each Verified on ticks: signals posted after the move (-1004427167750), a signal
  already past its stop (dannygen), and management instructions rewritten after the fact (Lucas).
- None of the channels gives enough data for a profitability test. The forwarder records the four channels it
  still receives (Lucas, GAB FX, dannygen, the earlier provider). Only Lucas posts structured signals regularly
  (about 2 per day).
