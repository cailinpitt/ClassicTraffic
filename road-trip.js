#!/usr/bin/env node
'use strict';

const argv = require('minimist')(process.argv.slice(2));
const _ = require('lodash');
const Path = require('path');
const Fs = require('fs-extra');
const { AtpAgent } = require('@atproto/api');

const keys = require('./keys.js');
const highways = require('./highways.json');

// Display names for states where the account name differs from title case
const STATE_DISPLAY_NAMES = {
  northcarolina: 'North Carolina',
  southcarolina: 'South Carolina',
  westvirginia: 'West Virginia',
  newjersey: 'New Jersey',
  newyork: 'New York',
  newmexico: 'New Mexico',
  newhampshire: 'New Hampshire',
  rhodeisland: 'Rhode Island',
};

function getDisplayName(accountName) {
  return STATE_DISPLAY_NAMES[accountName] ||
    accountName.charAt(0).toUpperCase() + accountName.slice(1);
}

const DURATION_OPTIONS = [60, 90, 120, 180, 240, 360];

async function main() {
  const highway = argv.highway;
  if (!highway) {
    console.error('Usage: node road-trip.js --highway I-75 [--dry-run]');
    process.exitCode = 1;
    return;
  }

  const highwayConfig = highways[highway];
  if (!highwayConfig) {
    console.error(`Unknown highway: ${highway}. Available: ${Object.keys(highways).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n🛣️  Road Trip: ${highway}`);
  console.log(`States: ${highwayConfig.states.join(', ')}\n`);

  const duration = _.sample(DURATION_OPTIONS);
  console.log(`Clip duration: ${duration}s per state (4x speed = ${duration / 4}s video)\n`);

  let threadRoot = null;
  let threadParent = null;
  let successCount = 0;
  const results = [];

  for (const stateName of highwayConfig.states) {
    const stateFile = Path.join(__dirname, 'states', `${stateName}.js`);
    if (!Fs.existsSync(stateFile)) {
      console.log(`[${stateName}] No bot file found, skipping`);
      continue;
    }

    let BotClass;
    try {
      BotClass = require(stateFile);
    } catch (err) {
      console.log(`[${stateName}] Failed to load bot: ${err.message}`);
      continue;
    }

    const bot = new BotClass();

    if (typeof bot.downloadVideoSegment !== 'function') {
      console.log(`[${stateName}] Image-only bot, skipping`);
      continue;
    }

    // Force 4x speed regardless of targetOutputSeconds
    bot.targetOutputSeconds = duration / 4;

    console.log(`\n[${stateName}] Starting...`);

    try {
      const account = keys.accounts[bot.accountName];
      if (!account) {
        console.log(`[${stateName}] No account in keys.js, skipping`);
        continue;
      }

      bot.agent = new AtpAgent({ service: keys.service });
      await bot.agent.login({ identifier: account.identifier, password: account.password });

      if (!bot.agent.session?.did) {
        console.log(`[${stateName}] Login failed, skipping`);
        continue;
      }

      console.log(`[${stateName}] Finding camera on ${highway}...`);
      const camera = await bot.findCameraOnHighway(highway);

      if (!camera) {
        console.log(`[${stateName}] No camera found on ${highway}, skipping`);
        continue;
      }

      // For hybrid bots, prefer video cameras; for pure video bots all cameras are video
      if (camera.hasVideo === false) {
        console.log(`[${stateName}] Camera found but is image-only, skipping`);
        continue;
      }

      bot.chosenCamera = camera;
      console.log(`[${stateName}] Camera: ${camera.name}`);

      Fs.ensureDirSync(bot.assetDirectory);
      bot.startTime = new Date();

      // Fetch weather at start
      if (camera.latitude && camera.longitude && camera.latitude !== 0) {
        try {
          bot.weatherStart = await bot.fetchWeather(camera.latitude, camera.longitude);
        } catch (err) {
          console.log(`[${stateName}] Weather fetch failed: ${err.message}`);
        }
      }

      await bot.downloadVideoSegment(duration);

      bot.endTime = new Date();

      // Fetch weather at end
      if (bot.weatherStart) {
        try {
          bot.weatherEnd = await bot.fetchWeather(camera.latitude, camera.longitude);
        } catch (err) {
          console.log(`[${stateName}] Weather fetch (end) failed: ${err.message}`);
        }
      }

      const displayName = getDisplayName(stateName);
      const titleOverride = `${highway} through ${displayName} 🛣️`;

      if (argv['dry-run']) {
        console.log(`[${stateName}] Dry run — would post: "${titleOverride}"`);
        successCount++;
        results.push({ state: stateName, success: true });
      } else {
        const replyRef = threadRoot ? { root: threadRoot, parent: threadParent } : null;
        const postResult = await bot.postToBluesky(replyRef, titleOverride);
        if (!threadRoot) threadRoot = postResult;
        threadParent = postResult;
        successCount++;
        results.push({ state: stateName, success: true });
        console.log(`[${stateName}] Posted successfully`);
      }
    } catch (err) {
      console.error(`[${stateName}] Error: ${err.message}`);
      results.push({ state: stateName, success: false, error: err.message });
    } finally {
      bot.cleanup();
    }
  }

  console.log(`\n=== Road Trip Complete: ${highway} ===`);
  console.log(`Posted: ${successCount} states`);
  for (const r of results) {
    const icon = r.success ? '✓' : '✗';
    console.log(`  ${icon} ${r.state}${r.error ? ': ' + r.error : ''}`);
  }

  if (successCount < 2) {
    console.log(`\nOnly ${successCount} state(s) posted — not enough for a thread`);
    // Note: if successCount === 1, that one post is already live as a standalone.
    // Nothing we can do about it retroactively.
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
