# Vantage AutoTrader — Design Contracts

Status: authoritative interface spec for the Vantage MT5 completion work
(2026-10-18). Every module below is implemented against this document. If code
and this document disagree, fix one of them deliberately and note it in
`VANTAGE_IMPLEMENTATION_PROGRESS.md`.

Pipeline (unchanged topology):

```
Telegram ─▶ Forwarder (index.ts, owns session)
              ├─▶ forward to destination channel (unchanged)
              └─▶ Firestore signal_events
                      │
                      ▼
            AutoTrader (autotrader.ts)
              signalFeed ─▶ mt5TradeEngine ─▶ brokerRouter ─▶ mt5Broker ─▶ mt5Client ─ZMQ─▶ VantageBridgeEA ─▶ MT5/Vantage
                                                         └▶ simulatedBroker (paper mode, tests)
              lifecycleManager / reconciler / adminCommands (same broker layer)
```

## 0. Ground rules (all modules)

- Legacy Bybit execution is **not invoked** from the Telegram path any more. The
  files stay on disk (AGENTS.md) but nothing calls `handleParsedSignal`.
- Price distances in profiles/safety are **price units** (e.g. `2.5` = 2.5 USD on
  XAUUSD), never "pips". Spread from the EA is converted with `point`.
- Volumes are computed in **integer step units** (`Math.round(v / step + 1e-9)`)
  to avoid float drift, and rendered with the step's decimal count.
- Every broker mutation is preceded by a Firestore write recording intent.
- A transport timeout on a mutating broker call is **ambiguous**, never
  "failed". The client never auto-retries a mutation.
- `initFirestore()` returns `null` and never throws; every caller no-ops on null.
- Significant paths log twice: `logger.*` and `writeSystemLog(...)`.
- Tests must never open a real ZeroMQ socket to `tcp://127.0.0.1:5555`; mock
  `zeromq` or inject a fake transport.
- **Do not write to `worker/dist/`.** Production services on this host run from
  it. Type-check with `npx tsc -p worker/tsconfig.json --noEmit`.

## 1. ZeroMQ protocol v2 (Node ⇄ VantageBridgeEA)

REQ (Node) / REP (EA) on `MT5_ZMQ_ENDPOINT` (default `tcp://127.0.0.1:5555`,
localhost only).

### Envelope

Request:
```json
{ "v": 2, "request_id": "<=48 chars", "action": "ORDER_SEND", "expires_at": 1760000000, ...params }
```
- `expires_at` (unix seconds, `TimeGMT()` basis) is **required on mutating
  actions**. EA rejects a mutating request with `retcode 5009` if
  `TimeGMT() > expires_at`. This bounds the window in which a timed-out request
  can still execute late. Node sets `expires_at = now + 8`.

Response:
```json
{ "ok": true,  "retcode": 0, "request_id": "...", "replayed": false, "data": { ... } }
{ "ok": false, "retcode": 10016, "error": "Invalid stops", "request_id": "...", "data": { ... } }
```
- EA keeps an in-memory ring buffer (256) of `request_id → response` for
  mutating actions. A repeated `request_id` returns the cached response with
  `"replayed": true` and does not re-execute.
- Mutating actions: `ORDER_SEND`, `POSITION_MODIFY`, `ORDER_MODIFY` (alias of
  POSITION_MODIFY), `PENDING_MODIFY`, `CLOSE_POSITION`, `CANCEL_ORDER`.

### Custom retcodes (EA-side, not broker)

| code | meaning |
|---|---|
| 4001 | malformed JSON / unknown action / missing field |
| 5001 | terminal not connected to trade server |
| 5002 | trading not allowed (terminal, MQL program, account, or expert) |
| 5003 | symbol trade mode forbids this operation |
| 5004 | invalid volume (min/max/step/remaining) |
| 5005 | invalid stops (side, stops_level, freeze_level) |
| 5006 | not owned (magic mismatch) |
| 5007 | unknown symbol |
| 5008 | position/order not found |
| 5009 | request expired |
| 5010 | magic in request does not equal EA magic |

Broker retcodes (`TRADE_RETCODE_*`, e.g. 10004 requote, 10006 rejected, 10016
invalid stops, 10019 no money) are passed through. Success for order
operations: broker retcode ∈ {10008 PLACED, 10009 DONE, 10010 DONE_PARTIAL}.

### Actions

`PING` → `{ server_time, gmt_time, ea_version:"2.0.0", magic, terminal_connected, terminal_trade_allowed, mql_trade_allowed }`

`ACCOUNT_INFO` → `{ login, trade_mode:"DEMO"|"CONTEST"|"REAL", margin_mode:"NETTING"|"EXCHANGE"|"HEDGING", currency, balance, equity, margin, margin_free, margin_level, leverage, trade_allowed, trade_expert, terminal_trade_allowed, server, company }`

`SYMBOL_INFO { symbol, auto_suffix?: bool }` → `{ symbol, digits, point, tick_size, tick_value, tick_value_profit, tick_value_loss, contract_size, volume_min, volume_max, volume_step, volume_limit, stops_level, freeze_level, trade_mode:"DISABLED"|"LONGONLY"|"SHORTONLY"|"CLOSEONLY"|"FULL", execution_mode:"REQUEST"|"INSTANT"|"MARKET"|"EXCHANGE", filling_fok, filling_ioc, bid, ask, spread_points, tick_time_msc, currency_profit, currency_margin }`
(`stops_level`/`freeze_level` are in points.)

`GET_POSITIONS { symbol?, magic? }` → `{ positions: [{ ticket, identifier, symbol, type:"BUY"|"SELL", volume, open_price, price_current, sl, tp, profit, swap, magic, comment, time_open, time_update_msc }], count }`
`price_current` is MT5 `POSITION_PRICE_CURRENT` (Bid for BUY, Ask for SELL).

`GET_ORDERS { symbol?, magic? }` → `{ orders: [{ ticket, symbol, type:"BUY_LIMIT"|"SELL_LIMIT"|"BUY_STOP"|"SELL_STOP", volume_initial, volume_current, price_open, sl, tp, magic, comment, time_setup, time_expiration }], count }`

`GET_DEALS { from, to?, magic?, position_id? }` (unix seconds) → `{ deals: [{ ticket, order, position_id, symbol, type:"BUY"|"SELL"|"OTHER", entry:"IN"|"OUT"|"INOUT"|"OUT_BY", volume, price, profit, commission, swap, fee, magic, comment, time, time_msc, reason:"CLIENT"|"EXPERT"|"SL"|"TP"|"SO"|"MOBILE"|"WEB"|"OTHER" }], count }`

`ORDER_CHECK { symbol, order_type, volume, price, sl, tp }` → `{ retcode, margin, margin_free, balance, equity, comment }` (`ok` true iff MQL `OrderCheck` retcode is 0).

`ORDER_SEND { symbol, order_type:"BUY"|"SELL"|"BUY_LIMIT"|"SELL_LIMIT"|"BUY_STOP"|"SELL_STOP", volume, price, sl, tp, deviation, comment, magic, expiration? }`
- Pre-checks in order: connected (5001) → trading allowed (5002) → magic equals EA magic (5010) → symbol exists (5007) → symbol trade mode (5003) → volume min/max/step (5004) → stops side + stops_level vs current Bid/Ask (market) or entry price (pending) (5005).
- **Duplicate guard**: if `comment` is non-empty and an open position, a pending order, or a deal in the last 7 days exists with EA magic and identical comment, return `ok:true` with `data.duplicate = true` and the existing refs; do not send.
- Filling: market orders use FOK if `SYMBOL_FILLING_FOK` allowed, else IOC if allowed, else RETURN. Pending orders use RETURN. Expiration: `ORDER_TIME_SPECIFIED` when `expiration > 0`, else GTC.
- Success data: `{ retcode, order, deal, position, price, volume, duplicate:false }`. `position` is the position ticket (from the deal's `DEAL_POSITION_ID`), `0` for pending orders.

`POSITION_MODIFY { ticket, sl, tp }` (also accepts action `ORDER_MODIFY`) — owned-only (5006); validates side and stops/freeze level against current Bid/Ask (5005); returns `{ ticket, retcode, sl, tp, unchanged }`.

`PENDING_MODIFY { ticket, price, sl, tp }` — owned-only; returns `{ ticket, retcode }`.

`CLOSE_POSITION { ticket, volume? }` — owned-only; `volume` absent/0 = full close; partial volume must respect step/min and leave remaining ≥ min (5004). Returns `{ ticket, retcode, deal, closed_volume, price, remaining_volume }`.

`CANCEL_ORDER { ticket }` — owned-only; returns `{ ticket, retcode }`.

Request processing happens in **`OnTimer` (EventSetMillisecondTimer)** and in
`OnTick`, so the bridge answers when the market is closed.

## 2. Broker layer (TypeScript)

`worker/src/lib/brokerTypes.ts`

```ts
export type OrderSide = 'BUY' | 'SELL';
export type BrokerOrderType = 'BUY' | 'SELL' | 'BUY_LIMIT' | 'SELL_LIMIT' | 'BUY_STOP' | 'SELL_STOP';
export type AccountTradeMode = 'DEMO' | 'CONTEST' | 'REAL';

export interface AccountInfo { login: number; tradeMode: AccountTradeMode; marginMode: 'NETTING' | 'EXCHANGE' | 'HEDGING'; currency: string; balance: number; equity: number; margin: number; marginFree: number; marginLevel: number; leverage: number; tradeAllowed: boolean; tradeExpert: boolean; terminalTradeAllowed: boolean; server: string; company: string; }
export interface SymbolInfo { symbol: string; digits: number; point: number; tickSize: number; tickValue: number; tickValueProfit: number; tickValueLoss: number; contractSize: number; volumeMin: number; volumeMax: number; volumeStep: number; volumeLimit: number; stopsLevelPoints: number; freezeLevelPoints: number; tradeMode: 'DISABLED' | 'LONGONLY' | 'SHORTONLY' | 'CLOSEONLY' | 'FULL'; bid: number; ask: number; spreadPoints: number; tickTimeMsc: number; currencyProfit: string; currencyMargin: string; }
export interface BrokerPosition { ticket: number; identifier: number; symbol: string; type: OrderSide; volume: number; openPrice: number; priceCurrent: number; sl: number; tp: number; profit: number; swap: number; magic: number; comment: string; timeOpen: number; }
export interface BrokerOrder { ticket: number; symbol: string; type: Exclude<BrokerOrderType, 'BUY' | 'SELL'>; volumeInitial: number; volumeCurrent: number; priceOpen: number; sl: number; tp: number; magic: number; comment: string; timeSetup: number; timeExpiration: number; }
export interface BrokerDeal { ticket: number; order: number; positionId: number; symbol: string; type: 'BUY' | 'SELL' | 'OTHER'; entry: 'IN' | 'OUT' | 'INOUT' | 'OUT_BY'; volume: number; price: number; profit: number; commission: number; swap: number; fee: number; magic: number; comment: string; time: number; reason: 'CLIENT' | 'EXPERT' | 'SL' | 'TP' | 'SO' | 'MOBILE' | 'WEB' | 'OTHER'; }
export interface PlaceOrderRequest { symbol: string; orderType: BrokerOrderType; volume: number; price: number; sl: number; tp: number; deviationPoints: number; comment: string; expiration?: number; }
export interface PlaceOrderResult { retcode: number; orderTicket: number; dealTicket: number; positionTicket: number; price: number; volume: number; duplicate: boolean; }
export interface CloseResult { retcode: number; dealTicket: number; closedVolume: number; price: number; remainingVolume: number; }
export interface OrderCheckResult { ok: boolean; retcode: number; margin: number; marginFree: number; comment: string; }

/** Broker answered and refused: the operation definitely did not happen. */
export class BrokerRejectedError extends Error { constructor(public retcode: number, message: string) }
/** Transport failure or timeout on a mutation: the operation MAY have happened. */
export class BrokerAmbiguousError extends Error { constructor(public action: string, message: string) }
/** Bridge unreachable before the request could be sent, or read-only call failed. */
export class BrokerUnavailableError extends Error {}

export interface BrokerAdapter {
  readonly kind: 'mt5' | 'simulated';
  readonly magic: number;
  ping(): Promise<{ eaVersion: string; terminalConnected: boolean; tradeAllowed: boolean; gmtTime: number }>;
  getAccountInfo(): Promise<AccountInfo>;
  getSymbolInfo(symbol: string): Promise<SymbolInfo>;
  getPositions(symbol?: string): Promise<BrokerPosition[]>;   // always filtered to this.magic
  getOrders(symbol?: string): Promise<BrokerOrder[]>;         // always filtered to this.magic
  getDeals(q: { fromSec: number; toSec?: number; positionId?: number }): Promise<BrokerDeal[]>; // magic-filtered
  checkOrder(req: PlaceOrderRequest): Promise<OrderCheckResult>;
  placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResult>;
  modifyPosition(ticket: number, sl: number, tp: number): Promise<{ retcode: number; unchanged: boolean }>;
  modifyPendingOrder(ticket: number, price: number, sl: number, tp: number): Promise<{ retcode: number }>;
  closePosition(ticket: number, volume?: number): Promise<CloseResult>;
  cancelOrder(ticket: number): Promise<{ retcode: number }>;
}
```

`mt5Client.ts`: single REQ socket, **all requests serialized through a FIFO
queue** (one in flight). Read actions retry once on timeout with a fresh socket
and a new `request_id`. Mutating actions never retry; on timeout they throw
`Mt5TimeoutError` with `ambiguous = true`. `Mt5BridgeError(retcode, msg)` when
`ok:false`. Legacy wrappers (`mt5PlaceOrder`, `mt5ModifyOrder`,
`mt5GetPositions`, `mt5ClosePosition`, `mt5HealthCheck`) remain exported.

`mt5Broker.ts`: `createMt5Broker({ magic, send? })` implements `BrokerAdapter`
over `mt5Client`, mapping snake_case → camelCase and errors → Broker*Error.

`simulatedBroker.ts`: `createSimulatedBroker(opts)` — deterministic in-memory
broker implementing the same validation as the EA (magic, volume step/min/max,
stop side + stops level, duplicate comment guard, partial close remaining ≥
min). Options: `{ magic, account: Partial<AccountInfo>, symbols: Record<string, SymbolInfo>, quoteProvider?: (symbol) => Promise<{ bid; ask }>, persistence?: { load(): Promise<SimState | null>; save(s: SimState): Promise<void> }, now?: () => number }`. Extra methods for tests/paper: `setQuote(symbol, bid, ask)`, `evaluate()` (fills pending orders, triggers SL/TP, records OUT deals with reason SL/TP), `failNext(action, kind: 'reject' | 'ambiguous', retcode?)` (an `ambiguous` failure performs the operation and then throws BrokerAmbiguousError — models a lost reply).

`brokerRouter.ts`: `getBroker(mode: 'paper' | 'demo' | 'live'): BrokerAdapter`
(singletons; paper → simulated broker whose quotes come from the MT5 bridge's
read-only `SYMBOL_INFO`, persisted to Firestore `paper_broker/state`; demo/live
→ mt5Broker) and `verifyAccountForMode(mode, broker)` →
`{ ok: true, account } | { ok: false, reason }`:
- `demo` requires `tradeMode === 'DEMO'`.
- `live` requires `tradeMode === 'REAL'` **and** env `BYTRADER_LIVE_TRADING=enabled`.
- both require `tradeAllowed && tradeExpert && terminalTradeAllowed`.
- `paper` always ok (no orders reach the broker). `setBrokerForTests(mode, broker)` for injection.

## 3. Execution profile (Optimal Report target)

`worker/src/lib/executionProfile.ts` — **pure module, zero imports** (the web
app imports it directly for validation and preview).

```ts
export const PROFILE_SCHEMA_VERSION = 1;
export type SizingMode = 'fixed_lots' | 'fixed_risk_money' | 'equity_risk_percent';
export type EntryPolicy = 'market_only' | 'follow_signal' | 'pending_at_range';

export interface ExecutionProfile {
  schema_version: 1;
  profile_id: string;                 // /^[a-z0-9][a-z0-9-]{2,47}$/
  version: number;                    // integer >= 1 (assigned by server)
  name: string;                       // 1..80 chars
  description?: string;
  source: { type: 'optimal_report' | 'manual'; report_id?: string; report_date?: string; author?: string; notes?: string };
  broker: 'vantage_mt5';
  symbols: { signal_symbol: string; broker_symbol: string }[];    // >=1, signal_symbol unique
  entry: {
    policy: EntryPolicy;
    market_tolerance_price: number;         // >=0; market entry only if price within [low - tol, high + tol]
    pending_expiry_minutes: number;          // 1..10080, used for pending orders
    allow_market_fallback: boolean;          // pending signal may be filled at market ONLY if true and price is inside range
  };
  sizing: {
    mode: SizingMode;
    fixed_lots?: number;                     // required iff mode fixed_lots
    risk_money?: number;                     // required iff mode fixed_risk_money
    risk_percent?: number;                   // required iff mode equity_risk_percent (0 < x <= 10)
    below_min_volume: 'skip' | 'use_min_if_within_cap';
  };
  take_profit: {
    checkpoints: { tp_index: number; close_percent: number }[];   // tp_index 1-based, strictly ascending, each 0<pct<=100, sum === 100 (±1e-6)
    missing_tp: 'skip_trade' | 'merge_into_last_available';
    infeasible_split: 'skip_trade' | 'merge_into_next';
    broker_tp: 'final_checkpoint' | 'none';
  };
  stop_loss: {
    min_distance_price: number;              // >=0
    max_distance_price: number;              // > min
    after_checkpoint: { after_tp_index: number; move_to: 'entry' | 'previous_tp'; buffer_price: number }[];
  };
  break_even: { enabled: boolean; trigger: 'price_distance' | 'after_tp_index'; trigger_value: number; buffer_price: number };
  trailing: { enabled: boolean; activation: 'price_distance' | 'after_tp_index'; activation_value: number; distance_price: number; step_price: number };
  limits: {
    max_concurrent_positions: number;        // int >=1
    max_positions_per_symbol: number;        // int >=1, <= max_concurrent
    max_spread_price: number;                // >0
    max_deviation_points: number;            // int >=0
    signal_max_age_sec: number;              // int 5..3600
    daily_loss_limit_money: number;          // >0
    max_total_risk_percent: number;          // 0 < x <= 50
  };
  edits: {
    before_fill: 'ignore' | 'apply_sl_tp';
    after_fill: 'ignore' | 'apply_tighten_only' | 'apply';
    unparseable_edit: 'ignore' | 'cancel_pending_only';
    explicit_cancel: 'ignore' | 'cancel_pending_only' | 'close_position';
  };
  recommendations?: Record<string, unknown>; // informational only, never executed
}

export interface SafetyLimits {                // settings/default.safety (snake_case on disk, same keys)
  max_risk_percent_per_trade: number;
  max_risk_money_per_trade: number;
  max_lots_per_trade: number;
  max_concurrent_positions: number;
  max_positions_per_symbol: number;
  daily_loss_limit_money: number;
  max_total_risk_percent: number;
  max_spread_price: number;
  max_deviation_points: number;
  max_signal_age_sec: number;
  min_margin_level_percent: number;            // post-trade margin level floor (0 disables)
  allowed_signal_symbols: string[];
}
export const HARD_CEILINGS: SafetyLimits;     // code constants; safety values above these are invalid
export const DEFAULT_SAFETY_LIMITS: SafetyLimits; // conservative; used only when settings.safety is ABSENT

export interface ValidationIssue { path: string; message: string }
export interface ValidationResult<T> { ok: boolean; value?: T; errors: ValidationIssue[]; warnings: ValidationIssue[] }
export function validateProfile(input: unknown): ValidationResult<ExecutionProfile>;
export function validateSafetyLimits(input: unknown): ValidationResult<SafetyLimits>;
export interface EffectiveLimits { maxRiskPercent: number; maxRiskMoney: number; maxLots: number; maxConcurrent: number; maxPerSymbol: number; dailyLossLimit: number; maxTotalRiskPercent: number; maxSpreadPrice: number; maxDeviationPoints: number; maxSignalAgeSec: number; minMarginLevelPercent: number }
export function effectiveLimits(profile: ExecutionProfile, safety: SafetyLimits): EffectiveLimits; // min() of profile and safety on every axis
export function profileDocId(profileId: string, version: number): string; // `${profileId}__v${version}`
export function resolveBrokerSymbol(profile: ExecutionProfile, signalSymbol: string): string | null;
```

Validation is strict: unknown top-level keys are **errors** (typo protection);
missing required fields are errors; no field is defaulted silently.

`worker/src/lib/positionSizing.ts` — pure, imports only types.

```ts
export interface SizingSpec { tickSize: number; tickValueLoss: number; volumeMin: number; volumeMax: number; volumeStep: number }
export function volumeDecimals(step: number): number;
export function roundVolumeDown(volume: number, step: number): number;
export function riskPerLot(entry: number, stopLoss: number, spec: SizingSpec): number; // (|entry-sl| / tickSize) * tickValueLoss
export type SizingFailure = 'invalid_stop_distance' | 'invalid_symbol_spec' | 'missing_sizing_value' | 'volume_below_min' | 'risk_exceeds_limit' | 'invalid_equity';
export type SizingResult = { ok: true; volume: number; riskMoney: number; riskPercent: number; clampedBy?: 'volume_max' | 'max_lots' } | { ok: false; reason: SizingFailure; detail: string };
export function computeVolume(i: { sizing: ExecutionProfile['sizing']; entryPrice: number; stopLoss: number; equity: number; spec: SizingSpec; limits: Pick<EffectiveLimits, 'maxRiskMoney' | 'maxRiskPercent' | 'maxLots'> }): SizingResult;
```
Rules: risk cap = `min(limits.maxRiskMoney, equity * limits.maxRiskPercent / 100)`.
`fixed_lots` → round down, then fail `risk_exceeds_limit` if risk > cap (never
silently resized). Risk modes → target = `risk_money` or `equity * risk_percent
/100`, then `min(target, cap)`, volume = roundDown(target / riskPerLot). Below
`volumeMin` → `skip` fails `volume_below_min`; `use_min_if_within_cap` uses
`volumeMin` only if `riskPerLot * volumeMin <= cap`. Above
`min(volumeMax, maxLots)` → clamp down and set `clampedBy`.

```ts
export interface PlannedCheckpoint { tpIndex: number; price: number; closePercent: number; closeVolume: number; targetRemainingVolume: number }
export type CheckpointPlanResult = { ok: true; checkpoints: PlannedCheckpoint[]; brokerTp: number; warnings: string[] } | { ok: false; reason: 'tp_missing' | 'tp_order_invalid' | 'tp_split_infeasible'; detail: string };
export function planCheckpoints(i: { totalVolume: number; direction: 'buy' | 'sell'; entryPrice: number; takeProfits: number[]; takeProfit: ExecutionProfile['take_profit']; spec: Pick<SizingSpec, 'volumeMin' | 'volumeStep'> }): CheckpointPlanResult;
```
Rules: selected TP prices must be strictly beyond entry and strictly monotonic
in trade direction (BUY ascending, SELL descending) → else `tp_order_invalid`.
Missing index → `skip_trade` fails `tp_missing`; `merge_into_last_available`
drops the missing checkpoints and adds their percent to the highest existing
selected checkpoint (warning recorded). Volumes: each non-final checkpoint
`closeVolume = roundDown(total * pct / 100)`; the final checkpoint takes the
remainder, so the sum is exactly `total`. Every `closeVolume >= volumeMin`
and every non-final `targetRemainingVolume >= volumeMin`; otherwise
`skip_trade` fails `tp_split_infeasible`, `merge_into_next` folds the
undersized checkpoint into the next one and re-plans (a single checkpoint
closing 100% is always feasible). `brokerTp` = final checkpoint price when
`broker_tp === 'final_checkpoint'`, else 0.

## 4. Execution control

`worker/src/lib/executionControl.ts`

```ts
export type ExecutionMode = 'disabled' | 'paper' | 'demo' | 'live';
export interface ExecutionControl {
  mode: ExecutionMode;
  killSwitch: boolean;
  activeProfileDocId: string | null;
  activeProfile: ExecutionProfile | null;
  profileErrors: string[];
  safety: SafetyLimits | null;
  safetyErrors: string[];
  liveTradingEnvEnabled: boolean;        // process.env.BYTRADER_LIVE_TRADING === 'enabled'
  source: 'firestore' | 'fail_closed';
  reason?: string;
  loadedAt: number;
}
export async function getExecutionControl(): Promise<ExecutionControl>;   // TTL 5 s cache
export function invalidateExecutionControl(): void;
export function canOpenNewEntries(c: ExecutionControl): { allowed: true } | { allowed: false; reason: string };
```
Firestore: `settings/default` fields `execution.mode`,
`execution.active_profile_doc_id`, `trading.kill_switch`, `safety.*`; profile
from `execution_profiles/{active_profile_doc_id}`.
- Firestore null / read error → `mode:'disabled', killSwitch:true, source:'fail_closed'`.
- Missing `execution.mode` → `'disabled'`. Unknown value → `'disabled'` + reason.
- Missing `safety` → `DEFAULT_SAFETY_LIMITS`; present but invalid → `safety:null` (blocks entries).
- Active profile missing/invalid → `activeProfile:null` (blocks entries).
- `canOpenNewEntries` reasons: `execution_disabled`, `kill_switch`, `config_unavailable`, `no_active_profile`, `invalid_profile`, `invalid_safety`, `live_not_enabled` (mode live without env flag).

**Kill switch semantics:** blocks new entries and pending-order placement.
It does **not** stop protective management (TP partial closes, SL/BE/trailing,
reconciliation) of trades already open. Close-all is a separate explicit command.

## 5. Firestore data model

`execution_profiles/{profile_id}__v{version}` — the profile fields plus
`status: 'draft' | 'approved' | 'active' | 'superseded' | 'rejected'`,
`validation: { ok, errors, warnings, validated_at }`, `created_at`,
`created_by`, `updated_at`, `approved_at?`, `approved_by?`, `activated_at?`.
Drafts are mutable; once approved the content is immutable.

`execution_profile_audit/{auto}` — `{ action: 'create_draft' | 'update_draft' | 'approve' | 'reject' | 'activate' | 'rollback', profile_doc_id, previous_active_doc_id?, actor_uid, actor_email, at, details }`.

`settings/default.execution` — `{ mode, active_profile_doc_id, updated_at, updated_by }`.
`settings/default.safety` — `SafetyLimits` (snake_case).
`settings/default.trading.kill_switch` — boolean (existing field).

`admin_commands/{auto}` — `{ type: 'close_all', status: 'pending' | 'running' | 'done' | 'rejected' | 'failed', confirm: 'CLOSE ALL', requested_by_uid, requested_by_email, requested_at, started_at?, finished_at?, result? }`. Created **only** by the web API (server-verified admin). Executed only by the AutoTrader.

`trade_sets/{chatId}_{messageId}` (schema 2):

```ts
export type TradeState =
  | 'CLAIMED'          // doc created, gates running, nothing sent
  | 'SKIPPED'          // gate refused (skip_reason)
  | 'SUBMITTING'       // intent persisted, ORDER_SEND in flight
  | 'SUBMIT_UNKNOWN'   // ORDER_SEND outcome ambiguous; reconciler must resolve
  | 'PENDING_ORDER'    // pending order resting at broker
  | 'OPEN'             // position open, no checkpoint closed yet
  | 'PARTIALLY_CLOSED' // >=1 checkpoint closed, remaining volume open
  | 'CLOSED'           // position fully closed (result.*)
  | 'CANCELLED'        // pending order cancelled / signal cancelled before fill
  | 'REJECTED'         // broker definitively refused entry
  | 'ERROR';           // unrecoverable error (error)

export interface TradeSetDoc {
  schema: 2;
  trade_set_id: string; chat_id: string; message_id: string; event_id: string;
  signal: GoldSignal; signal_revisions: { event_id: string; text_hash: string; received_at: string; outcome: 'applied' | 'ignored'; reason: string }[];
  symbol: string; broker_symbol: string | null; direction: 'buy' | 'sell';
  order_type: BrokerOrderType | null;
  mode: 'paper' | 'demo' | 'live' | 'disabled';
  broker: 'mt5' | 'simulated' | null;
  profile: { doc_id: string; profile_id: string; version: number } | null;
  profile_snapshot: ExecutionProfile | null;     // rules frozen at entry; later activations never rewrite them
  limits_snapshot: EffectiveLimits | null;
  state: TradeState;
  skip_reason?: string; error?: string;
  correlation_comment: string;                   // `BT-${12 hex}` — sha256(trade_set_id) prefix
  claim: { attempts: number; claimed_at: string; owner: string };
  plan: { volume: number; entry_ref_price: number; order_price: number; sl: number; broker_tp: number; risk_money: number; risk_percent: number; checkpoints: PlannedCheckpoint[] } | null;
  submission: { submitted_at: string; expires_at: number; request_id: string; pending_expires_at?: number } | null; // pending_expires_at: GMT sec (pending entries)
  broker_refs: { order_ticket: number; position_ticket: number; deal_ticket: number; fill_price: number; filled_volume: number; expiration_applied?: boolean } | null;
  lifecycle: {
    checkpoints: { tp_index: number; price: number; close_volume: number; target_remaining_volume: number; status: 'pending' | 'closing' | 'done' | 'failed'; attempts: number; requested_at?: string; ambiguous_until?: number; confirmed_at?: string; deal_ticket?: number; realized_pnl?: number; last_error?: string }[];
    current_volume: number; current_sl: number; current_tp: number;
    be_applied: boolean; trailing_active: boolean; best_price: number;
  } | null;
  result: { closed_at: string; close_reason: 'tp' | 'sl' | 'manual' | 'close_all' | 'cancel' | 'checkpoints_complete' | 'unknown'; realized_pnl: number } | null;
  cancel_requested?: { reason: 'unparseable_edit' | 'explicit_cancel'; at: string; event_id: string };
  operator_resolution?: { resolution: 'not_executed' | 'handled_manually'; by: string; at: string; note: string | null }; // POST /api/trades/[id]/resolve
  created_at: string; updated_at: string;
}
```

Legacy schema-1 docs (states `DETECTED`, `ENTRY_PLACED`, `PROTECTION_PLACED`,
`CANCEL_REQUESTED`, `CANCELLED`, `SKIPPED`, `ERROR`) stay readable in the web
UI but are not managed by the new lifecycle.

`trade_events/{trade_set_id}__{event_key}` — deterministic id → idempotent:

```ts
export type TradeEventType =
  | 'signal_received' | 'signal_validated' | 'execution_skipped'
  | 'entry_submitted' | 'entry_confirmed' | 'entry_rejected' | 'entry_unknown'
  | 'pending_order_placed' | 'pending_order_filled' | 'pending_order_cancelled'
  | 'protection_confirmed' | 'tp_checkpoint_reached' | 'partial_close_requested'
  | 'partial_close_confirmed' | 'partial_close_failed' | 'sl_modified'
  | 'break_even_applied' | 'trailing_updated' | 'position_closed'
  | 'signal_revision_applied' | 'signal_revision_ignored' | 'cancel_requested'
  | 'reconciliation' | 'execution_error';
export interface TradeEventInput {
  tradeSetId: string; eventKey: string; type: TradeEventType;
  mode?: string; profileDocId?: string | null; profileVersion?: number | null;
  reasonCode?: string; message?: string;
  orderTicket?: number; positionTicket?: number; dealTicket?: number;
  volume?: number; price?: number; sl?: number; tp?: number; realizedPnl?: number; retcode?: number;
  details?: Record<string, unknown>;
}
// tradeEvents.ts
export async function recordTradeEvent(e: TradeEventInput): Promise<boolean>; // create(); ALREADY_EXISTS → false; firestore null → false; never throws
```
Stored snake_case: `trade_set_id, event_key, type, timestamp (ISO), mode, profile_doc_id, profile_version, reason_code, message, order_ticket, position_ticket, deal_ticket, volume, price, sl, tp, realized_pnl, retcode, details`.

`signal_events` additions (forwarder): `cancel_reason?: 'unparseable_edit' | 'explicit_cancel'`, `trigger_message_id?: string` (the reply message that cancelled), `spooled_at?` (written from the forwarder outbox), and the durable queue state `autotrader` (rules in `worker/src/lib/signalQueue.ts`, superseding the earlier best-effort status):

```ts
autotrader: {
  status: 'pending' | 'processing' | 'retry_wait' | 'done' | 'ignored' | 'dead_letter' | 'discarded';
  attempts: number;                 // claims so far
  next_attempt_at: string | null;   // ISO; retry_wait becomes claimable at this time
  lease_id: string | null; lease_owner: string | null; lease_expires_at: string | null; // processing only
  outcome?; state?; reason?; last_error?; processed_at?; dead_lettered_at?; updated_at: string;
  history?: { attempt; at; result: 'done' | 'ignored' | 'retry' | 'error' | 'lease_expired' | 'dead_letter'; detail? }[]; // last 10
  requeue_count?; requeued_by?; requeued_at?; discarded_by?; discarded_at?; discard_note?;
  adopted?: true;                   // status added by the feed for an event written without one
}
```

The forwarder creates every event with `status: 'pending'`. The AutoTrader
claims an event with a transaction (lease, default 120 s, renewed while it
runs), handles one event per trade set key at a time in `created_at` order, and
backs off `5 s · 2^(n−1)` (cap 5 min, ±20 %) up to 8 attempts, then
`dead_letter`. Completion is fenced by `lease_id`. Old statuses (`failed`) are
never processed. Query: `autotrader.status in [pending, processing, retry_wait]`
ordered by `created_at` (composite index in `firestore.indexes.json`; unordered
fallback when the index is missing and the backlog fits one read).

`autotrader_state/signal_feed` — `{ cursor, cursor_ids, updated_at, worker_id }`: intake cursor for events without a status. Worker-internal (no client rule).

`alerts/{type}__{subject}` — operator alerts (`worker/src/lib/alertTypes.ts`): `{ type, subject, severity: 'critical' | 'error' | 'warning' | 'info', status: 'open' | 'acknowledged' | 'resolved', title, message, action, source, details (sanitized), count, first_seen_at, last_seen_at, opened_at, reopened_count, acknowledged_by/at, resolved_at/by, resolution, updated_at }`. One document per condition; repeats bump `count`; a higher severity re-opens an acknowledged alert; workers resolve alerts when the condition clears; admins acknowledge/resolve through `POST /api/alerts/[id]`.

`service_status/{autotrader|forwarder}` — heartbeat every 15 s: `{ service, updated_at, started_at, pid, host, interval_ms, healthy, issues[], details (sanitized) }`. Each service watches the other's (`service_unhealthy` after 3 min).

## 6. Engine flow (`mt5TradeEngine.ts`)

`handleSignalEvent(ev: { eventId; chatId; messageId; messageDate; messageType; kind: 'signal' | 'cancel'; signal: GoldSignal | null; cancelReason?; textHash? }, deps?)`

kind `signal`:
1. `trade_set_id = ${chatId}_${messageId}`. Try `create()` with state `CLAIMED`.
   ALREADY_EXISTS → if existing state is `CLAIMED`, `claim.claimed_at` older
   than 60 s, `claim.attempts < 3`, and existing `event_id === ev.eventId` →
   re-claim in a transaction and re-run gates; otherwise → **revision path**.
2. Gates (first failure → `SKIPPED` + `execution_skipped` event with reason):
   `canOpenNewEntries` → broker symbol mapping + `allowed_signal_symbols` →
   signal age (`messageDate`) ≤ `maxSignalAgeSec` → `verifyAccountForMode` →
   symbol `tradeMode` permits direction → spread (`spreadPoints*point`) ≤
   `maxSpreadPrice` → SL side and distance within profile min/max → entry
   decision (below) → checkpoint plan → position limits (broker positions +
   pending orders + local `SUBMITTING`/`SUBMIT_UNKNOWN` sets, total and per
   symbol) → daily realized loss (broker OUT deals since 00:00 UTC, profit +
   commission + swap + fee) → total open risk (sum `plan.risk_money` of
   open/pending/submitting sets without BE applied + new risk ≤ equity ×
   `maxTotalRiskPercent`) → sizing → `checkOrder` margin and post-trade margin
   level ≥ `minMarginLevelPercent`.
3. Entry decision — pure function `decideEntry(signal, quote, profile.entry)`
   in `entryPolicy.ts`. Let `p = Ask` for BUY, `Bid` for SELL, `tol =
   market_tolerance_price`, `inRange = entryLow - tol <= p <= entryHigh + tol`.
   - Signal `orderType === 'market'`:
     - `inRange` → `BUY`/`SELL` market, `order_price = 0`.
     - not in range and policy `pending_at_range`: BUY with `p > entryHigh + tol`
       → `BUY_LIMIT` at `entryHigh`; SELL with `p < entryLow - tol` →
       `SELL_LIMIT` at `entryLow`.
     - otherwise skip `price_outside_entry_range` (covers `market_only`,
       `follow_signal`, and price already beyond the range toward the SL).
   - Signal pending type:
     - policy `market_only`: `allow_market_fallback && inRange` → market;
       else skip `pending_not_allowed`.
     - policy `follow_signal` / `pending_at_range`: order price
       `BUY_LIMIT → entryHigh` (requires `< Ask`), `SELL_LIMIT → entryLow`
       (requires `> Bid`), `BUY_STOP → entryLow` (requires `> Ask`),
       `SELL_STOP → entryHigh` (requires `< Bid`). If the required relation
       fails: `allow_market_fallback && inRange` → market; else skip
       `invalid_pending_price`.
   - `entry_ref_price` (used for sizing and BE) = `p` for market,
     `order_price` for pending.
4. Persist `SUBMITTING` with `plan`, `submission`, `lifecycle` (all
   checkpoints `pending`). If that write fails → `ERROR`, nothing sent.
5. `placeOrder` →
   - success/duplicate, market → `OPEN`, `broker_refs`, `entry_confirmed`,
     then verify SL on the position via `getPositions` → `protection_confirmed`
     (if SL missing: attempt `modifyPosition`; if that fails record
     `execution_error` reason `protection_missing` and keep managing).
   - success, pending → `PENDING_ORDER`, `pending_order_placed`.
   - `BrokerRejectedError` → `REJECTED`, `entry_rejected` (retcode).
   - `BrokerAmbiguousError` / `Mt5TimeoutError` → `SUBMIT_UNKNOWN`,
     `entry_unknown`. **Never resend.** Reconciler resolves after
     `submission.expires_at + 5 s` (+ any amount the EA clock runs behind).

Gates added in the 2026-10-21 hardening pass (all skip with these reasons):
`account_netting` (router: margin mode not `HEDGING`), `clock_skew`
(MT5 only: |EA `TimeGMT()` − worker clock| > `MAX_CLOCK_SKEW_SEC`, default 5),
`quote_stale` (last tick older than `MAX_QUOTE_AGE_SEC`, default 60; unknown
tick time is not judged), `symbol_volume_limit` (`SYMBOL_VOLUME_LIMIT` would be
exceeded by the bot's own open plus pending volume). After a fill the engine
also compares the position comment with `correlation_comment`
(`comment_not_preserved` + critical `correlation_mismatch` alert). A pending
entry stores `submission.pending_expires_at` and `broker_refs.expiration_applied`;
the lifecycle cancels a pending entry still working 30 s after that time.

kind `signal` on an existing set (revision): idempotent on `event_id` in
`signal_revisions`. Apply per `profile_snapshot.edits`:
`PENDING_ORDER` + `before_fill:'apply_sl_tp'` → `modifyPendingOrder` SL/TP
and re-plan checkpoint prices (entry edits never re-place orders). `OPEN` /
`PARTIALLY_CLOSED` + `after_fill` → SL change applied if it is on the valid
side (and, for `apply_tighten_only`, reduces risk); TP changes update only
checkpoints still `pending`. Any other state → `ignored`.

kind `cancel`: by `cancelReason` and `profile_snapshot.edits`:
`unparseable_edit` → `cancel_pending_only` cancels a `PENDING_ORDER`; never
closes an open position. `explicit_cancel` → `cancel_pending_only` cancels
pending; `close_position` also closes an open position (full close,
`result.close_reason = 'cancel'`). `SUBMIT_UNKNOWN`/`SUBMITTING` → set
`cancel_requested`; reconciler applies it after resolution.

## 7. Lifecycle, reconciliation, admin commands

`lifecycleManager.ts` — tick every `LIFECYCLE_INTERVAL_MS` (default 2000):
query `trade_sets` where `state in ['OPEN','PARTIALLY_CLOSED','PENDING_ORDER']`
and `schema == 2`; group by `mode`; one `getPositions()`/`getOrders()` per
broker. Per trade, using **`priceCurrent`** (never `openPrice`) as the close
price:
1. Position missing → resolve via `getDeals({ positionId })` → `CLOSED`
   (close_reason from last OUT deal reason: SL→`sl`, TP→`tp`, else `manual`;
   `checkpoints_complete` when all checkpoints done), `position_closed`.
2. Checkpoints in order, at most one broker close per trade per tick:
   - `position.volume <= target_remaining_volume + ½step` → mark `done`
     (`partial_close_confirmed`). This is the idempotency rule: the target is
     a remaining volume, not a delta, so a repeated tick cannot close twice.
   - reached (`BUY: price >= cp.price`, `SELL: price <= cp.price`) and
     (`pending` or (`closing` and now > `ambiguous_until`)) → persist
     `closing` + `ambiguous_until = now + 15 s` **before** sending
     `closePosition(ticket, volume - target_remaining)` (full close when
     target is 0) → success → `done` with deal / realized pnl; reject →
     `pending`, `attempts+1`, `failed` after 5 (`partial_close_failed`, error
     alert); reject 10018 (market closed) → `pending` without counting the
     attempt, retried once a minute; ambiguous → stays `closing`.
3. SL candidates: `after_checkpoint` moves, break-even, trailing (watermark
   `best_price` persisted when it moves ≥ `step_price`). Pick the most
   protective; apply only if it tightens (BUY: new > current SL; SELL: new <
   current SL or SL == 0) and respects `stopsLevel`/`freezeLevel` vs current
   Bid/Ask; round to `digits`. Events `break_even_applied`,
   `trailing_updated`, `sl_modified` (event key includes the SL value).
4. `PENDING_ORDER`: order still resting 30 s past `submission.pending_expires_at`
   → `cancelOrder` (`pending_order_expired_by_worker`); order gone → position
   with matching comment → `OPEN` (`pending_order_filled`); otherwise →
   `CANCELLED` (`pending_order_cancelled`, broker expiry/manual).
Three consecutive failed stop moves raise `sl_modify_failed` (resolved by the next successful move).
Kill switch and mode `disabled` do **not** stop this loop.

`reconciler.ts` — every 15 s and at startup:
- `SUBMIT_UNKNOWN` past `expires_at + 5 s` → search positions/orders/deals
  (from `created_at - 60 s`) for `correlation_comment` → `OPEN` /
  `PENDING_ORDER` / `CLOSED`; nothing found → `REJECTED` reason
  `not_found_after_expiry` (safe because the EA rejects expired requests),
  **unless** an unlinked EA-magic position/order/IN deal on the same symbol and
  side appeared in `[submitted − 10 s, expiry + 60 s]`: then the set stays
  `SUBMIT_UNKNOWN` (`correlation_candidates`, critical `correlation_mismatch`
  alert) for the operator. Then apply any `cancel_requested`. A
  `SUBMIT_UNKNOWN` unresolved 5 min after expiry escalates its alert to critical.
- `CLAIMED` older than 5 min → `ERROR` `stale_claim`.
- `SUBMITTING` older than 2 min → treat as `SUBMIT_UNKNOWN` (process died
  mid-send).
- Broker positions/orders with EA magic not linked to any schema-2 trade set →
  `system_logs` warn `orphan_position` (once per ticket per process). Never
  managed automatically.
- Position volume lower than expected and unexplained by checkpoints →
  update `lifecycle.current_volume`, event `reconciliation`.

`adminCommands.ts` — poll `admin_commands` where `status == 'pending'` every
3 s; claim with a transaction (`pending → running`). `close_all`: reject if
`confirm !== 'CLOSE ALL'` or `requested_at` older than 5 min. Otherwise:
set `trading.kill_switch = true`, then for each broker in use (paper and the
configured MT5 mode): cancel every pending order and close every position
**with EA magic** (owned only), record per-ticket results, mark trade sets
`close_reason: 'close_all'`, finish `done` (or `failed` with partial results).

## 8. Web API (server-verified)

`web/src/lib/serverAuth.ts`: `requireAdmin(req): Promise<{ uid; email } | NextResponse>` —
token from `Authorization: Bearer` or the `bytrader_session` cookie →
`verifyIdToken(token, true)` → `email_verified === true` → `ALLOWED_EMAILS`
check (unset or empty refuses everyone: fail closed) → `users/{uid}.role === 'admin'`.
`requireUser` applies the same checks without the role. `/api/session` uses the same email rules.
Every mutating route calls it. Browser code calls routes through
`web/src/lib/adminApi.ts` (`authedFetch`), which attaches a fresh ID token.

Routes:
- `POST /api/settings` — whitelisted patch of `telegram.*` chat lists. `trading.*` keys are refused (the Bybit-era knobs are not read by v2; kill switch, mode and safety have their own routes).
- `POST /api/execution/mode` — `{ mode, confirm }`; `live` requires `confirm === 'ENABLE LIVE TRADING'`.
- `POST /api/execution/kill-switch` — `{ engaged: boolean }`.
- `POST /api/execution/safety` — validated `SafetyLimits`.
- `POST /api/admin/close-all` — `{ confirm: 'CLOSE ALL' }` → `admin_commands`.
- `GET/POST /api/profiles` — list / create draft (body: profile JSON without `version`; server assigns version).
- `PUT /api/profiles/[docId]` — update draft only.
- `POST /api/profiles/validate` — validation + execution preview.
- `POST /api/profiles/[docId]/approve` | `/activate` ; `POST /api/profiles/rollback` `{ docId }`.
- `GET /api/alerts?view=active|open|acknowledged|resolved` (user) ; `POST /api/alerts/[id]` `{ action: 'acknowledge' | 'resolve', note? }` (admin, audited).
- `GET /api/signal-events?view=dead_letter|active|discarded` (user) ; `POST /api/signal-events/[id]` `{ action: 'requeue' | 'discard', confirm: 'REQUEUE' | 'DISCARD', note? }` (admin, audited; requeue refused when a later event of the same trade set was handled or is running).
- `POST /api/trades/[id]/resolve` `{ resolution: 'not_executed' | 'handled_manually', confirm: 'RESOLVE <id>', note? }` (admin, audited) — only `SUBMIT_UNKNOWN`, only 120 s after the request's EA expiry; Firestore state only, never a broker call.

Firestore rules (`firestore.rules`): reads need a verified email and
`users/{uid}` with role `admin` or `viewer`; **all client writes are denied**;
every mutation goes through the API routes (admin SDK). Tested against the
emulator in `tests/firestore-rules/`.
