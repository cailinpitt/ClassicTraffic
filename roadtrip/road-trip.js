#!/usr/bin/env node
'use strict';

const argv = require('minimist')(process.argv.slice(2));
const _ = require('lodash');
const Path = require('path');
const Fs = require('fs-extra');
const { AtpAgent } = require('@atproto/api');

const keys = require('../keys.js');
const highways = require('./highways.json');
const { generateRoadTripMap } = require('./generate-road-trip-map.js');

const STATE_FILE = Path.join(__dirname, '..', 'cron', 'roadtrip-state.json');
const RECENT_CAMERAS_PER_STATE = 5;
const CAPTURE_CONCURRENCY = 6;

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

function loadState() {
  try {
    return JSON.parse(Fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { lastRunAt: {}, recentCameras: {} };
  }
}

function saveState(state) {
  Fs.ensureDirSync(Path.dirname(STATE_FILE));
  Fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Pick the highway that hasn't run for the longest time (or has never run).
function pickStalestHighway(state) {
  const highwayKeys = Object.keys(highways);
  let best = null;
  let bestTs = Infinity;
  for (const h of highwayKeys) {
    const ts = state.lastRunAt?.[h] ? new Date(state.lastRunAt[h]).getTime() : 0;
    if (ts < bestTs) {
      bestTs = ts;
      best = h;
    }
  }
  return best;
}

// Run async tasks with bounded concurrency. Returns results in the same order as `tasks`.
async function runWithConcurrency(tasks, concurrency) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      try {
        results[i] = { status: 'fulfilled', value: await tasks[i]() };
      } catch (err) {
        results[i] = { status: 'rejected', reason: err };
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// Capture one state's video or image timelapse. Returns { bot, titleOverride } on success,
// null if the state should be silently skipped (no camera found). Throws on hard errors.
async function captureState(stateName, BotClass, highway, duration, excludeIds) {
  const bot = new BotClass();
  bot.targetOutputSeconds = duration / 4;

  const isImageBot = typeof bot.downloadVideoSegment !== 'function';

  const account = keys.accounts[bot.accountName];
  bot.agent = new AtpAgent({ service: keys.service });
  await bot.agent.login({ identifier: account.identifier, password: account.password });

  if (!bot.agent.session?.did) throw new Error('Login failed');

  console.log(`[${stateName}] Finding camera on ${highway}...`);
  const camera = await bot.findCameraOnHighway(highway, { excludeIds });

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
    const delayMs = bot.delayBetweenImageFetches;
    const imageCount = Math.max(1, Math.min(20, Math.floor((duration * 1000) / delayMs)));
    console.log(`[${stateName}] Capturing ${imageCount} images (${delayMs / 1000}s interval) from ${camera.name}...`);
    for (let i = 0; i < imageCount; i++) {
      await bot.downloadImage(i);
      if (i < imageCount - 1) await bot.sleep(delayMs);
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
  // Login the shared road trip account used for the intro post
  const roadtripAccount = keys.accounts.roadtrip;
  if (!roadtripAccount) {
    console.error('No roadtrip account found in keys.js');
    process.exitCode = 1;
    return;
  }
  const roadtripAgent = new AtpAgent({ service: keys.service });
  await roadtripAgent.login({ identifier: roadtripAccount.identifier, password: roadtripAccount.password });
  if (!roadtripAgent.session?.did) {
    console.error('Failed to login roadtrip account');
    process.exitCode = 1;
    return;
  }

  const state = loadState();
  const highwayKeys = Object.keys(highways);
  const highway = argv.highway || pickStalestHighway(state);

  const highwayConfig = highways[highway];
  if (!highwayConfig) {
    console.error(`Unknown highway: ${highway}. Available: ${highwayKeys.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const lastRun = state.lastRunAt?.[highway];
  if (lastRun) {
    console.log(`\n🛣️  Road Trip: ${highway} (last run: ${lastRun})`);
  } else {
    console.log(`\n🛣️  Road Trip: ${highway} (never run)`);
  }
  console.log(`States: ${highwayConfig.states.join(', ')}\n`);

  const duration = _.sample(DURATION_OPTIONS);
  console.log(`Clip duration: ${duration}s per state (4x speed = ${duration / 4}s video)\n`);

  // Pre-filter to states that are eligible (have a file, are video bots, have credentials)
  const eligibleStates = [];
  for (const stateName of highwayConfig.states) {
    const stateFile = Path.join(__dirname, '..', 'states', `${stateName}.js`);
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

  // Phase 1: capture states with bounded concurrency
  const recentPerHighway = state.recentCameras?.[highway] || {};
  console.log(`\nCapturing ${eligibleStates.length} states with concurrency ${CAPTURE_CONCURRENCY}...\n`);
  const captureResults = await runWithConcurrency(
    eligibleStates.map(({ stateName, BotClass }) => () => {
      const excludeIds = recentPerHighway[stateName] || [];
      return captureState(stateName, BotClass, highway, duration, excludeIds);
    }),
    CAPTURE_CONCURRENCY,
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
  const endpoints = highwayConfig.endpoints;

  let introText;
  if (endpoints?.start && endpoints?.end) {
    introText = `${highway} from ${endpoints.start} to ${endpoints.end} 🛣️`;
    if (miles) introText += ` — ${miles}.`;
    introText += `\n\nHere's what traffic looks like right now.`;
  } else {
    introText = `${highway} road trip!`;
    if (miles) introText += ` ${miles} —`;
    introText += ` Here's what traffic looks like right now 🛣️`;
  }
  if (weatherSummary) introText += `\n\n${weatherSummary}`;

  let threadRoot = null;
  let threadParent = null;
  let successCount = 0;

  // Generate map image with highlighted states (upload only when not dry-run)
  let mapEmbed = null;
  let mapGenerated = false;
  try {
    const mapBuffer = await generateRoadTripMap(highway, highwayConfig.states);
    mapGenerated = true;
    if (!argv['dry-run']) {
      const uploadResp = await roadtripAgent.uploadBlob(mapBuffer, { encoding: 'image/png' });
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
      const introPost = await roadtripAgent.post({
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
        results.push({ state: stateName, success: true, cameraId: bot.chosenCamera?.id });
      } else {
        const replyRef = threadRoot ? { root: threadRoot, parent: threadParent } : null;
        const postResult = await bot.postToBluesky(replyRef, titleOverride);
        if (!threadRoot) threadRoot = postResult;
        threadParent = postResult;
        successCount++;
        results.push({ state: stateName, success: true, cameraId: bot.chosenCamera?.id });
        console.log(`[${stateName}] Posted successfully`);
      }
    } catch (err) {
      console.error(`[${stateName}] Post error: ${err.message}`);
      results.push({ state: stateName, success: false, error: err.message });
    } finally {
      bot.cleanup();
    }
  }

  // Persist state: update last-run timestamp and prepend chosen camera IDs to recency list
  if (!argv['dry-run'] && successCount > 0) {
    state.lastRunAt = state.lastRunAt || {};
    state.recentCameras = state.recentCameras || {};
    state.recentCameras[highway] = state.recentCameras[highway] || {};
    state.lastRunAt[highway] = new Date().toISOString();
    for (const r of results) {
      if (!r.success || !r.cameraId) continue;
      const prev = state.recentCameras[highway][r.state] || [];
      const id = String(r.cameraId);
      state.recentCameras[highway][r.state] = [id, ...prev.filter(x => x !== id)].slice(0, RECENT_CAMERAS_PER_STATE);
    }
    saveState(state);
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
