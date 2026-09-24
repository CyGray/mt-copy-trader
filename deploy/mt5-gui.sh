#!/usr/bin/env bash
# ByTrader MT5 GUI toggle
# Starts/stops a virtual display + VNC + noVNC web console for the Wine MT5
# terminal. Everything binds to localhost only -- reach it over an SSH tunnel:
#
#   ssh -N -L 6080:127.0.0.1:6080 kyle@vmi3564509
#   then open http://127.0.0.1:6080/vnc.html
#
set -uo pipefail

DISPLAY_NUM="${MT5_DISPLAY:-:99}"
VNC_PORT="${MT5_VNC_PORT:-5900}"
WEB_PORT="${MT5_WEB_PORT:-6080}"
SCREEN="${MT5_SCREEN:-1280x900x24}"

X11VNC_BIN="${X11VNC_BIN:-/home/kyle/opt/x11vnc/usr/bin/x11vnc}"
X11VNC_LIB="${X11VNC_LIB:-/home/kyle/opt/x11vnc/usr/lib/x86_64-linux-gnu}"
NOVNC_DIR="${NOVNC_DIR:-/home/kyle/opt/novnc}"
WEBSOCKIFY_BIN="${WEBSOCKIFY_BIN:-/home/kyle/.local/bin/websockify}"
WINEPREFIX="${WINEPREFIX:-/home/kyle/.wine-mt5}"
MT5_EXE="${MT5_EXE:-$WINEPREFIX/drive_c/Program Files/MetaTrader 5/terminal64.exe}"

RUN=/tmp/bytrader-gui
mkdir -p "$RUN"

pid_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }
read_pid() { [ -f "$RUN/$1" ] && cat "$RUN/$1" 2>/dev/null; }

start() {
  if pid_alive "$(read_pid xvfb)"; then
    echo "xvfb: already running ($(read_pid xvfb))"
  else
    Xvfb "$DISPLAY_NUM" -screen 0 "$SCREEN" -ac >"$RUN/xvfb.log" 2>&1 &
    echo $! > "$RUN/xvfb"; sleep 1
    echo "xvfb: started ($(read_pid xvfb)) on $DISPLAY_NUM"
  fi

  if pgrep -f 'terminal64.exe' >/dev/null; then
    echo "mt5: already running"
  else
    ( cd "$(dirname "$MT5_EXE")" && DISPLAY="$DISPLAY_NUM" WINEPREFIX="$WINEPREFIX" WINEDEBUG=-all \
        wine "$(basename "$MT5_EXE")" /portable >"$RUN/mt5.log" 2>&1 & echo $! > "$RUN/mt5" )
    echo "mt5: started"
  fi

  if pid_alive "$(read_pid x11vnc)"; then
    echo "x11vnc: already running ($(read_pid x11vnc))"
  else
    LD_LIBRARY_PATH="$X11VNC_LIB" "$X11VNC_BIN" -display "$DISPLAY_NUM" \
      -rfbport "$VNC_PORT" -localhost -nopw -forever -shared -bg \
      -o "$RUN/x11vnc.log" >/dev/null 2>&1
    sleep 1
    pgrep -f "x11vnc -display $DISPLAY_NUM" | head -1 > "$RUN/x11vnc"
    echo "x11vnc: listening on 127.0.0.1:$VNC_PORT ($(read_pid x11vnc))"
  fi

  if pid_alive "$(read_pid websockify)"; then
    echo "noVNC: already running ($(read_pid websockify))"
  else
    "$WEBSOCKIFY_BIN" --web "$NOVNC_DIR" "127.0.0.1:$WEB_PORT" "127.0.0.1:$VNC_PORT" \
      >"$RUN/websockify.log" 2>&1 &
    echo $! > "$RUN/websockify"; sleep 1
    echo "noVNC: http://127.0.0.1:$WEB_PORT/vnc.html ($(read_pid websockify))"
  fi
  echo
  echo "Tunnel:  ssh -N -L $WEB_PORT:127.0.0.1:$WEB_PORT kyle@$(hostname -f 2>/dev/null || hostname)"
  echo "Open:    http://127.0.0.1:$WEB_PORT/vnc.html"
}

stop() {
  for name in websockify x11vnc mt5 xvfb; do
    pid=$(read_pid "$name")
    if pid_alive "$pid"; then kill "$pid" 2>/dev/null && echo "$name: stopped ($pid)"; fi
    rm -f "$RUN/$name"
  done
  pkill -f 'terminal64.exe' 2>/dev/null
  pkill -f "x11vnc -display $DISPLAY_NUM" 2>/dev/null
  echo "gui: off"
}

status() {
  for name in xvfb mt5 x11vnc websockify; do
    pid=$(read_pid "$name")
    if pid_alive "$pid"; then echo "$name: UP ($pid)"; else echo "$name: down"; fi
  done
  ss -ltn 2>/dev/null | rg -e ":$VNC_PORT\b" -e ":$WEB_PORT\b" || true
}

case "${1:-}" in
  on|start)   start ;;
  off|stop)   stop ;;
  status)     status ;;
  *) echo "usage: $0 {on|off|status}"; exit 2 ;;
esac
