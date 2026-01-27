# engineering-spec.md — Marine Trader Crypto Bot (v1)

## 0) Purpose
Build an always-on system that:
1) Logs into **Telegram as a user account** (phone + OTP + optional 2FA password), persists a reusable session securely.
2) Listens to a **private crypto signals channel** and parses structured signals (symbol, direction, SL, TP1–TP3).
3) Executes and manages trades on **Bybit Unified Trading Account** using **USDT Perpetuals**.
4) Provides a **mobile-first Next.js (React + Tailwind) PWA dashboard** for control, settings, analytics, and logs.
5) Runs via **Docker Compose** on **Hetzner Cloud (Singapore, $5 tier)** with long-lived connections (no cold starts).

---

## 1) Scope (v1)
### In scope
- Telegram user login via dashboard onboarding (phone, OTP, 2FA password if enabled).
- Session saved as an **encrypted local file** (server).
- Read-only Telegram consumption of:
  - channel posts
  - forwarded messages
  - replies
  - message edits
  - media captions
- Parse only the “strict structured” signal format (see §6).
- Execute market entry with “late signal” favorability check.
- Place and manage:
  - SL (full remaining position)
  - 3 reduce-only TP orders (60% / 25% / 15%)
  - Move SL rules:
    - after TP1 fill → SL = entry
    - after TP2 fill → SL = TP1
- Firestore as system-of-record (messages + trade state + event log).
- Reconciliation loop every **15 seconds** with Bybit.
- Dashboard:
  - Overview: open positions count, running PnL, last signal (symbol + datetime)
  - Trade history
  - Settings
  - Logs (full Telegram messages + system logs)
  - Analytics (basic performance + latency)
- Auth: Google login; roles: Admin, Viewer.
- Notifications: Telegram message, Email (SMTP), Dashboard notification, PWA push notification.
- Safety: Paper mode, Kill switch, Emergency close-all, limits (max open positions, max exposure per symbol, max daily loss, max consecutive failures).

### Out of scope (v1)
- Parsing and acting on follow-up commentary signals (e.g., “TP1 HIT…”, “Bring SL to entry” messages).
- Strategy backtesting.
- Multi-tenant / multiple Telegram accounts.
- Redis/queue infrastructure (unless required later).
- Reverse proxy (unless required later).

---

## 2) High-level Architecture
### Services (Docker Compose)
- `web` (Next.js)
  - PWA UI (React + Tailwind)
  - API routes for dashboard operations (settings, auth gating, admin actions)
- `worker` (trading engine)
  - Telegram listener + parser
  - Bybit executor + trade manager
  - reconciliation loop
  - notifications dispatcher (or shared module)
- External dependencies
  - Firestore (DB)
  - Bybit API
  - SMTP server (email)
  - Web Push (VAPID)
  - Telegram MTProto network

### Key design decisions
- **Separate `web` and `worker`** to keep dashboard alive if worker fails.
- Firestore is the **single source of truth**; Bybit is treated as an external state to reconcile against.
- Trade lifecycle is modeled as a **state machine**, with all actions recorded as immutable events.

---

## 3) Technology Stack (recommended)
- **Web**
  - Next.js (App Router), React, Tailwind
  - Firebase Auth (Google provider)
  - Firestore client SDK (read) + server SDK (admin operations)
  - Web Push (VAPID) for PWA notifications
- **Backend/Worker**
  - Node.js (TypeScript) recommended for unified stack with Next.js
  - Telegram MTProto client library (user auth + session persistence)
  - Bybit API client (Unified account, USDT perp endpoints)
- **Crypto / Secrets**
  - AES-GCM encryption for:
    - Telegram session file (local)
    - Bybit API keys in Firestore fields
    - optional: Telegram 2FA password (if stored)
  - Master key stored as server env var (Hetzner) or Docker secret equivalent
- **Deployment**
  - Docker Compose
  - Persistent volume for encrypted Telegram session file
  - Structured logs to stdout + Firestore “system_logs” collection

---

## 4) Security Model
### Secrets to protect
- Telegram session data (MTProto session)
- Telegram 2FA password (if user enters and opts to store)
- Bybit API key + secret
- SMTP credentials
- VAPID keys

### Storage rules
- Telegram session: encrypted file on disk, mounted volume. Never store session plaintext in Firestore.
- Firestore: encrypt sensitive fields (Bybit keys, SMTP password if stored).
- Dashboard: do not expose secrets; only show “configured/healthy” status and allow reset/re-auth flows.

### Access control
- Firebase Auth: Google login
- RBAC:
  - Admin: all actions + settings
  - Viewer: read-only (no trading controls, no setting edits)
- Admin-only actions must be validated server-side (Next.js route handlers).

---

## 5) Operational Constraints (Anti-ban / stability)
### Telegram constraints
- Must behave like a stable single client:
  - One session per account
  - One worker instance active at a time (use distributed lock in Firestore)
  - Stable IP (Hetzner SG)
- Reconnect strategy:
  - Exponential backoff on network errors
  - Avoid rapid reconnect loops (protect against flagging)
- On auth/session failure or suspected restriction:
  - Stop listener
  - Optionally log out (configurable)
  - Notify via push + email + Telegram DM
- Read-only: never post to channels, never react, never DM random users.

### Crash behavior
- Compose restart policy:
  - retry 1: 5s, retry 2: 15s, retry 3: 60s
  - then stop + notify client/admin

---

## 6) Signal Parsing Spec
### Supported formats (v1)
Structured signal message example:
ADAUSDT (4H) (futures)
⬆️ LONG NOW (20X)
⭕️SL @ 0.3796
🔵TP @ 0.3886
🔵TP @ 0.3988
🔵TP @ 0.4235
#cryptosignal #Crypto

kotlin
Copy code

Short example:
SUIUSDT (4H) (futures)
⬇️ SHORT NOW (20X)
⭕️SL @ 1.4516
🔵TP @ 1.3773
🔵TP @ 1.3359
🔵TP @ 1.1810

markdown
Copy code

### Parsing rules
- Symbol:
  - first token ending with `USDT` (e.g., `ADAUSDT`, `SUIUSDT`)
- Direction:
  - contains `LONG` or `SHORT` (case-insensitive)
- Entry:
  - must include `NOW` → market entry (v1)
- SL:
  - line containing `SL` and a numeric value
- TP:
  - first three occurrences of `TP` numeric values → TP1/TP2/TP3
- Reject if:
  - missing any of: symbol, direction, SL, 3 TPs
  - any TP/SL value is not parseable float
  - for LONG: SL >= entry reference price (see late checks); for SHORT: SL <= entry ref price
  - TP ordering invalid (LONG: TP1<TP2<TP3; SHORT: TP1>TP2>TP3)

### Edits handling
- All messages and edits are logged.
- If a message edit changes parsed fields and a trade is already open:
  - v1 behavior (recommended): do **not** widen risk; only allow modifications that reduce risk (e.g., tightening SL). Otherwise ignore edit and notify.

---

## 7) Market Entry + Late Signal Favorability Check
### Inputs
- Telegram message time (`t_msg`)
- Current time (`t_now`)
- Price at message time (`p_msg`) from Bybit market data
- Current price (`p_now`) from Bybit market data

### Decision
- If delay `t_now - t_msg` exceeds `MAX_SIGNAL_DELAY` → skip + notify
- Favorability check:
  - LONG: accept if `p_now <= p_msg + SLIPPAGE_TOL`
  - SHORT: accept if `p_now >= p_msg - SLIPPAGE_TOL`
- Optional skip if price already beyond TP1 threshold:
  - LONG: if `p_now >= TP1 - TP1_BUFFER` → skip
  - SHORT: if `p_now <= TP1 + TP1_BUFFER` → skip

All thresholds are configurable.

---

## 8) Risk & Sizing Model
### Configuration inputs
- `risk_mode`: `PERCENT_AVAILABLE_MARGIN` or `FIXED_USDT`
- `risk_value`: percentage (e.g., 1.0) OR fixed USDT (e.g., 50)
- Limits:
  - `max_daily_loss` (percent or fixed)
  - `max_open_positions`
  - `max_positions_per_symbol`
  - `max_consecutive_failures`

### Sizing algorithm (conceptual)
1) Determine `risk_amount`:
   - percent: `risk_amount = available_margin * (risk_value / 100)`
   - fixed: `risk_amount = risk_value`
2) Determine entry price reference:
   - use actual filled average entry price from Bybit once filled
3) `sl_distance = abs(entry - sl)`
4) Compute raw quantity so that max loss at SL ≈ risk_amount (accounting for contract specs).
5) Round quantity to Bybit lot step size.
6) Apply safety buffer (e.g., 98% of computed qty) to reduce insufficient margin.
7) Validate min qty / min notional; else skip and notify.

---

## 9) Order Strategy (Bybit)
### Entry
- Market order in the direction of the signal.
- On partial fill:
  - v1: accept actual filled size; build TP/SL based on actual size.

### Exits
- Place:
  - Stop loss order (reduce-only) for **100% remaining position**
  - 3 take profit limit orders (reduce-only):
    - TP1: 60%
    - TP2: 25%
    - TP3: 15%
- SL movement:
  - After TP1 fill is detected: cancel old SL, place new SL at entry for remaining qty
  - After TP2 fill is detected: cancel old SL, place new SL at TP1 for remaining qty
- On SL trigger:
  - Cancel all remaining TP orders for this trade set

### API correctness requirements
- All orders must be placed with correct:
  - symbol
  - side
  - reduce-only where appropriate
  - tick size / lot size rounding
- Worker must confirm order existence via Bybit query after placement.

---

## 10) State Machine
### Trade lifecycle states (minimum)
- `DETECTED` — signal parsed, awaiting checks
- `SKIPPED` — invalid / late / not favorable / blocked / limits hit
- `ENTRY_PLACED` — entry order submitted
- `OPEN` — position confirmed open
- `PROTECTION_PLACED` — SL + TP orders placed
- `TP1_FILLED` — TP1 partial closed
- `SL_MOVED_TO_ENTRY` — after TP1
- `TP2_FILLED` — TP2 partial closed
- `SL_MOVED_TO_TP1` — after TP2
- `TP3_FILLED` — final target closed
- `SL_FILLED` — stop loss closed remaining
- `CLOSED` — trade set complete
- `ERROR` — requires admin intervention or auto-retry

### Invariants
- At most one active trade set per symbol if configured (or allow multiple up to max).
- Reduce-only TP/SL orders must not increase position size.
- All state transitions must write an event record.

---

## 11) Reconciliation (Every 15 seconds)
### Goals
- Ensure Firestore state matches Bybit reality.
- Detect:
  - manual closes on Bybit
  - missing/canceled orders
  - partial fills
  - mismatched quantities
  - stale SL after TP fills

### Algorithm (high-level)
1) Load all `ACTIVE` trades from Firestore.
2) Query Bybit open positions for involved symbols.
3) Query open orders for involved symbols and correlate by:
   - stored order IDs
   - symbol + side + price + reduce-only flags
4) For each trade set:
   - update state if fills occurred
   - (re)place missing protection orders if safe and appropriate
   - if position closed unexpectedly: mark closed, cancel remaining, notify

---

## 12) Firestore Data Model (v1)
> Names are suggestions; final naming can change, but the structure should remain.

### Collections
#### `users`
- `uid`
- `role`: `admin` | `viewer`
- `email`
- `created_at`

#### `settings`
Single doc (or per-tenant doc, but v1 is single tenant).
- trading:
  - `paper_mode` (bool)
  - `kill_switch` (bool)
  - `risk_mode` (enum)
  - `risk_value`
  - `max_open_positions`
  - `max_positions_per_symbol`
  - `max_daily_loss_mode` (enum)
  - `max_daily_loss_value`
  - `max_consecutive_failures`
  - late-signal thresholds: `max_signal_delay_sec`, `slippage_tol`, `tp1_skip_buffer`
- notifications:
  - enabled flags per channel per event type
  - smtp config reference
  - telegram notify recipient(s)
- telegram:
  - channel identifiers / peer reference
  - “logout on block” (bool)

#### `telegram_messages`
- `message_id` (telegram internal id)
- `chat_id` / `peer_id`
- `date` (timestamp)
- `edit_date` (timestamp, optional)
- `type`: post/forward/reply/caption/edit
- `raw_text` (unredacted)
- `media_meta` (optional)
- `parsed_signal` (optional object with extracted fields)
- `parse_status`: ok/failed
- `hash` (optional for dedupe)

#### `trade_sets`
One per signal executed/skipped.
- `trade_set_id`
- `source_message_id`
- `symbol`
- `direction`
- `entry_type`: market
- `sl`
- `tp1`, `tp2`, `tp3`
- `risk_amount`
- `qty`
- `state`
- `created_at`, `updated_at`
- `bybit`:
  - `position_id` (if applicable)
  - `entry_order_id`
  - `sl_order_id`
  - `tp1_order_id`, `tp2_order_id`, `tp3_order_id`
  - `avg_entry_price`
  - `fills`: summary

#### `trade_events` (append-only)
- `trade_set_id`
- `timestamp`
- `event_type`: DETECTED, SKIPPED, ENTRY_PLACED, OPEN_CONFIRMED, TP1_FILLED, SL_MOVED, ERROR, etc.
- `details` (json payload)
- `bybit_snapshot` (optional)

#### `system_logs`
- `timestamp`
- `level`: info/warn/error
- `component`: worker/web/telegram/bybit
- `message`
- `details` (json)

#### `push_subscriptions`
- `uid`
- `endpoint`
- `keys`
- `created_at`

---

## 13) Encryption Spec (v1)
### Algorithms
- AES-256-GCM
- Random IV per encryption
- Store IV + ciphertext + auth tag together
- Use base64 encoding for storage in Firestore

### Key management
- `MASTER_KEY` from environment variable on server
- Optional: key versioning field in encrypted payload for rotation later

---

## 14) Dashboard Requirements (v1)
### Pages
- Overview
  - open positions count
  - running PnL
  - last signal (symbol, timestamp)
  - bot status: running/stopped, telegram session OK, bybit OK
- Trade history
  - filter by symbol/date/state
  - drill-down view shows event timeline
- Settings (admin only)
  - risk controls, limits, notifications, paper/live mode, kill switch
  - telegram session status + “re-auth required” CTA
- Logs
  - telegram messages list (raw text)
  - system logs
- Analytics
  - win rate, PnL aggregates, drawdown proxy, average trade duration, trade latency

### Actions (admin only)
- Enable/disable paper mode
- Toggle kill switch
- Emergency close-all
- Start/stop worker (logical flag in Firestore; worker respects it)

---

## 15) Notification Requirements (v1)
### Channels
- Telegram DM/message (to configured recipient)
- Email (SMTP)
- Dashboard in-app notifications
- PWA push

### Events (configurable)
- Trade executed
- TP1/TP2/TP3 hit
- SL hit
- Telegram login/session expired
- Telegram blocked/suspected restriction
- Bybit downtime/API error
- Worker crash / restart limit reached
- Daily summary (optional)

### Anti-spam
- Rate-limit repeated error notifications:
  - e.g., same error type no more than once per 5 minutes

---

## 16) Deployment (Hetzner SG $5)
### Compose requirements
- `web` container
- `worker` container
- mounted volume for telegram session encrypted file
- env vars for:
  - Firestore credentials
  - Bybit keys (or encrypted in Firestore)
  - SMTP creds
  - VAPID keys
  - encryption master key
- resource constraints (soft):
  - ensure worker doesn’t starve web

---

## 17) Non-functional Requirements
- Idempotency: actions must be safe to retry (network failures, restarts).
- Exactly-once trade creation per signal:
  - dedupe by telegram message id + hash
- Latency:
  - acceptable trade latency given low frequency; log end-to-end time from message receipt to entry fill
- Auditability:
  - every action logged (telegram message + trade events + order changes)

---

## 18) Acceptance Criteria (v1)
- Telegram login works via dashboard; session persists across restarts.
- Valid structured signal triggers correct market entry on testnet and places SL + TP ladder.
- TP fills update SL correctly (TP1 → entry, TP2 → TP1).
- SL hit cancels remaining TP orders and closes trade set.
- Firestore contains full message log + full trade event timeline.
- Reconciliation recovers correctly after worker restart and matches Bybit state.
- Dashboard kill switch prevents new trades.
- Emergency close-all works (admin-only).
- Notifications fire correctly for configured events.

---

## 19) Open Decisions (to finalize before implementation)
- Exact thresholds:
  - `MAX_SIGNAL_DELAY`, `SLIPPAGE_TOL`, TP1 skip buffer
- Edited message policy for active trades (tighten-only recommended)
- Default max daily loss (your initial value is 90%; recommended default is lower)
- Log retention policy for Firestore costs
- Whether “logout on Telegram block” is required or just stop+notify

## 20) Accounting, PnL, and Metrics Definitions

### PnL calculation rules
- All PnL metrics are calculated using **realized PnL only**.
- Unrealized PnL may be displayed on the dashboard but must be clearly labeled.
- Fees:
  - Trading fees (maker/taker) are included in realized PnL when available via Bybit fills.
  - Funding fees:
    - v1: displayed separately (informational), not merged into trade PnL.
- Currency:
  - All PnL is reported in **USDT**.

### Trade outcome classification
Each completed trade set is classified as one of:
- `FULL_TP` — TP3 reached
- `PARTIAL_TP` — TP1 or TP2 reached, then SL
- `BREAKEVEN` — SL moved to entry and hit
- `FULL_SL` — SL hit before TP1
- `MANUAL_CLOSE` — closed by admin action or external change

These classifications are stored on the `trade_sets` document for analytics.

---

## 21) Daily Risk Reset & Accounting Window

### Daily loss limit
- The "day" is defined as **UTC day** (00:00–23:59 UTC).
- Daily loss includes:
  - realized PnL losses
  - excludes unrealized PnL
- Once the daily loss limit is hit:
  - new trade execution is blocked
  - existing trades continue to be managed (TP/SL still active)
  - notification is sent
- Daily counters reset automatically at UTC day rollover.

---

## 22) Duplicate Signal Protection

### Duplicate detection
To prevent accidental duplicate execution:
- A signal is considered duplicate if:
  - same symbol
  - same direction
  - same SL
  - same TP set
  - within a configurable time window (default: 24h)
- Duplicate signals are:
  - logged
  - skipped
  - optionally notified (configurable)

This protects against reposts, forwarded repeats, or accidental edits.

---

## 23) Manual Intervention Rules

### Admin manual actions
Admin actions include:
- Kill switch toggle
- Emergency close-all
- Manual trade close (per trade set)

Rules:
- Manual close immediately:
  - cancels all remaining TP/SL orders
  - closes the position at market
- Manual actions are logged as `trade_events` with:
  - actor (admin UID)
  - reason (free text)
- After manual close:
  - trade state transitions to `MANUAL_CLOSE`
  - reconciliation loop must not attempt to “fix” the trade

---

## 24) Telegram Message Deduplication & Ordering

### Ordering guarantees
- Telegram messages are processed in the order received.
- If messages arrive out-of-order (rare but possible):
  - ordering is corrected using message timestamp and message ID.

### Deduplication
- Each Telegram message is identified by:
  - `chat_id + message_id`
- A hash of the normalized message text is stored to guard against:
  - resend
  - reconnect replay
- Deduplication must occur **before parsing**.

---

## 25) Exchange Downtime & Degraded Modes

### Bybit degraded mode
If Bybit API becomes unavailable:
- New trades are blocked.
- Existing trades:
  - are **not modified** until API recovers.
  - reconciliation pauses after configurable retries.
- Notifications:
  - immediate alert
  - periodic reminder if downtime persists (rate-limited).

### Telegram degraded mode
If Telegram becomes unavailable:
- Listener pauses.
- Worker remains alive.
- Existing trades continue to be managed via Bybit.
- Client is notified only once per incident (unless resolved and reoccurs).

---

## 26) Time & Clock Synchronization

- All timestamps are stored in **UTC**.
- The worker must periodically:
  - compare server time vs Bybit server time
  - log drift if above threshold (e.g., >500ms)
- Time drift above threshold:
  - blocks trade execution
  - notifies admin
This prevents incorrect “late signal” decisions.

---

## 27) Compliance & Responsibility Boundary (Engineering Perspective)

- The system is an **execution tool**, not a strategy engine.
- The system:
  - does not validate signal quality
  - does not evaluate market conditions
  - does not override provided SL/TP values
- Responsibility boundaries:
  - Signal provider → signal logic
  - Bot → faithful execution + risk controls
  - Client → capital allocation decisions

This section exists to make engineering intent explicit and prevent feature creep.

---

## 28) Versioning & Upgrade Safety

### Version tagging
- Each deployment includes:
  - `app_version`
  - `schema_version`
- Stored on:
  - Firestore `settings` doc
  - `system_logs` on startup

### Upgrade rules
- Schema changes must be backward-compatible for:
  - active trade sets
  - historical analytics
- Worker must refuse to start if:
  - schema version is incompatible
  - critical migration incomplete

---

## 29) Explicit Non-Goals (Hard Boundaries)

The following will **not** be added implicitly:
- Signal “smart interpretation” or NLP-based inference
- Automatic leverage optimization
- Auto-switching signal providers
- Auto-trading based on performance metrics
- Copy trading other accounts

Any of the above requires a separate spec revision.

---

## 30) Engineering Success Criteria (Internal)

Engineering considers v1 successful when:
- The system can run unattended for weeks without manual babysitting.
- Restarts do not cause duplicate trades.
- A Telegram outage does not affect existing positions.
- A Bybit outage does not corrupt trade state.
- An admin can always stop risk instantly.

These are **non-negotiable quality bars**.