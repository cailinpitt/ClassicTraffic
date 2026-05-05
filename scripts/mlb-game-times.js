#!/usr/bin/env node
// Outputs today's home-game first-pitch times for an MLB team in a given timezone.
// Skips postponed/cancelled games. Prints `GAME_TIMES="HH:MM HH:MM"` (empty string
// if no home games), suitable for `eval` in a shell script.
//
// Usage: node mlb-game-times.js <teamId> <timezone>
// Example: node mlb-game-times.js 112 America/Chicago   # Cubs

const [,, teamIdArg, tz] = process.argv;

if (!teamIdArg || !tz) {
  console.error('Usage: node mlb-game-times.js <teamId> <timezone>');
  process.exit(1);
}

const teamId = parseInt(teamIdArg, 10);
if (Number.isNaN(teamId)) {
  console.error(`Invalid teamId: ${teamIdArg}`);
  process.exit(1);
}

function toHHMM(date, tz) {
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz,
  });
}

(async () => {
  // en-CA gives YYYY-MM-DD, which is what statsapi expects.
  const date = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=${teamId}&date=${date}`;

  const res = await fetch(url);
  if (!res.ok) {
    console.error(`MLB API returned ${res.status}`);
    process.exit(1);
  }
  const data = await res.json();

  // codedGameState: D=Postponed, C=Cancelled, P=Pre-Game, S=Scheduled, I=In Progress, F=Final
  const SKIP_STATES = new Set(['D', 'C']);

  const times = (data.dates?.[0]?.games || [])
    .filter(g => g.teams?.home?.team?.id === teamId)
    .filter(g => !SKIP_STATES.has(g.status?.codedGameState))
    .map(g => g.gameDate)
    .sort()
    .map(iso => toHHMM(new Date(iso), tz));

  console.log(`GAME_TIMES="${times.join(' ')}"`);
})().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
