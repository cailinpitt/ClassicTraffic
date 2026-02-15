#!/bin/bash
# Usage: ./run-bot.sh <state>
# Runs a bot with logging and Healthchecks.io pings

set -euo pipefail

STATE="$1"
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$DIR/cron"
LOG_FILE="$LOG_DIR/$STATE.log"
HC_FILE="$DIR/healthchecks.json"

mkdir -p "$LOG_DIR"

# Check if bot is enabled via LaunchDarkly
FLAG_EXIT=0
/usr/bin/node "$DIR/check-flag.js" "$STATE" 2>/dev/null || FLAG_EXIT=$?
if [ "$FLAG_EXIT" -eq 1 ]; then
  echo "$(date): Bot $STATE is disabled via feature flag, skipping" >> "$LOG_FILE"
  exit 0
fi

# Look up healthcheck UUID
HC_UUID=""
if [ -f "$HC_FILE" ]; then
  HC_UUID=$(node -e "const h=require('$HC_FILE'); console.log(h['$STATE'] || '')")
fi

# Ping start
if [ -n "$HC_UUID" ]; then
  curl -fsS -m 10 --retry 3 "https://hc-ping.com/$HC_UUID/start" > /dev/null 2>&1 || true
fi

# Run bot
printf "\n\n=== $(date) ===\n" >> "$LOG_FILE" 2>&1
EXIT_CODE=0
/usr/bin/node "$DIR/states/$STATE.js" >> "$LOG_FILE" 2>&1 || EXIT_CODE=$?

# Ping finish (with exit code)
if [ -n "$HC_UUID" ]; then
  curl -fsS -m 10 --retry 3 "https://hc-ping.com/$HC_UUID/$EXIT_CODE" > /dev/null 2>&1 || true
fi

exit $EXIT_CODE
