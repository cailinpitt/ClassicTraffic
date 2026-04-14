const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');
const { exec } = require('child_process');
const argv = require('minimist')(process.argv.slice(2));


class WestVirginiaBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'westvirginia',
      timezone: 'America/New_York',
      tzAbbrev: 'ET',
    });
  }

  async fetchCameras() {
    console.log('Fetching cameras from WV511...');

    try {
      const response = await Axios.get('https://dev.www.511wv.cloud.ilchost.com/xml/data/js/cameras_export.geojson', {
        headers: {
          'Accept': '*/*',
          'Referer': 'https://wv511.org/',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
        },
        timeout: 15000,
      });

      const features = response.data.features || [];

      const cameras = features
        .filter(f => {
          const p = f.properties;
          return p && p.is_stream === 1 && p.available === 1;
        })
        .map(f => {
          const p = f.properties;
          const coords = f.geometry?.coordinates || [0, 0];
          return {
            id: p.statewide_id || p.md5,
            name: p.descriptive_location || p.name || `Camera ${p.statewide_id}`,
            url: p.url.replace('sfstest.roadsummary.com', 'vtc3.roadsummary.com'),
            latitude: coords[1],
            longitude: coords[0],
          };
        });

      console.log(`Found ${cameras.length} active streaming cameras`);
      return cameras;
    } catch (error) {
      console.error('Error fetching West Virginia cameras:', error.message);
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

      this.ensureAssetDir();

      if (!_.isUndefined(argv.id)) {
        this.chosenCamera = _.find(cameras, { id: argv.id });
        if (!this.chosenCamera) {
          console.error('Could not select a camera');
          process.exitCode = 1;
          return;
        }
        console.log(`ID ${this.chosenCamera.id}: ${this.chosenCamera.name}`);
        this.startTime = new Date();
        await this.downloadVideoSegment(_.sample(TrafficBot.DEFAULT_DURATION_OPTIONS));
      } else {
        const recentIds = this.getRecentCameraIds();
        const filtered = cameras.filter(c => !recentIds.includes(String(c.id)));
        const pool = filtered.length > 0 ? filtered : cameras;

        const MAX_ATTEMPTS = 5;
        const triedIds = new Set();
        let downloaded = false;

        while (!downloaded && triedIds.size < MAX_ATTEMPTS) {
          const available = pool.filter(c => !triedIds.has(c.id));
          if (available.length === 0) break;

          this.chosenCamera = _.sample(available);
          triedIds.add(this.chosenCamera.id);
          if (triedIds.size === 1) this.saveRecentCameraId(this.chosenCamera.id);

          console.log(`ID ${this.chosenCamera.id}: ${this.chosenCamera.name}`);
          this.startTime = new Date();

          try {
            await this.downloadVideoSegment(_.sample(TrafficBot.DEFAULT_DURATION_OPTIONS));
            downloaded = true;
          } catch (error) {
            console.log(`Stream unavailable for camera ${this.chosenCamera.id}, trying another...`);
            await this.sleep(2000);
          }
        }

        if (!downloaded) {
          throw new Error(`All ${triedIds.size} camera attempts failed`);
        }
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

const bot = new WestVirginiaBot();
if (require.main === module) bot.start();
module.exports = WestVirginiaBot;
