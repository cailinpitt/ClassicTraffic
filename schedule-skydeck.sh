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
source "$DIR/scripts/schedule-lib.sh"
init_log_file skydeck-schedule

log "Scheduling skydeck sunrise/sunset posts"

# Chicago coordinates and timezone
LAT=41.8781
LNG=-87.6298
TZ_NAME="America/Chicago"

# Compute today's sunrise and sunset (outputs SUNRISE=HH:MM and SUNSET=HH:MM)
eval "$(/usr/bin/node "$DIR/scripts/sun-times.js" "$LAT" "$LNG" "$TZ_NAME")"

# Start captures 5 minutes early to include the actual sunrise/sunset moment
SUNRISE_START=$(date -d "$SUNRISE today - 5 minutes" +%H:%M)
SUNSET_START=$(date -d "$SUNSET today - 5 minutes" +%H:%M)

log "Sunrise=$SUNRISE (capture starts $SUNRISE_START) Sunset=$SUNSET (capture starts $SUNSET_START)"

schedule_at "$SUNRISE_START" "$DIR/run-bot.sh illinois --lock-key illinois-skydeck-sunrise --id skydeck-east --duration 600 --speed 16 --event sunrise"
schedule_at "$SUNSET_START"  "$DIR/run-bot.sh illinois --lock-key illinois-skydeck-sunset --id skydeck-west --duration 600 --speed 16 --event sunset"

log "Done scheduling"

rotate_logs skydeck-schedule
