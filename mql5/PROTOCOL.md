# VantageBridgeEA protocol v2

EA-side reference for `mql5/VantageBridgeEA.mq5` (version `2.0.0`).
The authoritative interface spec is `docs/project_memory/VANTAGE_DESIGN_CONTRACTS.md` section 1.
Where this file and that spec disagree, the spec wins and this file needs fixing.
Interpretation choices made in the EA are listed in [Decisions](#decisions-where-the-spec-left-room).

## Transport

- ZeroMQ REQ (Node `mt5Client`) to REP (EA). Default endpoint `tcp://127.0.0.1:5555`, localhost only.
- Strict alternation: each request gets exactly one reply, including for malformed JSON.
- The EA binds the socket in `OnInit` and drains requests from two places:
  - `OnTimer`, set with `EventSetMillisecondTimer(InpPollIntervalMs)`, clamped to at least 10 ms.
  - `OnTick`.
- Each pass reads at most 20 queued requests with `ZMQ_DONTWAIT`.
- Requests are processed while the market is closed, so `PING` and read-only actions work outside trading hours.

## Time bases

| Field | Basis | Used for |
|---|---|---|
| `expires_at` | `TimeGMT()`, unix seconds | Mutating actions only. Refused with 5009 once `TimeGMT() > expires_at`. |
| `expiration` (ORDER_SEND, pending) | `TimeCurrent()`, server time, unix seconds | Pending order expiry. Must be in the future or 4001. |
| `from` / `to` (GET_DEALS) | `TimeCurrent()`, server time, unix seconds | History window. Deal times are server time, not GMT. Pass a generous window. `to` defaults to now + 60 s. |
| `server_time`, `gmt_time` (PING) | both | Use these to measure skew between Node, the broker server clock, and `TimeGMT()`. |

`TimeGMT()` is MT5's estimate derived from the broker's server offset. It is not an NTP clock.
Verify on Vantage that `PING.gmt_time` tracks Node's UTC clock closely before relying on `expires_at`. Node sets `expires_at = now + 8`.

## Envelope

Request:

```json
{"v":2,"request_id":"<=48 chars","action":"ORDER_SEND","expires_at":1760000008, "...params"}
```

- `v` must be `2`. Missing or other values return 4001.
- `request_id` is echoed in every reply. An empty id is allowed but disables replay protection.
- `expires_at` must be present and `> 0` on mutating actions. Missing returns 4001.

Reply:

```json
{"ok":true,"retcode":0,"request_id":"...","replayed":false,"data":{...}}
{"ok":false,"retcode":10016,"error":"Invalid stops","request_id":"...","replayed":false,"data":{}}
```

- `retcode` is 0 on success. On failure it is the EA retcode (4xxx/5xxx) or the broker retcode.
- `data` is always present (`{}` when empty).

Mutating actions: `ORDER_SEND`, `POSITION_MODIFY`, `ORDER_MODIFY` (alias), `PENDING_MODIFY`, `CLOSE_POSITION`, `CANCEL_ORDER`.

## Retcodes

| Code | Meaning |
|---|---|
| 0 | Success (EA level). Order success is reported in `data.retcode` (broker code). |
| 4001 | Malformed JSON, missing `v`/`action`/required field, unknown action or order type, bad expiry, or CTrade did not send the request (broker retcode 0). |
| 5001 | Terminal not connected to the trade server. |
| 5002 | Trading not allowed: terminal AutoTrading, MQL program trading, account trading, or expert trading. |
| 5003 | Symbol trade mode forbids the operation. |
| 5004 | Invalid volume: below min, above max, not a step multiple, or remaining volume below min. |
| 5005 | Invalid stops: wrong side, inside the stops level, or inside the freeze level. |
| 5006 | Not owned: the position or order magic is not `InpMagicNumber`. |
| 5007 | Unknown symbol. |
| 5008 | Position or order not found, or ticket is the wrong kind (market vs pending). |
| 5009 | Request expired (`TimeGMT() > expires_at`). |
| 5010 | Request `magic` does not equal the EA magic. |

Broker retcodes pass through unchanged (for example 10004 requote, 10006 rejected, 10016 invalid stops, 10019 no money).
Success for order operations is broker retcode 10008 (PLACED), 10009 (DONE) or 10010 (DONE_PARTIAL).
`10018` is returned by the EA without sending when no quote is available (market closed).

## Actions

Examples are abbreviated. Prices and tickets are illustrative.

### PING

Does not require `expires_at`.

```json
{"v":2,"request_id":"p1","action":"PING"}
```
```json
{"ok":true,"retcode":0,"request_id":"p1","replayed":false,"data":{"server_time":1760000000,"gmt_time":1759992800,"ea_version":"2.0.0","magic":98801,"terminal_connected":true,"terminal_trade_allowed":true,"mql_trade_allowed":true}}
```

### ACCOUNT_INFO

Fields: `login`, `trade_mode` (DEMO/CONTEST/REAL), `margin_mode` (NETTING/EXCHANGE/HEDGING), `currency`, `balance`, `equity`, `margin`, `margin_free`, `margin_level`, `leverage`, `trade_allowed`, `trade_expert`, `terminal_trade_allowed`, `server`, `company`.

`login` is the account number. It is returned on the localhost socket only and is never logged.

### SYMBOL_INFO

```json
{"v":2,"request_id":"s1","action":"SYMBOL_INFO","symbol":"XAUUSD","auto_suffix":true}
```

With `auto_suffix: true` the EA tries `""`, `"+"`, `".raw"`, `".Raw"`, `"m"`, `"pro"` in that order, regardless of `InpAutoSuffix`. The reply's `symbol` is the resolved name.

Data fields: `symbol`, `digits`, `point`, `tick_size`, `tick_value`, `tick_value_profit`, `tick_value_loss`, `contract_size`, `volume_min`, `volume_max`, `volume_step`, `volume_limit`, `stops_level`, `freeze_level` (both in points), `trade_mode`, `execution_mode`, `filling_fok`, `filling_ioc`, `bid`, `ask`, `spread_points`, `tick_time_msc`, `currency_profit`, `currency_margin`.

Unknown symbol returns 5007.

### GET_POSITIONS

```json
{"v":2,"request_id":"gp1","action":"GET_POSITIONS","symbol":"XAUUSD","magic":98801}
```
```json
{"ok":true,"retcode":0,"request_id":"gp1","replayed":false,"data":{"positions":[{"ticket":123456789,"identifier":123456789,"symbol":"XAUUSD","type":"BUY","volume":0.01,"open_price":2650.12,"price_current":2651.40,"sl":2640.00,"tp":2660.00,"profit":1.28,"swap":0.00,"magic":98801,"comment":"tg_-100123_456","time_open":1759999000,"time_update_msc":1759999000123}],"count":1}}
```

`symbol` and `magic` are optional filters. Without a magic filter, positions from other EAs and manual trades are returned too. Check `magic` yourself.

`price_current` is `POSITION_PRICE_CURRENT` (Bid for BUY, Ask for SELL).

### GET_ORDERS

```json
{"v":2,"request_id":"go1","action":"GET_ORDERS","symbol":"XAUUSD","magic":98801}
```

Each order has `ticket`, `symbol`, `type` (BUY_LIMIT, SELL_LIMIT, BUY_STOP, SELL_STOP, or OTHER), `volume_initial`, `volume_current`, `price_open`, `sl`, `tp`, `magic`, `comment`, `time_setup`, `time_expiration`.

### GET_DEALS

```json
{"v":2,"request_id":"gd1","action":"GET_DEALS","from":1759900000,"to":1760000000,"magic":98801}
```

`from` is required. `to` defaults to `TimeCurrent() + 60`. `from` after `to` returns 4001.
Each deal has `ticket`, `order`, `position_id`, `symbol`, `type` (BUY/SELL/OTHER), `entry` (IN/OUT/INOUT/OUT_BY), `volume`, `price`, `profit`, `commission`, `swap`, `fee`, `magic`, `comment`, `time`, `time_msc`, `reason` (CLIENT/EXPERT/SL/TP/SO/MOBILE/WEB/OTHER).

### ORDER_CHECK

Read-only. Runs `OrderCheck` with the same request shape as ORDER_SEND. No trading gates and no duplicate guard.

```json
{"v":2,"request_id":"oc1","action":"ORDER_CHECK","symbol":"XAUUSD","order_type":"BUY","volume":0.01,"price":0,"sl":2640.0,"tp":2660.0,"deviation":20}
```

`ok` is true only when the MQL `OrderCheck` retcode is 0. Otherwise `ok` is false, `retcode` is the check retcode, and `error` carries the check comment.

```json
{"ok":true,"retcode":0,"request_id":"oc1","replayed":false,"data":{"retcode":0,"margin":104.12,"margin_free":4000.00,"balance":5000.00,"equity":5000.00,"comment":"Done"}}
```

### ORDER_SEND

```json
{"v":2,"request_id":"os1","action":"ORDER_SEND","expires_at":1760000008,"symbol":"XAUUSD","order_type":"BUY","volume":0.01,"price":0,"sl":2640.00,"tp":2660.00,"deviation":20,"comment":"tg_-100123_456","magic":98801}
```

`order_type` is one of `BUY`, `SELL`, `BUY_LIMIT`, `SELL_LIMIT`, `BUY_STOP`, `SELL_STOP`. `price` is required for pending orders and ignored for market orders. `magic` is optional and must equal the EA magic (5010). `expiration` is optional, for pending orders only.

Success (market):

```json
{"ok":true,"retcode":0,"request_id":"os1","replayed":false,"data":{"retcode":10009,"order":123456789,"deal":123456790,"position":123456789,"price":2650.12,"volume":0.01,"duplicate":false}}
```

Success (pending with expiry):

```json
{"ok":true,"retcode":0,"request_id":"os2","replayed":false,"data":{"retcode":10008,"order":123456800,"deal":0,"position":0,"price":2640.00,"volume":0.01,"duplicate":false,"expiration_applied":true}}
```

`expiration_applied` is present whenever `expiration > 0`. It is `false` when the symbol does not allow `ORDER_TIME_SPECIFIED` (the order falls back to GTC) and for market orders.

Duplicate (same comment and EA magic already open, pending, or traded in the last 7 days):

```json
{"ok":true,"retcode":0,"request_id":"os3","replayed":false,"data":{"retcode":0,"order":123456789,"deal":123456790,"position":123456789,"price":2650.12,"volume":0.01,"duplicate":true,"duplicate_of":"position"}}
```

`duplicate_of` is `position`, `order` or `deal`. No order is sent. `retcode` 0 means the broker was not called.

Pre-check order (each failure returns immediately):

1. Field validation: `order_type` (4001), `volume` present (4001), `price` for pending (4001), `expiration` not in the past (4001).
2. Terminal, AutoTrading, MQL trade, account trade and expert trade flags (5001 / 5002).
3. `magic`, if present, equals the EA magic (5010).
4. Symbol exists and can be selected (5007).
5. Duplicate guard (see below).
6. Symbol trade mode (5003): `DISABLED` blocks everything. `CLOSEONLY` blocks all entries. `LONGONLY` blocks sell-side entries. `SHORTONLY` blocks buy-side entries.
7. Volume: `> 0`, at least `volume_min`, at most `volume_max`, and a multiple of `volume_step` within `1e-6` (5004).
8. Stops (5005), applied to the normalised SL and TP when non-zero:
   - BUY: SL below and TP above the reference. SELL: the reverse.
   - Market reference: Bid for BUY, Ask for SELL. Pending reference: the pending price.
   - Distance from the reference must be at least `stops_level * point`.

Filling: market orders use FOK if the symbol allows it, else IOC, else RETURN. Pending orders always use RETURN.

Expiration: `ORDER_TIME_SPECIFIED` only when `expiration > 0`, the order is pending, and `SYMBOL_EXPIRATION_MODE` includes `SPECIFIED`. Otherwise `ORDER_TIME_GTC`.

Prices are normalised with `NormalizeDouble(x, digits)` before checks and sending. Market prices are Ask for BUY and Bid for SELL.

Position resolution: on a market fill, `position` is `DEAL_POSITION_ID` of the deal (`HistoryDealSelect` then `HistoryDealGetInteger`). It is `0` for pending orders.

### POSITION_MODIFY (alias ORDER_MODIFY)

```json
{"v":2,"request_id":"pm1","action":"POSITION_MODIFY","expires_at":1760000008,"ticket":123456789,"sl":2645.00,"tp":2660.00}
```

Owned only (5006). Missing `sl` or `tp` keeps the current value. Setting a value to `0` removes it.

If both values equal the current ones (after normalisation), the reply is success with no broker call:

```json
{"ok":true,"retcode":0,"request_id":"pm1","replayed":false,"data":{"ticket":123456789,"retcode":0,"sl":2645.00,"tp":2660.00,"unchanged":true}}
```

Otherwise the EA checks, against the current Bid (BUY) or Ask (SELL):

- Side and stops level (5005) for each changed SL or TP.
- Freeze level (5005) for each changed field whose current value is non-zero. The current value must not be inside `freeze_level * point` of the market.

Success: `{"ticket":...,"retcode":10009,"sl":...,"tp":...,"unchanged":false}`.

### PENDING_MODIFY

```json
{"v":2,"request_id":"pdm1","action":"PENDING_MODIFY","expires_at":1760000008,"ticket":123456800,"price":2638.00,"sl":2630.00,"tp":2650.00}
```

Owned only (5006). `price`, `sl` and `tp` are optional and default to the current values. Stops are checked against the new price. Freeze is checked only when the price changes, against the current pending price and the market (Ask for BUY types, Bid for SELL types). Reply: `{"ticket","retcode","price","sl","tp","unchanged"}`.

### CLOSE_POSITION

Full close:

```json
{"v":2,"request_id":"cp1","action":"CLOSE_POSITION","expires_at":1760000008,"ticket":123456789}
```

Partial close:

```json
{"v":2,"request_id":"cp2","action":"CLOSE_POSITION","expires_at":1760000008,"ticket":123456789,"volume":0.005}
```

Owned only (5006). `volume` absent or `0` closes everything. `volume` equal to the position volume is also a full close. For a partial close, `volume` must pass the volume checks (5004) and leave at least `volume_min` remaining.

Reply: `{"ticket","retcode","deal","closed_volume","price","remaining_volume"}`. `remaining_volume` is re-read after the close and is `0` when the position is gone.

### CANCEL_ORDER

```json
{"v":2,"request_id":"co1","action":"CANCEL_ORDER","expires_at":1760000008,"ticket":123456800}
```

Owned only (5006). Market orders return 5008. Reply: `{"ticket","retcode"}`.

## Expiry, replay and duplicate guard

### Expiry (`expires_at`)

- Mutating requests with `TimeGMT() > expires_at` are refused with 5009 before any trading check, so a late request is not sent to the broker.
- Guarantees: a request the EA receives after its expiry is never sent by the EA.
- Does not guarantee: a request the EA sent before expiry will not execute late. Once `OrderSend` is called, the broker may fill it after the timeout. Expiry only bounds the window in which the EA accepts the request.

### Replay cache

- A ring buffer of 256 `(request_id -> reply)` entries for mutating actions. Replies are cached for success and error alike.
- A repeated non-empty `request_id` returns the cached reply with `"replayed":true` and does not execute. The cache is checked before the expiry check, so a replay after expiry still returns the cached reply.
- Guarantees: within one EA process lifetime, a mutating request id that was processed is executed at most once, and only while it is still among the last 256 mutating requests.
- Does not guarantee:
  - Anything across an EA restart. The cache is in memory. After a restart, a re-sent id within its expiry window executes again. The duplicate guard is the second line of defence.
  - Matching on content. Only the id is compared. A different request reusing an id gets the old reply.
  - Protection for empty ids.

### Duplicate guard (ORDER_SEND)

- Before any send, the EA looks for an open position, pending order, or deal from the last 7 days where `comment` is identical and the magic equals the EA magic. If one is found, it returns `duplicate:true` and does not send.
- Guarantees: a signal whose comment is already visible in the terminal's positions, orders or history is not sent twice, even when the request id is new.
- Does not guarantee:
  - Correct behaviour if the broker alters comments. The comparison is exact. MT5 and the broker may truncate or rewrite comments. Commonly, order comments are limited to about 31 characters. Keep comments short and verify on Vantage.
  - Protection across magic numbers or symbols. Only the EA magic is checked; the symbol is not.
  - Protection after 7 days, or for a comment that matches a closed trade older than 7 days.
  - Protection if the first order was never executed (for example it was rejected or the EA restarted before sending). Then the retry goes ahead, which is correct.

### Interaction

The three mechanisms work together. Replay covers a timed-out request that is re-sent within one EA lifetime. Expiry bounds how long the EA accepts a request. The duplicate guard covers a new request for a signal that already executed, including after an EA restart. Node should still treat a timeout on a mutating call as ambiguous and reconcile through `GET_POSITIONS`, `GET_ORDERS` and `GET_DEALS`, not by blind retry.

## Decisions where the spec left room

- Duplicate guard placement: after symbol existence and before trade mode, volume and stops. A retry of an executed signal returns the existing references even if the market has moved.
- Market stops reference: Bid for BUY and Ask for SELL, for both SL and TP (as the spec says).
- Freeze level: applied to the current SL, TP or pending price being changed, against the market price.
- `expiration` in the past returns 4001. It is not silently changed to GTC.
- `expiration` uses server time. The spec does not state a basis.
- `expiration_applied` appears whenever `expiration > 0`.
- 4001 also covers the case where CTrade did not send (`ResultRetcode` 0). Broker code 0 is never reported as a success.
- `ORDER_CHECK` has no trading gate and no duplicate guard. It is a read-only probe.
- Replies for mutating requests are cached whether they succeeded or failed.
- `GET_POSITIONS` and `GET_ORDERS` do not filter by EA magic by default.
- `PENDING_MODIFY` returns `price`, `sl` and `tp` in addition to `ticket` and `retcode`.

## Verify on Vantage before relying on this

1. Comment preservation: place a minimum-size order with a long comment and confirm `GET_POSITIONS`, `GET_ORDERS` and `GET_DEALS` return it unchanged. Find the maximum length.
2. Filling modes: check `filling_fok` and `filling_ioc` from `SYMBOL_INFO` for XAUUSD, and that pending orders with RETURN are accepted.
3. Expiration: confirm `SYMBOL_EXPIRATION_MODE` for XAUUSD includes SPECIFIED, and that the server-time expiry is accepted.
4. Stops and freeze levels: read `stops_level` and `freeze_level` for XAUUSD and confirm the EA's 5005 pre-checks agree with the broker's own rejections (invalid stops, modification denied near the freeze level). Log any broker retcode the pre-checks did not catch.
5. Clock skew: compare `PING.gmt_time` and `PING.server_time` against Node's UTC clock and the broker's offset.
6. Margin mode: confirm `ACCOUNT_INFO.margin_mode`. The position-id semantics in `CLOSE_POSITION` and `position` in ORDER_SEND assume either netting or hedging (see `ACCOUNT_INFO.margin_mode`).
7. History depth: confirm the broker keeps at least 7 days of deals for the duplicate guard, and that `GET_DEALS` returns server-time deals in the window Node passes.
