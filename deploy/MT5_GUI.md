# MT5 on the VPS — install status & GUI console

Host: `vmi3564509` (Contabo, Ubuntu 24.04). Wine prefix: `~/.wine-mt5`.

## What is installed

| Piece | Where |
|---|---|
| Wine 9.0 (64-bit prefix, no wine32) | `~/.wine-mt5` |
| MetaTrader 5 terminal (portable) | `~/.wine-mt5/drive_c/Program Files/MetaTrader 5/terminal64.exe` |
| Bridge EA (compiled, 0 errors) | `.../MQL5/Experts/VantageBridgeEA.ex5` |
| mql-zmq headers (build-5100+ compat fork) | `.../MQL5/Include/Zmq`, `.../MQL5/Include/Mql` |
| libzmq.dll + libsodium.dll | `.../MQL5/Libraries/` |
| JAson.mqh (CJAVal JSON lib) | `.../MQL5/Include/JAson.mqh` |
| x11vnc (no-sudo, extracted) | `~/opt/x11vnc/usr/bin/x11vnc` |
| noVNC 1.5.0 + websockify | `~/opt/novnc`, `~/.local/bin/websockify` |

The EA binds a ZeroMQ REP socket on `tcp://127.0.0.1:5555` and executes
`ORDER_SEND / ORDER_MODIFY / GET_POSITIONS / CLOSE_POSITION`.

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

## Remaining steps (need you)

1. **Log in to the Vantage account** in the MT5 GUI (no credentials are stored on the box).
2. Attach `VantageBridgeEA` to an **XAUUSD M1** chart with **Allow DLL imports** and
   **AutoTrading** enabled; set `InpMagicNumber` / `InpEndpoint` as needed.
3. Set `settings/default.mt5` in Firestore (`symbol_suffix`, `magic`, `volume`, …).
4. Then rebuild and restart the **AutoTrader** service so it ships the MT5
   execution path (the forwarder is unrelated — see `deploy/SERVICES.md`):
   ```bash
   cd ~/projects/ByTrader/worker && npx tsc -p tsconfig.json
   systemctl --user restart bytrader-autotrader.service
   curl -s localhost:4001/health   # mt5Bridge should read "ok" once the EA is attached
   ```

> **Two services:** `bytrader-worker.service` (port 4000) is the Telegram
> forwarder; `bytrader-autotrader.service` (port 4001) is the MT5 execution
> side. They are independent — restarting one does not touch the other.

> `sudo` is required for the *system-wide* systemd units in `deploy/install-services.sh`;
> the GUI toggle and worker service do not need it.
