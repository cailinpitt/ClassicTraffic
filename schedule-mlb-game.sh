#!/bin/bash
# Schedules a state bot to capture today's MLB home game(s) for a given team.
# Looks up first-pitch times via statsapi.mlb.com and queues `at` jobs that
# call run-bot.sh with the right --id. Doubleheaders get two scheduled jobs.
# Off-days and away days are no-ops.
#
# Usage:
#   schedule-mlb-game.sh \
#     --team-id 112 \
#     --tz America/Chicago \
#     --state illinois \
#     --camera-id wrigley-field \
#     --lock-prefix illinois-cubs \
#     [--duration 1800] \
#     [--dry-run]
#
# Run daily at midnight via cron, e.g.:
#   0 0 * * * $CT/schedule-mlb-game.sh --team-id 112 --tz America/Chicago \
#     --state illinois --camera-id wrigley-field --lock-prefix illinois-cubs

set -euo pipefail

TEAM_ID=""
TZ_NAME=""
STATE=""
CAMERA_ID=""
LOCK_PREFIX=""
DURATION=1800
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --team-id)     TEAM_ID="$2"; shift 2;;
    --tz)          TZ_NAME="$2"; shift 2;;
    --state)       STATE="$2"; shift 2;;
    --camera-id)   CAMERA_ID="$2"; shift 2;;
    --lock-prefix) LOCK_PREFIX="$2"; shift 2;;
    --duration)    DURATION="$2"; shift 2;;
    --dry-run)     DRY_RUN=true; shift;;
    *) echo "Unknown arg: $1" >&2; exit 2;;
  esac
done

for var in TEAM_ID TZ_NAME STATE CAMERA_ID LOCK_PREFIX; do
  if [[ -z "${!var}" ]]; then
    echo "Missing required --${var,,}" >&2
    exit 2
  fi
done

DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/scripts/schedule-lib.sh"
init_log_file "${LOCK_PREFIX}-schedule"

log "Looking up home games for team $TEAM_ID (tz $TZ_NAME)"

# Outputs GAME_TIMES="HH:MM HH:MM ..." (empty if no home games today)
eval "$(/usr/bin/node "$DIR/scripts/mlb-game-times.js" "$TEAM_ID" "$TZ_NAME")"

if [[ -z "${GAME_TIMES:-}" ]]; then
  log "No home games today — nothing to schedule"
  rotate_logs "${LOCK_PREFIX}-schedule"
  exit 0
fi

log "Home game start times: $GAME_TIMES"

i=0
for game_time in $GAME_TIMES; do
  LOCK_KEY="${LOCK_PREFIX}-game-${i}"
  CMD="$DIR/run-bot.sh $STATE --lock-key $LOCK_KEY --id $CAMERA_ID --duration $DURATION"
  schedule_at "$game_time" "$CMD"
  log "Scheduled $LOCK_KEY at $game_time"
  i=$((i + 1))
done

log "Done scheduling"

rotate_logs "${LOCK_PREFIX}-schedule"
