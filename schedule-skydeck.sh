#!/bin/bash
# Schedules skydeck-east at sunrise and skydeck-west at sunset for today.
# Run this daily at midnight via cron:
#   0 0 * * * /home/cailin/Development/ClassicTraffic/schedule-skydeck.sh

set -euo pipefail

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$DIR/cron"
LOG_FILE="$LOG_DIR/skydeck-schedule-$(date +%Y-%m-%d).log"
mkdir -p "$LOG_DIR"

echo "$(date): Scheduling skydeck sunrise/sunset posts" >> "$LOG_FILE"

# Chicago coordinates and timezone
LAT=41.8781
LNG=-87.6298
TZ_NAME="America/Chicago"

# Compute today's sunrise and sunset (outputs SUNRISE=HH:MM and SUNSET=HH:MM)
eval "$(/usr/bin/node "$DIR/sun-times.js" "$LAT" "$LNG" "$TZ_NAME")"

# Start captures 5 minutes early to include the actual sunrise/sunset moment
SUNRISE_START=$(date -d "$SUNRISE today - 5 minutes" +%H:%M)
SUNSET_START=$(date -d "$SUNSET today - 5 minutes" +%H:%M)

echo "$(date): Sunrise=$SUNRISE (capture starts $SUNRISE_START) Sunset=$SUNSET (capture starts $SUNSET_START)" >> "$LOG_FILE"

SUNRISE_CMD="$DIR/run-bot.sh illinois --lock-key illinois-skydeck-sunrise --id skydeck-east --duration 600 --speed 16"
SUNSET_CMD="$DIR/run-bot.sh illinois --lock-key illinois-skydeck-sunset --id skydeck-west --duration 600 --speed 16"

if $DRY_RUN; then
  echo "DRY RUN — would schedule:"
  echo "  [$SUNRISE_START] $SUNRISE_CMD"
  echo "  [$SUNSET_START]  $SUNSET_CMD"
else
  echo "$SUNRISE_CMD" | at "$SUNRISE_START" >> "$LOG_FILE" 2>&1
  echo "$SUNSET_CMD"  | at "$SUNSET_START"  >> "$LOG_FILE" 2>&1
fi

echo "$(date): Done scheduling" >> "$LOG_FILE"

# Rotate logs older than 7 days
find "$LOG_DIR" -name "skydeck-schedule-*.log" -mtime +7 -delete 2>/dev/null || true
