# AGENTS.md — ByTrader

Orientation for AI coding agents. Read this before changing anything; follow the
links for depth instead of rediscovering the codebase.

## What this project is

**ByTrader** — a private, single-tenant bridge that listens to Telegram signal
channels as a *user account*, parses structured trade signals, forwards them to a
destination channel, and executes them on a broker, with a Next.js operator
dashboard on top.

npm-workspaces monorepo: `web/` (Next.js 14 App Router) + `worker/`
(TypeScript, two long-running services) + `mql5/` (MetaTrader 5 Expert Advisor) +
`deploy/` (systemd units and VPS scripts). Shared state is **Google Cloud
Firestore**; there is no other database or queue.

> **Execution path.** Vantage MT5 is the only live execution path:
> `signal_events` → AutoTrader (`mt5TradeEngine.ts` → `brokerRouter.ts` →
> `mt5Client.ts` protocol v2) → `mql5/VantageBridgeEA.mq5` v2. The legacy Bybit
> engine was **deleted** on 2026-10-21 (owner decision in the hardening mission).
> `telegramParser.ts` stays: it fills the message history and never executes.

> ⚠️ **`worker/dist/` is production on the VPS host.** The systemd units load it
> with `Restart=always`. Do not run `npm run build` (root or worker) there;
> use `npm run typecheck` or emit to a temp `--outDir`. Deploy only with
> `deploy/deploy-v2.sh` (dry run by default) per
> `docs/project_memory/VANTAGE_EXECUTION_GUIDE.md` §17 (worker + EA together).
> `node_modules/bybit-api` must stay until the v1 rollback window has passed:
> do not run `npm ci`, `npm prune` or a plain `npm install` on the host before that.

## Read these first

| Document | Why |
|---|---|
| `docs/project_memory/PROJECT_CONTEXT.md` | What the project is, full stack, constraints |
| `docs/project_memory/ARCHITECTURE.md` | How it works end to end, with file/line evidence |
| `docs/project_memory/CURRENT_STATE.md` | What is implemented vs. not — read before planning |
| `docs/project_memory/REPOSITORY_MAP.md` | Where everything lives |
| `docs/project_memory/DEVELOPMENT_GUIDE.md` | Commands, env vars, conventions |
| `docs/project_memory/PLANNING_BACKLOG.md` | Known outstanding work |
| `deploy/SERVICES.md` | The forwarder/AutoTrader split — the most accurate ops doc |
| `docs/project_memory/VANTAGE_EXECUTION_GUIDE.md` | Operating the AutoTrader: modes, kill switch, close-all, recovery, demo verification, deploy |
| `docs/project_memory/VANTAGE_DESIGN_CONTRACTS.md` | Interfaces: bridge protocol v2, broker layer, data model, engine/lifecycle rules |
| `docs/project_memory/OPTIMAL_REPORT_SCHEMA.md` | Execution profile format for the manual Optimal Report |
| `docs/project_memory/VANTAGE_TEST_REPORT.md` | What is verified offline and what is not |
| `docs/project_memory/VANTAGE_BROKER_ASSUMPTIONS.md` | What the code assumes about Vantage, the safeguard for each, the evidence still needed |
| `docs/research/signal_provider/HISTORY.md` + skill `.claude/skills/signal-provider-analysis/SKILL.md` | Signal-provider performance research: conclusions, history, and the repeatable read-only analysis workflow (use it before judging a provider, TP or lot size) |

## Directory navigation

```
web/src/app/            Pages + API routes (Next.js App Router)
web/src/lib/            Firebase clients, auth hook, format helpers
worker/src/index.ts     Forwarder entry point   (:4000) — owns the Telegram session
worker/src/autotrader.ts AutoTrader entry point (:4001) — MT5 execution
worker/src/lib/         All worker logic + co-located Vitest tests
mql5/VantageBridgeEA.mq5 ZeroMQ REP bridge inside MT5
worker/src/tools/       preflight.ts (read-only deploy checks)
deploy/                 systemd units, deploy-v2.sh / rollback-v2.sh, MT5 GUI/VNC scripts, service docs
tests/firestore-rules/  Firestore rules tests (emulator; standalone npm package)
web/test/               Web API route and view-model tests (Vitest)
```

## Architecture rules to preserve

1. **Only the forwarder may hold the Telegram session.** The AutoTrader must
   never import `telegramClient.ts`. The split exists so either service can be
   rebuilt and restarted without disturbing the other.
2. **The two services communicate only through Firestore** (`signal_events`), not
   over HTTP and not by importing each other's entry point.
3. **Idempotency is by Firestore document id.** Always check `doc.exists` before
   acting. Never introduce a locking scheme.
   - `trade_sets` → `${chatId}_${messageId}`
   - `signal_events` → `${chatId}_${messageId}_${textHash}`
   - `telegram_messages` → `${chatId}_${messageId}_${textHash}`
4. **`initFirestore()` returns `null`, never throws.** Callers no-op on `null`.
   Keep that contract; do not add throwing variants.
5. **Config loaders have a TTL cache and hardcoded defaults.** Follow the pattern
   in `signalForwarding.ts`, `mt5Secrets.ts`, `executionControl.ts` (camelCase in
   TS, snake_case on disk).
6. **Log twice on significant paths**: `logger.*` (stdout JSON) and
   `writeSystemLog(...)` (Firestore `system_logs`).
7. **Firestore is the source of truth for config; the EA is the source of truth
   for broker state.** Policy belongs in Node, order mechanics in MQL5.
8. **Keep the EA thin.** New EA actions require an MQL5 edit *and* a recompile on
   the VPS (`deploy/MT5_GUI.md`), so prefer doing logic in TypeScript.
9. **Persist intent before any broker mutation**, and never retry a mutation on
   timeout. A timeout is ambiguous (`SUBMIT_UNKNOWN`, checkpoint `closing`) and
   is resolved from broker state by the lifecycle/reconciler.
10. **Checkpoint closes are idempotent by target remaining volume**, never by a
    fixed delta. Do not change this to "close N lots".
11. **Each trade uses its frozen `profile_snapshot`.** Activating a profile never
    changes open trades.
12. **Fail closed.** Missing/unreadable execution config, invalid profile or
    safety, or missing persistence → no new entries. The kill switch blocks new
    entries only; protective management keeps running.
13. **Web mutations only through server-verified API routes** (`requireAdmin`
    in `web/src/lib/serverAuth.ts`). `firestore.rules` denies client writes.
    `ALLOWED_EMAILS` unset means nobody gets in; keep it failing closed.
14. **Signal events are a durable queue** (`signalQueue.ts`). Their state lives
    on the event document (`autotrader.*`); claims are transactional leases on
    that same document (rule 3 still holds: no separate lock collection).
    Never retry an uncertain broker mutation from the queue: it is a terminal
    engine outcome that the reconciler resolves.
15. **Operator-visible problems raise an alert** (`raiseAlert` / `resolveAlert`
    in `alerts.ts`; never throws) in addition to rule 6. Never put a secret in an
    alert; details pass through `sanitizeDetails`.
16. **Never link a broker position to a trade set by heuristics.** If the
    correlation comment does not match, leave the trade `SUBMIT_UNKNOWN` and
    alert (`VANTAGE_BROKER_ASSUMPTIONS.md` A1).

## Conventions

- TypeScript 5.5.4 everywhere, `strict` on (enabled in `worker/tsconfig.json`
  on 2026-10-18; it had been off). Next.js uses `@/*` → `web/src/*`.
- Tailwind only for styling; client components; no data-fetching library.
- Single quotes, semicolons, trailing commas (`.prettierrc`). Prettier is **not
  installed**, so match the existing style by hand.
- Test files import `'./module.js'` (with the extension) on purpose so Vitest
  resolves TypeScript — do not "fix" those specifiers.
- Comments are sparse; newer worker modules use a file-header docblock. Match the
  surrounding file rather than adding commentary everywhere.
- Do not commit `.env`, `.env.local`, credentials, or `service-account*.json`.
  Never print secret values into a session or a doc.

## Commands

```bash
npm install --no-audit --no-fund     # from the repo root
npm run dev                          # web :3000 + forwarder :4000 (NOT the AutoTrader)
npm run lint                         # web then worker
npm run build                        # web then worker
npm test                             # worker tests (vitest run)
npm run test:web                     # web API route and view tests
npm run test:rules                   # Firestore rules in the emulator (Java 21 or auto-download)
npm run typecheck                    # worker strict type-check, no emit
deploy/deploy-v2.sh                  # deployment DRY RUN (changes nothing)
npm run seed:firestore --workspace worker
```

Worker-only: `npx tsc -p worker/tsconfig.json` then
`node worker/dist/autotrader.js` (run with `cwd=worker/`, or `dotenv` will not
find `.env.local`).

The Telegram → Firestore → AutoTrader chain is covered offline by
`worker/src/lib/pipeline.e2e.test.ts` (simulated broker, fake Firestore); web
routes by `web/test` (same fake Firestore, a token table for Firebase Auth);
the rules by `tests/firestore-rules`. None of it is verified against Vantage.
Tests must never open real sockets: use `setBrokerForTests` +
`createSimulatedBroker` and `worker/src/lib/testing/fakeFirestore.ts`.

## Before you finish a change

1. `npm run lint && npm run typecheck && npm test && npm run test:web` must pass
   (and `npm run build --workspace web`; never the root build on the host).
2. If you touched worker logic, add or update a Vitest test in `worker/src/lib/`.
3. If you touched Firebase access, confirm the `null` path still no-ops.
4. If you touched the Telegram path, confirm you have not created a second
   consumer of the session.
5. Update `docs/project_memory/CURRENT_STATE.md` (and `PLANNING_BACKLOG.md` if you
   closed an item). If something is unverified, say so — do not claim it works.

## Do not

- Do not "modernise" the architecture, restructure directories, or rename things
  for style. Preserve existing behaviour and naming.
- Do not reintroduce a second execution path (the Bybit engine was removed).
  Do not remove `telegramParser.ts`: the message history uses it.
- Do not assume documented features exist. `engineering-spec.MD` and
  `implementation-plan.MD` describe intent and are out of date; check
  `CURRENT_STATE.md` (e-mail/push notifications are still **not** implemented;
  dashboard alerts and optional webhook/Telegram-bot notifications are).
- Do not enable live trading, send broker orders, or close positions from a
  development session without explicit owner authorization.
- Do not treat `web/src/app/**/page.old.tsx` as live code, and do not reference
  it. It is not routed.
