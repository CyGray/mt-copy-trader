# Owner action: supply data for GAB FX and LUCAS GOLD LEGEND

> **Correction 2026-10-28:** statements here that GAB FX posts no signals describe only the 1 day the forwarder
> had recorded. Its full history has 303 gold signals, and its own May-Oct signals lose money (`REPORT_GAB_LIVE.md`).
> The owner's ladder plan is in `REPORT_GAB_LADDER.md`; it runs on the demo account since 2026-10-29
> (`deploy_gab_demo/README.md`).

Both channels lack the history needed for a verdict. The research session may not open Telegram, so only you
can supply it. This page lists the smallest steps; each is optional and independent.

## What is already happening (nothing to do)

The Go forwarder (`bytrader-go-forwarder`) records every chat that is not on the blocked list
(`telegram.allowed_chat_ids` is empty, which means "all", and neither chat is blocked). It has stored every new
message and every edit revision of both channels since about 2026-10-26 00:00 UTC, with the hash-keyed ids this
pipeline reads. **Do not add either chat to the blocked list, and do not add them as AutoTrader source chats.**

At the rate seen on 2026-10-26:

| Channel | Signals seen per day | Days to reach 160 signals (protocol minimum) |
|---|---|---|
| LUCAS GOLD LEGEND (free channel) | 2 | about 80 trading days, i.e. mid-February 2027 |
| GAB FX | 0 ("signals only inside circle") | never: this channel does not post signals |

## Option A (fastest for LUCAS): Telegram Desktop export of the channel history

The free channel's message ids reach 23,252, so its history probably holds hundreds of signals.

1. On your own computer, open Telegram Desktop with the account that is a member of LUCAS GOLD LEGEND.
   Use the desktop app's export; do **not** log in anywhere new, and do not use the server's session.
2. Open the channel → ⋮ menu → **Export chat history**.
3. Untick photos, videos, voice messages, stickers and files. Format: **Machine-readable JSON**. Period: all time.
4. Copy the resulting `result.json` to the server as
   `/home/kyle/projects/ByTrader/.data/exports/lucas_gold_legend_result.json` (create the folder; it is
   outside git). For GAB FX, do the same into `gabfx_result.json` only if you want the marketing history
   checked; it will not contain signals.
5. Tell the research session. It runs:
   ```
   python3 -I analysis/a1/load_tdesktop_export.py <result.json> -1002371904451 <workdir>/lucas_revisions.json
   ```
   This step validates the file and refuses it if the channel id does not match or a message lacks
   `date_unixtime`. The rest of the pipeline then runs unchanged (`analysis/README.md`).

Fields the loader requires on every message: `id`, `type`, `date_unixtime` (UTC), `text` (a string or a list of
strings and `{type, text}` entities). Optional: `edited_unixtime`, `reply_to_message_id`, `photo`/`file`/
`media_type`, `forwarded_from`. The plain `date` field is in your computer's local time and is ignored.

**Limit:** an export contains only the **final** text of each message. First-seen levels and the edit history
are Unknown, and the final text can embed hindsight; the earlier provider's late edits did. So export history
supports a train / validation / first out-of-sample test. The forwarder's own recording (which keeps every
revision) then provides the second, independent out-of-sample period.

## Option B: wait for the forwarder's recording

No action. Ask for the refresh run once at least 160 Lucas signals are stored, or earlier for a
low-power look. The pre-registration in this folder already fixes the protocol, so it cannot be tuned
after the fact.

## GAB FX: what would be needed

The channel advertises a paid "circle" where the signals are posted. Testing GAB FX means giving the research
an export (Option A) of **that** paid group, which requires membership. On the evidence here this study does
**not** recommend paying for it. The public channel posts unverifiable profit claims and a forwarded
crypto "trading bot" offer promising USD 300 → 5,500 in 3 days. That pattern is typical of investment scams.

## Things this study did NOT change (decisions still yours)

- `settings/default.safety.max_spread_price` is 0.5. Every draft profile so far, including the Lucas one, needs
  1.0 to pass safety. Vantage XAUUSD showed 0.29 USD during the Asian session on 2026-10-27; the London and
  New York spreads are still unmeasured.
- The live Go parser does not read the Lucas format (it returned `missing_entry` for the signal message). A
  parser change is a code change for the Go service and needs your approval. The research parser
  (`analysis/a1/parser_multi.py`) shows the format.
- No profile was activated, no source chat was added, no setting was changed.
- A previous hub session (task 3784d888) built a Go `dialogsreader` program that opens the stored Telegram
  session. It was not run here. A second client on the forwarder's session risks invalidating it. The Node
  session was invalidated on 2026-10-25 with `AUTH_KEY_UNREGISTERED`. Consider deleting that binary.
