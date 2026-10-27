# Optimal Report to Execution Profile: Schema and Workflow

Status: specification for the Vantage AutoTrader profile layer (2026-10-18).
Authoritative interface: `VANTAGE_DESIGN_CONTRACTS.md` sections 3, 5 and 8.
Code: `worker/src/lib/executionProfile.ts` (validation, types, safety limits),
`worker/src/lib/positionSizing.ts` (volume and checkpoint planning),
`worker/src/lib/entryPolicy.ts` (entry decision and stop-loss checks).

## 1. Purpose

An **Optimal Report** is a manual review of a backtest or forward-test report
(for example, MT5 Strategy Tester output). An operator, or an external AI agent
working from the operator's notes, turns that review into a **draft execution
profile**: a JSON document that tells the AutoTrader how to enter, size, take
profit and protect trades for a signal symbol.

Rules for this process:

- The profile is **produced by hand or by an external agent**, then validated,
  reviewed and approved by an operator. The AutoTrader never calls an AI service
  at runtime. There is no runtime AI dependency.
- The AutoTrader executes only an **approved, active** profile. Nothing in a
  report or a recommendation executes on its own.
- Every price distance is in **price units** (for XAUUSD, `2.5` means a 2.5 USD
  move). Pips are never used.

## 2. The three layers

| Layer | Where it lives | Who controls it | Executed? |
|---|---|---|---|
| **Recommendations** | `recommendations` object inside the profile | Author (free-form notes, suggested values) | **Never.** Stored for reference only. |
| **Approved profile** | `execution_profiles/{profile_id}__v{version}` | Operator approves and activates a version. Once approved, content is immutable. | Yes, when it is the active profile. Frozen into each trade set at entry. |
| **Safety limits** | `settings/default.safety` | Operator, through the dashboard | Yes. Each limit is a cap. Effective limit = min(profile, safety). |
| **Hard ceilings** | `HARD_CEILINGS` in code | Code owners | Safety values above a ceiling are rejected. Profile values above a ceiling are **errors**: the profile does not validate. |

A profile can never raise a safety limit. Safety can never exceed a hard ceiling.

**Both ceilings and current safety limits are enforced as errors.** A profile
that exceeds either one:

- does not validate (`validateProfile` returns `ok: false`), so it cannot be
  approved as valid or activated;
- is refused at activation time by `validateProfileAgainstSafety` against the
  current `settings.safety`;
- is refused at runtime for **new entries**: the AutoTrader re-runs the same
  check, and a failing check blocks the new signal.

Trades already open are **not** closed or changed by a profile check. They keep
being managed under their frozen `profile_snapshot` (see section 10).

## 3. Profile field reference

Units: `price` = price units (USD per troy ounce on XAUUSD). `%` = percent.
"Required" means the field must be present. Nothing is defaulted silently.
Unknown keys are **errors** at every nesting level (for example `sizing.fixedlots`).

### 3.1 Top level

| Field | Type | Constraints | Meaning |
|---|---|---|---|
| `schema_version` | literal `1` | required | Schema version. Must be `1`. |
| `profile_id` | string | required; `/^[a-z0-9][a-z0-9-]{2,47}$/` | Stable identifier shared by all versions of this profile. |
| `version` | integer | required by `validateProfile`; `>= 1` | Assigned by the server. **Agents omit it.** |
| `name` | string | required; 1 to 80 characters | Human-readable name. |
| `description` | string | optional | Free text. |
| `source` | object | required | Provenance. See 3.2. |
| `broker` | literal `"vantage_mt5"` | required | Only supported broker target. |
| `symbols` | array | required; at least 1 item | Signal-to-broker symbol map. See 3.3. |
| `entry` | object | required | Entry policy. See 3.4. |
| `sizing` | object | required | Volume rules. See 3.5. |
| `take_profit` | object | required | TP checkpoints and missing-TP rules. See 3.6. |
| `stop_loss` | object | required | SL distance bounds and move-after-checkpoint rules. See 3.7. |
| `break_even` | object | required | Break-even rule. See 3.8. |
| `trailing` | object | required | Trailing-stop rule. See 3.9. |
| `limits` | object | required | Position and risk caps. See 3.10. |
| `edits` | object | required | How signal edits and cancellations are handled. See 3.11. |
| `recommendations` | object | optional | Free-form, informational, never executed. |

### 3.2 `source`

| Field | Type | Constraints | Meaning |
|---|---|---|---|
| `type` | enum | required: `optimal_report` or `manual` | Where the profile came from. |
| `report_id` | string | optional | Identifier of the reviewed report. |
| `report_date` | string | optional | Date of the report, for example `2026-01-01`. |
| `author` | string | optional | Who wrote the draft. |
| `notes` | string | optional | Provenance notes. |

### 3.3 `symbols[]`

| Field | Type | Constraints | Meaning |
|---|---|---|---|
| `signal_symbol` | string | required; uppercase, `/^[A-Z0-9][A-Z0-9._-]{0,31}$/`; unique within the list | Symbol as it appears in signals, for example `XAUUSD`. Matching at runtime is case-insensitive. |
| `broker_symbol` | string | required; `/^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/` | Exact symbol name in MT5 Market Watch. **Vantage may add a suffix such as `XAUUSD+`. The operator must set this to the name the terminal shows.** |

### 3.4 `entry`

| Field | Type | Constraints | Meaning |
|---|---|---|---|
| `policy` | enum | required: `market_only`, `follow_signal`, `pending_at_range` | See the entry decision table in section 5. |
| `market_tolerance_price` | number | required; `>= 0` (price) | Market entry is allowed when the live price lies within `[entryLow - tol, entryHigh + tol]`. |
| `pending_expiry_minutes` | integer | required; 1 to 10080 | Lifetime of a pending order at the broker. |
| `allow_market_fallback` | boolean | required | A pending signal may fill at market only if this is `true` **and** the price is inside the range. |

### 3.5 `sizing`

| Field | Type | Constraints | Meaning |
|---|---|---|---|
| `mode` | enum | required: `fixed_lots`, `fixed_risk_money`, `equity_risk_percent` | Which sizing rule is active. |
| `fixed_lots` | number | required iff `mode = fixed_lots`; `> 0` | Lots per trade. |
| `risk_money` | number | required iff `mode = fixed_risk_money`; `> 0` | Money at risk per trade (account currency). |
| `risk_percent` | number | required iff `mode = equity_risk_percent`; `0 < x <= 10` | Percent of equity at risk per trade. |
| `below_min_volume` | enum | required: `skip` or `use_min_if_within_cap` | What to do when the computed volume is below the symbol minimum. |

A value for a mode that is **not** active is type-checked and reported as a
warning ("ignored"). It is not an error. Every present value, active or not, is
checked against its hard ceiling, and exceeding a ceiling is an error.

### 3.6 `take_profit`

| Field | Type | Constraints | Meaning |
|---|---|---|---|
| `checkpoints` | array | required; at least 1 item | Partial-close schedule. See section 6. |
| `checkpoints[].tp_index` | integer | required; 1 to 10; strictly ascending across the array | Which signal TP this checkpoint uses (`TP1` = `takeProfits[0]`). |
| `checkpoints[].close_percent` | number | required; `0 < x <= 100` | Share of the position closed at this checkpoint. |
| `missing_tp` | enum | required: `skip_trade`, `merge_into_last_available` | What to do when a referenced TP is absent from the signal. |
| `infeasible_split` | enum | required: `skip_trade`, `merge_into_next` | What to do when a split would produce a volume below the minimum. |
| `broker_tp` | enum | required: `final_checkpoint` or `none` | Whether the broker holds a TP at the final checkpoint price (`final_checkpoint`) or no broker TP (`none`). |

Rules: the close percentages must sum to 100 (tolerance 1e-6).

### 3.7 `stop_loss`

| Field | Type | Constraints | Meaning |
|---|---|---|---|
| `min_distance_price` | number | required; `>= 0` | Minimum distance from entry to the initial stop. |
| `max_distance_price` | number | required; `> min_distance_price` | Maximum distance from entry to the initial stop. Wider signals are skipped. |
| `after_checkpoint` | array | required (may be empty) | Stop moves triggered when a checkpoint is reached. |
| `after_checkpoint[].after_tp_index` | integer | required; must match a `take_profit` checkpoint; unique in the array | Trigger checkpoint. |
| `after_checkpoint[].move_to` | enum | required: `entry` or `previous_tp` | Move the stop to entry, or to the previous TP price. |
| `after_checkpoint[].buffer_price` | number | required; `>= 0` | `entry`: stop = entry + buffer (BUY) / entry − buffer (SELL), i.e. locks in the buffer. `previous_tp`: stop = previous TP − buffer (BUY) / + buffer (SELL), i.e. leaves the buffer as room behind that level; for the first checkpoint (no earlier TP) it behaves like `entry`. |

### 3.8 `break_even`

| Field | Type | Constraints | Meaning |
|---|---|---|---|
| `enabled` | boolean | required | Whether the rule is active. |
| `trigger` | enum | required: `price_distance` or `after_tp_index` | What starts break-even. |
| `trigger_value` | number | required | For `after_tp_index`: an integer that must match a checkpoint `tp_index`. For `price_distance`: `> 0` when enabled, `>= 0` when disabled. |
| `buffer_price` | number | required; `>= 0` | Offset beyond entry. |

### 3.9 `trailing`

| Field | Type | Constraints | Meaning |
|---|---|---|---|
| `enabled` | boolean | required | Whether trailing is active. |
| `activation` | enum | required: `price_distance` or `after_tp_index` | What starts trailing. |
| `activation_value` | number | required | Same rule as `break_even.trigger_value`. |
| `distance_price` | number | required; `> 0` when enabled, `>= 0` when disabled | Trail distance behind price. |
| `step_price` | number | required; `> 0` when enabled, `>= 0` when disabled | Minimum move before the stop is updated. |

### 3.10 `limits`

| Field | Type | Constraints | Meaning |
|---|---|---|---|
| `max_concurrent_positions` | integer | required; `>= 1` | Open positions plus pending orders across all symbols. |
| `max_positions_per_symbol` | integer | required; `>= 1` and `<= max_concurrent_positions` | Same, per symbol. |
| `max_spread_price` | number | required; `> 0` | Maximum spread (price units) at signal time. |
| `max_deviation_points` | integer | required; `>= 0` | Maximum slippage in broker points. |
| `signal_max_age_sec` | integer | required; 5 to 3600 | Signals older than this (by message date) are skipped. |
| `daily_loss_limit_money` | number | required; `> 0` | Daily realized loss that blocks new entries. |
| `max_total_risk_percent` | number | required; `0 < x <= 50` | Sum of open and pending risk as a percent of equity. |

### 3.11 `edits`

| Field | Type | Constraints | Meaning |
|---|---|---|---|
| `before_fill` | enum | required: `ignore` or `apply_sl_tp` | Apply SL/TP edits to a pending order. |
| `after_fill` | enum | required: `ignore`, `apply_tighten_only`, `apply` | Apply SL edits to an open position. |
| `unparseable_edit` | enum | required: `ignore` or `cancel_pending_only` | Action when a signal edit cannot be parsed. |
| `explicit_cancel` | enum | required: `ignore`, `cancel_pending_only`, `close_position` | Action on an explicit cancel message. |

### 3.12 `recommendations`

Optional object. Any keys and values are allowed. It is stored and shown for
review. It is **never** interpreted or executed. Use it for the reasoning and
suggested numbers behind the draft.

## 4. Safety limits and hard ceilings

Safety limits live in `settings/default.safety` (snake_case). All fields are
required. Each numeric field must be `> 0` (`min_margin_level_percent` may be
`0`, which disables the floor), and at most the hard ceiling below.
Profile values are checked against the same ceilings (`sizing.fixed_lots` against
`max_lots_per_trade`, `sizing.risk_money` against `max_risk_money_per_trade`,
`sizing.risk_percent` against `max_risk_percent_per_trade`, and the `limits.*`
fields against the same-named ceilings).
`allowed_signal_symbols` must be a non-empty list of uppercase symbols.

| Safety field | Hard ceiling | Conservative default | Notes |
|---|---|---|---|
| `max_risk_percent_per_trade` | 5 | 1 | % of equity per trade |
| `max_risk_money_per_trade` | 5000 | 50 | money per trade |
| `max_lots_per_trade` | 20 | 1 | lots |
| `max_concurrent_positions` | 20 | 3 | integer |
| `max_positions_per_symbol` | 10 | 1 | integer |
| `daily_loss_limit_money` | 20000 | 100 | money |
| `max_total_risk_percent` | 20 | 3 | % of equity |
| `max_spread_price` | 10 | 0.5 | price units |
| `max_deviation_points` | 500 | 30 | points, integer |
| `max_signal_age_sec` | 3600 | 120 | seconds, integer |
| `min_margin_level_percent` | 10000 | 200 | post-trade margin level floor; 0 disables |
| `allowed_signal_symbols` | (none) | `["XAUUSD"]` | signals for other symbols are skipped |

The conservative defaults apply **only** when `settings.safety` is absent. If it
is present but invalid, entries are blocked.

**Effective limits** (`effectiveLimits`): for each axis the value used is the
smaller of the profile value and the safety value. Per-trade risk, lots and
margin level come from safety alone, because the profile does not set them.

| Effective limit | Computed as |
|---|---|
| max risk % per trade | `safety.max_risk_percent_per_trade` |
| max risk money per trade | `safety.max_risk_money_per_trade` |
| max lots | `safety.max_lots_per_trade` |
| max concurrent | `min(limits.max_concurrent_positions, safety.max_concurrent_positions)` |
| max per symbol | `min(limits.max_positions_per_symbol, safety.max_positions_per_symbol)` |
| daily loss limit | `min(limits.daily_loss_limit_money, safety.daily_loss_limit_money)` |
| max total risk % | `min(limits.max_total_risk_percent, safety.max_total_risk_percent)` |
| max spread | `min(limits.max_spread_price, safety.max_spread_price)` |
| max deviation | `min(limits.max_deviation_points, safety.max_deviation_points)` |
| max signal age | `min(limits.signal_max_age_sec, safety.max_signal_age_sec)` |
| min margin level % | `safety.min_margin_level_percent` |

## 5. Entry decision

Let `p` be Ask for BUY and Bid for SELL. `tol = entry.market_tolerance_price`.
`inRange = entryLow - tol <= p <= entryHigh + tol`.

| Signal order type | Policy | Result |
|---|---|---|
| `market` | in range | Market BUY or SELL |
| `market` | not in range, `pending_at_range`, price beyond the high (BUY) or below the low (SELL) | `BUY_LIMIT` at `entryHigh`, or `SELL_LIMIT` at `entryLow` |
| `market` | any other case | Skip: `price_outside_entry_range` |
| pending | `market_only` | Market only if `allow_market_fallback` and in range; else skip `pending_not_allowed` |
| pending | `follow_signal` or `pending_at_range` | Place the signal's pending order if its price is valid (below Ask for `BUY_LIMIT` at `entryHigh`, above Bid for `SELL_LIMIT` at `entryLow`, above Ask for `BUY_STOP` at `entryLow`, below Bid for `SELL_STOP` at `entryHigh`); otherwise market if `allow_market_fallback` and in range; else skip `invalid_pending_price` |

A pending signal whose order type disagrees with its direction is skipped as
`invalid_pending_price`. A crossed or non-positive quote is skipped as
`invalid_quote`.

Stop-loss checks (`validateStopLoss`): a BUY stop must be below the entry
reference, a SELL stop above it (`sl_wrong_side`). The distance must lie in
`[min_distance_price, max_distance_price]` (`sl_too_close`, `sl_too_far`).

## 6. Sizing and take-profit checkpoints

### 6.1 Volume

Units: integer step units, rendered with the step's decimal count, so
`0.07` is never `0.069999...`. Rounding is always **down** to a whole step.

```
riskPerLot = (|entry - stop| / tickSize) * tickValueLoss
cap        = min(limits.maxRiskMoney, equity * limits.maxRiskPercent / 100)
maxVolume  = min(symbol volumeMax, limits.maxLots)

fixed_lots:           volume = roundDown(fixed_lots, step)
fixed_risk_money:     volume = roundDown(min(risk_money, cap) / riskPerLot, step)
equity_risk_percent:  volume = roundDown(min(equity * risk_percent / 100, cap) / riskPerLot, step)

fixed_lots only:
  lots % step != 0             -> fail volume_not_step_aligned (never rounded silently)
  volume > maxVolume           -> fail volume_exceeds_max (never clamped)

risk modes only:
if volume > maxVolume          -> volume = roundDown(maxVolume), clampedBy = 'volume_max' or 'max_lots'
if volume < symbol volumeMin   -> skip (volume_below_min)
                                  or, if below_min_volume = use_min_if_within_cap
                                     and riskPerLot * volumeMin <= cap: volume = volumeMin
if riskPerLot * volume > cap   -> fail risk_exceeds_limit
```

Points to note:

- `fixed_lots` is **never resized**. Three refusals apply, each with its own
  reason: `volume_not_step_aligned` (the value is not a multiple of the symbol
  step), `volume_exceeds_max` (the value is above `min(volumeMax, maxLots)`), and
  `risk_exceeds_limit` (its risk is above the cap).
- Risk-derived sizes (`fixed_risk_money`, `equity_risk_percent`) may be clamped
  **down** to `maxVolume`. That only reduces risk. The result carries `clampedBy`.
- `equity` must be `> 0`. The symbol spec (tick size, tick value, min, max, step)
  must be positive and consistent, or the trade is refused.

**Worked example.** XAUUSD: tick 0.01, tick value loss 1.0 (so 1 lot loses 100
USD per 1.00 move), min 0.01, step 0.01, max 100. Entry 2000, stop 1995, equity
10000, `equity_risk_percent` 0.5.

- riskPerLot = 5 / 0.01 * 1.0 = 500 USD per lot.
- target = 10000 * 0.5 / 100 = 50 USD; cap = min(5000, 500) = 500 USD.
- volume = roundDown(50 / 500) = 0.10 lots, risk = 50 USD, 0.5% of equity.

### 6.2 Checkpoint plan

Each checkpoint `k` closes `closeVolume_k` of the position. Non-final checkpoints
round **down** to a step. The final checkpoint takes the remainder, so the total
is exactly the position volume. `targetRemainingVolume` is what should remain
after the close (the final checkpoint's target is 0).

```
closeVolume_k = roundDown(total * pct_k / 100)     for non-final k
closeVolume_last = total - sum(others)             final checkpoint
targetRemaining_k = total - sum(closeVolume_1..k)
```

Feasibility: every `closeVolume` must be `>= volumeMin`, and every non-final
`targetRemaining` must be `>= volumeMin` (the position must still be tradeable
for the next close).

**Worked example, 0.10 lots, checkpoints 50 / 30 / 20:**

| Checkpoint | Percent | closeVolume | targetRemaining |
|---|---|---|---|
| TP1 | 50 | 0.05 | 0.05 |
| TP2 | 30 | 0.03 | 0.02 |
| TP3 | 20 | 0.02 | 0 |

The three closes sum to exactly 0.10.

**Infeasible split, 0.01 lots, same checkpoints.** TP1 would close 0.005, which
rounds to 0 and is below the minimum.

- `infeasible_split = skip_trade`: the trade fails `tp_split_infeasible`.
- `infeasible_split = merge_into_next`: TP1's 50% folds into TP2 (80%). TP2's
  0.008 also rounds to 0, so it folds into TP3. The result is a single
  checkpoint: TP3 closes 100% (0.01). A single 100% checkpoint is always
  feasible. Two warnings are recorded.

**Infeasible split, 0.02 lots.** TP1 closes 0.01. TP2 (30%) rounds to 0 and
folds into TP3. Result: TP1 closes 0.01, TP3 closes the remaining 0.01.

**Missing TP.** If the signal has no TP3 and the checkpoints include TP3:

- `missing_tp = skip_trade`: the trade fails `tp_missing`.
- `missing_tp = merge_into_last_available`: TP3's 20% folds into the highest
  existing checkpoint (TP2, now 50%). A warning is recorded.

**Price order.** Selected TP prices must lie strictly beyond the entry reference
and move monotonically in the trade direction (BUY: ascending; SELL: descending).
Otherwise the trade fails `tp_order_invalid`.

**`broker_tp`.** With `final_checkpoint`, the broker holds a TP at the final
checkpoint's price. With `none`, the broker TP is 0 and only the AutoTrader
manages closes.

## 7. Example profile

The file `docs/project_memory/examples/optimal_report_profile.example.json` is
the canonical example. It validates with no errors and no warnings. It is
illustrative only, not a recommendation.

```json
{
  "schema_version": 1,
  "profile_id": "optimal-report-xauusd-example",
  "version": 1,
  "name": "XAUUSD Optimal Report (illustrative example)",
  "description": "Illustrative draft derived by hand from a manual Optimal Report review. Not a recommendation; values are placeholders to show the shape.",
  "source": {
    "type": "optimal_report",
    "report_id": "EXAMPLE-REPORT-ID",
    "report_date": "2026-01-01",
    "author": "operator",
    "notes": "Example only. Replace with figures from the reviewed report."
  },
  "broker": "vantage_mt5",
  "symbols": [{ "signal_symbol": "XAUUSD", "broker_symbol": "XAUUSD" }],
  "entry": {
    "policy": "pending_at_range",
    "market_tolerance_price": 0.5,
    "pending_expiry_minutes": 60,
    "allow_market_fallback": false
  },
  "sizing": { "mode": "equity_risk_percent", "risk_percent": 0.5, "below_min_volume": "skip" },
  "take_profit": {
    "checkpoints": [
      { "tp_index": 1, "close_percent": 50 },
      { "tp_index": 2, "close_percent": 30 },
      { "tp_index": 3, "close_percent": 20 }
    ],
    "missing_tp": "skip_trade",
    "infeasible_split": "merge_into_next",
    "broker_tp": "final_checkpoint"
  },
  "stop_loss": {
    "min_distance_price": 2.0,
    "max_distance_price": 25.0,
    "after_checkpoint": [
      { "after_tp_index": 1, "move_to": "entry", "buffer_price": 0.2 },
      { "after_tp_index": 2, "move_to": "previous_tp", "buffer_price": 0 }
    ]
  },
  "break_even": { "enabled": false, "trigger": "price_distance", "trigger_value": 5.0, "buffer_price": 0.2 },
  "trailing": {
    "enabled": false,
    "activation": "after_tp_index",
    "activation_value": 2,
    "distance_price": 3.0,
    "step_price": 0.5
  },
  "limits": {
    "max_concurrent_positions": 3,
    "max_positions_per_symbol": 1,
    "max_spread_price": 0.5,
    "max_deviation_points": 30,
    "signal_max_age_sec": 120,
    "daily_loss_limit_money": 100,
    "max_total_risk_percent": 3
  },
  "edits": {
    "before_fill": "apply_sl_tp",
    "after_fill": "apply_tighten_only",
    "unparseable_edit": "cancel_pending_only",
    "explicit_cancel": "cancel_pending_only"
  },
  "recommendations": { "note": "Informational only. Never executed." }
}
```

**Broker symbol.** `broker_symbol` is `XAUUSD` in the example only. Vantage
may name the instrument with a suffix such as `XAUUSD+`. Set `broker_symbol` to
the exact name shown in MT5 Market Watch before validating.

## 8. How an external agent should produce a draft

Output **one JSON object** that matches this document exactly:

- No comments, no prose, no markdown fences in the stored file. Prose belongs in
  `recommendations` or `description`.
- Omit `version`. The server assigns it. Do not add status fields.
- Use numbers, not strings, for every numeric field. Use `0` only where the
  table allows it.
- Omit optional fields you do not need. Do not send `null`.
- Include every required field for the chosen `sizing.mode`.
- Use price units for every distance. Never write pips.
- `signal_symbol` is uppercase. `broker_symbol` is the exact terminal name.
- Put reasoning, the source report reference and any suggested values in
  `recommendations`. It is never executed.
- Do not set values above the hard ceilings. A value above a ceiling is an
  **error**, and the profile is refused. Keep `fixed_lots` a multiple of the
  symbol's volume step, and keep it within the safety limits.

The agent's output is a draft. It has no effect until an operator validates,
approves and activates it.

## 9. Validation

**Programmatic.** `validateProfile(input)` in `executionProfile.ts` returns
`{ ok, value?, errors, warnings }`. `errors` are blocking. Each has a `path`
(for example `take_profit.checkpoints.1.tp_index`), a `message`, and where
relevant the submitted `value` and the applicable `limit`. Range and ceiling
errors always carry both, for example:

```
{ path: 'sizing.fixed_lots', message: 'fixed_lots 25 exceeds hard ceiling max_lots_per_trade 20', value: 25, limit: 20 }
```

`warnings` never block; they are used only for values ignored because their sizing
mode is inactive. On success, `value` is a deep copy of the input.
`validateSafetyLimits` does the same for the safety block.

**Runtime and activation check.** `validateProfileAgainstSafety(profile, safety)`
returns the list of issues against the current `settings.safety`. It applies the
same mapping as the ceilings, against the safety values, and also requires each
`symbols[].signal_symbol` to appear in `safety.allowed_signal_symbols`. An empty
list means the profile is within safety. Activation and new-entry admission both
use it. The same logic is applied again before each new entry, so a later safety
change takes effect without re-activating the profile.

`validateProfile` requires `version` to be present. The web API adds the
version when it validates a draft, so the object you pass in must include it.

**Operator.** The dashboard Profiles page, or `POST /api/profiles/validate`
(contracts section 8), runs the same validation and shows an execution preview.
Check `VANTAGE_IMPLEMENTATION_PROGRESS.md` for whether that workstream has landed.

**Procedure.**

1. Compose the JSON as in section 8.
2. Validate. Fix every error at the reported path. Re-validate.
3. Read the warnings. Confirm each is intended (for example, a value for an
   inactive sizing mode).
4. Check the example against your intent: the TP percentages sum to 100, the
   TP indexes you reference exist, and `broker_symbol` matches Market Watch.

## 10. Lifecycle: draft, approve, activate, rollback

Contracts sections 5 and 8. Every step writes an `execution_profile_audit` entry
with the actor, the time and the details.

| Step | Route | Effect |
|---|---|---|
| Create draft | `POST /api/profiles` | Creates `execution_profiles/{profile_id}__v{version}` with `status: draft`, a `validation` record and `created_by`. The server assigns `version`. |
| Edit draft | `PUT /api/profiles/[docId]` | Allowed only while `status` is `draft`. Re-validates. |
| Approve | `POST /api/profiles/[docId]/approve` | `status: approved`, `approved_at`, `approved_by`. Content is now **immutable**. |
| Activate | `POST /api/profiles/[docId]/activate` | Sets `settings/default.execution.active_profile_doc_id` to this doc. The previously active version becomes `superseded`. Requires `status: approved`, a passing `validateProfile`, and an empty `validateProfileAgainstSafety` against the current `settings.safety`. Otherwise the activation is refused and nothing changes. |
| Roll back | `POST /api/profiles/rollback` with `{ docId }` | Re-activates a previously approved version. The version that was active becomes `superseded`. |

Points to note:

- Activating or rolling back **does not change** trades already open. Each
  trade set keeps a `profile_snapshot` taken at entry, and later activations
  never rewrite it.
- **Open trades keep being managed under their frozen snapshot.** A profile that
  later fails the safety check, or a safety change that makes a profile
  exceed a limit, does not close, resize, or re-plan a trade that is already
  open or pending. Take-profit closes, stop-loss and break-even moves, trailing,
  and reconciliation continue as planned. Only new entries and pending-order
  placement are refused, with the reason recorded on the trade set.
- The kill switch and mode `disabled` block new entries. They do not stop
  management of trades already open.
- The `rejected` status exists in the audit model (`action: reject`). Section 8
  of the contracts lists no reject route yet, so an unwanted draft is not
  activated and may be left as a draft.
- To change an approved profile, create a new draft (a new version) and approve
  it. Do not edit the approved version.
