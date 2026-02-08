const keys = require('./keys.js');

const Path = require('path');
const Fs = require('fs-extra');
const _ = require('lodash');
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');
const { AtpAgent } = require('@atproto/api');
const argv = require('minimist')(process.argv.slice(2));
const crypto = require('crypto');

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
    this.assetDirectory = `./${this.accountName}-assets-${uuidv4()}/`;
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
   * Check if an image is a duplicate and store it if unique.
   * Automatically deletes duplicate images.
   * @param {string} filePath - Path to the downloaded image
   * @param {number} index - Image index (for logging)
   * @returns {boolean} True if image was unique and stored, false if duplicate
   */
  checkAndStoreImage(filePath, index) {
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

    const cmd = `ffmpeg -y -framerate ${this.framerate} -i ${this.assetDirectory}seq-%d.jpg -c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p ${this.pathToVideo}`;

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
   * Upload the video to Bluesky and create a post.
   * Handles video upload, processing, and post creation with
   * camera name, time range, and optional location link.
   * @returns {Promise<void>}
   */
  async postToBluesky() {
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

    let postText;
    let facets = [];

    const hasCoordinates = this.chosenCamera.latitude !== 0 && this.chosenCamera.longitude !== 0;
    const timeLabel = this.is24HourTimelapse ? `24-Hour Timelapse: ${timeRange}` : timeRange;

    if (hasCoordinates) {
      const googleMapsUrl = `https://www.google.com/maps?q=${this.chosenCamera.latitude},${this.chosenCamera.longitude}`;
      const coordinates = `${this.chosenCamera.latitude},${this.chosenCamera.longitude}`;
      postText = `${this.chosenCamera.name}\n🕒 ${timeLabel}\n\n📍: ${coordinates}`;

      const byteStart = Buffer.from(`${this.chosenCamera.name}\n🕒 ${timeLabel}\n\n📍: `).length;
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
      postText = `${this.chosenCamera.name}\n🕒 ${timeLabel}`;
    }

    await this.agent.post({
      text: postText,
      ...(facets.length > 0 && { facets }),
      embed: {
        $type: 'app.bsky.embed.video',
        video: blob,
        aspectRatio: aspectRatio,
      },
    });

    console.log('Posted video to Bluesky successfully');
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
        return;
      }

      const cameras = await this.fetchCameras();
      if (cameras.length === 0) {
        console.error('No cameras available');
        return;
      }

      if (!_.isUndefined(argv.id)) {
        this.chosenCamera = _.find(cameras, { id: argv.id });
      } else {
        this.chosenCamera = _.sample(cameras);
      }

      if (!this.chosenCamera) {
        console.error('Could not select a camera');
        return;
      }

      console.log(`ID ${this.chosenCamera.id}: ${this.chosenCamera.name}`);
      Fs.ensureDirSync(this.assetDirectory);

      this.startTime = new Date();
      const numImages = this.getNumImages();
      console.log(`Downloading traffic camera images. ${numImages} images...`);

      for (let i = 0; i < numImages; i++) {
        await this.downloadImage(i);
        if (i < numImages - 1) await this.sleep(this.delayBetweenImageFetches);
      }

      if (this.shouldAbort()) {
        return;
      }

      this.endTime = new Date();

      console.log('Download complete');
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
