const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');
const { exec } = require('child_process');
const argv = require('minimist')(process.argv.slice(2));


class ArkansasBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'arkansas',
      timezone: 'America/Chicago',
      tzAbbrev: 'CT',
      framerate: 10,
      delayBetweenImageFetches: 6000,
    });
  }

  getCaptureFlags() { return '-rw_timeout 15000000 -headers "Referer: https://www.idrivearkansas.com/\\r\\n"'; }
  async getVideoUrl() { return this.getTokenizedUrl(this.chosenCamera.url); }

  async fetchCameras() {
    console.log('Fetching cameras from iDriveArkansas...');

    try {
      const response = await Axios.get('https://layers.idrivearkansas.com/cameras.geojson', {
        headers: {
          'Accept': 'application/json',
          'Origin': 'https://www.idrivearkansas.com',
          'Referer': 'https://www.idrivearkansas.com/',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
        },
      });

      const features = response.data.features || [];

      const cameras = features
        .filter(f => {
          const p = f.properties;
          return p && p.status === 'online' && p.hls_stream_protected;
        })
        .map(f => {
          const p = f.properties;
          const coords = f.geometry?.coordinates || [0, 0];
          return {
            id: p.id,
            name: p.name || p.description,
            url: p.hls_stream_protected,
            latitude: coords[1],
            longitude: coords[0],
          };
        });

      console.log(`Found ${cameras.length} active cameras`);
      return cameras;
    } catch (error) {
      console.error('Error fetching Arkansas cameras:', error.message);
      return [];
    }
  }

  async getTokenizedUrl(url) {
    const response = await Axios.get(url, {
      headers: {
        'Referer': 'https://www.idrivearkansas.com/',
        'Origin': 'https://www.idrivearkansas.com',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
      },
      maxRedirects: 0,
      validateStatus: status => status === 302,
    });

    const tokenizedUrl = response.headers.location;
    if (!tokenizedUrl) {
      throw new Error('No redirect URL returned from stream endpoint');
    }
    return tokenizedUrl;
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
      console.log(`ID ${this.chosenCamera.id}: ${this.chosenCamera.name}`);
      Fs.ensureDirSync(this.assetDirectory);

      this.startTime = new Date();

      const duration = _.sample(TrafficBot.DEFAULT_DURATION_OPTIONS);
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
  }
}

const bot = new ArkansasBot();
if (require.main === module) bot.start();
module.exports = ArkansasBot;
