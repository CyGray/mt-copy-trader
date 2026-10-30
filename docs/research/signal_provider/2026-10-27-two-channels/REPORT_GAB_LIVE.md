# GAB FX: full live history, deep check (2026-10-28)

**Short answer: do not trade GAB FX and do not send it money.** The channel's main product is a crypto
"investment" offer with impossible returns. Its free gold signals do exist (earlier reports were wrong to say
there were none), but its own signals from May to October **lose money** under every entry and target choice
tested. Its "100% win rate" claims are false by the channel's own numbers.

Labels: **Verified** = counted directly from the live data or the price data. **Modeled** = result of a price
replay with stated assumptions. **Inferred** = a reasoned reading of verified facts. **Unknown** = not
recoverable from the data we have.

## 1. Correction to the earlier reports

`SUMMARY.md` (2026-10-27) said GAB FX posted **0 signals**. That was based on the 28 to 37 messages the
forwarder had recorded since 2026-10-26, and the forwarder only records messages that arrive after it started
listening. The live history contains **303 gold signals** and 102 other ones. The "0 signals" finding was true
for that window only and is withdrawn for the channel as a whole. (Verified)

## 2. How the data was obtained

- The owner authorized a live read on 2026-10-28 and logged in a **separate** Telegram session for it. The
  forwarder's session was not used, so its login could not be flagged as duplicated.
- Reader: `analysis/gab/gabread/main.go` (gotd, compiled offline against the forwarder's module cache). A
  middleware refuses every Telegram method that is not on a read-only allowlist: login, list chats, channel
  info, message history. Nothing was sent, joined, left, marked read or edited. The API id and hash are read
  from the env file and never printed.
- Fetched 2026-10-28 15:36Z: channel info, and all **5,231** messages (server count 5,231; ids 1 to 5,792)
  with text, edit time, forward header, links, buttons, media type, views, forward count, reactions, pin
  status and album id. The channel has no linked comment group. Raw data stays in the scratch folder, outside git.
- Prices: Dukascopy XAUUSD 1-minute **bid and ask** candles for 2026-02-08 to 2026-10-27 (public, 524 daily
  files). Check: on 387 outcomes where hourly ticks also exist, the 1-minute replay agrees with the tick replay
  387 − 5 = 382 times (98.7%). Earlier checks found Dukascopy within 0.02 to 0.17 of Vantage. (Verified)

## 3. What the channel is

| Fact | Value | Label |
|---|---|---|
| Created | 2026-02-02 (service message id 1) | Verified |
| Subscribers | 73,538 | Verified |
| Messages alive / ids used | 5,231 / 5,792; 561 ids deleted (9.7%) | Verified |
| Edited messages | 2,636 (50%); median edit 6 min after posting | Verified |
| Forwarded messages | 1,531 (29%) | Verified |
| Pinned | one post: the "TRADING BOT OPPORTUNITY" offer (71,298 views, the most viewed post by far) | Verified |
| Audience language | Malaysian slang and RM amounts; posts peak at 12:00Z (20:00 Malaysia time) | Inferred |

**Three phases** (Verified from hashtags, handles and templates):

1. **Feb to early Mar, "Uncle Din" branding.** Signals tagged `#UncleDinEntryPoint`, the `@uncledintrader`
   handle (88 mentions), a JustMarkets affiliate link (53). 28 gold signals.
2. **Mar to Apr, copied multi-symbol feed.** "SIGNAL ALERT" templates for gold, forex, BTC and indices, partly
   forwarded from a channel titled "VVip trading group" (218 forwards). 132 gold signals, 77 forex, 22 index or
   crypto. Promotions for other "gold" channels and an "INVEST $500 GET $20,000" offer appear.
3. **May to Oct, "GAB FX" branding.** Contact `@GABFXS001`, template "Gold BUY/SELL Now INSTANT" with an entry
   zone, two TPs and a stop. 126 gold signals. This is the channel's current product.

**Hooks (calls to action).** 48 "PM NOW" buttons; 146 "PM/contact" posts; 342 links to another signal channel
(`MichaelGoldFx_00`), plus other cross-promoted channels; WhatsApp, Instagram, YouTube and TikTok links; 50
polls ("2,000 VOTE AND I START" a Dubai bootcamp). (Verified)

**The money offer.** The pinned post, also self-forwarded 47 times, offers a "trading bot" that turns
USD 300 into 5,500 in 3 days, USD 1,000 into 16,000, or 1 BTC into 7 BTC in 5 days. It accepts BTC, USDT, ETH,
PayPal or Skrill and asks for **full name, nationality, e-mail and wallet address**. Other posts announce "USDT
payouts" to "investors" (146 payout or withdrawal posts, 8 with tronscan.org transaction links). Returns of
1,500% in 3 days do not exist in legitimate trading. (Offer: Verified. That it is an advance-fee or Ponzi-type
crypto scam: **Inferred**, high confidence. We did not and will not contact the channel.)

**Engagement looks bought** (Inferred from Verified counts):
- Feb to Apr: median **2 to 4 views** per post. From May the median jumps to 1,262 to 2,431, and the pinned
  offer reaches 71k views. That is consistent with a purchased audience or an ad push, not organic growth.
- Oct: median 655 views for 73.5k subscribers (0.9%).
- Reactions May to Aug: the top posts have almost identical counts on four emojis (for example 127, 127, 128,
  122). Reactions then collapse from 40,229 in Aug to 1,293 in Sep. That pattern matches bulk reaction services.
- Polls: the "2,000 votes" poll had 704 voters; earlier polls had 1 to 3 voters on posts with 40 to 680 views.
- "Testimonials": 1,012 forwards from named private users (221 names). 242 contain invisible filler
  characters. Many are payment chats ("Send your usdt wallet address sir", "I want to join the weekend
  investment with $1000").

**Claims vs. edits** (Verified, from the forwarder's own copies, 2026-10-26 to 10-28):
- Pips claims were **raised after posting**: "150PIPS" became "170PIPS"; "OUR BUY RUNNING 300PIPS" became
  "340PIPS".
- 12 recorded messages were later deleted, including a gold buy signal (re-posted as a forward of itself) and a
  "GIVING US 700PIPS" post.

## 4. Do the signals make money?

Replay rules (Modeled): the follower acts **20 s** after posting. Fills use bid and ask (spread included).
Horizon 24 h; every trade settled within 24 h, and 72 h gives identical results.
- **market** = enter at the next minute's open.
- **level** = a limit order at the near edge of the posted zone, valid 4 h.
- If a target was already passed when the follower could act, the trade counts as *missed* (a broker rejects
  that TP). Same-minute stop and target ties are scored both ways; the range is shown as pess/opt where it differs.
- R = result divided by the initial risk. Duplicate reposts (13) and impossible levels (4 provider typos) are excluded.

| Phase (gold signals) | Rule | Trades | Win rate | Mean R (95% CI) | Profit factor | Label |
|---|---|---|---|---|---|---|
| **May to Oct, GAB FX own (126)** | market, all at TP1 | 112 | 66% | **−0.11** (−0.23 to 0.00) | 0.63 | Modeled |
| | market, all at TP2 | 124 | 54% | **−0.13** (−0.29 to +0.01) | 0.70 | Modeled |
| | level, all at TP1 | 117 | 60 to 61% | **−0.07 to −0.06** (−0.21 to +0.08) | 0.82 to 0.85 | Modeled |
| | level, all at TP2 | 116 | 44% | **−0.11** (−0.30 to +0.09) | 0.80 | Modeled |
| Mar to Apr, copied feed (132) | level, all at TP1 | 122 | 87% | +0.15 (+0.03 to +0.28) | 2.15 | Modeled |
| | market, all at TP1 | 86 (46 missed) | 74% | +0.14 (−0.03 to +0.32) | 1.91 | Modeled |
| Feb to Mar, Uncle Din (28) | market, all at TP1 | 24 | 46% | −0.37 (−0.62 to −0.13) | 0.21 | Modeled |
| **All 286** | level, all at TP1 | 265 | 71% | 0.00 (−0.09 to +0.09) | 1.01 | Modeled |

By month (market, TP1), mean R: Feb −0.33, Mar +0.15, Apr +0.07, May +0.08, Jun +0.12, **Jul −0.20, Aug −0.08,
Sep −0.21, Oct −0.53** (Oct: 12 trades, 36% wins). (Modeled)

**Why it loses.** The posted geometry needs a very high hit rate (Verified from the posted levels):
- GAB-era signals risk a median **USD 10** per ounce for a TP1 that is **0.5×** the risk. At that ratio the
  break-even win rate is 67%, and the replay gets 60 to 66%.
- TP2 is still below 1× the risk.
- In the copied March and April feed, TP1 was 0.14× the risk (about USD 1.5 for a USD 14 stop). That makes its
  87% win rate look better than it is, and 46 of 132 signals were already past TP1 when a follower could act.

**Why the true result is probably worse** (Inferred):
- **Edits.** 124 of the 126 GAB-era signals were edited, a median 25 minutes after posting (p90 157 min). Under the
  market TP1 rule, 66 were edited after the trade had already ended: 54 after a TP, 12 after a stop. What changed is **Unknown**: Telegram
  keeps only the final text. The replay therefore uses the final, possibly corrected levels.
- **Deletions.** Deleted signals are invisible, so they cannot be scored. In the 5 ids after each signal, the
  deletion rate is similar for winners (0.38 per signal) and losers (0.40). So there is no evidence of
  *follow-up* posts being cleaned up after losses. Whether losing *signals* were deleted is Unknown, but at least
  one signal deletion is Verified (section 3).
- **Win posts after losses.** Of the 34 GAB-era signals that hit their stop (market TP1 rule), 28 were
  followed within 24 h by a "TP hit", "BOOOOM" or "100% WINRATE" post. The channel posted 70 "100% win rate"
  claims in total. The boasts are not tied to results (Verified counts, Inferred meaning).

**Not tested:** the 77 forex signals and the 22 index or crypto signals, all from the copied March and April
feed (Unknown). They are not the channel's current product.

## 5. Verdict

| Question | Answer | Label |
|---|---|---|
| Does GAB FX post signals? | Yes: 303 gold signals since February, about 5 a week from May to October | Verified |
| Are the current (May to Oct) signals profitable? | No. Negative mean R in every rule tested, profit factor 0.63 to 0.85, getting worse since July | Modeled |
| Best TP or trailing? | None makes it positive. TP1 loses least, but the edge is still below zero | Modeled |
| Lot size | Not applicable: do not trade it | n/a |
| Is the channel honest? | No. Claims are raised by edits; "100% win rate" contradicts the replay; engagement looks bought | Verified / Inferred |
| Is the "trading bot" or "circle" safe to pay? | No. It shows the hallmarks of a crypto investment scam | Inferred, high confidence |

## 6. Reproduce

```
analysis/gab/gabread/main.go         read-only Telegram reader (own session; allowlist middleware)
analysis/gab/gab_parse.py            parser for all 12 signal templates (Feb to Oct)
analysis/gab/get_m1.py               Dukascopy daily 1-minute bid/ask candles
analysis/gab/gab_sim_m1.py           replay (market/level x TP1/TP2/last, pessimistic/optimistic ties)
analysis/gab/gab_sim.py              tick replay used to validate the 1-minute replay
analysis/gab/gab_report_m1.py        aggregates, CIs, edits/deletions/claims checks
analysis/aggregates/gab_live_m1_h24.json   aggregate results (no per-trade rows)
```

The research Telegram session is still logged in. Revoke it with `gabread logout` (it revokes only that
session) or from Telegram › Settings › Devices ("ByTrader research reader").
