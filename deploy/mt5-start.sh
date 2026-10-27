#!/usr/bin/env bash
# deploy/mt5-start.sh — start the Wine MT5 terminal headless, logged in, with
# VantageBridgeEA attached, and wait until the bridge listens.
#
# The terminal does not keep the account password, and a plain restart opens a
# Login dialog with no EA. This writes a temporary startup config (mode 0600)
# with the credentials from the env file, starts the terminal with it, waits for
# 127.0.0.1:5555, and deletes the config. Credentials are never printed.
#
# Refuses a server that is not a demo server unless MT5_ALLOW_NON_DEMO=1 (live
# trading additionally needs BYTRADER_LIVE_TRADING=enabled in the worker).
#
# Environment: MT5_ENV_FILE (default <repo>/.env) providing MT5_LOGIN,
# MT5_PASSWORD, MT5_SERVER; MT5_DISPLAY (default :99); MT5_CHART_SYMBOL (EURUSD).
# Exit 0 when the bridge listens (or already did), 1 otherwise.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${MT5_ENV_FILE:-$ROOT/.env}"
DISPLAY_NUM="${MT5_DISPLAY:-:99}"
SYMBOL="${MT5_CHART_SYMBOL:-EURUSD}"
WINEPREFIX="${WINEPREFIX:-$HOME/.wine-mt5}"
MT5_DIR="$WINEPREFIX/drive_c/Program Files/MetaTrader 5"
INI="$MT5_DIR/Config/bytrader_start.ini"

listening() { ss -ltn 2>/dev/null | grep -q '127.0.0.1:5555 '; }

if listening; then echo "bridge already listening"; exit 0; fi

if ! DISPLAY="$DISPLAY_NUM" xdpyinfo >/dev/null 2>&1 && ! pgrep -f "Xvfb $DISPLAY_NUM" >/dev/null; then
  setsid nohup Xvfb "$DISPLAY_NUM" -screen 0 1280x900x24 -ac >/tmp/bytrader-xvfb.log 2>&1 < /dev/null &
  for _ in $(seq 1 15); do DISPLAY="$DISPLAY_NUM" xdpyinfo >/dev/null 2>&1 && break; sleep 1; done
fi

# A terminal without the bridge (for example stuck at a Login dialog) is replaced.
for pid in $(pgrep -f "^terminal64\.exe" 2>/dev/null || true); do kill "$pid" 2>/dev/null || true; done
for _ in $(seq 1 20); do pgrep -f "^terminal64\.exe" >/dev/null || break; sleep 1; done

[[ -f "$ENV_FILE" ]] || { echo "env file not found: $ENV_FILE" >&2; exit 1; }
login="$(sed -n 's/^MT5_LOGIN=//p' "$ENV_FILE" | tr -d '"'"'"'\r')"
password="$(sed -n 's/^MT5_PASSWORD=//p' "$ENV_FILE" | tr -d '"'"'"'\r')"
server="$(sed -n 's/^MT5_SERVER=//p' "$ENV_FILE" | tr -d '"'"'"'\r')"
[[ -n "$login" && -n "$password" && -n "$server" ]] || { echo "MT5_LOGIN, MT5_PASSWORD and MT5_SERVER are required" >&2; exit 1; }
if [[ "$server" != *-Demo && "${MT5_ALLOW_NON_DEMO:-}" != "1" ]]; then
  echo "refusing non-demo server '$server' (set MT5_ALLOW_NON_DEMO=1 to override)" >&2
  exit 1
fi

umask 077
trap 'rm -f "$INI"' EXIT
printf '[Common]\r\nLogin=%s\r\nPassword=%s\r\nServer=%s\r\nNewsEnable=0\r\n[Experts]\r\nAllowLiveTrading=1\r\nAllowDllImport=1\r\nEnabled=1\r\nAccount=0\r\nProfile=0\r\n[StartUp]\r\nExpert=VantageBridgeEA\r\nSymbol=%s\r\nPeriod=M1\r\n' \
  "$login" "$password" "$server" "$SYMBOL" > "$INI"
unset password

(cd "$MT5_DIR" && DISPLAY="$DISPLAY_NUM" WINEPREFIX="$WINEPREFIX" WINEDEBUG=-all \
  setsid nohup wine terminal64.exe /portable '/config:Config\bytrader_start.ini' >/tmp/bytrader-mt5.log 2>&1 < /dev/null &)

for _ in $(seq 1 60); do
  if listening; then echo "bridge listening on 127.0.0.1:5555 ($server)"; exit 0; fi
  sleep 3
done
echo "bridge did not start within 180 s; see $MT5_DIR/logs" >&2
exit 1
