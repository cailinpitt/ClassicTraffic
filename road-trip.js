#!/usr/bin/env node
'use strict';

const argv = require('minimist')(process.argv.slice(2));
const _ = require('lodash');
const Path = require('path');
const Fs = require('fs-extra');
const { AtpAgent } = require('@atproto/api');

const keys = require('./keys.js');
const highways = require('./highways.json');
const { generateRoadTripMap } = require('./generate-road-trip-map.js');

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
const ROAD_TRIP_IMAGE_COUNT = 15;
const ROAD_TRIP_IMAGE_DELAY_MS = 2000;

// Capture one state's video or image timelapse. Returns { bot, titleOverride } on success,
// null if the state should be silently skipped (no camera found). Throws on hard errors.
async function captureState(stateName, BotClass, highway, duration) {
  const bot = new BotClass();
  bot.targetOutputSeconds = duration / 4;

  const isImageBot = typeof bot.downloadVideoSegment !== 'function';

  const account = keys.accounts[bot.accountName];
  bot.agent = new AtpAgent({ service: keys.service });
  await bot.agent.login({ identifier: account.identifier, password: account.password });

  if (!bot.agent.session?.did) throw new Error('Login failed');

  console.log(`[${stateName}] Finding camera on ${highway}...`);
  const camera = await bot.findCameraOnHighway(highway);

  if (!camera || (!isImageBot && camera.hasVideo === false)) {
    console.log(`[${stateName}] No camera found on ${highway}, skipping`);
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

  if (isImageBot) {
    console.log(`[${stateName}] Capturing ${ROAD_TRIP_IMAGE_COUNT} images from ${camera.name}...`);
    for (let i = 0; i < ROAD_TRIP_IMAGE_COUNT; i++) {
      await bot.downloadImage(i);
      if (i < ROAD_TRIP_IMAGE_COUNT - 1) await bot.sleep(ROAD_TRIP_IMAGE_DELAY_MS);
    }
    if (bot.uniqueImageCount < 2) {
      console.log(`[${stateName}] Only ${bot.uniqueImageCount} unique image(s), skipping`);
      bot.cleanup();
      return null;
    }
    await bot.createVideo();
  } else {
    await bot.downloadVideoSegment(duration);
  }

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
      const err = result.reason;
      const detail = err.stderr ? `\n${err.stderr.trim()}` : '';
      console.error(`[${stateName}] Capture error: ${err.message}${detail}`);
      results.push({ state: stateName, success: false, error: err.message });
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
  introText += ` Here's what traffic looks like right now passing through ${statesText} 🛣️`;
  if (weatherSummary) introText += `\n\n${weatherSummary}`;

  let threadRoot = null;
  let threadParent = null;
  let successCount = 0;

  // Generate map image with highlighted states (upload only when not dry-run)
  let mapEmbed = null;
  let mapGenerated = false;
  try {
    const mapBuffer = await generateRoadTripMap(highway, captured.map(c => c.stateName));
    mapGenerated = true;
    if (!argv['dry-run']) {
      const uploadResp = await captured[0].bot.agent.uploadBlob(mapBuffer, { encoding: 'image/png' });
      mapEmbed = {
        $type: 'app.bsky.embed.images',
        images: [{ image: uploadResp.data.blob, alt: `Map of the United States with ${highway} states highlighted` }],
      };
      console.log('Map image generated and uploaded');
    }
  } catch (err) {
    console.log(`Map generation failed (continuing without image): ${err.message}`);
  }

  if (argv['dry-run']) {
    console.log(`Dry run — would post intro: "${introText}" ${mapGenerated ? '[with map]' : '[no map]'}`);
  } else {
    try {
      const introPost = await captured[0].bot.agent.post({
        text: introText,
        createdAt: new Date().toISOString(),
        ...(mapEmbed && { embed: mapEmbed }),
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
