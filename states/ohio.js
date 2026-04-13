const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');
const { exec } = require('child_process');
const argv = require('minimist')(process.argv.slice(2));

const numImagesPerVideoOptions = [150, 300, 450, 600, 750, 900];
const videoDurationOptions = [60, 90, 120, 180, 240, 360, 480, 960];

const KITTY_BREW_CAMERA = {
  id: 'kitty-brew',
  name: 'Kitty Brew Cat Cafe',
  url: 'https://kittybrew.lorexddns.net:8888/stream3/index.m3u8',
  hasVideo: true,
  latitude: 39.35096988742476,
  longitude: -84.32375557204591,
};

class OhioBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'ohio',
      timezone: 'America/New_York',
      tzAbbrev: 'ET',
      framerate: 10,
      delayBetweenImageFetches: 6000,
      threadProbability: 0.25,
    });
  }

  getNumImages() {
    return _.sample(numImagesPerVideoOptions);
  }

  async fetchCameras() {
    const threeMonthsFromNow = new Date();
    threeMonthsFromNow.setMonth(threeMonthsFromNow.getMonth() + 3);

    const year = threeMonthsFromNow.getFullYear();
    const month = threeMonthsFromNow.getMonth() + 1;
    const day = threeMonthsFromNow.getDate();
    const dateStr = `${year}-${month}-${day}`;

    const ohgoUrl = `https://api.ohgo.com/road-markers/multi-markers?before=${dateStr}`;
    console.log(`Fetching cameras from API (before=${dateStr})...`);

    try {
      const response = await Axios.get(ohgoUrl);
      const cameraMarkers = response.data.CameraMarkers || [];

      const cameras = [];
      cameraMarkers.forEach((marker) => {
        if (marker.Cameras && marker.Cameras.length > 0) {
          marker.Cameras.forEach((camera, index) => {
            cameras.push({
              id: `${marker.Id}-${index}`,
              name: marker.Description,
              url: camera.LargeURL,
              location: marker.Location,
              latitude: marker.Latitude,
              longitude: marker.Longitude
            });
          });
        }
      });

      cameras.push(KITTY_BREW_CAMERA);
      console.log(`Fetched ${cameras.length} cameras from API`);
      return cameras;
    } catch (error) {
      console.error('Error fetching cameras:', error.message);
      return [];
    }
  }

  async downloadImage(index, retries = 3) {
    const path = this.getImagePath(index);

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const writer = Fs.createWriteStream(path);

        const response = await Axios({
          url: this.chosenCamera.url,
          method: 'GET',
          responseType: 'stream',
          timeout: 20000,
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
        if (Fs.existsSync(path)) {
          Fs.removeSync(path);
        }

        if (attempt === retries) {
          throw error;
        }

        await this.sleep(1000 * Math.pow(2, attempt - 1));
      }
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

    // If a specific video camera is requested, handle it directly
    if (!_.isUndefined(argv.id)) {
      const cameras = await this.fetchCameras();
      const cam = _.find(cameras, c => c.id == argv.id);
      if (cam?.hasVideo) {
        const runStart = Date.now();
        try {
          const keys = require('../keys.js');
          const account = keys.accounts[this.accountName];
          if (!account) throw new Error(`Account '${this.accountName}' not found in keys.js`);
          const { AtpAgent } = require('@atproto/api');
          this.agent = new AtpAgent({ service: keys.service });
          await this.agent.login({ identifier: account.identifier, password: account.password });
          if (!this.agent.session?.did) { process.exitCode = 1; return; }

          console.log(`Logged in as @${account.identifier}`);
          this.chosenCamera = cam;
          this.saveRecentCameraId(cam.id);
          console.log(`ID ${cam.id}: ${cam.name} (video)`);
          Fs.ensureDirSync(this.assetDirectory);
          this.startTime = new Date();
          const duration = argv.duration ? parseInt(argv.duration) : _.sample(videoDurationOptions);
          await this.downloadVideoSegment(duration);
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
          const elapsedMs = Date.now() - runStart;
          const elapsedMin = Math.floor(elapsedMs / 60000);
          const elapsedSec = Math.round((elapsedMs % 60000) / 1000);
          const elapsedStr = elapsedMin > 0 ? `${elapsedMin}m ${elapsedSec}s` : `${elapsedSec}s`;
          console.log(`Done in ${elapsedStr}`);
        }
        return;
      }
    }

    // Default: use base class run() for image cameras
    return super.run();
  }
}

const bot = new OhioBot();
if (require.main === module) bot.start();
module.exports = OhioBot;
