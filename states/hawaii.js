const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');
const { exec } = require('child_process');
const argv = require('minimist')(process.argv.slice(2));

const durationOptions = [60, 90, 120, 180];
const numImagesPerVideoOptions = [15, 30, 45];

class HawaiiBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'hawaii',
      timezone: 'Pacific/Honolulu',
      tzAbbrev: 'HST',
      framerate: 5,
      delayBetweenImageFetches: 120000,
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
    console.log('Fetching cameras from GoAkamai...');

    try {
      const response = await Axios.get('http://a.cameraservice.goakamai.org/cameras/?format=cameraPage', {
        headers: {
          'Accept': 'application/json',
          'Origin': 'http://www.goakamai.org',
          'Referer': 'http://www.goakamai.org/',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
          'x-icx-copyright': 'ICxTransportationGroup',
          'x-icx-ts': String(Date.now()),
        },
      });

      const data = Array.isArray(response.data) ? response.data : response.data.cameras || [];

      const cameras = data
        .filter(cam => cam.id && cam.image && cam.image.status === 'OK')
        .map(cam => {
          const hasVideo = !!(cam.stream && cam.stream.status === 'OK' && cam.stream.URL);
          return {
            id: cam.id,
            name: cam.description || cam.id,
            url: hasVideo ? cam.stream.URL : cam.image.URL,
            hasVideo,
            latitude: 0,
            longitude: 0,
          };
        });

      const videoCount = cameras.filter(c => c.hasVideo).length;
      const imageCount = cameras.filter(c => !c.hasVideo).length;
      console.log(`Found ${cameras.length} active cameras (${videoCount} video, ${imageCount} image-only)`);
      return cameras;
    } catch (error) {
      console.error('Error fetching Hawaii cameras:', error.message);
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
          timeout: 10000,
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

  async downloadVideoSegment(duration) {
    console.log(`Recording ${duration}s of video from ${this.chosenCamera.name}...`);

    const cmd = `ffmpeg -y -t ${duration} -i "${this.chosenCamera.url}" -c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p -vf "setpts=0.5*PTS" -an "${this.pathToVideo}"`;

    await new Promise((resolve, reject) => {
      exec(cmd, { timeout: (duration * 3 + 60) * 1000 }, (error) => {
        if (error) return reject(error);
        resolve();
      });
    });

    const stats = Fs.statSync(this.pathToVideo);
    const fileSizeInMB = stats.size / (1024 * 1024);
    console.log(`Video saved: ${this.pathToVideo} (${fileSizeInMB.toFixed(2)} MB)`);
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

      console.log(`ID ${this.chosenCamera.id}: ${this.chosenCamera.name} (${this.chosenCamera.hasVideo ? 'video' : 'image'})`);
      Fs.ensureDirSync(this.assetDirectory);

      this.startTime = new Date();

      if (this.chosenCamera.hasVideo) {
        const duration = _.sample(durationOptions);
        await this.downloadVideoSegment(duration);
      } else {
        const numImages = this.getNumImages();
        console.log(`Downloading ${numImages} images every 2min...`);
        for (let i = 0; i < numImages; i++) {
          await this.downloadImage(i);
          if (i < numImages - 1) await this.sleep(this.delayBetweenImageFetches);
        }

        if (this.shouldAbort()) {
          return;
        }

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

const bot = new HawaiiBot();
bot.run();
