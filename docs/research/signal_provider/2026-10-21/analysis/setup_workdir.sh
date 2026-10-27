#!/bin/sh
# Prepare a working copy of the research scripts for a new run.
# usage: setup_workdir.sh WORKDIR
# Copies analysis/ to WORKDIR and rewrites the one absolute scratchpad prefix the original run used.
# The scripts otherwise locate each other relative to their own directory (a1 a2 a3 b1 b2 b3 c2 oos2).
# Heavy inputs are NOT in the repo and must be regenerated: Dukascopy ticks (a3/download_ticks.py),
# b1/signals_universe.csv (b1/prepare_signals.py), b2/out/finalists.json (copy aggregates/b2_finalists.json).
set -eu
[ $# -eq 1 ] || { echo "usage: $0 WORKDIR" >&2; exit 64; }
SRC="$(cd "$(dirname "$0")" && pwd)"
DST="$1"
OLD='/tmp/claude-1001/-home-kyle-projects-ByTrader/49765c97-aa3e-4f05-97ec-79e2b692b108/scratchpad'
mkdir -p "$DST"
cp -r "$SRC"/. "$DST"/
grep -rlF "$OLD" "$DST" 2>/dev/null | while read -r f; do
  sed -i "s#$OLD#$DST#g" "$f"
done
echo "ready: $DST  (python3 -I for analysis scripts; node 24 for .mjs; nice -n 10 for tick work)"
