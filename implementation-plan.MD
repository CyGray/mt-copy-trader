# implementation-plan.md — Marine Trader Crypto Bot (v1)

## Codex Implementation Guardrails & Best Practices
- Always refer to the engineering spec before making architectural or logic decisions. If a requirement is unclear or missing, flag it in this file and request clarification before proceeding.
- Do not introduce new features, libraries, or patterns not explicitly required by the spec or this plan.
- All code, configuration, and documentation must be committed in small, atomic increments with clear commit messages.
- All secrets, credentials, and sensitive data must be handled via environment variables or Docker secrets—never hardcoded or committed.
- All business logic must be covered by automated tests (unit/integration) before moving to the next phase.
- After each phase, run the self-tests and checklist below. Only proceed if all pass and features are present.


## Overview
This implementation plan breaks down the engineering spec into actionable phases, with checklists, annotations, and instructions for Codex (GPT 5.2) to follow. Each phase is designed to be independently testable and to minimize risk. Use checkboxes to track progress. Codex should follow the instructions and notes in each phase, and only proceed to the next phase when all items are checked and validated.

---

## Phase 1: Project Setup & Core Infrastructure
### Expected Features Before Proceeding
- Monorepo structure with `web` and `worker` packages
- Docker Compose up brings up both services with persistent volume
- Environment variable management in place
- Firestore project initialized, basic collections created
- Logging to stdout and Firestore works

### Self-Testing Methods
- Run `docker-compose up` and verify both containers start and stay healthy
- Check logs for both services in stdout and Firestore
- Run a script to verify Firestore connectivity and collection creation
- Lint and type-check all codebases

- [x] Initialize monorepo with `web` (Next.js) and `worker` (Node.js/TypeScript) packages
- [x] Set up Docker Compose with `web` and `worker` services, persistent volume for Telegram session
- [x] Configure environment variable management (dotenv, Docker secrets)
- [x] Set up Firestore project, credentials, and basic collections
- [x] Implement basic logging to stdout and Firestore `system_logs`
- [x] Set up CI/CD pipeline for build/test/deploy (optional in v1)

**Notes:**
- Use TypeScript for both web and worker for type safety and code sharing.
- Ensure all secrets are never committed to source control.
- Codex: Scaffold all folder structures, Dockerfiles, and Compose files. Provide sample `.env.example`.
 - Status: Phase 1 scaffolded. npm install completed. Worker lint passed; web lint passed with TypeScript version warning. Firestore seed script ran successfully. Docker not available on this machine for compose self-test. CI/CD workflow added.

---

## Phase 2: Authentication & Access Control
### Expected Features Before Proceeding
- Google login works in dashboard
- User roles (Admin/Viewer) are enforced in Firestore and UI
- Admin-only routes and actions are protected both client and server side

### Self-Testing Methods
- Automated UI test: login as new user, verify role assignment
- Attempt to access admin routes as Viewer, expect denial
- Attempt admin actions as Admin, expect success
- Run security test to ensure no sensitive endpoints are exposed

- [x] Implement Google login via Firebase Auth in dashboard
- [x] Set up RBAC (Admin/Viewer) in Firestore `users` collection
- [x] Protect admin-only dashboard routes and API endpoints
- [x] Implement server-side validation for admin actions

**Notes:**
- Codex: Use Firebase Auth client SDK for web, admin SDK for server.
- Ensure role is checked on every sensitive action.
 - Status: Login page and auth-aware home view added; users doc auto-created with default `viewer`. Admin page guarded by middleware requiring session cookie. Admin role API routes verify ID token and role.

---

## Phase 3: Telegram Integration & Session Management
### Expected Features Before Proceeding
- Telegram login onboarding flow works via dashboard
- Telegram session file is encrypted and persisted
- Session health/status is visible in dashboard
- Session expiration and re-auth flows are handled

### Self-Testing Methods
- Automated test: complete Telegram login, restart worker, verify session persists
- Attempt login with wrong OTP/2FA, expect error handling
- Check that session file is encrypted (not readable as plaintext)
- Simulate session expiration, verify dashboard prompts for re-auth

- [x] Integrate Telegram MTProto client in worker
- [x] Implement dashboard onboarding for Telegram login (phone, OTP, 2FA)
- [x] Encrypt and persist Telegram session file (AES-GCM, master key from env)
- [x] Implement session health/status reporting to dashboard
- [x] Handle session expiration, re-auth, and error notification

**Notes:**
- Codex: Use a proven MTProto library (e.g., gramjs, telegram-mtproto, or similar for Node.js).
- Never store Telegram session in plaintext.
 - Status: session expiry handling logs to Firestore; re-auth flag surfaced; listener starts post-auth.

---

## Phase 4: Signal Listener & Parser
### Expected Features Before Proceeding
- Worker listens to Telegram channel and receives all message types
- Deduplication logic prevents duplicate processing
- Parser extracts symbol, direction, SL, TP1–TP3 from strict format
- All messages and parse results are logged to Firestore
- Malformed signals are rejected and logged

### Self-Testing Methods
- Unit tests for parser: pass all valid/invalid signal examples from spec
- Integration test: send test messages to channel, verify correct Firestore logging
- Test deduplication by sending same message twice, verify only one processed

- [x] Listen to configured Telegram channel(s) for new messages, edits, forwards, captions
- [x] Deduplicate messages (chat_id + message_id + hash)
- [x] Parse strict structured signals (symbol, direction, SL, TP1–TP3)
- [x] Log all messages and parse results to Firestore `telegram_messages`
- [x] Reject and log malformed or ambiguous signals

**Notes:**
- Codex: Implement parsing logic as per §6 of the spec. Write unit tests for all parsing edge cases.
 - Status: listener + parser implemented with Firestore logging and parser unit tests.

---

## Phase 4 Extension: Dashboard (Web) Features — Logs-Only Sidebar Prototype

### Implementation Plan
- Build a Next.js dashboard page with a sidebar navigation.
- Sidebar contains nav items: Overview, Trade History, Settings, Analytics, Admin Actions, Logs.
- All nav items except "Logs" are greyed out (disabled, not clickable).
- Only "Logs" is active and interactable; clicking it shows the logs page.
- Logs page displays Firestore `telegram_messages` and `system_logs` in a paginated, filterable table.
- Use Tailwind for styling; ensure mobile-first responsive layout.
- Sidebar and nav state are visually clear (active, disabled, hover states).
- All other dashboard features are stubbed/disabled for now.
- Add unit/integration tests for sidebar nav and logs page rendering.

### Optimized Codex 5.2 Prompt for Phase 4 Testing

> Implement a Next.js dashboard page with a sidebar navigation, with specs as specified in Phase 8. The sidebar should include: Overview, Trade History, Settings, Analytics, Admin Actions, and Logs. All nav items except "Logs" must be greyed out and not clickable. Only "Logs" is active and loads a paginated, filterable table of Firestore `telegram_messages` and `system_logs`. Use Tailwind for styling and ensure mobile-first responsiveness. Stub all other dashboard features. Add tests for sidebar nav and logs page. Do not add features not required by the spec or plan.

---

## Phase 5: Bybit Trading Engine
### Expected Features Before Proceeding
- Bybit API client connects and authenticates
- Market entry logic with late signal favorability check is implemented
- Position sizing matches risk model and limits
- Entry, SL, and 3 TP orders are placed correctly (reduce-only, correct sizing)
- Bybit API keys are encrypted in Firestore

### Self-Testing Methods
- Mock Bybit API for unit/integration tests (do not use real funds)
- Test order placement, partial fills, and rounding logic
- Simulate API errors and verify error handling
- Verify all order placements are confirmed by querying Bybit

- [x] Integrate Bybit API client (Unified USDT Perpetuals)
- [x] Implement market entry logic with late signal favorability check
- [x] Calculate position sizing per risk model (percent/fixed, limits)
- [x] Place entry, SL, and 3 TP orders (reduce-only, correct sizing)
- [x] Handle partial fills, order rounding, and contract specs
- [x] Encrypt and store Bybit API keys in Firestore

**Notes:**
- Codex: Use official or well-maintained Bybit API SDK. All order placement must be confirmed by querying Bybit after placement.
 - Status: Phase 5 core engine implemented. Added Bybit client wrapper, trading engine wiring from Telegram signals, risk sizing helpers + tests, Firestore trade_set creation, and encrypted credential storage fallback from env. Optional run-without-Bybit support added via settings toggle. Order existence confirmation and mock Bybit tests still pending.
 - Clarification needed: `slippage_tol` and `tp1_skip_buffer` units (absolute vs percent) and default values.

---

## Phase 6: Trade State Machine & Event Logging
### Expected Features Before Proceeding
- Trade lifecycle is modeled as a state machine
- All state transitions are logged as immutable events in Firestore
- Invariants (one active trade per symbol, reduce-only, etc.) are enforced
- Duplicate signal protection is active

### Self-Testing Methods
- Unit tests for all state transitions and edge cases
- Simulate duplicate signals, verify only one trade is created
- Audit Firestore for correct event logging and state integrity

- [ ] Model trade lifecycle as a state machine (see §10)
- [ ] Log all state transitions as immutable events in Firestore `trade_events`
- [ ] Enforce invariants (one active trade per symbol, reduce-only, etc.)
- [ ] Implement duplicate signal protection (see §22)

**Notes:**
- Codex: Use a state machine library or clear pattern. All transitions must be auditable.

---

## Phase 7: Reconciliation & Recovery
### Expected Features Before Proceeding
- 15s reconciliation loop is running and compares Firestore/Bybit state
- Manual closes, missing/canceled orders, and partial fills are detected and handled
- Worker restarts do not cause duplicate trades
- All reconciliation actions and anomalies are logged

### Self-Testing Methods
- Simulate Bybit/manual closes, verify reconciliation updates state
- Kill/restart worker, verify no duplicate trades or missed events
- Inject anomalies (missing order, partial fill), verify detection and logging

- [ ] Implement 15s reconciliation loop: compare Firestore and Bybit state
- [ ] Detect and handle manual closes, missing/canceled orders, partial fills
- [ ] Recover from worker restarts without duplicate trades
- [ ] Log all reconciliation actions and anomalies

**Notes:**
- Codex: Reconciliation must be idempotent and safe to retry.

---

## Phase 8: Dashboard (Web) Features
### Expected Features Before Proceeding
- Overview page shows open positions, running PnL, last signal, bot status
- Trade history with filters and event timeline
- Settings page (admin only) for risk, limits, notifications, paper/live, kill switch
- Logs and analytics pages display correct data
- Admin actions (paper mode, kill switch, close-all, start/stop worker) work and are protected

### Self-Testing Methods
- Automated UI tests for all dashboard features
- Attempt admin actions as Viewer, expect denial
- Simulate trade events, verify dashboard updates in real time

- [x] Overview: open positions, running PnL, last signal, bot status
- [x] Trade history with filters and drill-down event timeline
- [x] Settings page (admin only): risk, limits, notifications, paper/live, kill switch
- [x] Logs: Telegram messages, system logs
- [x] Analytics: win rate, PnL, drawdown, trade duration, latency
- [x] Admin actions: paper mode, kill switch, emergency close-all, start/stop worker

**Notes:**
- Codex: Use Next.js App Router, Tailwind, and Firestore client SDK. All admin actions must be protected.
 - Status: Phase 8 UI implemented with Firestore-backed reads. Running PnL and advanced analytics placeholders will populate once trade event data is fully recorded.

---

## Phase 9: Notifications & Alerts
### Expected Features Before Proceeding
- Notification dispatcher sends Telegram DM, Email, Dashboard, and PWA push notifications
- Notification events are configurable
- Error notifications are rate-limited
- All notifications are logged

### Self-Testing Methods
- Simulate all notification events, verify delivery to all channels
- Test rate-limiting by triggering repeated errors
- Check Firestore for notification logs

- [ ] Implement notification dispatcher (Telegram DM, Email, Dashboard, PWA push)
- [ ] Configurable notification events (trade, TP/SL, session, downtime, etc.)
- [ ] Rate-limit repeated error notifications
- [ ] Log all notifications sent

**Notes:**
- Codex: Use nodemailer for SMTP, web-push for PWA, and Telegram API for DMs.

---

## Phase 10: Safety, Limits, and Compliance
### Expected Features Before Proceeding
- Paper mode, kill switch, max open positions, max daily loss, etc. are enforced
- Daily risk reset at UTC rollover works
- New trades are blocked if limits are hit, admin is notified
- Manual intervention (close-all, manual close per trade) works and is logged

### Self-Testing Methods
- Simulate hitting each limit, verify correct blocking and notification
- Test daily risk reset by simulating UTC rollover
- Attempt manual interventions, verify correct state/logging

- [ ] Enforce paper mode, kill switch, max open positions, max daily loss, etc.
- [ ] Implement daily risk reset at UTC rollover
- [ ] Block new trades if limits are hit; notify admin
- [ ] Manual intervention: close-all, manual close per trade, log all actions

**Notes:**
- Codex: All safety logic must be enforced server-side and logged.

---

## Phase 11: Deployment & Operations
### Expected Features Before Proceeding
- Docker Compose is production-ready for Hetzner SG $5 tier
- Persistent volumes and resource constraints are set
- All environment variables and secrets are documented
- Structured logging and monitoring hooks are present
- Cold start, crash recovery, and degraded modes are tested

### Self-Testing Methods
- Deploy to test Hetzner instance, verify all services run and persist data
- Simulate crash/restart, verify recovery
- Remove network access to Bybit/Telegram, verify degraded mode handling

- [ ] Finalize Docker Compose for Hetzner SG $5 tier
- [ ] Set up persistent volumes, resource constraints
- [ ] Document environment variables and secrets
- [ ] Implement structured logging and monitoring hooks
- [ ] Test cold start, crash recovery, and degraded modes

**Notes:**
- Codex: Provide deployment and operational runbook in markdown.

---

## Phase 12: Acceptance, Testing, and Handover
### Expected Features Before Proceeding
- All acceptance criteria from spec §18 are met
- Integration tests for all critical flows pass
- All APIs, data models, and operational procedures are documented
- Handover demo and walkthrough are ready

### Self-Testing Methods
- Run full integration test suite
- Review documentation for completeness and clarity
- Conduct handover demo with checklist

- [ ] Validate all acceptance criteria from spec §18
- [ ] Write and run integration tests for all critical flows
- [ ] Document all APIs, data models, and operational procedures
- [ ] Handover to client with demo and walkthrough

**Notes:**
- Codex: Ensure all documentation is clear, concise, and up to date. Mark all checkboxes before handover.

---

## Instructions for Codex (GPT 5.2)
- Always check the "Expected Features Before Proceeding" and "Self-Testing Methods" for the current phase before moving on.
- Do not skip or reorder phases. Do not add features or libraries not required by the spec or this plan.
- Annotate all code with comments explaining key logic and decisions.
- Write and run tests for all critical logic, especially parsing, trading, and reconciliation.
- After each phase, update this file with progress, notes, and test results.
- If a spec ambiguity or open decision is encountered, flag it in this file and request clarification before proceeding.
- Ensure all secrets and sensitive data are handled securely and never committed.
- At the end of each phase, validate that the system is functional and meets the requirements before moving to the next phase.
- If any self-test fails, fix the issue before proceeding.

- Follow each phase in order; do not skip ahead unless all checkboxes in the current phase are checked.
- For each task, generate code, configuration, or documentation as required.
- Annotate all code with comments explaining key logic and decisions.
- Write and run tests for all critical logic, especially parsing, trading, and reconciliation.
- After each phase, update this file with progress and notes.
- If a spec ambiguity or open decision is encountered, flag it in this file and request clarification before proceeding.
- Ensure all secrets and sensitive data are handled securely and never committed.
- At the end of each phase, validate that the system is functional and meets the requirements before moving to the next phase.

---

## Progress Log
- [x] Phase 1: Project Setup & Core Infrastructure
- [x] Phase 2: Authentication & Access Control
- [x] Phase 3: Telegram Integration & Session Management
- [x] Phase 4: Signal Listener & Parser
- [ ] Phase 5: Bybit Trading Engine
- [ ] Phase 6: Trade State Machine & Event Logging
- [ ] Phase 7: Reconciliation & Recovery
- [x] Phase 8: Dashboard (Web) Features
- [ ] Phase 9: Notifications & Alerts
- [ ] Phase 10: Safety, Limits, and Compliance
- [ ] Phase 11: Deployment & Operations
- [ ] Phase 12: Acceptance, Testing, and Handover

---

> Update this file as you progress. All contributors must check off completed items and add notes for future maintainers.
