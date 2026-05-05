# Shared helpers for at-based scheduling scripts (schedule-skydeck.sh,
# schedule-mlb-game.sh, etc.). Source from a script that has $DIR set to
# the repo root and may set DRY_RUN=true.

# init_log_file <prefix> — sets LOG_DIR and LOG_FILE for today's log.
init_log_file() {
  local prefix="$1"
  LOG_DIR="$DIR/cron"
  LOG_FILE="$LOG_DIR/${prefix}-$(date +%Y-%m-%d).log"
  mkdir -p "$LOG_DIR"
}

# log <message> — timestamp and append to LOG_FILE.
log() {
  echo "$(date): $*" >> "$LOG_FILE"
}

# schedule_at <HH:MM> <command...> — schedule a command via `at`, or print if DRY_RUN.
schedule_at() {
  local at_time="$1"
  shift
  local cmd="$*"
  if ${DRY_RUN:-false}; then
    echo "DRY RUN — would schedule at $at_time: $cmd"
  else
    echo "$cmd" | at "$at_time" >> "$LOG_FILE" 2>&1
  fi
}

# rotate_logs <prefix> — delete this prefix's logs older than 7 days.
rotate_logs() {
  local prefix="$1"
  find "$LOG_DIR" -name "${prefix}-*.log" -mtime +7 -delete 2>/dev/null || true
}
