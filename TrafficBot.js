const keys = require('./keys.js');

const Path = require('path');
const Fs = require('fs-extra');
const _ = require('lodash');
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');
const { AtpAgent } = require('@atproto/api');
const argv = require('minimist')(process.argv.slice(2));
const crypto = require('crypto');
const GoogleMapsAPI = require('googlemaps');

const gmAPI = new GoogleMapsAPI({ key: keys.googleKey });

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
    /** @type {boolean} */
    this.is24HourTimelapse = config.is24HourTimelapse || false;

    /** @type {string} */
    this.assetDirectory = `./assets/${this.accountName}-${uuidv4()}/`;
    /** @type {string} */
    this.pathToVideo = `${this.assetDirectory}camera.mp4`;
    /** @type {Set<string>} */
    this.imageHashes = new Set();
    /** @type {number} */
    this.uniqueImageCount = 0;
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
   * Download a single image from the chosen camera.
   * Must be implemented by subclasses.
   * Use this.getImagePath(index) for the save location.
   * Use this.checkAndStoreImage(path, index) to handle deduplication.
   * @abstract
   * @param {number} index - Image index (0-based)
   * @returns {Promise<boolean>} True if image was unique, false if duplicate
   */
  async downloadImage(index) {
    throw new Error('downloadImage() must be implemented');
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
   * @returns {boolean} True to abort (skip video creation and posting)
   */
  shouldAbort() {
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
      console.log(`Skipping duplicate image ${index}`);
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
   * Create a video from downloaded images using ffmpeg.
   * Renames images sequentially and generates an MP4.
   * @returns {Promise<void>}
   */
  async createVideo() {
    console.log('Generating video...');

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

    const cmd = `ffmpeg -y -framerate ${this.framerate} -i ${this.assetDirectory}seq-%d.jpg -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" -c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p ${this.pathToVideo}`;

    await new Promise((resolve, reject) => {
      exec(cmd, (error, stdout, stderr) => {
        if (error) return reject(error);
        resolve();
      });
    });

    const stats = Fs.statSync(this.pathToVideo);
    const fileSizeInMB = stats.size / (1024 * 1024);
    console.log(`Video generated: ${this.pathToVideo} (${fileSizeInMB.toFixed(2)} MB)`);
    console.log(`Total unique images: ${this.uniqueImageCount}`);
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
   * Reverse geocode coordinates to a human-readable location name.
   * Returns a string like "Columbus, Ohio" or null on failure.
   * @param {number} lat
   * @param {number} lon
   * @returns {Promise<string|null>}
   */
  /**
   * Reverse geocode coordinates to structured location info.
   * Scans all results to extract road name, city, and state.
   * @param {number} lat
   * @param {number} lon
   * @returns {Promise<{route: string|null, location: string|null}>}
   */
  async reverseGeocode(lat, lon) {
    const params = { latlng: `${lat},${lon}` };

    const result = await new Promise((resolve, reject) => {
      gmAPI.reverseGeocode(params, (err, data) => err ? reject(err) : resolve(data));
    });

    if (!result?.results?.length) return { route: null, location: null };

    let route = null;
    let locality = null;
    let sublocality = null;
    let county = null;
    let area = null;

    for (const r of result.results) {
      for (const comp of r.address_components) {
        if (!route && comp.types.includes('route')) route = comp.short_name || comp.long_name;
        if (!locality && comp.types.includes('locality')) locality = comp.long_name;
        if (!sublocality && comp.types.includes('sublocality')) sublocality = comp.long_name;
        if (!county && comp.types.includes('administrative_area_level_2')) county = comp.long_name;
        if (!area && comp.types.includes('administrative_area_level_1')) area = comp.long_name;
      }
    }

    const city = locality || sublocality || county || null;
    const location = city && area ? `${city}, ${area}` : (area || null);
    return { route, city, location };
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
  buildAltText(geocodedLocation, weatherStart, weatherEnd) {
    const type = this.is24HourTimelapse ? '24-hour traffic camera timelapse' : 'Traffic camera footage';
    let text = `${type} of ${this.chosenCamera.name}`;
    if (geocodedLocation) text += ` in ${geocodedLocation}`;
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
  async postToBluesky() {
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

    console.log('Uploading video to Bluesky...');

    const videoBuffer = Fs.readFileSync(this.pathToVideo);
    const stats = Fs.statSync(this.pathToVideo);
    const fileSizeInMB = stats.size / (1024 * 1024);
    console.log(`Video file size: ${fileSizeInMB.toFixed(2)} MB`);

    const { data: serviceAuth } = await this.agent.com.atproto.server.getServiceAuth({
      aud: `did:web:${this.agent.dispatchUrl.host}`,
      lxm: 'com.atproto.repo.uploadBlob',
      exp: Math.floor(Date.now() / 1000) + 60 * 30,
    });

    const token = serviceAuth.token;

    const uploadUrl = new URL('https://video.bsky.app/xrpc/app.bsky.video.uploadVideo');
    uploadUrl.searchParams.append('did', this.agent.session.did);
    uploadUrl.searchParams.append('name', 'camera.mp4');

    console.log('Uploading to video service...');
    const uploadResponse = await fetch(uploadUrl.toString(), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'video/mp4',
        'Content-Length': stats.size.toString(),
      },
      body: videoBuffer,
    });

    if (!uploadResponse.ok) {
      const error = await uploadResponse.json();
      throw new Error(`Video upload failed: ${JSON.stringify(error)}`);
    }

    const jobStatus = await uploadResponse.json();
    console.log('Video uploaded, processing...');

    let blob = jobStatus.blob;
    const videoServiceAgent = new AtpAgent({ service: keys.videoService });

    while (!blob) {
      await this.sleep(1000);

      try {
        const { data: status } = await videoServiceAgent.app.bsky.video.getJobStatus({
          jobId: jobStatus.jobId,
        });

        console.log(`Processing: ${status.jobStatus.state}`, status.jobStatus.progress || '');

        if (status.jobStatus.blob) {
          blob = status.jobStatus.blob;
        } else if (status.jobStatus.state === 'JOB_STATE_FAILED') {
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

    console.log('Video processing complete!');

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
    const timeLabel = this.is24HourTimelapse ? `24-Hour Timelapse: ${timeRange}` : timeRange;

    let postText;
    let facets = [];
    let geocodedLocation = null;

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

      let postTitle = this.chosenCamera.name;
      try {
        const { route, city, location } = await this.reverseGeocode(this.chosenCamera.latitude, this.chosenCamera.longitude);
        geocodedLocation = location;
        if (route && city) postTitle = `${route}, ${city}`;
        else if (city) postTitle = city;
        else if (location) postTitle = location;
      } catch (err) {
        console.log('Reverse geocoding failed:', err.message);
      }

      postText = `${postTitle}\n🕒 ${timeLabel}${weatherLine}\n\n📍: ${coordinates}`;

      const byteStart = Buffer.from(`${postTitle}\n🕒 ${timeLabel}${weatherLine}\n\n📍: `).length;
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
      postText = `${this.chosenCamera.name}\n🕒 ${timeLabel}${weatherLine}`;
    }

    const altText = this.buildAltText(geocodedLocation, this.weatherStart, this.weatherEnd);

    await this.agent.post({
      text: postText,
      ...(facets.length > 0 && { facets }),
      embed: {
        $type: 'app.bsky.embed.video',
        video: blob,
        aspectRatio: aspectRatio,
        alt: altText,
      },
    });

    console.log('Posted video to Bluesky successfully');
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
          console.log(`Cleaned up stale asset directory: ${fullPath}`);
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
        console.log(`Removed ${this.assetDirectory}`);
      }
    } catch (err) {
      console.error(`Failed to cleanup ${this.assetDirectory}:`, err.message);
    }
  }

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
    // Handle --list flag (no login required)
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

      const cameras = await this.fetchCameras();
      if (cameras.length === 0) {
        console.error('No cameras available');
        process.exitCode = 1;
        return;
      }

      if (!_.isUndefined(argv.id)) {
        this.chosenCamera = _.find(cameras, c => c.id == argv.id);
      } else {
        const recentIds = this.getRecentCameraIds();
        const freshCameras = cameras.filter(c => !recentIds.includes(String(c.id)));
        this.chosenCamera = _.sample(freshCameras.length > 0 ? freshCameras : cameras);
      }

      if (!this.chosenCamera) {
        console.error('Could not select a camera');
        process.exitCode = 1;
        return;
      }

      this.saveRecentCameraId(this.chosenCamera.id);

      console.log(`ID ${this.chosenCamera.id}: ${this.chosenCamera.name}`);
      Fs.ensureDirSync(this.assetDirectory);

      this.startTime = new Date();

      if (this.chosenCamera.latitude !== 0 && this.chosenCamera.longitude !== 0) {
        try {
          this.weatherStart = await this.fetchWeather(this.chosenCamera.latitude, this.chosenCamera.longitude);
        } catch (err) {
          console.log('Weather fetch (start) failed:', err.message);
        }
      }

      const numImages = this.getNumImages();
      console.log(`Downloading ${numImages} images every ${this.delayBetweenImageFetches / 1000}s...`);

      let currentDelay = this.delayBetweenImageFetches;
      const maxDelay = this.delayBetweenImageFetches * 4;

      for (let i = 0; i < numImages; i++) {
        const countBefore = this.uniqueImageCount;
        await this.downloadImage(i);
        const wasUnique = this.uniqueImageCount > countBefore;

        if (i >= 9 && this.shouldAbort()) {
          return;
        }

        if (i < numImages - 1) {
          if (!wasUnique) {
            const newDelay = Math.min(Math.round(currentDelay * 1.5), maxDelay);
            if (newDelay !== currentDelay) {
              console.log(`Duplicate image, increasing interval to ${newDelay / 1000}s`);
              currentDelay = newDelay;
            }
          } else {
            currentDelay = this.delayBetweenImageFetches;
          }
          await this.sleep(currentDelay);
        }
      }

      this.endTime = new Date();

      if (this.weatherStart) {
        try {
          this.weatherEnd = await this.fetchWeather(this.chosenCamera.latitude, this.chosenCamera.longitude);
        } catch (err) {
          console.log('Weather fetch (end) failed:', err.message);
        }
      }

      console.log('Download complete');

      if (this.uniqueImageCount < 2) {
        console.log(`Only ${this.uniqueImageCount} unique image(s) captured. Skipping video creation.`);
        process.exitCode = 1;
        return;
      }

      await this.createVideo();

      if (argv['dry-run']) {
        console.log('Dry run - skipping post to Bluesky');
      } else {
        await this.postToBluesky();
      }
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    } finally {
      this.cleanup();
    }
  }
}

module.exports = TrafficBot;
