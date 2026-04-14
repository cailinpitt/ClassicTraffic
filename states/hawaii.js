const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const _ = require('lodash');
const argv = require('minimist')(process.argv.slice(2));

const durationOptions = [60, 90, 120, 180, 480, 960];
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

  getTimeout() {
    return (Math.max(...numImagesPerVideoOptions) - 1) * (this.delayBetweenImageFetches * 4) / 1000 + 600;
  }

  getEncodeFlags() { return '-err_detect ignore_err -max_muxing_queue_size 4096'; }
  getEncodeTimeout(duration) { return Math.max(duration * 10, 300) * 1000; }

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
        this.chosenCamera = _.find(cameras, { id: argv.id });
      } else {
        // For video cameras, verify the stream URL is reachable before committing
        const recentIds = this.getRecentCameraIds();
        const filtered = cameras.filter(c => !recentIds.includes(String(c.id)));
        const pool = filtered.length > 0 ? filtered : cameras;
        const shuffled = _.shuffle(pool);
        for (const cam of shuffled) {
          if (cam.hasVideo) {
            try {
              await Axios.head(cam.url, { timeout: 5000 });
              this.chosenCamera = cam;
              break;
            } catch (e) {
              console.log(`Stream 404 for ${cam.id}, trying another...`);
              continue;
            }
          } else {
            this.chosenCamera = cam;
            break;
          }
        }
      }

      if (!this.chosenCamera) {
        console.error('Could not select a camera');
        process.exitCode = 1;
        return;
      }

      this.saveRecentCameraId(this.chosenCamera.id);
      console.log(`ID ${this.chosenCamera.id}: ${this.chosenCamera.name} (${this.chosenCamera.hasVideo ? 'video' : 'image'})`);
      this.ensureAssetDir();

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
if (require.main === module) bot.start();
module.exports = HawaiiBot;
