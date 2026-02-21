#!/bin/bash
# Usage: ./run-bot.sh <state>
# Runs a bot with logging and Grafana Loki telemetry

set -euo pipefail

STATE="$1"
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$DIR/cron"
LOG_FILE="$LOG_DIR/$STATE-$(date +%Y-%m-%d).log"

mkdir -p "$LOG_DIR"

# Load Grafana credentials from keys.js
GRAFANA_LOKI_URL=$(/usr/bin/node -e "const k=require('$DIR/keys.js'); console.log(k.grafana.lokiUrl)")
GRAFANA_USER=$(/usr/bin/node -e "const k=require('$DIR/keys.js'); console.log(k.grafana.user)")
GRAFANA_API_KEY=$(/usr/bin/node -e "const k=require('$DIR/keys.js'); console.log(k.grafana.apiKey)")

# Check if bot is enabled via LaunchDarkly
FLAG_EXIT=0
/usr/bin/node "$DIR/check-flag.js" "$STATE" 2>/dev/null || FLAG_EXIT=$?
if [ "$FLAG_EXIT" -eq 1 ]; then
  echo "$(date): Bot $STATE is disabled via feature flag, skipping" >> "$LOG_FILE"
  exit 0
fi

# Run bot
START_TIME=$(date +%s)
printf "\n\n=== $(date) ===\n" >> "$LOG_FILE" 2>&1
EXIT_CODE=0
/usr/bin/node "$DIR/states/$STATE.js" >> "$LOG_FILE" 2>&1 || EXIT_CODE=$?
DURATION=$(( $(date +%s) - START_TIME ))

# Push run telemetry to Grafana Loki
TIMESTAMP=$(date +%s%N)
TS=$(($(date +%s) * 1000))
PAYLOAD="{\"streams\":[{\"stream\":{\"job\":\"classictraffic\",\"state\":\"$STATE\"},\"values\":[[\"$TIMESTAMP\",\"{\\\"state\\\":\\\"$STATE\\\",\\\"exit_code\\\":$EXIT_CODE,\\\"duration_seconds\\\":$DURATION,\\\"ts\\\":$TS}\"]]}]}"
curl -s -X POST "${GRAFANA_LOKI_URL}/loki/api/v1/push" \
  -u "${GRAFANA_USER}:${GRAFANA_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  > /dev/null 2>&1 || true

# Rotate: delete logs for this state older than 7 days
find "$LOG_DIR" -name "$STATE-*.log" -mtime +7 -delete 2>/dev/null || true

exit $EXIT_CODE
