const keys = require('./keys.js');

const Path = require('path');
const Fs = require('fs-extra');
const _ = require('lodash');
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');
const { AtpAgent } = require('@atproto/api');
const argv = require('minimist')(process.argv.slice(2));
const crypto = require('crypto');
const Axios = require('axios');

/**
 * @typedef {Object} Camera
 * @property {string} id - Unique identifier for the camera
 * @property {string} name - Display name for the camera location
 * @property {string} url - URL to fetch the camera image from
 * @property {number} latitude - GPS latitude (0 if unknown)
 * @property {number} longitude - GPS longitude (0 if unknown)
 */

/**
 * @typedef {Object} TrafficBotConfig
 * @property {string} accountName - Key in keys.js accounts object (e.g., 'ohio', 'montana')
 * @property {string} timezone - IANA timezone for post timestamps (e.g., 'America/New_York')
 * @property {string} tzAbbrev - Timezone abbreviation for display (e.g., 'ET', 'MT')
 * @property {number} framerate - Video framerate in fps (e.g., 10)
 * @property {number} delayBetweenImageFetches - Milliseconds between image downloads (e.g., 6000)
 * @property {boolean} [is24HourTimelapse=false] - If true, post text shows "24-Hour Timelapse:"
 */

/**
 * Base class for traffic camera timelapse bots.
 *
 * Handles the common workflow: login, fetch cameras, download images,
 * create video, post to Bluesky, and cleanup.
 *
 * Subclasses must implement:
 * - fetchCameras() - Return array of available cameras
 * - downloadImage(index) - Download a single image
 * - getNumImages() - Return number of images to capture
 *
 * Subclasses may override:
 * - shouldAbort() - Return true to stop after downloads (e.g., frozen camera)
 */
class TrafficBot {
  /**
   * @param {TrafficBotConfig} config - Bot configuration
   */
  constructor(config) {
    /** @type {string} */
    this.accountName = config.accountName;
    /** @type {string} */
    this.timezone = config.timezone;
    /** @type {string} */
    this.tzAbbrev = config.tzAbbrev;
    /** @type {number} */
    this.framerate = config.framerate;
    /** @type {number} */
    this.delayBetweenImageFetches = config.delayBetweenImageFetches;
    /** @type {number} Maximum ms to spend collecting images (default: no cap) */
    this.maxImageCollectionMs = config.maxImageCollectionMs || Infinity;
    /** @type {number} Target output video duration in seconds for dynamic speed calculation */
    this.targetOutputSeconds = config.targetOutputSeconds || 30;
    /** @type {number|null} Speed multiplier applied during encode (e.g. 4 for 4x), set by getSetpts() */
    this.videoSpeedFactor = null;
    /** @type {boolean} */
    this.is24HourTimelapse = config.is24HourTimelapse || false;
    /** @type {number} Probability (0-1) of posting a multi-camera thread instead of single post */
    this.threadProbability = config.threadProbability || 0;
    /** @type {string} Short ID for this run, prepended to all log output */
    this.runId = process.env.RUN_ID || String(process.pid);

    /** @type {string} */
    this.assetDirectory = `./assets/${this.accountName}-${uuidv4()}/`;
    /** @type {string} */
    this.pathToVideo = `${this.assetDirectory}camera.mp4`;
    /** @type {Set<string>} */
    this.imageHashes = new Set();
    /** @type {number} */
    this.uniqueImageCount = 0;
    /** @type {number} */
    this.consecutiveDuplicates = 0;
    /** @type {Camera|null} */
    this.chosenCamera = null;
    /** @type {AtpAgent|null} */
    this.agent = null;
    /** @type {Date|null} */
    this.startTime = null;
    /** @type {Date|null} */
    this.endTime = null;
    /** @type {{tempF: number, description: string}|null} */
    this.weatherStart = null;
    /** @type {{tempF: number, description: string}|null} */
    this.weatherEnd = null;
  }

  /**
   * Fetch available cameras from the data source.
   * Must be implemented by subclasses.
   * @abstract
   * @returns {Promise<Camera[]>} Array of available cameras
   */
  async fetchCameras() {
    throw new Error('fetchCameras() must be implemented');
  }

  /**
   * Return the URL to fetch for image downloads.
   * Override to add cache-busting query params.
   * @returns {string}
   */
  getImageUrl() {
    return this.chosenCamera.url;
  }

  /**
   * Return extra HTTP headers to include in image download requests.
   * Override to add Referer, User-Agent, etc.
   * @returns {Object}
   */
  getImageHeaders() {
    return {};
  }

  /**
   * Download a single image from the chosen camera.
   * Uses getImageUrl() and getImageHeaders() hooks — override those instead of this.
   * @param {number} index - Image index (0-based)
   * @returns {Promise<boolean>} True if image was unique, false if duplicate
   */
  async downloadImage(index, retries = 3) {
    const path = this.getImagePath(index);

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const writer = Fs.createWriteStream(path);

        const response = await Axios({
          url: this.getImageUrl(),
          method: 'GET',
          responseType: 'stream',
          timeout: 20000,
          headers: this.getImageHeaders(),
        });

        return await new Promise((resolve, reject) => {
          response.data.pipe(writer);
          writer.on('finish', () => {
            setTimeout(() => {
              try {
                const isUnique = this.checkAndStoreImage(path, index);
                resolve(isUnique);
              } catch (err) {
                reject(err);
              }
            }, 100);
          });
          writer.on('error', reject);
        });
      } catch (error) {
        console.log(`Error downloading image ${index} (attempt ${attempt}/${retries}): ${error.message}`);
        if (Fs.existsSync(path)) Fs.removeSync(path);
        if (attempt === retries) throw error;
        await this.sleep(1000 * Math.pow(2, attempt - 1));
      }
    }
  }

  /**
   * Return ffmpeg flags placed between `ffmpeg -y` and `-t` in the capture command.
   * Override to change protocol flags or add authentication headers.
   * @returns {string}
   */
  getCaptureFlags() {
    return '-rw_timeout 15000000';
  }

  /**
   * Return the video stream URL to capture from.
   * Override for bots that need to fetch an authenticated or dynamic URL.
   * @returns {Promise<string>}
   */
  async getVideoUrl() {
    return this.chosenCamera.url;
  }

  /**
   * Return extra ffmpeg flags appended to the encode command.
   * Override to add codec-specific flags (e.g. -err_detect ignore_err).
   * @returns {string}
   */
  getEncodeFlags() {
    return '';
  }

  /**
   * Return the timeout (ms) for the ffmpeg encode exec call.
   * Override on slow hardware where encoding takes longer.
   * @param {number} duration - Capture duration in seconds
   * @returns {number}
   */
  getEncodeTimeout(duration) {
    return (duration * 2 + 300) * 1000;
  }

  /**
   * Return duration options (in seconds) for video capture.
   * Override to use a different set of durations.
   * @returns {number[]}
   */
  getDurationOptions() {
    return TrafficBot.DEFAULT_DURATION_OPTIONS;
  }

  /**
   * Capture a video segment from the chosen camera and encode it as an MP4.
   * Uses getCaptureFlags(), getVideoUrl(), getEncodeFlags(), getEncodeTimeout() hooks.
   * @param {number} duration - Capture duration in seconds
   * @returns {Promise<void>}
   */
  async downloadVideoSegment(duration) {
    this.getSetpts(duration);
    console.log(`Recording ${duration}s of video from ${this.chosenCamera.name} at ${this.videoSpeedFactor}x...`);

    const tempPath = `${this.assetDirectory}raw.ts`;
    const streamUrl = await this.getVideoUrl();
    const captureCmd = `ffmpeg -y ${this.getCaptureFlags()} -t ${duration} -i "${streamUrl}" -map 0:v:0 -c copy "${tempPath}"`;

    await new Promise((resolve, reject) => {
      exec(captureCmd, { timeout: (duration + 60) * 1000 }, (error) => {
        if (Fs.existsSync(tempPath) && Fs.statSync(tempPath).size > 500 * 1024) return resolve();
        if (error) return reject(error);
        resolve();
      });
    });

    const encodeFlags = this.getEncodeFlags();
    const encodeCmd = `ffmpeg -y -i "${tempPath}" -c:v libx264 -preset ultrafast -crf 28 -maxrate 10M -bufsize 20M -pix_fmt yuv420p${encodeFlags ? ' ' + encodeFlags : ''} -vf "setpts=${this.getSetpts(duration)}*PTS" -an "${this.pathToVideo}"`;

    await new Promise((resolve, reject) => {
      exec(encodeCmd, { timeout: this.getEncodeTimeout(duration) }, (error) => {
        if (error) return reject(error);
        resolve();
      });
    });

    Fs.removeSync(tempPath);

    if (!Fs.existsSync(this.pathToVideo) || Fs.statSync(this.pathToVideo).size === 0) {
      throw new Error('ffmpeg encode produced no output');
    }

    const stats = Fs.statSync(this.pathToVideo);
    console.log(`Video saved: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
  }

  /**
   * Get the number of images to capture.
   * Must be implemented by subclasses.
   * @abstract
   * @returns {number} Number of images to download
   */
  getNumImages() {
    throw new Error('getNumImages() must be implemented');
  }

  /**
   * Check if the bot should abort after downloading images.
   * Override to implement checks like frozen camera detection.
   * Base class aborts if camera has been frozen for 10+ consecutive duplicates.
   * @returns {boolean} True to abort (skip video creation and posting)
   */
  shouldAbort() {
    if (this.uniqueImageCount === 1 || this.consecutiveDuplicates >= 3) {
      const reason = this.consecutiveDuplicates >= 3
        ? `${this.consecutiveDuplicates} consecutive duplicates`
        : 'only 1 unique image';
      console.log(`Camera ${this.chosenCamera?.id}: ${this.chosenCamera?.name} appears frozen (${reason}). Exiting`);
      return true;
    }
    return false;
  }

  /**
   * Get the maximum number of seconds this bot may run.
   * Used by run-bot.sh to set the process timeout.
   * Override in subclasses with long image intervals.
   * @returns {number} Timeout in seconds
   */
  getTimeout() {
    return 7200;
  }

  /**
   * Entry point. Handles --get-timeout before delegating to run().
   * @returns {Promise<void>}
   */
  async start() {
    if (argv['get-timeout']) {
      console.log(this.getTimeout());
      return;
    }

    // Prepend run ID to every log line so concurrent bot runs can be distinguished
    const tag = `[${this.runId}]`;
    const origLog = console.log.bind(console);
    const origError = console.error.bind(console);
    console.log = (...args) => origLog(tag, ...args);
    console.error = (...args) => origError(tag, ...args);

    await this.run();
  }

  /**
   * Get the file path for an image by index.
   * @param {number} index - Image index
   * @returns {string} Absolute path to save the image
   */
  getImagePath(index) {
    return Path.resolve(`${this.assetDirectory}camera-${index}.jpg`);
  }

  /**
   * Calculate MD5 hash of a file.
   * @param {string} filePath - Path to the file
   * @returns {string} MD5 hash hex string
   */
  getImageHash(filePath) {
    const fileBuffer = Fs.readFileSync(filePath);
    return crypto.createHash('md5').update(fileBuffer).digest('hex');
  }

  /**
   * Check if a file is a valid JPEG image.
   * Verifies SOI marker and minimum file size.
   * @param {string} filePath - Path to the image file
   * @returns {boolean} True if the file appears to be a valid JPEG
   */
  isValidJpeg(filePath) {
    try {
      const buf = Fs.readFileSync(filePath);
      if (buf.length < 100) return false;
      // Check JPEG SOI marker (FF D8)
      if (buf[0] !== 0xFF || buf[1] !== 0xD8) return false;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if an image is a duplicate and store it if unique.
   * Automatically deletes duplicate or corrupt images.
   * @param {string} filePath - Path to the downloaded image
   * @param {number} index - Image index (for logging)
   * @returns {boolean} True if image was unique and stored, false if duplicate/invalid
   */
  checkAndStoreImage(filePath, index) {
    if (!this.isValidJpeg(filePath)) {
      console.log(`Skipping corrupt image ${index}`);
      Fs.removeSync(filePath);
      return false;
    }

    const hash = this.getImageHash(filePath);

    if (this.imageHashes.has(hash)) {
      Fs.removeSync(filePath);
      return false;
    } else {
      this.imageHashes.add(hash);
      this.uniqueImageCount++;
      return true;
    }
  }

  /**
   * Sleep for the specified duration.
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise<void>}
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Download images with adaptive backoff, duplicate detection, and abort support.
   * Extracted so subclasses with custom run() loops can reuse the same logic.
   * @param {number} numImages - Number of images to collect
   * @param {string} [prefix] - Log line prefix (e.g. "[Camera 1/2] ")
   * @returns {Promise<boolean>} True if aborted early, false if completed normally
   */
  async collectImages(numImages, prefix = '') {
    let currentDelay = this.delayBetweenImageFetches;
    const maxDelay = this.delayBetweenImageFetches * 4;
    const collectionStart = Date.now();

    for (let i = 0; i < numImages; i++) {
      const countBefore = this.uniqueImageCount;
      await this.downloadImage(i);
      const wasUnique = this.uniqueImageCount > countBefore;
      if (wasUnique) {
        if (this.consecutiveDuplicates > 0) {
          console.log(`${prefix}${this.consecutiveDuplicates} duplicate(s) skipped`);
        }
        this.consecutiveDuplicates = 0;
      } else {
        this.consecutiveDuplicates++;
      }

      if (i >= 4 && this.shouldAbort()) {
        return true;
      }

      if (i < numImages - 1) {
        if (!wasUnique) {
          const newDelay = Math.min(Math.round(currentDelay * 1.5), maxDelay);
          if (newDelay !== currentDelay) {
            console.log(`${prefix}Duplicate image, increasing interval to ${newDelay / 1000}s`);
            currentDelay = newDelay;
          }
        } else {
          currentDelay = Math.max(this.delayBetweenImageFetches, Math.round(currentDelay / 1.5));
        }

        if (Date.now() - collectionStart + currentDelay > this.maxImageCollectionMs) {
          console.log(`${prefix}Max collection time reached after ${i + 1} images, stopping early`);
          return false;
        }

        await this.sleep(currentDelay);
      }
    }
    const totalImages = numImages;
    const duplicates = totalImages - this.uniqueImageCount;
    if (duplicates > 0) {
      console.log(`${prefix}${this.uniqueImageCount}/${totalImages} unique images (${duplicates} duplicate${duplicates === 1 ? '' : 's'} skipped)`);
    }
    return false;
  }

  /**
   * Calculate the ffmpeg setpts factor to target a consistent output duration.
   * Speed is capped at 8x to avoid unwatchably fast video.
   * @param {number} captureDurationS - Raw capture duration in seconds
   * @returns {string} setpts factor string (e.g. "0.250000")
   */
  getSetpts(captureDurationS) {
    const MIN_SPEED = 2;
    const MAX_SPEED = 32;
    const speed = Math.max(MIN_SPEED, Math.min(captureDurationS / this.targetOutputSeconds, MAX_SPEED));
    this.videoSpeedFactor = Math.round(speed);
    return (1 / speed).toFixed(6);
  }

  /**
   * Create a video from downloaded images using ffmpeg.
   * Renames images sequentially and generates an MP4.
   * @returns {Promise<void>}
   */
  async createVideo() {
    console.log(`Generating video from ${this.uniqueImageCount} images...`);

    const files = Fs.readdirSync(this.assetDirectory)
      .filter(f => f.startsWith('camera-') && f.endsWith('.jpg'))
      .sort((a, b) => {
        const numA = parseInt(a.match(/camera-(\d+)\.jpg/)[1]);
        const numB = parseInt(b.match(/camera-(\d+)\.jpg/)[1]);
        return numA - numB;
      });

    files.forEach((file, index) => {
      const oldPath = `${this.assetDirectory}${file}`;
      const newPath = `${this.assetDirectory}seq-${index}.jpg`;
      Fs.renameSync(oldPath, newPath);
    });

    const cmd = `ffmpeg -y -framerate ${this.framerate} -i ${this.assetDirectory}seq-%d.jpg -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p ${this.pathToVideo}`;

    await new Promise((resolve, reject) => {
      exec(cmd, (error, stdout, stderr) => {
        if (error) return reject(error);
        resolve();
      });
    });

    const stats = Fs.statSync(this.pathToVideo);
    const fileSizeInMB = stats.size / (1024 * 1024);
    console.log(`Video generated: ${fileSizeInMB.toFixed(2)} MB (${this.uniqueImageCount} images)`);
  }

  /**
   * Get the aspect ratio of the generated video using ffprobe.
   * @returns {Promise<{width: number, height: number}>}
   */
  async getAspectRatio() {
    return new Promise((resolve, reject) => {
      const cmd = `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 ${this.pathToVideo}`;
      exec(cmd, (error, stdout, stderr) => {
        if (error) return reject(error);
        const [width, height] = stdout.trim().split(',').map(Number);
        resolve({ width, height });
      });
    });
  }


  /**
   * Find a camera on or near a given highway (e.g. "I-75").
   * First tries name-based matching (free), then geocoding fallback.
   * @param {string} highway - e.g. "I-75"
   * @returns {Promise<Camera|null>}
   */
  async fetchAllCameras(_highway) {
    return this.fetchCameras();
  }

  async findCameraOnHighway(highway) {
    const cameras = await this.fetchAllCameras(highway);
    if (cameras.length === 0) return null;

    // Build name-matching patterns based on highway type
    let patterns;
    if (/^US-/i.test(highway)) {
      // US numbered routes: "US-1", "US-101", etc.
      const num = highway.replace(/^US-/i, '');
      patterns = [
        new RegExp(`\\bUS-${num}\\b`, 'i'),
        new RegExp(`\\bUS ${num}\\b`, 'i'),
        new RegExp(`\\bUS${num}\\b`, 'i'),
        new RegExp(`\\bUS[- ]?Hwy[- ]?${num}\\b`, 'i'),
        new RegExp(`\\bUS[- ]?Highway[- ]?${num}\\b`, 'i'),
        new RegExp(`\\bUS[- ]?Route[- ]?${num}\\b`, 'i'),
        new RegExp(`\\bRoute ${num}\\b`, 'i'),
        new RegExp(`\\bHwy ${num}\\b`, 'i'),
      ];
    } else {
      // Interstate: "I-75", "I-10", etc.
      const num = highway.replace(/^I-?/i, '');
      patterns = [
        new RegExp(`\\bI-${num}\\b`, 'i'),
        new RegExp(`\\bI ${num}\\b`, 'i'),
        new RegExp(`\\bI${num}\\b`, 'i'),
        new RegExp(`\\bInterstate ${num}\\b`, 'i'),
        new RegExp(`\\bIH-?\\s*0*${num}\\b`, 'i'),  // Texas: "IH 10", "IH0010", "IH-10"
      ];
    }

    // Pass 1: camera name or route field contains the highway
    const byName = cameras.filter(c => patterns.some(p => p.test(c.name) || (c.route && p.test(c.route))));
    if (byName.length > 0) {
      console.log(`Found ${byName.length} cameras matching ${highway} by name`);
      return _.sample(byName);
    }

    console.log(`No camera found on ${highway}`);
    return null;
  }

  /**
   * Map a WMO weather interpretation code to a human-readable description.
   * @param {number} code - WMO weather code
   * @returns {string}
   */
  getWeatherDescription(code) {
    if (code === 0) return 'Clear';
    if (code === 1) return 'Mostly Clear';
    if (code === 2) return 'Partly Cloudy';
    if (code === 3) return 'Overcast';
    if (code === 45 || code === 48) return 'Foggy';
    if (code >= 51 && code <= 55) return 'Drizzle';
    if (code >= 61 && code <= 65) return 'Rain';
    if (code >= 71 && code <= 77) return 'Snow';
    if (code >= 80 && code <= 82) return 'Rain Showers';
    if (code >= 85 && code <= 86) return 'Snow Showers';
    if (code === 95) return 'Thunderstorm';
    if (code >= 96) return 'Severe Thunderstorm';
    return 'Unknown';
  }

  /**
   * Fetch current weather conditions from Open-Meteo (free, no API key required).
   * @param {number} lat
   * @param {number} lon
   * @returns {Promise<{tempF: number, description: string}>}
   */
  async fetchWeather(lat, lon) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&temperature_unit=fahrenheit`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Weather API returned ${response.status}`);
    const data = await response.json();
    const { temperature_2m: tempF, weather_code: code } = data.current;
    return { tempF, description: this.getWeatherDescription(code) };
  }

  /**
   * Build accessibility alt text for the video post.
   * @param {string|null} geocodedLocation - e.g. "Columbus, Ohio"
   * @param {{tempF: number, description: string}|null} weather
   * @returns {string}
   */
  buildAltText(weatherStart, weatherEnd) {
    const type = this.is24HourTimelapse ? '24-hour traffic camera timelapse' : 'Traffic camera footage';
    let text = `${type} of ${this.chosenCamera.name}`;
    if (this.startTime && this.endTime) {
      const formatTime = (date) => date.toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit', hour12: true, timeZone: this.timezone,
      });
      text += `, recorded ${formatTime(this.startTime)}-${formatTime(this.endTime)} ${this.tzAbbrev}`;
    }
    if (weatherStart) {
      const end = weatherEnd;
      const tempChanged = end && Math.abs(end.tempF - weatherStart.tempF) >= 3;
      const descChanged = end && end.description !== weatherStart.description;
      if (tempChanged || descChanged) {
        text += `. Weather: ${weatherStart.description}→${end.description}, ${Math.round(weatherStart.tempF)}→${Math.round(end.tempF)}F`;
      } else {
        text += `. Weather: ${weatherStart.description}, ${Math.round(weatherStart.tempF)}F`;
      }
    }
    text += '.';
    return text;
  }

  /**
   * Upload the video to Bluesky and create a post.
   * Handles weather overlay, video upload, processing, and post creation with
   * camera name, time range, optional location link, and accessibility alt text.
   * @returns {Promise<void>}
   */
  async postToBluesky(replyRef = null, titleOverride = null) {
    const hasCoordinates = this.chosenCamera.latitude !== 0 && this.chosenCamera.longitude !== 0;

    // Use weather captured during recording; fall back to a fresh fetch for video bots
    // that override run() and don't set weatherStart/weatherEnd.
    if (!this.weatherStart && hasCoordinates) {
      try {
        this.weatherStart = await this.fetchWeather(this.chosenCamera.latitude, this.chosenCamera.longitude);
      } catch (err) {
        console.log('Weather fetch failed:', err.message);
      }
    }

    if (this.weatherStart) {
      const w = this.weatherStart;
      console.log(`Weather: ${Math.round(w.tempF)}°F, ${w.description}`);
    }

    const videoBuffer = Fs.readFileSync(this.pathToVideo);
    const stats = Fs.statSync(this.pathToVideo);
    const fileSizeInMB = stats.size / (1024 * 1024);

    console.log(`Uploading video (${fileSizeInMB.toFixed(2)} MB)...`);
    const uploadStart = Date.now();

    const { data: serviceAuth } = await this.agent.com.atproto.server.getServiceAuth({
      aud: `did:web:${this.agent.dispatchUrl.host}`,
      lxm: 'com.atproto.repo.uploadBlob',
      exp: Math.floor(Date.now() / 1000) + 60 * 30,
    });

    const token = serviceAuth.token;

    const uploadUrl = new URL('https://video.bsky.app/xrpc/app.bsky.video.uploadVideo');
    uploadUrl.searchParams.append('did', this.agent.session.did);
    uploadUrl.searchParams.append('name', 'camera.mp4');

    let uploadResponse;
    for (let attempt = 1; attempt <= 3; attempt++) {
      uploadResponse = await fetch(uploadUrl.toString(), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'video/mp4',
          'Content-Length': stats.size.toString(),
        },
        body: videoBuffer,
      });
      if (uploadResponse.ok) break;
      const errBody = await uploadResponse.json().catch(() => ({}));
      if (attempt < 3) {
        console.log(`Upload attempt ${attempt} failed (${uploadResponse.status}), retrying...`);
        await this.sleep(1000 * attempt);
      } else {
        throw new Error(`Video upload failed after 3 attempts: ${JSON.stringify(errBody)}`);
      }
    }

    const uploadElapsed = ((Date.now() - uploadStart) / 1000).toFixed(1);
    console.log(`Upload complete in ${uploadElapsed}s`);

    const jobStatus = await uploadResponse.json();

    let blob = jobStatus.blob;
    const videoServiceAgent = new AtpAgent({ service: keys.videoService });
    let lastLoggedState = null;
    let pollAttempts = 0;
    const MAX_POLL_ATTEMPTS = 150; // 5 minutes at 2s intervals

    while (!blob) {
      if (++pollAttempts > MAX_POLL_ATTEMPTS) {
        throw new Error('Video processing timed out after 5 minutes');
      }
      await this.sleep(2000);

      try {
        const { data: status } = await videoServiceAgent.app.bsky.video.getJobStatus({
          jobId: jobStatus.jobId,
        });

        const state = status.jobStatus.state;
        const progress = status.jobStatus.progress;

        const stateLabel = {
          JOB_STATE_CREATED: 'Queued',
          JOB_STATE_ENCODING: 'Encoding',
          JOB_STATE_SCANNING: 'Scanning',
          JOB_STATE_SCANNED: 'Scanned',
          JOB_STATE_COMPLETED: 'Complete',
          JOB_STATE_FAILED: 'Failed',
        }[state] || state;

        const logLine = progress ? `${stateLabel}: ${progress}%` : stateLabel;
        if (logLine !== lastLoggedState) {
          console.log(logLine);
          lastLoggedState = logLine;
        }

        if (status.jobStatus.blob) {
          blob = status.jobStatus.blob;
        } else if (state === 'JOB_STATE_FAILED') {
          throw new Error(`Video processing failed: ${status.jobStatus.error || 'Unknown error'}`);
        }
      } catch (error) {
        if (error.message && error.message.includes('already_exists')) {
          blob = error.blob || jobStatus.blob;
          break;
        }
        throw error;
      }
    }

    const aspectRatio = await this.getAspectRatio();

    const formatTime = (date) => {
      return date.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: this.timezone
      });
    };

    const timeRange = `${formatTime(this.startTime)} - ${formatTime(this.endTime)} ${this.tzAbbrev}`;
    const speedSuffix = this.videoSpeedFactor ? ` (${this.videoSpeedFactor}x speed)` : '';
    const eventPrefix = this.sunEvent === 'sunrise' ? 'Sunrise: ' : this.sunEvent === 'sunset' ? 'Sunset: ' : '';
    const clockEmoji = this.sunEvent === 'sunrise' ? '🌅' : this.sunEvent === 'sunset' ? '🌇' : '🕒';
    const timeLabel = this.is24HourTimelapse ? `24-Hour Timelapse: ${timeRange}${speedSuffix}` : `${eventPrefix}${timeRange}${speedSuffix}`;

    let postText;
    let facets = [];

    let weatherLine = '';
    if (this.weatherStart) {
      const start = this.weatherStart;
      const end = this.weatherEnd;
      const tempChanged = end && Math.abs(end.tempF - start.tempF) >= 3;
      const descChanged = end && end.description !== start.description;
      if (tempChanged || descChanged) {
        const tempStr = `${Math.round(start.tempF)}→${Math.round(end.tempF)}°F`;
        const descStr = descChanged ? `${start.description}→${end.description}` : start.description;
        weatherLine = `\n🌡️ ${tempStr} | ${descStr}`;
      } else {
        weatherLine = `\n🌡️ ${Math.round(start.tempF)}°F | ${start.description}`;
      }
    }

    if (hasCoordinates) {
      const lat = this.chosenCamera.latitude.toFixed(6);
      const lon = this.chosenCamera.longitude.toFixed(6);
      const googleMapsUrl = `https://www.google.com/maps?q=${lat},${lon}`;
      const coordinates = `${lat},${lon}`;

      let postTitle = titleOverride || this.chosenCamera.name;

      postText = `${postTitle}\n${clockEmoji} ${timeLabel}${weatherLine}\n\n📍: ${coordinates}`;

      const byteStart = Buffer.from(`${postTitle}\n${clockEmoji} ${timeLabel}${weatherLine}\n\n📍: `).length;
      const byteEnd = byteStart + Buffer.from(coordinates).length;

      facets = [
        {
          index: {
            byteStart: byteStart,
            byteEnd: byteEnd,
          },
          features: [
            {
              $type: 'app.bsky.richtext.facet#link',
              uri: googleMapsUrl,
            },
          ],
        },
      ];
    } else {
      const noCoordTitle = titleOverride || this.chosenCamera.name;
      postText = `${noCoordTitle}\n${clockEmoji} ${timeLabel}${weatherLine}`;
    }

    const altText = this.buildAltText(this.weatherStart, this.weatherEnd);

    const result = await this.agent.post({
      text: postText,
      ...(facets.length > 0 && { facets }),
      ...(replyRef && { reply: replyRef }),
      embed: {
        $type: 'app.bsky.embed.video',
        video: blob,
        aspectRatio: aspectRatio,
        alt: altText,
      },
    });

    const rkey = result.uri.split('/').pop();
    const did = result.uri.split('/')[2];
    const postUrl = `https://bsky.app/profile/${did}/post/${rkey}`;
    console.log(`Posted video to Bluesky successfully: ${postUrl}`);
    return { uri: result.uri, cid: result.cid };
  }

  /**
   * Load the list of recently posted camera IDs for this state.
   * @returns {string[]}
   */
  getRecentCameraIds() {
    const path = `./cron/${this.accountName}-recent.json`;
    try {
      return JSON.parse(Fs.readFileSync(path, 'utf8'));
    } catch {
      return [];
    }
  }

  /**
   * Prepend a camera ID to the recent list, capped at 20 entries.
   * @param {string|number} id
   */
  saveRecentCameraId(id) {
    const path = `./cron/${this.accountName}-recent.json`;
    const recent = this.getRecentCameraIds();
    const updated = [String(id), ...recent.filter(r => r !== String(id))].slice(0, 48);
    Fs.ensureDirSync('./cron');
    Fs.writeFileSync(path, JSON.stringify(updated));
  }

  /**
   * Remove stale asset directories from previous runs of this bot.
   * Called at startup to clean up after crashed or killed processes.
   * Only removes directories not modified in the last hour to avoid
   * interfering with concurrently running instances.
   */
  cleanupStaleAssets() {
    const assetsDir = './assets';
    if (!Fs.existsSync(assetsDir)) return;

    const prefix = this.accountName + '-';
    const staleThreshold = 60 * 60 * 1000; // 1 hour
    const now = Date.now();

    const dirs = Fs.readdirSync(assetsDir)
      .filter(d => d.startsWith(prefix) && Fs.statSync(Path.join(assetsDir, d)).isDirectory());

    for (const dir of dirs) {
      const fullPath = Path.join(assetsDir, dir);
      try {
        const stat = Fs.statSync(fullPath);
        if (now - stat.mtimeMs > staleThreshold) {
          Fs.removeSync(fullPath);
          console.log(`Cleaned up stale assets: ${dir}`);
        }
      } catch (err) {
        console.error(`Failed to clean up ${fullPath}:`, err.message);
      }
    }
  }

  /**
   * Remove the temporary asset directory.
   * Skipped if --persist flag is passed.
   */
  cleanup() {
    if (argv.persist === true) return;

    try {
      if (Fs.existsSync(this.assetDirectory)) {
        Fs.removeSync(this.assetDirectory);
        console.log('Assets cleaned up');
      }
    } catch (err) {
      console.error(`Failed to cleanup ${this.assetDirectory}:`, err.message);
    }
  }

  // ─── Stream URL helpers ───────────────────────────────────────────────────

  async get511DotSession(cctvUrl) {
    const hostname = new URL(cctvUrl).hostname;
    console.log(`Fetching session from ${hostname}...`);
    const response = await Axios.get(cctvUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
      },
      maxRedirects: 5,
      timeout: 15000,
    });
    const setCookies = response.headers['set-cookie'] || [];
    const cookieString = setCookies.map(c => c.split(';')[0]).join('; ');
    const tokenMatch = response.data.match(
      /<input[^>]*name="__RequestVerificationToken"[^>]*value="([^"]+)"/
    );
    if (!tokenMatch) throw new Error('Could not find verification token in page');
    return { cookies: cookieString, token: tokenMatch[1] };
  }

  async getEarthCamStreamUrl(fecnetworkId, pageUrl) {
    console.log(`Fetching EarthCam stream URL for fecnetwork ${fecnetworkId}...`);
    const response = await Axios.get(pageUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36' },
      timeout: 15000,
    });
    const match = response.data.match(new RegExp(`"html5_streampath":"(\\\\/fecnetwork\\\\/${fecnetworkId}[^"]+)"`));
    if (!match) throw new Error(`Could not find stream URL for fecnetwork ID ${fecnetworkId}`);
    const path = match[1].replace(/\\\//g, '/');
    return `https://videos-3.earthcam.com${path}`;
  }

  async getEarthCamNetStreamUrl(shareApiClient, shareApiContext) {
    console.log(`Fetching EarthCam.net stream URL for ${shareApiContext}...`);
    const response = await Axios.get(`https://share.earthcam.net/api/${shareApiClient}/${shareApiContext}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
        'Referer': 'https://share.earthcam.net/',
      },
      timeout: 15000,
    });
    const stream = response.data?.views?.[0]?.live?.regular?.stream;
    if (!stream) throw new Error(`No stream URL found for EarthCam.net context ${shareApiContext}`);
    return stream;
  }

  async getYouTubeStreamUrl(youtubeId) {
    console.log(`Fetching YouTube stream URL for ${youtubeId}...`);
    return new Promise((resolve, reject) => {
      exec(`yt-dlp -g --format "best[ext=mp4]/best" "https://www.youtube.com/watch?v=${youtubeId}"`, { timeout: 30000 }, (error, stdout) => {
        if (error) return reject(new Error(`yt-dlp failed: ${error.message}`));
        const url = stdout.trim().split('\n')[0];
        if (!url) return reject(new Error('yt-dlp returned no URL'));
        resolve(url);
      });
    });
  }

  async getWetMetStreamUrl(uid) {
    console.log(`Fetching WetMet stream URL for ${uid}...`);
    const response = await Axios.get(`https://api.wetmet.net/widgets/stream/frame.php?uid=${uid}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36' },
      timeout: 15000,
    });
    const match = response.data.match(/var vurl = '([^']+)'/);
    if (!match) throw new Error(`Could not find stream URL for WetMet uid ${uid}`);
    return match[1];
  }

  async getOzolioStreamUrl(oid) {
    console.log(`Fetching Ozolio stream URL for ${oid}...`);
    const initResp = await Axios.get(`https://relay.ozolio.com/ses.api?cmd=init&oid=${oid}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36' },
      timeout: 15000,
    });
    const sessionId = initResp.data?.session?.id;
    if (!sessionId) throw new Error(`Could not get Ozolio session for ${oid}`);
    const openResp = await Axios.get(`https://relay.ozolio.com/ses.api?cmd=open&oid=${sessionId}&output=1&format=M3U8`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36' },
      timeout: 15000,
    });
    const streamUrl = openResp.data?.output?.source;
    if (!streamUrl) throw new Error(`Could not get Ozolio stream URL for ${oid}`);
    return streamUrl;
  }

  // ─────────────────────────────────────────────────────────────────────────

  /**
   * List all available cameras and exit.
   * @returns {Promise<void>}
   */
  async listCameras() {
    const cameras = await this.fetchCameras();
    if (cameras.length === 0) {
      console.error('No cameras available');
      return;
    }

    console.log(`\nAvailable cameras (${cameras.length}):\n`);
    cameras.forEach(cam => {
      const coords = (cam.latitude && cam.longitude)
        ? ` (${cam.latitude}, ${cam.longitude})`
        : '';
      console.log(`  ${cam.id}`);
      console.log(`    ${cam.name}${coords}\n`);
    });
  }

  /**
   * Main entry point. Runs the full bot workflow:
   * 1. Login to Bluesky
   * 2. Fetch and select a camera
   * 3. Download images over time
   * 4. Create timelapse video
   * 5. Post to Bluesky
   * 6. Cleanup temp files
   *
   * Supports flags:
   * - --list: List available cameras and exit
   * - --dry-run: Do everything except post to Bluesky
   * - --persist: Keep the assets folder after completion
   * - --id <id>: Use a specific camera instead of random
   *
   * Handles errors and sets process.exitCode on failure.
   * @returns {Promise<void>}
   */
  async run() {
    if (argv.list) {
      try {
        await this.listCameras();
      } catch (error) {
        console.error(error);
        process.exitCode = 1;
      }
      return;
    }

    this.cleanupStaleAssets();

    const runStart = Date.now();

    try {
      const account = keys.accounts[this.accountName];
      if (!account) {
        throw new Error(`Account '${this.accountName}' not found in keys.js`);
      }

      this.agent = new AtpAgent({ service: keys.service });
      await this.agent.login({
        identifier: account.identifier,
        password: account.password,
      });

      if (!this.agent.session?.did) {
        console.error('Failed to get DID after login');
        process.exitCode = 1;
        return;
      }

      console.log(`Logged in as @${account.identifier}`);

      const cameras = await this.fetchCameras();
      if (cameras.length === 0) {
        console.error('No cameras available');
        process.exitCode = 1;
        return;
      }

      const isThread = !argv.id && !argv['dry-run'] && this.threadProbability > 0 && Math.random() < this.threadProbability;
      const threadCount = isThread ? _.sample([2, 3]) : 1;

      if (threadCount > 1) {
        console.log(`[Thread] Starting ${threadCount}-camera thread`);
      }

      const recentIds = this.getRecentCameraIds();
      const usedCameraIds = new Set();
      let threadRoot = null;
      let threadParent = null;
      let anySuccess = false;

      for (let camIdx = 0; camIdx < threadCount; camIdx++) {
        const prefix = threadCount > 1 ? `[Camera ${camIdx + 1}/${threadCount}] ` : '';

        // Reset per-camera state
        this.imageHashes = new Set();
        this.uniqueImageCount = 0;
        this.consecutiveDuplicates = 0;
        this.assetDirectory = `./assets/${this.accountName}-${uuidv4()}/`;
        this.pathToVideo = `${this.assetDirectory}camera.mp4`;
        this.weatherStart = null;
        this.weatherEnd = null;
        this.startTime = null;
        this.endTime = null;
        this.chosenCamera = null;
        this.videoSpeedFactor = null;

        try {
          // Camera selection
          if (!_.isUndefined(argv.id)) {
            this.chosenCamera = _.find(cameras, c => c.id == argv.id);
          } else {
            const freshCameras = cameras.filter(c =>
              !recentIds.includes(String(c.id)) && !usedCameraIds.has(String(c.id))
            );
            const pool = freshCameras.length > 0 ? freshCameras : cameras.filter(c => !usedCameraIds.has(String(c.id)));
            this.chosenCamera = _.sample(pool);
          }

          if (!this.chosenCamera) {
            console.error(`${prefix}Could not select a camera`);
            process.exitCode = 1;
            continue;
          }

          usedCameraIds.add(String(this.chosenCamera.id));
          this.saveRecentCameraId(this.chosenCamera.id);

          console.log(`${prefix}ID ${this.chosenCamera.id}: ${this.chosenCamera.name}`);
          Fs.ensureDirSync(this.assetDirectory);

          this.startTime = new Date();

          if (this.chosenCamera.hasVideo) {
            const duration = _.sample(this.getDurationOptions());
            // On stream failure, try up to 3 different cameras (only when auto-selecting)
            const maxVideoRetries = _.isUndefined(argv.id) ? 3 : 1;
            for (let vAttempt = 1; vAttempt <= maxVideoRetries; vAttempt++) {
              try {
                await this.downloadVideoSegment(duration);
                break;
              } catch (e) {
                if (vAttempt === maxVideoRetries) throw e;
                console.log(`${prefix}Stream failed for ${this.chosenCamera.id}, trying another camera...`);
                this.cleanup();
                this.assetDirectory = `./assets/${this.accountName}-${uuidv4()}/`;
                this.pathToVideo = `${this.assetDirectory}camera.mp4`;
                const remaining = cameras.filter(c => c.hasVideo && !usedCameraIds.has(String(c.id)));
                this.chosenCamera = _.sample(remaining.length > 0 ? remaining : cameras.filter(c => c.hasVideo));
                usedCameraIds.add(String(this.chosenCamera.id));
                this.saveRecentCameraId(this.chosenCamera.id);
                console.log(`${prefix}ID ${this.chosenCamera.id}: ${this.chosenCamera.name}`);
                Fs.ensureDirSync(this.assetDirectory);
              }
            }
          } else {
            if (this.chosenCamera.latitude !== 0 && this.chosenCamera.longitude !== 0) {
              try {
                this.weatherStart = await this.fetchWeather(this.chosenCamera.latitude, this.chosenCamera.longitude);
                console.log(`${prefix}Weather: ${Math.round(this.weatherStart.tempF)}°F, ${this.weatherStart.description}`);
              } catch (err) {
                console.log(`${prefix}Weather fetch failed: ${err.message}`);
              }
            }

            const numImages = this.getNumImages();
            console.log(`${prefix}Downloading ${numImages} images every ${this.delayBetweenImageFetches / 1000}s...`);

            const aborted = await this.collectImages(numImages, prefix);

            if (this.weatherStart) {
              try {
                this.weatherEnd = await this.fetchWeather(this.chosenCamera.latitude, this.chosenCamera.longitude);
              } catch (err) {
                // End weather is best-effort; no need to log failure
              }
            }

            if (aborted || this.uniqueImageCount < 2) {
              console.log(`${prefix}Only ${this.uniqueImageCount} unique image(s) captured, skipping`);
              if (threadCount === 1) process.exitCode = 1;
              continue;
            }

            await this.createVideo();
          }

          this.endTime = new Date();

          if (argv['dry-run']) {
            console.log(`${prefix}Dry run - skipping post to Bluesky`);
            anySuccess = true;
          } else {
            const replyRef = threadRoot ? { root: threadRoot, parent: threadParent } : null;
            const postResult = await this.postToBluesky(replyRef);
            if (!threadRoot) threadRoot = postResult;
            threadParent = postResult;
            anySuccess = true;
          }
        } catch (error) {
          console.error(`${prefix}Error: ${error.message}`);
          if (error.stack) console.error(error.stack);
        } finally {
          this.cleanup();
        }
      }

      if (!anySuccess) {
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    } finally {
      const elapsedMs = Date.now() - runStart;
      const elapsedMin = Math.floor(elapsedMs / 60000);
      const elapsedSec = Math.round((elapsedMs % 60000) / 1000);
      const elapsedStr = elapsedMin > 0 ? `${elapsedMin}m ${elapsedSec}s` : `${elapsedSec}s`;
      console.log(`Done in ${elapsedStr}`);
    }
  }
}

TrafficBot.DEFAULT_DURATION_OPTIONS = [60, 90, 120, 180, 240, 360, 480, 960];

module.exports = TrafficBot;
