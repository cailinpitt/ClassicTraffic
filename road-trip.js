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

// Capture one state's video. Returns { bot, titleOverride } on success, null if
// the state should be silently skipped (no camera found). Throws on hard errors.
async function captureState(stateName, BotClass, highway, duration) {
  const bot = new BotClass();
  bot.targetOutputSeconds = duration / 4;

  const account = keys.accounts[bot.accountName];
  bot.agent = new AtpAgent({ service: keys.service });
  await bot.agent.login({ identifier: account.identifier, password: account.password });

  if (!bot.agent.session?.did) throw new Error('Login failed');

  console.log(`[${stateName}] Finding camera on ${highway}...`);
  const camera = await bot.findCameraOnHighway(highway);

  if (!camera || camera.hasVideo === false) {
    console.log(`[${stateName}] No video camera found on ${highway}, skipping`);
    bot.cleanup();
    return null;
  }

  bot.chosenCamera = camera;
  console.log(`[${stateName}] Camera: ${camera.name}`);

  Fs.ensureDirSync(bot.assetDirectory);
  bot.startTime = new Date();

  if (camera.latitude && camera.longitude && camera.latitude !== 0) {
    try {
      bot.weatherStart = await bot.fetchWeather(camera.latitude, camera.longitude);
    } catch (err) {
      console.log(`[${stateName}] Weather fetch failed: ${err.message}`);
    }
  }

  await bot.downloadVideoSegment(duration);

  bot.endTime = new Date();

  if (bot.weatherStart) {
    try {
      bot.weatherEnd = await bot.fetchWeather(camera.latitude, camera.longitude);
    } catch (err) {
      console.log(`[${stateName}] End weather fetch failed: ${err.message}`);
    }
  }

  return { bot, titleOverride: `${highway} through ${getDisplayName(stateName)} 🛣️` };
}

async function main() {
  const highwayKeys = Object.keys(highways);
  const highway = argv.highway || _.sample(highwayKeys);

  const highwayConfig = highways[highway];
  if (!highwayConfig) {
    console.error(`Unknown highway: ${highway}. Available: ${highwayKeys.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n🛣️  Road Trip: ${highway}`);
  console.log(`States: ${highwayConfig.states.join(', ')}\n`);

  const duration = _.sample(DURATION_OPTIONS);
  console.log(`Clip duration: ${duration}s per state (4x speed = ${duration / 4}s video)\n`);

  // Pre-filter to states that are eligible (have a file, are video bots, have credentials)
  const eligibleStates = [];
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
    if (!keys.accounts[bot.accountName]) {
      console.log(`[${stateName}] No account in keys.js, skipping`);
      continue;
    }
    eligibleStates.push({ stateName, BotClass });
  }

  if (eligibleStates.length === 0) {
    console.error('No eligible states for this highway');
    process.exitCode = 1;
    return;
  }

  // Phase 1: capture all states in parallel
  console.log(`\nCapturing ${eligibleStates.length} states in parallel...\n`);
  const captureResults = await Promise.allSettled(
    eligibleStates.map(({ stateName, BotClass }) =>
      captureState(stateName, BotClass, highway, duration)
    )
  );

  // Collect ordered successful captures; track hard errors for the summary
  const captured = [];
  const results = [];
  for (let i = 0; i < captureResults.length; i++) {
    const { stateName } = eligibleStates[i];
    const result = captureResults[i];
    if (result.status === 'rejected') {
      console.error(`[${stateName}] Capture error: ${result.reason.message}`);
      results.push({ state: stateName, success: false, error: result.reason.message });
    } else if (result.value !== null) {
      captured.push({ stateName, ...result.value });
    }
    // null = soft skip (no camera found), already logged
  }

  if (captured.length < 2) {
    console.log(`\nOnly ${captured.length} state(s) captured — not enough for a thread`);
    captured.forEach(c => c.bot.cleanup());
    process.exitCode = 1;
    return;
  }

  // Phase 2: post intro + videos in highway order
  console.log('\nPosting thread in highway order...\n');

  const stateDisplayNames = captured.map(c => getDisplayName(c.stateName));
  const statesText = stateDisplayNames.length === 2
    ? `${stateDisplayNames[0]} and ${stateDisplayNames[1]}`
    : stateDisplayNames.slice(0, -1).join(', ') + ', and ' + stateDisplayNames[stateDisplayNames.length - 1];

  // Build weather summary by grouping consecutive states with the same condition
  const weatherParts = [];
  const weatherStates = captured.map(c => ({
    displayName: getDisplayName(c.stateName),
    description: c.bot.weatherStart?.description || null,
  })).filter(w => w.description);

  if (weatherStates.length > 0) {
    const allSame = weatherStates.every(w => w.description === weatherStates[0].description);
    if (allSame) {
      weatherParts.push(`${weatherStates[0].description} in all states`);
    } else {
      let group = [weatherStates[0].displayName];
      let currentDesc = weatherStates[0].description;
      for (let i = 1; i < weatherStates.length; i++) {
        if (weatherStates[i].description === currentDesc) {
          group.push(weatherStates[i].displayName);
        } else {
          const stateList = group.length === 1 ? group[0] : group.slice(0, -1).join(', ') + ' and ' + group[group.length - 1];
          weatherParts.push(`${currentDesc} in ${stateList}`);
          group = [weatherStates[i].displayName];
          currentDesc = weatherStates[i].description;
        }
      }
      const stateList = group.length === 1 ? group[0] : group.slice(0, -1).join(', ') + ' and ' + group[group.length - 1];
      weatherParts.push(`${currentDesc} in ${stateList}`);
    }
  }

  const miles = highwayConfig.miles ? `${highwayConfig.miles.toLocaleString()} miles` : null;
  const weatherSummary = weatherParts.length > 0 ? weatherParts.join(', ') : null;

  let introText = `${highway} road trip!`;
  if (miles) introText += ` ${miles} —`;
  introText += ` Here's what traffic looks like right now passing through ${statesText}`;
  if (weatherSummary) introText += `. ${weatherSummary}`;
  introText += ' 🛣️';

  let threadRoot = null;
  let threadParent = null;
  let successCount = 0;

  if (argv['dry-run']) {
    console.log(`Dry run — would post intro: "${introText}"`);
  } else {
    try {
      const introPost = await captured[0].bot.agent.post({
        text: introText,
        createdAt: new Date().toISOString(),
      });
      threadRoot = introPost;
      threadParent = introPost;
      console.log(`Intro posted: "${introText}"`);
    } catch (err) {
      console.error(`Failed to post intro: ${err.message}`);
    }
  }

  for (const { stateName, bot, titleOverride } of captured) {
    try {
      if (argv['dry-run']) {
        console.log(`[${stateName}] Would post: "${titleOverride}"`);
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
      console.error(`[${stateName}] Post error: ${err.message}`);
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
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
