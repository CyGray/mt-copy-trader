# ByTrader Go Migration — Architecture Audit Handoff

## Purpose

This is an orientation brief for the next agent, which should make the architecture and design recommendations for the proposed Go migration. It records the plan and current repository evidence; it does not approve the migration or choose its target architecture. Do not implement migration work during the audit.

## Repository snapshot and evidence quality

- Repository: `/home/kyle/projects/ByTrader`; HEAD `435466fb27726f6a2274baeb290c189e2b6d3d33` (`feature/mt5-autotrader`).
- The worktree was heavily modified and contained many untracked files during this exploration. The audit must inspect `git status` and the complete current diff before treating HEAD as the implementation baseline. Do not discard or overwrite those changes.
- `docs/migrate/GO_MIGRATION_PLAN.md` and `docs/audits/VPS_RESOURCE_EFFICIENCY_AUDIT.md` are untracked local documents, not committed project decisions. The migration plan says “Approved for Implementation,” but all its roadmap checkboxes are open.
- `docs/project_memory/CURRENT_STATE.md` is dated 2026-10-23 and describes the worktree as offline-tested, not broker-verified, and not deployed. It reports 762 worker tests, 66 web tests, and 10 rules tests. Treat these as documented claims until verified against the current worktree.
- `docs/project_memory/PLANNING_BACKLOG.md` §D explicitly excludes rewrites and describes the two-service split, Firestore queue, and document-ID idempotency as working designs. This conflicts with the untracked Go plan and needs an owner-level decision.
- No `.codegraph/` index or usable zvec-grep index was present during exploration.

## What the migration plan proposes

The proposal is a whole-service migration, not a Go UI rewrite. It proposes a Go daemon (`bytraderd`) for the backend and operations, while keeping React for the browser UI and replacing Next.js with a Vite-built static SPA.

### Target components and assumptions

- One Go binary contains Telegram MTProto, signal processing, trade execution, ZeroMQ bridge, SQLite, HTTP APIs, and embedded web assets.
- Replace Firestore with SQLite in WAL mode; the diagram also mentions optional asynchronous Firestore sync, but no sync contract or implementation plan is specified.
- Replace GramJS with `gotd/td`, Node ZeroMQ with `go-zeromq/zmq4`, and the Next.js server with `net/http`/`chi` plus `embed.FS`.
- Keep React, Tailwind, and Lucide. Build a Vite SPA in `web/dist`; remove Next.js routing and use a lightweight router or a single dashboard view.
- Preserve MT5 protocol v2, intent-before-mutation, no blind retry after ambiguous mutation timeouts, target-remaining-volume partial closes, and sleeping lifecycle behavior.
- The sample SQLite schema covers `signal_events`, `trade_sets`, `trade_orders`, and `system_logs`. It does not define migration/import behavior for the full current Firestore data model.

### Complete roadmap inventory

1. **Environment and scaffolding:** install Go 1.23+ locally and on the VPS; add root `go.mod`; establish `cmd/bytraderd`, `internal/{broker,bridge,engine,lifecycle,notify,parser,profile,reconciler,safety,store,telegram,web}`, and the Vite `web/` app.
2. **Core logic:** port gold parsing, execution-profile validation, sizing, entry policy, and lifecycle rules; establish parity against existing TypeScript fixtures.
3. **Bridge and broker:** implement a pure-Go ZeroMQ v2 client with socket reuse, request correlation, and timeout handling; port simulated and MT5 brokers.
4. **Local state:** implement SQLite WAL and transactional event/trade/order queries; port reconciliation and an adaptive lifecycle runner.
5. **Telegram:** port the user client to `gotd/td`; create a session migration/authentication script; implement message handling, deduplication, forwarding, and a Go-channel handoff to execution.
6. **Dashboard:** convert Next.js to Vite + React SPA, remove Next routing, retain Tailwind/Lucide, build to `web/dist`, add Go health/trades/control/profiles APIs, and embed static assets.
7. **Parallel verification and deployment:** run paper mode alongside the current services, then verify against an MT5 demo account; measure RSS, idle CPU, and file descriptors; switch the systemd service to the Go binary and disable both Node services.

The plan also proposes retaining disabled legacy systemd units for rollback and says legacy Node services can resume from Firestore. That rollback claim needs scrutiny if SQLite becomes authoritative and has received writes that are not synchronized back to Firestore.

## Current system map

### Runtime and message-to-order path

`worker/src/index.ts` is the Forwarder and owns the only Telegram user session. It captures messages, applies filters and deduplication, parses/forwards gold signals, and publishes durable events. `worker/src/autotrader.ts` is a separate AutoTrader. It consumes Firestore `signal_events`, applies execution controls and profiles, and calls the broker layer. The two Node services communicate through Firestore, not direct imports or HTTP. See `deploy/SERVICES.md`, `worker/src/lib/signalEvents.ts`, `signalQueue.ts`, `signalOutbox.ts`, and `signalFeed.ts`.

The AutoTrader path includes `mt5TradeEngine.ts`, `brokerRouter.ts`, `mt5Broker.ts`, `mt5Client.ts`, `lifecycleManager.ts`, and `reconciler.ts`. The EA contract is in `mql5/PROTOCOL.md`; implementation is `mql5/VantageBridgeEA.mq5`. The UI and worker both depend on Firestore. The browser uses Firebase client SDK for reads; server-verified Next.js routes guard mutations.

### Web surface

- Pages: `/`, `/login`, `/admin`, `/analytics`, `/alerts`, `/logs`, `/profiles`, `/settings`, `/signals`, `/telegram`, and `/trades` under `web/src/app/`.
- API routes cover session creation/deletion, admin/role, Telegram session lifecycle, worker health, settings, execution mode/safety/kill switch, profiles and profile audit, alerts, signal queue inspection/recovery, and stuck-trade resolution. Enumerate current routes with `rg --files web/src/app/api` before designing replacement contracts.
- Auth boundary: `web/middleware.ts`, `web/src/app/api/session/route.ts`, `web/src/lib/serverAuth.ts`, `web/src/lib/firebaseAdmin.ts`, and `firestore.rules`. `ALLOWED_EMAILS` and admin-role checks fail closed; Firestore client writes are denied.
- UI building blocks live in `web/src/components/`, `web/src/hooks/`, and page-specific components in `web/src/app/profiles/`. Shared pure validation includes `worker/src/lib/executionProfile.ts`; inspect TS path aliases and web imports before proposing package boundaries.
- Root/web manifests specify Next.js 14, React 18, TypeScript 5.5, Firebase client/admin, Tailwind, Vitest, and Lucide. `web/package.json` currently depends on `firebase-admin` as well as the browser Firebase SDK; determine which imports are server-only before moving to Vite.

### State, execution safety, and operations

- Firestore is the shared source of truth and durable queue. Current state includes `signal_events` with leases/retries/dead letters, local forwarder outbox fallback, `trade_sets` schema 2 with frozen profile snapshots, `trade_events`, execution profiles and audit history, `admin_commands`, alerts, service heartbeats, settings, user roles, logs, and persisted paper-broker state. See `docs/project_memory/ARCHITECTURE.md` §0, `CURRENT_STATE.md`, and `VANTAGE_DESIGN_CONTRACTS.md`.
- Preserve document-ID idempotency, queue fencing/leases/order, intent persistence, ambiguous-timeout handling, broker ownership checks, frozen profiles, fail-closed config, kill-switch semantics, and the distinction between policy in the worker and order mechanics in the EA. `AGENTS.md` lists the current invariants.
- MT5 is an external Wine-hosted terminal/EA using loopback ZeroMQ protocol v2. The plan must not assume the EA can be changed without recompilation/deployment. Review `mql5/PROTOCOL.md`, `deploy/MT5_GUI.md`, and `docs/project_memory/VANTAGE_BROKER_ASSUMPTIONS.md`.
- Deployment files include two service units, Docker, dry-run deploy/rollback scripts, and a preflight tool. Current state says v2 code and EA are not deployed; production still runs old v1 artifacts. No audit or test should enable live trading or send broker orders.

## Questions for the architecture audit

Treat these as questions to verify, not conclusions:

1. **Decision and scope:** Is this a Go backend rewrite, a Next.js-to-static-SPA change, or both? Which owner decision supersedes the backlog’s explicit “no rewrites” position? Is a complete rewrite necessary to address the measured VPS problems?
2. **Baseline and measurements:** Separate production behavior from the current uncommitted worktree. Verify the audit’s CPU, memory, read-volume, and latency claims and define comparable measurement methods before accepting targets such as `<1 ms` or `<25 MB`.
3. **Process topology:** Can one daemon retain the restart/failure isolation of Forwarder and AutoTrader while preserving the single-session constraint? Compare a single Go process with incremental Go services and the existing two-service topology.
4. **Persistence and cutover:** Inventory every current Firestore collection and its readers/writers. Specify export/import, schema versioning, backup/restore, consistency, dual-run behavior, observability, and rollback after SQLite accepts writes. Decide whether Firestore remains for dashboard access, auth, or remote viewing.
5. **Queue correctness:** Map signal edits/cancels, outbox replay, idempotency, leases, fencing, ordering, retries, dead letters, and restart recovery to any proposed in-process or local queue. A buffered channel alone is not a durable replacement.
6. **Trading invariants:** Prove parity for profiles, safety gates, sizing, entry policies, order types, pending expiry, partial take-profits, lifecycle, reconciliation, and ambiguous broker outcomes. Include schema-2 trade states and migration of open trades.
7. **UI/API/auth parity:** Inventory every live page and API route, browser Firestore read, server mutation, role check, confirmation flow, and audit record. Assess which Next.js server functions move into Go and how browser auth, CORS/CSRF, sessions, static routing, and server-only Firebase code work after the move.
8. **External contracts:** Verify `gotd/td` session compatibility and recovery, Telegram forwarding/edit semantics, and byte-level ZeroMQ protocol v2 compatibility with the deployed EA.
9. **Migration sequencing and rollback:** Define a safe shadow/paper period, one active execution owner, cutover gates, rollback triggers, and data handling. Do not rely on restoring old services from Firestore unless reverse synchronization or a no-write cutover makes that true.
10. **Alternatives:** Compare targeted Node fixes, static SPA with the current backend, the Go daemon, and any other proposed runtime against measured needs and operational cost. Recommend the smallest architecture that satisfies owner goals.

## Suggested reading order for the audit agent

1. `git status --short` and the full diff; establish the actual worktree baseline.
2. `AGENTS.md`, this file, `docs/migrate/GO_MIGRATION_PLAN.md`, and `docs/audits/VPS_RESOURCE_EFFICIENCY_AUDIT.md`.
3. `docs/project_memory/CURRENT_STATE.md`, `ARCHITECTURE.md` §0, `VANTAGE_DESIGN_CONTRACTS.md`, `PLANNING_BACKLOG.md` §D, and `docs/project_memory/VANTAGE_EXECUTION_GUIDE.md`.
4. `deploy/SERVICES.md`; `worker/src/index.ts`, `autotrader.ts`; then `telegramListener.ts` → `signalEvents.ts` / `signalOutbox.ts` → `signalQueue.ts` / `signalFeed.ts` → `mt5TradeEngine.ts` → broker/bridge → `lifecycleManager.ts` / `reconciler.ts`.
5. `web/middleware.ts`, `web/src/lib/serverAuth.ts`, `firestore.rules`, all live pages and `web/src/app/api/**`; then the root, web, and worker manifests and test suites.
6. `mql5/PROTOCOL.md`, `mql5/VantageBridgeEA.mq5`, `deploy/MT5_GUI.md`, and the deploy/rollback/preflight scripts.

## Expected audit deliverable

Return a decision-ready report, not code: verified current-state map; discrepancies between plan, docs, worktree, and production; prioritized risks; options with tradeoffs; recommended target and migration stages; data/auth/queue/trading parity requirements; objective go/no-go gates; and unresolved owner decisions. Cite repository paths and line numbers. Mark every claim as verified, documented-only, inferred, or externally unverified. Do not run deploys, mutate production, access credentials, or send broker orders.
