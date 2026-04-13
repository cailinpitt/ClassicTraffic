const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');
const { exec } = require('child_process');
const argv = require('minimist')(process.argv.slice(2));

const durationOptions = [60, 90, 120, 180, 240, 360, 480, 960];
const numImagesPerVideoOptions = [150, 300, 450, 600, 750, 900];

class MinnesotaBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'minnesota',
      timezone: 'America/Chicago',
      tzAbbrev: 'CT',
      framerate: 10,
      delayBetweenImageFetches: 6000,
    });
  }

  getImageUrl() { return `${this.chosenCamera.url}?t=${Date.now()}`; }
  getImageHeaders() { return { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36' }; }

  getNumImages() {
    return _.sample(numImagesPerVideoOptions);
  }

  async fetchCameras() {
    console.log('Fetching cameras from MnDOT...');

    try {
      const response = await Axios.get('https://mntg.carsprogram.org/cameras_v1/api/cameras', {
        headers: {
          'Accept': 'application/json',
          'Origin': 'https://511mn.org',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
        },
      });

      const cameras = response.data
        .filter(cam => (cam.active !== false) && cam.public && cam.views && cam.views.length > 0)
        .map(cam => {
          const view = cam.views[0];
          const isVideo = view.type === 'WMP';
          return {
            id: String(cam.id),
            name: cam.name,
            url: isVideo ? view.url : view.url,
            hasVideo: isVideo,
            latitude: cam.location?.latitude || 0,
            longitude: cam.location?.longitude || 0,
          };
        })
        .filter(cam => cam.url);

      const videoCount = cameras.filter(c => c.hasVideo).length;
      const imageCount = cameras.filter(c => !c.hasVideo).length;
      console.log(`Found ${cameras.length} active cameras (${videoCount} video, ${imageCount} image-only)`);
      return cameras;
    } catch (error) {
      console.error('Error fetching MnDOT cameras:', error.message);
      return [];
    }
  }


  async run() {
    this.cleanupStaleAssets();

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
      const keys = require('../keys.js');
      const account = keys.accounts[this.accountName];
      if (!account) {
        throw new Error(`Account '${this.accountName}' not found in keys.js`);
      }

      const { AtpAgent } = require('@atproto/api');
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
        const filtered = cameras.filter(c => !recentIds.includes(String(c.id)));
        const pool = filtered.length > 0 ? filtered : cameras;
        this.chosenCamera = _.sample(pool);
      }

      if (!this.chosenCamera) {
        console.error('Could not select a camera');
        process.exitCode = 1;
        return;
      }

      this.saveRecentCameraId(this.chosenCamera.id);
      console.log(`ID ${this.chosenCamera.id}: ${this.chosenCamera.name} (${this.chosenCamera.hasVideo ? 'video' : 'image'})`);
      Fs.ensureDirSync(this.assetDirectory);

      this.startTime = new Date();

      if (this.chosenCamera.hasVideo) {
        const duration = _.sample(durationOptions);
        await this.downloadVideoSegment(duration);
      } else {
        const numImages = this.getNumImages();
        console.log(`Downloading ${numImages} images every ${this.delayBetweenImageFetches / 1000}s...`);
        if (await this.collectImages(numImages)) return;

        await this.createVideo();
      }

      this.endTime = new Date();

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

const bot = new MinnesotaBot();
if (require.main === module) bot.start();
module.exports = MinnesotaBot;
