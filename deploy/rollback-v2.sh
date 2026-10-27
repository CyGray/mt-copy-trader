#!/usr/bin/env bash
# deploy/rollback-v2.sh — restores the deployment recorded by deploy-v2.sh.
#
# DEFAULT IS A DRY RUN: it prints what would be restored and changes nothing.
# With --execute, after the typed confirmation 'ROLLBACK <stamp>', it:
#   1. stops the AutoTrader, then the forwarder,
#   2. moves the failed worker/dist aside (worker/.dist-failed-<stamp>),
#   3. restores the previous build (worker/.dist-prev-<stamp>, or the verified
#      backup copy if that is gone) and checks it against the backup manifest,
#   4. restores the installed unit files from the backup when they differ,
#   5. waits while the operator restores the v1 EA (manual), and
#   6. starts the forwarder, then the AutoTrader, and checks both /health.
#
# Rolling back restores the PREVIOUS behaviour exactly, including the v1 worker's
# known gaps (VANTAGE_EXECUTION_GUIDE.md §17). Firestore rules, indexes and the
# web app are not touched; restore them separately if they were deployed.
#
# Usage: deploy/rollback-v2.sh [--execute] [<deploy run dir>]   (default: $BYTRADER_DEPLOY_HOME/latest)
# Environment: the same overrides as deploy-v2.sh, plus BYTRADER_HEALTH_CMD
# (default: curl -fsS) and BYTRADER_ROLLBACK_CONFIRM / BYTRADER_EA_CONFIRM.
set -euo pipefail

ROOT="${BYTRADER_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
DEPLOY_HOME="${BYTRADER_DEPLOY_HOME:-$HOME/bytrader-deploy}"
UNIT_DIR="${BYTRADER_UNIT_DIR:-$HOME/.config/systemd/user}"
SYSTEMCTL="${BYTRADER_SYSTEMCTL:-systemctl --user}"
HEALTH_CMD="${BYTRADER_HEALTH_CMD:-curl -fsS}"
SETTLE_SEC="${BYTRADER_SETTLE_SEC:-15}"
WORKER="$ROOT/worker"

EXECUTE=0
RUN_DIR=""
for arg in "$@"; do
  case "$arg" in
    --execute) EXECUTE=1 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) RUN_DIR="$arg" ;;
  esac
done
RUN_DIR="${RUN_DIR:-$DEPLOY_HOME/latest}"

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die() { printf 'ABORT: %s\n' "$*" >&2; exit 1; }

[[ -f "$RUN_DIR/deploy.env" ]] || die "no deploy record at $RUN_DIR (deploy.env missing)"
# shellcheck disable=SC1091
STAMP="$(sed -n 's/^stamp=//p' "$RUN_DIR/deploy.env")"
PREV="$(sed -n 's/^prev=//p' "$RUN_DIR/deploy.env")"
[[ -n "$STAMP" ]] || die "deploy record has no stamp"
FAILED="$WORKER/.dist-failed-$STAMP"

if [[ -d "$PREV" ]]; then SOURCE="$PREV"; else SOURCE="$RUN_DIR/backup/dist"; fi
[[ -d "$SOURCE" ]] || die "nothing to restore: neither $PREV nor the backup copy exists"

# The v1 build loads the Bybit SDK at startup (lib/bybitClient.js). v2 removed it from
# package.json; node_modules keeps it until `npm ci` runs after the rollback window.
if [[ -f "$SOURCE/lib/bybitClient.js" && ! -d "$ROOT/node_modules/bybit-api" ]]; then
  die "the build to restore needs node_modules/bybit-api, which is missing. Run 'npm install --no-save bybit-api@4.5.1' in $ROOT first."
fi

step "Rollback of deployment $STAMP"
say "restore build from: $SOURCE"
say "failed build moves to: $FAILED"
for u in bytrader-autotrader.service bytrader-worker.service; do
  if [[ -f "$RUN_DIR/backup/units/$u" ]] && ! cmp -s "$RUN_DIR/backup/units/$u" "$UNIT_DIR/$u" 2>/dev/null; then
    say "unit $u differs from the backup and will be restored"
  fi
done
[[ -n "$(ls -A "$RUN_DIR/backup/ea" 2>/dev/null)" ]] && say "EA backup available in $RUN_DIR/backup/ea (restore manually)"

if [[ "$EXECUTE" -eq 0 ]]; then
  step "DRY RUN: nothing was changed. Run with --execute to roll back."
  exit 0
fi

typed="${BYTRADER_ROLLBACK_CONFIRM:-}"
[[ -n "$typed" ]] || read -r -p "Type 'ROLLBACK $STAMP' to continue: " typed
[[ "$typed" == "ROLLBACK $STAMP" ]] || die "confirmation did not match"

step "1. Stop services"
$SYSTEMCTL stop bytrader-autotrader.service || true
$SYSTEMCTL stop bytrader-worker.service || true

step "2-3. Restore the previous build"
[[ ! -e "$FAILED" ]] || die "$FAILED already exists"
[[ -d "$WORKER/dist" ]] && mv "$WORKER/dist" "$FAILED"
if [[ "$SOURCE" == "$PREV" ]]; then
  mv "$PREV" "$WORKER/dist"
else
  cp -a "$SOURCE" "$WORKER/dist"
fi
if [[ -f "$RUN_DIR/manifest.sha256" ]]; then
  (cd "$RUN_DIR/backup" && grep ' ./dist/' "$RUN_DIR/manifest.sha256" | sed "s# ./dist/# $WORKER/dist/#" | sha256sum -c --quiet -) \
    || die "restored build does not match the backup manifest; services left stopped"
fi

step "4. Unit files"
restored_units=0
for u in bytrader-autotrader.service bytrader-worker.service; do
  if [[ -f "$RUN_DIR/backup/units/$u" ]] && ! cmp -s "$RUN_DIR/backup/units/$u" "$UNIT_DIR/$u" 2>/dev/null; then
    cp -a "$RUN_DIR/backup/units/$u" "$UNIT_DIR/$u"
    restored_units=1
  fi
done
[[ "$restored_units" -eq 1 ]] && $SYSTEMCTL daemon-reload

step "5. EA v1"
say "Detach the EA, copy the v1 VantageBridgeEA.ex5 from $RUN_DIR/backup/ea into MQL5/Experts,"
say "and attach it again. Type 'EA V1 RESTORED' when done (or SKIP if the EA was not replaced)."
ea_typed="${BYTRADER_EA_CONFIRM:-}"
[[ -n "$ea_typed" ]] || read -r -p "> " ea_typed
[[ "$ea_typed" == "EA V1 RESTORED" || "$ea_typed" == "SKIP" ]] || die "EA step not confirmed; services left stopped"

step "6. Start services"
$SYSTEMCTL start bytrader-worker.service
$SYSTEMCTL start bytrader-autotrader.service
sleep "$SETTLE_SEC"
ok=1
$HEALTH_CMD http://127.0.0.1:4000/health >/dev/null || ok=0
$HEALTH_CMD http://127.0.0.1:4001/health >/dev/null || ok=0
if [[ "$ok" -ne 1 ]]; then
  say "Health check failed after rollback. Check: journalctl --user -u bytrader-autotrader -u bytrader-worker"
  exit 1
fi
say "Rolled back to the build before $STAMP. The failed build is kept at $FAILED."
