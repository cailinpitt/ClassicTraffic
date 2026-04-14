#!/bin/bash
# Usage: ./run-meta.sh <script-name> [extra args passed to node]
# Runs a script in meta/ with per-script locking and dated logging under cron/
# Example: ./run-meta.sh engagement-repost

set -uo pipefail

SCRIPT="$1"
shift
DIR="$(cd "$(dirname "$0")" && pwd)"

LOCK_KEY="meta-$SCRIPT"
LOG_DIR="$DIR/cron"
LOG_FILE="$LOG_DIR/$LOCK_KEY-$(date +%Y-%m-%d).log"

mkdir -p "$LOG_DIR"

# Prevent overlapping runs
LOCKFILE="$LOG_DIR/$LOCK_KEY.lock"
exec 9>"$LOCKFILE"
if ! flock -n 9; then
  echo "$(date): [$$] meta script $SCRIPT already running, skipping" >> "$LOG_FILE"
  exit 0
fi

cd "$DIR"

printf "\n\n=== $(date) ===\n" >> "$LOG_FILE" 2>&1
EXIT_CODE=0
timeout 600 /usr/bin/node "$DIR/meta/$SCRIPT.js" "$@" >> "$LOG_FILE" 2>&1 || EXIT_CODE=$?

# Rotate: delete logs for this lock key older than 7 days
find "$LOG_DIR" -name "$LOCK_KEY-*.log" -mtime +7 -delete 2>/dev/null || true

exit $EXIT_CODE
