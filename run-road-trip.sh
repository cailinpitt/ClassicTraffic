#!/bin/bash
# Usage: ./run-road-trip.sh [--highway I-75] [extra args]
# If --highway is omitted, a random highway is chosen from highways.json.
# Runs a road trip with logging and Grafana Loki telemetry

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$DIR/cron"

# Parse --highway from args for use in lock key and logging
HIGHWAY=""
HIGHWAY_NEXT=0
for arg in "$@"; do
  if [[ "$HIGHWAY_NEXT" == "1" ]]; then
    HIGHWAY="$arg"
    HIGHWAY_NEXT=0
  fi
  if [[ "$arg" == "--highway" ]]; then
    HIGHWAY_NEXT=1
  fi
done

if [[ -z "$HIGHWAY" ]]; then
  HIGHWAY=$(timeout 10 /usr/bin/node -e "
    const Fs = require('fs');
    const h = require('$DIR/roadtrip/highways.json');
    const all = Object.keys(h);
    const recentPath = '$DIR/cron/road-trip-recent-highways.json';
    let recent = [];
    try { recent = JSON.parse(Fs.readFileSync(recentPath, 'utf8')); } catch {}
    const fresh = all.filter(k => !recent.includes(k));
    const pool = fresh.length > 0 ? fresh : all;
    const chosen = pool[Math.floor(Math.random() * pool.length)];
    recent = [chosen, ...recent.filter(k => k !== chosen)].slice(0, Math.floor(all.length / 2));
    Fs.mkdirSync('$DIR/cron', { recursive: true });
    Fs.writeFileSync(recentPath, JSON.stringify(recent));
    console.log(chosen);
  ")
fi

LOG_FILE="$LOG_DIR/road-trip-$(date +%Y-%m-%d).log"

mkdir -p "$LOG_DIR"

LOCKFILE="$LOG_DIR/road-trip.lock"
exec 9>"$LOCKFILE"
if ! flock -n 9; then
  echo "$(date): Road trip already running, skipping" >> "$LOG_FILE"
  exit 0
fi

read -r GRAFANA_LOKI_URL GRAFANA_USER GRAFANA_API_KEY < <(
  timeout 10 /usr/bin/node -e "const k=require('$DIR/keys.js'); console.log(k.grafana.lokiUrl, k.grafana.user, k.grafana.apiKey)"
)

cd "$DIR"

START_TIME=$(date +%s)
printf "\n\n=== $(date) ===\n" >> "$LOG_FILE" 2>&1
STDERR_FILE=$(mktemp)
EXIT_CODE=0

timeout 7200 /usr/bin/node "$DIR/roadtrip/road-trip.js" "$@" >> "$LOG_FILE" 2>"$STDERR_FILE" || EXIT_CODE=$?
cat "$STDERR_FILE" >> "$LOG_FILE"
DURATION=$(( $(date +%s) - START_TIME ))

TIMESTAMP=$(date +%s%N)
TS=$(($(date +%s) * 1000))
PAYLOAD=$(/usr/bin/node -e "
  const fs = require('fs');
  const logData = { state: 'road-trip', highway: '${HIGHWAY}', exit_code: $EXIT_CODE, duration_seconds: $DURATION, ts: $TS };
  if ($EXIT_CODE !== 0) {
    const raw = fs.readFileSync('$STDERR_FILE', 'utf8').trim();
    logData.error = raw.length > 2000 ? raw.slice(0, 2000) + '...' : raw;
  }
  console.log(JSON.stringify({
    streams: [{
      stream: { job: 'classictraffic', state: 'road-trip', highway: '${HIGHWAY}' },
      values: [['$TIMESTAMP', JSON.stringify(logData)]]
    }]
  }));
")
rm -f "$STDERR_FILE"
curl -s --max-time 30 -X POST "${GRAFANA_LOKI_URL}/loki/api/v1/push" \
  -u "${GRAFANA_USER}:${GRAFANA_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  > /dev/null 2>&1 || true

find "$LOG_DIR" -name "road-trip-*.log" -mtime +7 -delete 2>/dev/null || true

exit $EXIT_CODE
