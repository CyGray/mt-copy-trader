# Telegram Chats & Accounts

Reference IDs for the Telegram entities ByTrader listens to, forwards to, or ignores. Resolved from the authenticated worker account `Fritzgioranztayo` (`5841696614`) on 2026-09-22.

Prefer the numeric IDs in code and config — titles and usernames change, IDs do not.

## Signal source

| Title | ID | Type | Notes |
| --- | --- | --- | --- |
| VIP group | `-1003271337051` | Broadcast channel | Gold (XAUUSD) signal source. Read-only for us. Signals follow the `BUY\|SELL POSITION XAUUSD` + `OPEN/ENTRY` + `SL` + `TPn` template. |

## Signal destination

| Title | ID | Type | Notes |
| --- | --- | --- | --- |
| Marine Trader FX | `-1002350471397` | Broadcast channel | Default forward target. Account is creator with `postMessages`. |
| Marine Trader FX Discussion | `-1002326484593` | Supergroup | Linked discussion group. Account is creator/admin. |

## Related chats

| Title | ID | Type | Notes |
| --- | --- | --- | --- |
| Marine Trader BT | `-1002304026307` | Broadcast channel | Backtest channel. Account is creator with `postMessages`. |
| ULTM8X Digitraders | `-1003684806144` | Broadcast channel | Captured by the listener. |
| Gen Wealth VIP | `-1003546335047` | Broadcast channel | Captured by the listener. |

## Blocked chats

Configured in `settings/default` → `telegram.blocked_chat_ids`. Messages from these are dropped before parsing:

- `-1002725939599`
- `-1003192025181` (Bills trading)
- `-1001987669185`
- `-1001645497300`
- `-1002483210299`
- `-1001537427825`

## Test user

See [TESTING.md](./TESTING.md) — `@binsent_404` (`8356138890`).

## Configuration

Signal forwarding reads `settings/default` in Firestore under `telegram`, falling back to the defaults in `worker/src/lib/signalForwarding.ts`:

| Field | Default | Purpose |
| --- | --- | --- |
| `telegram.signal_forward_enabled` | `true` | Master switch for forwarding parsed signals. |
| `telegram.forward_chat_id` | `-1002350471397` | Destination chat for forwarded signals. |
| `telegram.signal_source_chat_ids` | `["-1003271337051"]` | Chats whose parsed signals are forwarded. |
