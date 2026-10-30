#!/bin/sh
# Pre-commit check for research commits: scans the STAGED set (added lines and new files).
# Prints file:line and the rule name, never the matched text. Exit 1 if anything is flagged.
# Usage (from the repo root): sh .claude/skills/clean-research/references/commit_check.sh [max_kb]
MAX_KB=${1:-1024}
fail=0
flag() { echo "FLAG $1: $2"; fail=1; }

files=$(git diff --cached --name-only --diff-filter=AM)
[ -z "$files" ] && { echo "nothing staged"; exit 0; }

for f in $files; do
  case "$f" in
    *.env|*.env.*|.env*|*service-account*.json|*.session|*.session.json|*session*.sqlite|*.pem|*.key|*.p12)
      flag "secret-file" "$f" ;;
    *.bi5|*.csv.gz|*.parquet|*.sqlite|*.sqlite-wal|*.db|*.ex5|*.zip|*.tar*)
      flag "raw-or-binary-data" "$f" ;;
    *trades*.csv|*fills*.csv|*universe*.csv|*revisions*.json|*messages*.json|*result.json)
      flag "per-row-data-or-raw-text" "$f" ;;
  esac
  if [ -f "$f" ]; then
    kb=$(( $(wc -c < "$f") / 1024 ))
    [ "$kb" -gt "$MAX_KB" ] && flag "large-file(${kb}KB)" "$f"
  fi
done

# Added lines only. Patterns look for assigned values, not identifiers.
git diff --cached -U0 --no-color | awk -v OFS=: '
  /^\+\+\+ b\// { file = substr($0, 7); next }
  /^@@/ { split($3, a, ","); line = substr(a[1], 2) - 1; next }
  /^\+/ {
    line++; s = substr($0, 2)
    if (s ~ /(API_HASH|API_ID|PASSWORD|PASSWD|SECRET|TOKEN|MASTER_KEY|PRIVATE_KEY)[A-Z_]*[ \t]*[=:][ \t]*["'\'']?[A-Za-z0-9+\/_-]{8,}/) print "FLAG secret-assignment", file, line
    if (s ~ /-----BEGIN [A-Z ]*PRIVATE KEY-----/) print "FLAG private-key", file, line
    if (s ~ /AIza[0-9A-Za-z_-]{35}/) print "FLAG google-api-key", file, line
    if (s ~ /[0-9]{6,}:AA[0-9A-Za-z_-]{30,}/) print "FLAG telegram-bot-token", file, line
    if (s ~ /(login|LOGIN|account|ACCOUNT)[^A-Za-z]{0,6}[0-9]{7,10}([^0-9]|$)/) print "FLAG broker-login-like", file, line
    if (s ~ /\+[0-9]{10,14}([^0-9]|$)/) print "FLAG phone-number-like", file, line
  }' > /tmp/commit_check.$$ 2>/dev/null
if [ -s /tmp/commit_check.$$ ]; then cat /tmp/commit_check.$$; fail=1; fi
rm -f /tmp/commit_check.$$

[ "$fail" = 0 ] && echo "commit_check: OK ($(echo "$files" | wc -l) files)"
exit $fail
