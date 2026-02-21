#!/usr/bin/env node
// Reports when each bot last successfully posted to Bluesky.
// Bots run every 30 min; flags any bot that hasn't posted in >1 hour.
// Usage: node status.js

const fs = require('fs');
const path = require('path');

const cronDir = path.join(__dirname, 'cron');
const statesDir = path.join(__dirname, 'states');
const SUCCESS = 'Posted video to Bluesky successfully';
const STALE_MS = 60 * 60 * 1000; // 1 hour = 2 missed runs

const allStates = fs.readdirSync(statesDir)
  .filter(f => f.endsWith('.js'))
  .map(f => f.replace('.js', ''))
  .sort();

function parseLastPost(logFile) {
  if (!fs.existsSync(logFile)) return { lastPost: null, lastRun: null, status: 'no log' };

  const content = fs.readFileSync(logFile, 'utf8');

  // Each run is delimited by "\n\n=== <date> ===\n" written by run-bot.sh
  const parts = content.split(/\n\n=== (.+?) ===\n/);
  // parts[0]: pre-header content (disabled-flag lines, etc.)
  // Then alternates: [date, body, date, body, ...]

  let lastPost = null;
  let lastRun = null;

  for (let i = 1; i < parts.length; i += 2) {
    const date = parts[i];
    const body = parts[i + 1] || '';
    lastRun = date;
    if (body.includes(SUCCESS)) {
      lastPost = date;
    }
  }

  const status = lastPost ? 'ok' : lastRun ? 'never posted' : 'no runs';
  return { lastPost, lastRun, status };
}

function timeSince(dateStr) {
  if (!dateStr) return null;
  const ms = Date.now() - new Date(dateStr).getTime();
  if (isNaN(ms)) return dateStr;
  const mins = Math.floor(ms / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h ago`;
  if (hours > 0) return `${hours}h ${mins % 60}m ago`;
  return `${mins}m ago`;
}

const now = Date.now();

const results = allStates.map(state => {
  const logFile = path.join(cronDir, `${state}.log`);
  const info = parseLastPost(logFile);
  const lastPostMs = info.lastPost ? new Date(info.lastPost).getTime() : null;
  const stale = !lastPostMs || (now - lastPostMs > STALE_MS);
  return { state, ...info, stale };
});

// Sort: stale first (by last-post time ascending), then healthy (by last-post descending)
results.sort((a, b) => {
  if (a.stale !== b.stale) return a.stale ? -1 : 1;
  const aT = a.lastPost ? new Date(a.lastPost).getTime() : 0;
  const bT = b.lastPost ? new Date(b.lastPost).getTime() : 0;
  return a.stale ? aT - bT : bT - aT; // stale: oldest first; healthy: newest first
});

const colW = Math.max(...results.map(r => r.state.length)) + 2;

console.log(`\nBot post status — ${new Date().toLocaleString()}`);
console.log(`Stale threshold: >1 hour without a successful post (bots run every 30 min)\n`);
console.log('   ' + 'State'.padEnd(colW) + 'Last posted'.padEnd(38) + 'Since');
console.log('   ' + '─'.repeat(colW + 52));

for (const { state, lastPost, lastRun, status, stale } of results) {
  const flag = stale ? '[!]' : '   ';

  let dateCol, sinceCol;
  if (lastPost) {
    dateCol = lastPost;
    sinceCol = timeSince(lastPost) ?? '';
  } else if (status === 'no log') {
    dateCol = '(no log file)';
    sinceCol = '';
  } else if (status === 'never posted') {
    dateCol = `(last run: ${lastRun ?? 'unknown'})`;
    sinceCol = 'never posted';
  } else {
    dateCol = '(no runs recorded)';
    sinceCol = '';
  }

  console.log(`${flag} ${state.padEnd(colW)}${dateCol.padEnd(38)}${sinceCol}`);
}

const staleCount = results.filter(r => r.stale).length;
console.log(`\n${staleCount} bot(s) stale, ${results.length - staleCount} healthy\n`);
