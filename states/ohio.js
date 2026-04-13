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
  latitude: 39.3601,
  longitude: -84.3097,
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

  shouldAbort() {
    if (this.uniqueImageCount === 1) {
      console.log(`Camera ${this.chosenCamera.id}: ${this.chosenCamera.name} is frozen. Exiting`);
      return true;
    }
    return false;
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

  async downloadVideoSegment(duration) {
    console.log(`Recording ${duration}s of video from ${this.chosenCamera.name}...`);

    const tempPath = `${this.assetDirectory}raw.ts`;
    const captureCmd = `ffmpeg -y -rw_timeout 15000000 -t ${duration} -i "${this.chosenCamera.url}" -map 0:v:0 -c copy "${tempPath}"`;

    await new Promise((resolve, reject) => {
      exec(captureCmd, { timeout: (duration + 60) * 1000 }, (error) => {
        if (Fs.existsSync(tempPath) && Fs.statSync(tempPath).size > 500 * 1024) return resolve();
        if (error) return reject(error);
        resolve();
      });
    });

    const encodeCmd = `ffmpeg -y -i "${tempPath}" -c:v libx264 -preset ultrafast -crf 23 -pix_fmt yuv420p -vf "setpts=${this.getSetpts(duration)}*PTS" -an "${this.pathToVideo}"`;

    await new Promise((resolve, reject) => {
      exec(encodeCmd, { timeout: (duration * 2 + 300) * 1000 }, (error) => {
        if (error) return reject(error);
        resolve();
      });
    });

    Fs.removeSync(tempPath);

    const stats = Fs.statSync(this.pathToVideo);
    console.log(`Video saved: ${this.pathToVideo} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
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
        try {
          const keys = require('../keys.js');
          const account = keys.accounts[this.accountName];
          if (!account) throw new Error(`Account '${this.accountName}' not found in keys.js`);
          const { AtpAgent } = require('@atproto/api');
          this.agent = new AtpAgent({ service: keys.service });
          await this.agent.login({ identifier: account.identifier, password: account.password });
          if (!this.agent.session?.did) { process.exitCode = 1; return; }

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
