const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');
const { exec } = require('child_process');
const argv = require('minimist')(process.argv.slice(2));

const durationOptions = [60, 90, 120, 180, 240, 360, 480, 960];

class SouthCarolinaBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'southcarolina',
      timezone: 'America/New_York',
      tzAbbrev: 'ET',
      framerate: 10,
      delayBetweenImageFetches: 6000,
    });
  }

  async fetchCameras() {
    console.log('Fetching cameras from 511SC...');

    try {
      const response = await Axios.get('https://sc.cdn.iteris-atis.com/geojson/icons/metadata/icons.cameras.geojson', {
        headers: {
          'Referer': 'https://www.511sc.org/',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
          'Accept': 'application/json',
        },
      });

      const features = response.data.features || [];

      const cameras = features
        .filter(f => {
          const p = f.properties;
          return p && p.active && !p.problem_stream && p.https_url;
        })
        .map(f => {
          const p = f.properties;
          const coords = f.geometry?.coordinates || [0, 0];
          return {
            id: p.id,
            name: p.description || p.name,
            url: p.https_url,
            latitude: coords[1],
            longitude: coords[0],
          };
        });

      console.log(`Found ${cameras.length} active cameras`);
      return cameras;
    } catch (error) {
      console.error('Error fetching South Carolina cameras:', error.message);
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

      const duration = _.sample(durationOptions);
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

const bot = new SouthCarolinaBot();
if (require.main === module) bot.start();
module.exports = SouthCarolinaBot;
