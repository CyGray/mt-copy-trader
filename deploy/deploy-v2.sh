#!/usr/bin/env bash
# deploy/deploy-v2.sh — coordinated rollout of the protocol-v2 worker
# (forwarder + AutoTrader) together with VantageBridgeEA v2.
#
# DEFAULT IS A DRY RUN. Without --execute this script builds the new worker into
# a temporary worker/.dist-dryrun-* directory, runs the read-only preflight,
# prints the plan and removes the temporary build. It changes nothing else.
#
# With --execute, after a typed confirmation, it:
#   1. builds into worker/.dist-next-<stamp> (production keeps running),
#   2. runs the preflight (aborts on any failure, before any change),
#   3. backs up worker/dist, the installed units and (if MT5_EXPERTS_DIR is set)
#      the EA files into $BYTRADER_DEPLOY_HOME/<stamp>/ with a checksum manifest,
#   4. stops the AutoTrader, then the forwarder,
#   5. swaps the build in with two renames (worker/dist → worker/.dist-prev-<stamp>),
#   6. waits while the operator replaces and attaches EA v2 (manual, MetaEditor),
#   7. starts the forwarder, then the AutoTrader,
#   8. runs the post-deploy preflight (v2 EA, DEMO account, execution disabled).
#      On failure the AutoTrader is stopped again (safe state) and the rollback
#      command is printed.
#
# It never enables trading, never sends a broker request, never edits Firestore,
# and never deploys Firestore rules, indexes or the web app: those are separate
# commands printed at the end. Open positions keep their broker-side SL/TP while
# the services are stopped; partial take-profits and stop moves pause.
#
# Environment (all optional; defaults target the VPS layout):
#   BYTRADER_ROOT         repo root                          (default: this script's ..)
#   BYTRADER_DEPLOY_HOME  backups and logs                   (default: $HOME/bytrader-deploy)
#   BYTRADER_UNIT_DIR     installed user units               (default: $HOME/.config/systemd/user)
#   BYTRADER_SYSTEMCTL    service manager command            (default: systemctl --user)
#   BYTRADER_TSC          TypeScript compiler command        (default: npx tsc)
#   BYTRADER_NODE         node binary                        (default: node)
#   BYTRADER_PREFLIGHT    preflight command override         (default: node <build>/tools/preflight.js)
#   BYTRADER_SETTLE_SEC   wait before the post check         (default: 20)
#   MT5_EXPERTS_DIR       MQL5/Experts directory, for EA backup
#   EXPECT_ACCOUNT        account trade mode the post check requires (default: DEMO)
#   BYTRADER_CONFIRM, BYTRADER_EA_CONFIRM  typed confirmations for non-interactive runs
set -euo pipefail

ROOT="${BYTRADER_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
DEPLOY_HOME="${BYTRADER_DEPLOY_HOME:-$HOME/bytrader-deploy}"
UNIT_DIR="${BYTRADER_UNIT_DIR:-$HOME/.config/systemd/user}"
SYSTEMCTL="${BYTRADER_SYSTEMCTL:-systemctl --user}"
TSC="${BYTRADER_TSC:-npx tsc}"
NODE="${BYTRADER_NODE:-node}"
SETTLE_SEC="${BYTRADER_SETTLE_SEC:-20}"
EXPECT_ACCOUNT="${EXPECT_ACCOUNT:-DEMO}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORKER="$ROOT/worker"
UNITS=(bytrader-autotrader.service bytrader-worker.service)

EXECUTE=0
for arg in "$@"; do
  case "$arg" in
    --execute) EXECUTE=1 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die() { printf 'ABORT: %s\n' "$*" >&2; exit 1; }

confirm() {
  # $1 = phrase, $2 = env var carrying a non-interactive confirmation
  local phrase="$1" preset="${!2:-}" typed
  if [[ -n "$preset" ]]; then
    typed="$preset"
  else
    read -r -p "Type '$phrase' to continue: " typed
  fi
  [[ "$typed" == "$phrase" ]] || die "confirmation did not match"
}

run_preflight() {
  local build="$1"; shift
  if [[ -n "${BYTRADER_PREFLIGHT:-}" ]]; then
    $BYTRADER_PREFLIGHT "$@"
  else
    "$NODE" "$build/tools/preflight.js" "$@" --repo "$ROOT" --build "$build" --units "$UNIT_DIR"
  fi
}

[[ -d "$WORKER/dist" ]] || die "no production build at $WORKER/dist"

if [[ "$EXECUTE" -eq 0 ]]; then
  step "DRY RUN (nothing on the host is changed; use --execute to deploy)"
  # Inside worker/ so Node resolves the repo's node_modules; git-ignored and removed on exit.
  TMP_BUILD="$WORKER/.dist-dryrun-$STAMP-$$"
  trap 'rm -rf "$TMP_BUILD"' EXIT
  say "Building the new worker into $TMP_BUILD (removed afterwards)..."
  $TSC -p "$WORKER/tsconfig.json" --outDir "$TMP_BUILD"
  step "Preflight (read-only)"
  set +e
  run_preflight "$TMP_BUILD" --stage pre --live --firestore
  pre_rc=$?
  set -e
  step "Plan for --execute (stamp would be $STAMP)"
  say "1. build into $WORKER/.dist-next-<stamp>"
  say "2. preflight must pass (it $([[ $pre_rc -eq 0 ]] && echo 'PASSES' || echo 'FAILS') right now)"
  say "3. back up worker/dist, ${UNITS[*]}$([[ -n "${MT5_EXPERTS_DIR:-}" ]] && echo ', EA files') to $DEPLOY_HOME/<stamp>/"
  say "4. $SYSTEMCTL stop bytrader-autotrader.service; $SYSTEMCTL stop bytrader-worker.service"
  say "5. mv worker/dist worker/.dist-prev-<stamp>; mv worker/.dist-next-<stamp> worker/dist"
  say "6. operator replaces and attaches VantageBridgeEA v2 (deploy/MT5_GUI.md), types 'EA V2 ATTACHED'"
  say "7. $SYSTEMCTL start bytrader-worker.service; $SYSTEMCTL start bytrader-autotrader.service"
  say "8. post preflight: v2 EA, $EXPECT_ACCOUNT account, execution disabled; on failure the AutoTrader is stopped"
  exit "$pre_rc"
fi

# ---------------------------------------------------------------------------
# --execute
# ---------------------------------------------------------------------------

RUN_DIR="$DEPLOY_HOME/$STAMP"
STAGE="$WORKER/.dist-next-$STAMP"
PREV="$WORKER/.dist-prev-$STAMP"
[[ ! -e "$RUN_DIR" && ! -e "$STAGE" && ! -e "$PREV" ]] || die "stamp $STAMP already used"

# Until the swap, an abort leaves only the staging build behind; remove it.
trap 'rm -rf "$STAGE"' EXIT

step "1. Build into $STAGE (production keeps running)"
$TSC -p "$WORKER/tsconfig.json" --outDir "$STAGE"

step "2. Preflight"
run_preflight "$STAGE" --stage pre --live --firestore || die "preflight failed; nothing was changed"

step "Confirmation"
say "This stops both services, swaps worker/dist and requires EA v2 to be attached."
confirm "DEPLOY V2 $STAMP" BYTRADER_CONFIRM

step "3. Backup to $RUN_DIR"
mkdir -p "$RUN_DIR/backup/units" "$RUN_DIR/backup/ea"
cp -a "$WORKER/dist" "$RUN_DIR/backup/dist"
for u in "${UNITS[@]}"; do
  [[ -f "$UNIT_DIR/$u" ]] && cp -a "$UNIT_DIR/$u" "$RUN_DIR/backup/units/"
done
if [[ -n "${MT5_EXPERTS_DIR:-}" ]]; then
  for f in VantageBridgeEA.mq5 VantageBridgeEA.ex5; do
    [[ -f "$MT5_EXPERTS_DIR/$f" ]] && cp -a "$MT5_EXPERTS_DIR/$f" "$RUN_DIR/backup/ea/"
  done
fi
(cd "$RUN_DIR/backup" && find . -type f -print0 | sort -z | xargs -0 sha256sum) > "$RUN_DIR/manifest.sha256"
git -C "$ROOT" rev-parse HEAD > "$RUN_DIR/git-head" 2>/dev/null || echo unknown > "$RUN_DIR/git-head"
diff -rq "$WORKER/dist" "$RUN_DIR/backup/dist" >/dev/null || die "backup of worker/dist does not match the original"
printf 'stamp=%s\nprev=%s\nstage=%s\n' "$STAMP" "$PREV" "$STAGE" > "$RUN_DIR/deploy.env"
ln -sfn "$RUN_DIR" "$DEPLOY_HOME/latest"
say "backup verified: $(wc -l < "$RUN_DIR/manifest.sha256") files"

step "4. Stop services (AutoTrader first)"
$SYSTEMCTL stop bytrader-autotrader.service
$SYSTEMCTL stop bytrader-worker.service

step "5. Swap the build"
mv "$WORKER/dist" "$PREV"
mv "$STAGE" "$WORKER/dist"

step "6. EA v2"
say "Detach VantageBridgeEA from the chart, keep the v1 .ex5 (backed up above), copy"
say "mql5/VantageBridgeEA.mq5 into MQL5/Experts, compile (0 errors), and attach it to an"
say "XAUUSD chart with Algo Trading allowed (deploy/MT5_GUI.md). Confirm the Experts tab"
say "shows '[Bridge] v2.0.0 listening'. Type ABORT to stop here (services stay stopped)."
ea_typed="${BYTRADER_EA_CONFIRM:-}"
[[ -n "$ea_typed" ]] || read -r -p "Type 'EA V2 ATTACHED' when done: " ea_typed
if [[ "$ea_typed" != "EA V2 ATTACHED" ]]; then
  say "Stopped before starting the services. Roll back with: deploy/rollback-v2.sh --execute"
  exit 1
fi

step "7. Start services (forwarder first)"
$SYSTEMCTL start bytrader-worker.service
$SYSTEMCTL start bytrader-autotrader.service
say "waiting ${SETTLE_SEC}s for the first heartbeat and bridge check..."
sleep "$SETTLE_SEC"

step "8. Post-deploy preflight"
if ! run_preflight "$WORKER/dist" --stage post --expect-account "$EXPECT_ACCOUNT" --firestore; then
  $SYSTEMCTL stop bytrader-autotrader.service || true
  say ""
  say "SAFE STOP: the AutoTrader is stopped. The forwarder keeps receiving signals; they"
  say "queue durably in signal_events and execution mode is still disabled."
  say "Investigate, or roll back with: deploy/rollback-v2.sh --execute"
  exit 1
fi

step "Done: v2 is running with execution disabled"
say "Next, separately and only when ready:"
say "  firebase deploy --only firestore:indexes   (then wait until the indexes are built)"
say "  deploy the web app (ALLOWED_EMAILS must be set)"
say "  firebase deploy --only firestore:rules"
say "  demo verification: docs/project_memory/VANTAGE_EXECUTION_GUIDE.md §16"
say "Keep $PREV and $RUN_DIR until v2 has run cleanly for at least a day."
