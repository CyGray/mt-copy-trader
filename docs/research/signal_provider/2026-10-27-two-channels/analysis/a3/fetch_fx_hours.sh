#!/bin/sh
# Download the FX decode-check hours: 12:00 and 13:00 UTC (12:00-14:00 half-open) on 5 weekdays of
# October 2026 for EURUSD, USDJPY, GBPUSD, plus XAUUSD 2026-10-26 13:00 UTC for the gold level check.
# One symbol-day per download_ticks.py run, 4 workers at most, nice 10, 1 s pause per request.
# usage: fetch_fx_hours.sh FX_ROOT        (raw files -> FX_ROOT/raw/<SYMBOL>/, manifests -> FX_ROOT/manifests/)
set -eu
[ $# -eq 1 ] || { echo "usage: $0 FX_ROOT" >&2; exit 64; }
HERE="$(cd "$(dirname "$0")" && pwd)"
FX="$1"
mkdir -p "$FX/manifests"
for SYM in EURUSD USDJPY GBPUSD; do
  for D in 2026-10-05 2026-10-09 2026-10-14 2026-10-20 2026-10-23; do
    nice -n 10 python3 -I -B "$HERE/download_ticks.py" "$FX/raw/$SYM" "$FX/manifests/${SYM}_${D}.csv" \
      "${D}T12" "${D}T14" 4 --symbol "$SYM" --pause 1.0
  done
done
nice -n 10 python3 -I -B "$HERE/download_ticks.py" "$FX/raw/XAUUSD" "$FX/manifests/XAUUSD_2026-10-26.csv" \
  2026-10-26T13 2026-10-26T14 4 --symbol XAUUSD --pause 1.0
echo "ALL DONE"
