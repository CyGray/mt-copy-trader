# MT5 on the VPS — install status & GUI console

Host: `vmi3564509` (Contabo, Ubuntu 24.04). Wine prefix: `~/.wine-mt5`.

## What is installed

| Piece | Where |
|---|---|
| Wine 9.0 (64-bit prefix, no wine32) | `~/.wine-mt5` |
| MetaTrader 5 terminal (portable) | `~/.wine-mt5/drive_c/Program Files/MetaTrader 5/terminal64.exe` |
| Bridge EA **v1** (deployed, compiled) | `.../MQL5/Experts/VantageBridgeEA.ex5` |
| mql-zmq headers (build-5100+ compat fork) | `.../MQL5/Include/Zmq`, `.../MQL5/Include/Mql` |
| libzmq.dll + libsodium.dll | `.../MQL5/Libraries/` |
| JAson.mqh (CJAVal JSON lib) | `.../MQL5/Include/JAson.mqh` |
| x11vnc (no-sudo, extracted) | `~/opt/x11vnc/usr/bin/x11vnc` |
| noVNC 1.5.0 + websockify | `~/opt/novnc`, `~/.local/bin/websockify` |

The deployed **v1** EA binds a ZeroMQ REP socket on `tcp://127.0.0.1:5555` and
executes `ORDER_SEND / ORDER_MODIFY / GET_POSITIONS / CLOSE_POSITION`, only from
`OnTick`.

**EA v2** (`mql5/VantageBridgeEA.mq5`, protocol in `mql5/PROTOCOL.md`) is in the
repo and compiles in this MetaEditor with 0 errors / 0 warnings (checked on
2026-10-18 from a temporary copy under a different name; the deployed `.mq5` and
`.ex5` were not touched). It processes requests on a timer, so it also answers
when the market is closed. It has **not** been attached or run. The v2 EA
**rejects v1 requests** (`v` must be 2), so the v2 EA and the new worker build
must be deployed **together**; see `deploy/SERVICES.md` "Deploying safely" and
`docs/project_memory/VANTAGE_EXECUTION_GUIDE.md` §16–17.

Compiling from the shell (MetaEditor's exit code is unreliable — read the log):

```bash
cd "$HOME/.wine-mt5/drive_c/Program Files/MetaTrader 5"
WINEPREFIX=$HOME/.wine-mt5 wine MetaEditor64.exe /compile:"MQL5\Experts\VantageBridgeEA.mq5" /log:"MQL5\Experts\compile.log"
iconv -f UTF-16LE -t UTF-8 MQL5/Experts/compile.log | tail -3
```

Compiling the file a running terminal has attached reloads the live EA, so only
do this during the coordinated deploy window.

## GUI console (toggle on/off)

Everything binds to **localhost only** — reach it through an SSH tunnel.

```bash
# on the VPS
bash ~/projects/ByTrader/deploy/mt5-gui.sh on      # start Xvfb + MT5 + VNC + noVNC
bash ~/projects/ByTrader/deploy/mt5-gui.sh status
bash ~/projects/ByTrader/deploy/mt5-gui.sh off     # tear it all down

# from your laptop
ssh -N -L 6080:127.0.0.1:6080 kyle@vmi3564509
# then open http://127.0.0.1:6080/vnc.html
```

Ports: VNC `127.0.0.1:5900`, web console `127.0.0.1:6080`.

## Agent Hub preview (preferred)

The MT5 GUI is registered as a **project service** in the Agent Hub, so you can
start it from the UI instead of the manual toggle:

1. Open any **ByTrader** conversation in the Hub.
2. Conversation actions → **Preview** tab → **Start**.
3. Click **Open**, or browse the preview URL —
   `https://vmi3564509.tail6b5d4c.ts.net:8445` (Tailscale Serve → `127.0.0.1:6080`).

It **shuts itself down after 3 minutes with no connected VNC client**
(`MT5_IDLE_SECS`, default `180`); the Hub **Stop** button tears it down
immediately. Backed by `deploy/mt5-preview.sh`; the manual `mt5-gui.sh` toggle
still works if you need it outside the Hub.

## Remaining steps (need you)

1. **Log in to the Vantage account** in the MT5 GUI (no credentials are stored on the box).
2. Attach `VantageBridgeEA` to an **XAUUSD M1** chart with **Allow DLL imports** and
   **AutoTrading** enabled; set `InpMagicNumber` / `InpEndpoint` as needed.
3. Set `settings/default.mt5` in Firestore (`symbol_suffix`, `magic`, `volume`, …).
4. Deploy the new worker build together with EA v2 using the temp-dir swap in
   `deploy/SERVICES.md` "Deploying safely" (never `npx tsc` straight into
   `worker/dist`, which the running services load). Start with execution mode
   `disabled`, then check:
   ```bash
   curl -s localhost:4001/health   # bridge.reachable true, bridge.eaVersion "2.0.0"
   ```

> **Two services:** `bytrader-worker.service` (port 4000) is the Telegram
> forwarder; `bytrader-autotrader.service` (port 4001) is the MT5 execution
> side. They are independent — restarting one does not touch the other.

> `sudo` is required for the *system-wide* systemd units in `deploy/install-services.sh`;
> the GUI toggle and worker service do not need it.
