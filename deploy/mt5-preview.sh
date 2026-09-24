#!/usr/bin/env bash
# ByTrader MT5 preview — the Agent Hub "Preview" tab project service.
#
# The hub launches this in a transient systemd unit and proxies its web port
# over Tailscale Serve (see DEV_PROJECTS["ByTrader"] in agent-harness). This
# script:
#   1. starts the Wine/MT5 GUI + noVNC console (delegates to mt5-gui.sh),
#   2. stays in the foreground streaming status to the hub log,
#   3. tears the whole GUI down after MT5_IDLE_SECS with no VNC client.
#
# Env (set by the hub):  AGENT_DEV_PORT  -> the web/noVNC port to bind
# Env (optional):        MT5_IDLE_SECS   -> idle timeout, default 180 (3 min)
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
GUI="$HERE/mt5-gui.sh"

WEB_PORT="${AGENT_DEV_PORT:-6080}"
VNC_PORT="${MT5_VNC_PORT:-5900}"
IDLE_SECS="${MT5_IDLE_SECS:-180}"
POLL_SECS="${MT5_POLL_SECS:-5}"

echo "[mt5-preview] starting GUI (web port $WEB_PORT, vnc port $VNC_PORT)"
if ! MT5_WEB_PORT="$WEB_PORT" bash "$GUI" on; then
  echo "[mt5-preview] GUI failed to start"
  exit 1
fi

stopped=0

# Wine ignores SIGTERM and keeps service processes (winedevice.exe/services.exe)
# alive, which would hold the hub's systemd unit open until TimeoutStopSec.
# Walk /proc and force-kill every Wine userland process in the prefix.
kill_wine() {
  for p in /proc/[0-9]*; do
    pid="${p#/proc/}"
    [ "$pid" = "$$" ] && continue
    comm="$(cat "$p/comm" 2>/dev/null || true)"
    case "$comm" in
      winedevice.exe|services.exe|plugplay.exe|explorer.exe|terminal64.exe|wineserver*|wine64|wine)
        kill -9 "$pid" 2>/dev/null || true
        continue
        ;;
    esac
    exe="$(readlink "$p/exe" 2>/dev/null || true)"
    case "$exe" in
      */wine/wine64|*/wine/wine|*/wineserver*) kill -9 "$pid" 2>/dev/null || true ;;
    esac
  done
}

cleanup() {
  [ "$stopped" = 1 ] && return
  stopped=1
  echo "[mt5-preview] stopping GUI"
  MT5_WEB_PORT="$WEB_PORT" bash "$GUI" off || true
  WINEPREFIX="${MT5_WINEPREFIX:-/home/kyle/.wine-mt5}" wineserver -k9 2>/dev/null || true
  kill_wine
}
on_signal() {
  echo "[mt5-preview] received stop signal"
  exit 0
}
trap on_signal TERM INT
trap cleanup EXIT

# Count established VNC clients. noVNC/websockify opens a connection to x11vnc
# only while a browser session is live, so this is the inactivity signal.
vnc_clients() {
  ss -Htn state established "sport = :$VNC_PORT" 2>/dev/null | wc -l | tr -d ' '
}

last_active=$(date +%s)
echo "[mt5-preview] ready — shuts down after ${IDLE_SECS}s without a VNC client"

while true; do
  # Backgrounded sleep + wait so a stop signal is handled immediately.
  sleep "$POLL_SECS" &
  wait $! 2>/dev/null || true
  if ! pgrep -f 'terminal64\.exe' >/dev/null 2>&1; then
    echo "[mt5-preview] MT5 process is gone; shutting down"
    break
  fi
  now=$(date +%s)
  clients=$(vnc_clients)
  if [ "${clients:-0}" -gt 0 ]; then
    last_active=$now
  else
    idle=$(( now - last_active ))
    if [ "$idle" -ge "$IDLE_SECS" ]; then
      echo "[mt5-preview] idle for ${idle}s — shutting down"
      break
    fi
  fi
done
exit 0
