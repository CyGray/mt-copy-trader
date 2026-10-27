# Two new signal channels: plain-language summary (2026-10-27)

**Short answer: do not trade either channel. Neither can be judged yet, and one of them does not post
signals at all.**

## GAB FX (channel -1003740937489)

- **Profitable?** Unknown. The channel posted **no trade signals** in the day we have. Its own posts say the
  signals are only for a paid "circle". What it does post: profit boasts that cannot be checked, sales pitches,
  and a forwarded crypto "trading bot" offer promising USD 300 → 5,500 in 3 days, a typical scam pattern.
- **Best TP / trailing / lot size:** not applicable, there is nothing to trade.
- **What to do:** nothing. Do not pay for the "circle" on this evidence. Despite the name, the only prices it
  posted were for gold, not forex.

## LUCAS GOLD LEGEND (channel -1002371904451)

- **Profitable?** Unknown. This is the provider's **free** channel. We have one day: **2 gold signals**. In our
  simulation one hit its third target and the other hit its stop. Two trades say nothing about the long run.
- **Best TP / trailing:** not known. With 2 trades every choice is luck. The draft profile copies the provider's
  own plan (half at TP1 and stop to entry, rest at TP3) for a future *test*, not as advice.
- **Lot size:** if it is ever tested, risk 0.25% of equity per trade and skip a signal that would need less than
  0.01 lot. That makes the signals seen so far tradable from about **3,000 USD**; the provider's split plan needs
  about **7,000 USD**. At 1,000 USD every signal would be skipped.
- **Honesty check:** its recaps quote the best moment of a move, and they called a trade that hit its stop
  "break-even, +60 pips".
- **What to do:** let the forwarder keep recording (it already does, automatically). For a faster answer, export
  the channel's history from Telegram Desktop (`OWNER_ACTION.md`, about 10 minutes of your time).

## Comparison

| Provider | Signals tested | Mean result per trade (R) | 95% range | Label | Verdict |
|---|---|---|---|---|---|
| Earlier gold provider (-1003271337051), first out-of-sample test, conservative plan | 68 | +0.20 | -0.33 to +0.80 | Modeled | no edge shown |
| Same, second out-of-sample test (2026-09-24 .. 10-22) | 53 | **-0.66** | -0.79 to -0.52 | Modeled | losing |
| GAB FX | **0** | n/a | n/a | Verified (no signals) | Unknown, no data |
| LUCAS GOLD LEGEND, pilot (all at TP1 / provider plan) | **2** | -0.14 / +0.36 | -1.01 to +2.73 (meaningless at n = 2) | Modeled | Unknown, insufficient data |

R = profit or loss divided by the amount risked to the stop. Simulated on independent tick prices (Dukascopy),
with realistic spread and slippage costs ("MID"), not on the broker. Comparing three providers and keeping the
best would be a selection effect. After the Holm adjustment across the three, none shows a profit.

## The single recommended action

**Trade nothing. Keep the forwarder recording both channels.** If you want an answer about Lucas within days
rather than months, put a Telegram Desktop export of its channel history on the server (`OWNER_ACTION.md`,
option A). The rest of the analysis then runs in minutes under rules that were fixed before seeing any result.

Nothing was traded, restarted, activated or changed in this study.
