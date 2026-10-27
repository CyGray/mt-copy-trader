# ByTrader VPS Resource Efficiency & Architecture Audit

**Date:** 2026-10-21  
**Target:** ByTrader VPS Services (`bytrader-autotrader`, `bytrader-worker`, Web UI)  
**Status:** Completed  

---

## 1. Executive Summary

An audit of ByTrader running on the production VPS revealed severe CPU pegging, file descriptor exhaustion, and cloud quota depletion while in an idle state. In addition, the planned web dashboard deployment poses substantial memory strain.

* **AutoTrader CPU Strain**: `bytrader-autotrader.service` accumulated **18h 30m of CPU time over ~38 hours**, maintaining a steady **~47% CPU utilization** while idle.
* **Socket / File Descriptor Leak**: Reconnection attempts to MT5 during outages leaked ZeroMQ sockets, reaching **1,051 open file descriptors** and tripping Linux's default `1024` descriptor limit (`EMFILE: Too many open file descriptors`).
* **Firestore Quota Depletion**: 2–3 second polling loops across multiple worker managers exhausted Google Cloud Firestore daily free quotas (`8 RESOURCE_EXHAUSTED: Quota exceeded.`), turning loops into rapid failure/retry cycles.
* **Execution Jitter**: Relying on Firestore polling (`SIGNAL_FEED_INTERVAL_MS = 3000`) introduces a **0 to 3,000 ms entry delay** on signals, creating unnecessary slippage on fast market entries.
* **Web UI Memory Footprint**: Running the dashboard via Next.js 14 App Router requires a separate Node.js SSR runtime that consumes between **500 MB and 1.1 GB of RAM**, which is disproportionately heavy for a single-tenant operator interface.

---

## 2. Live VPS Diagnostic Evidence

Measurements taken directly from the host environment:

```
PID   %CPU  %MEM    RSS     VSZ    COMMAND
824   47.3   1.4  115MB   1.9GB    node .../worker/dist/autotrader.js
827    0.2   1.5  124MB   1.7GB    node .../worker/dist/index.js (worker)
```

### Key Metrics:
- **AutoTrader Open File Descriptors:** `1,051` (`/proc/824/fd`)
- **Systemd Service CPU:** `18h 30min 33s` over 1 day 15 hours (`bytrader-autotrader.service`)
- **Active Errors Recorded in Logs:**
  - `{"level":"warn","event":"signal_feed_tick_failed","payload":{"error":"8 RESOURCE_EXHAUSTED: Quota exceeded."}}`
  - `{"level":"error","event":"mt5_bridge_unreachable","payload":{"message":"Too many open file descriptors"}}`
  - `{"level":"warn","event":"lifecycle_tick_failed","payload":{"error":"MT5 bridge did not respond within 5000ms"}}`

---

## 3. Root Cause Analysis

### 3.1. ZeroMQ Socket Lifecycle in `mt5Client.ts`
When MT5 is disconnected or unresponsive, each timed-out request triggers `destroySocket()` and sets `socketHealthy = false`. In [`worker/src/lib/mt5Client.ts`](file:///home/kyle/projects/ByTrader/worker/src/lib/mt5Client.ts), instances of `new zmqModule.Request()` are continuously created on consecutive ticks without proper underlying context closure or socket unbinding. Because lifecycle and ping loops fire every 2–3 seconds, hundreds of sockets leak into the kernel until `EMFILE` is hit.

### 3.2. Synchronous Polling Loops
The AutoTrader architecture uses uncoordinated timer intervals:
- `signalFeed.ts`: queries Firestore `signal_events` every 3,000 ms.
- `lifecycleManager.ts`: polls MT5 EA and Firestore positions every 2,000 ms.
- `adminCommands.ts`: polls Firestore `admin_commands`.
- `alertMonitor.ts`: reads and writes heartbeats to Firestore every 10,000 ms.

At ~2–3 Firestore operations per second, the service generates **>150,000 reads per day**, exceeding the standard Firestore 50,000 free daily quota within hours. Once quota errors hit, loops fail and immediately cycle, consuming massive CPU.

### 3.3. Next.js App Router for Single-Tenant Operations
Next.js SSR, webpack/turbopack runtime buffers, and React Server Component trees consume hundreds of megabytes just to serve private configuration and log pages. For a private trading dashboard with no public SEO or high-traffic requirements, full-stack SSR is unnecessary overhead.

---

## 4. Architectural & Paradigm Improvements

### 4.1. Event-Driven Push IPC (Sub-Millisecond Execution & 0% Idle CPU)
* **The Problem:** Polling Firestore for signals introduces up to 3 seconds of execution delay and high network/CPU overhead.
* **The Solution:** Replace Firestore polling with **direct local Inter-Process Communication (IPC)** between the Telegram Forwarder and AutoTrader:
  - Local **Unix Domain Socket** (`/run/bytrader/signals.sock`), **ZeroMQ PUSH/PULL**, or local loopback HTTP POST (`http://127.0.0.1:4001/api/signal`).
  - Signal reception to MT5 order handoff drops from **~2,000 ms to < 5 ms**.
  - When no signals are arriving, the socket waits asynchronously in `epoll`, utilizing **0.0% CPU**.

### 4.2. Local-First State (Embedded SQLite in WAL Mode)
* **The Problem:** Cloud roundtrips to Firestore add 100–300 ms of latency per trade mutation and introduce external rate/quota limits.
* **The Solution:** Use local **SQLite** (`better-sqlite3`) configured with Write-Ahead Logging (`WAL`):
  - Read/write latency: **< 0.1 ms**.
  - Zero cloud costs, zero quota exhaustion, zero dependency on external internet connectivity for execution.
  - (Optional) Asynchronously stream updates to Firestore only for remote mobile viewing.

### 4.3. Adaptive Position Lifecycle
* **The Problem:** `lifecycleManager` polls MT5 every 2 seconds regardless of whether any trades exist.
* **The Solution:**
  - If open trade count is `0`, **suspend the lifecycle timer completely**.
  - Wake the timer only upon order fill confirmation.
  - While positions are open, subscribe to MT5 tick events or poll at defined intervals; return to sleep when positions close.

### 4.4. Resilient MT5 Bridge Management with Exponential Backoff
* Ensure single socket reuse: maintain one long-lived `Request` socket.
* On communication failure:
  - Do not hammer the bridge every 2 seconds.
  - Use exponential backoff (1s → 2s → 5s → 15s → max 30s) and explicitly close and discard zombie sockets.

---

## 5. Web Framework Modernization: Ditching Next.js

Replace the standalone Next.js server with a **Vite-based Single Page Application (SPA)**:
1. Build the dashboard into static HTML, JavaScript, and CSS bundles (`web/dist`).
2. Serve static assets directly from the backend daemon (or lightweight Caddy/Nginx) via static middleware.
3. The dashboard connects to the backend REST/WebSocket endpoints.
4. **Memory impact:** **Saves 500 MB – 1.1 GB of RAM** by eliminating the Next.js Node.js server entirely.

---

## 6. Language & Runtime Comparison

| Approach | Memory (RSS) | Idle CPU | Execution Latency | Migration Complexity | Recommendation |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Current (Node.js + Next.js)** | ~400MB – 1.2GB | 2% – 50% | 1,000 – 3,000 ms | N/A | Baseline |
| **Phase 1: Node.js (Patched) + Static SPA** | ~150 – 200 MB | < 0.2% | 2 – 5 ms | **Low** | **Immediate quick win** |
| **Phase 2: Bun Runtime + Static SPA** | ~80 – 120 MB | < 0.1% | 1 – 3 ms | **Low** | Drop-in runtime replacement |
| **Phase 3: Go (Golang) Single Binary** | **~15 – 25 MB** | **0.0%** | **< 1 ms** | **Medium** | **Optimal long-term target** |
| **Phase 4: Rust** | ~5 – 10 MB | 0.0% | < 0.1 ms | High | Overkill given network/broker latency |

---

## 7. Phased Implementation Roadmap

### Phase 1: Immediate Stabilization (Quick Wins)
- [ ] Fix ZeroMQ socket leak in [`worker/src/lib/mt5Client.ts`](file:///home/kyle/projects/ByTrader/worker/src/lib/mt5Client.ts) and add exponential backoff on bridge errors.
- [ ] Modify [`worker/src/lib/lifecycleManager.ts`](file:///home/kyle/projects/ByTrader/worker/src/lib/lifecycleManager.ts) to sleep when no open positions exist.
- [ ] Increase Firestore polling intervals or implement snapshot listeners to stop burning quota.

### Phase 2: Web Layer Lean Optimization
- [ ] Migrate `web/` from Next.js to Vite + React/Preact.
- [ ] Configure `autotrader.ts` / `index.ts` Express server to serve static assets directly on port `3001`.
- [ ] Shut down Next.js dev server.

### Phase 3: Push-Based IPC & Local Storage
- [ ] Replace `signal_events` Firestore polling in `signalFeed.ts` with direct local IPC push from `telegramListener.ts`.
- [ ] Transition state storage (`trade_sets`, `signal_events`) to local SQLite WAL.

### Phase 4: Long-Term Daemon Consolidation (Optional)
- [ ] Port the combined service (Telegram MTProto listener + trade engine + MT5 bridge + embedded UI) into a single Go daemon (`bytraderd`), achieving sub-20MB RAM and 0.0% idle CPU.
