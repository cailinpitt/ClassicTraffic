const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');
const { exec } = require('child_process');
const argv = require('minimist')(process.argv.slice(2));


const CAMERA_PAGES = [
  'https://www.dot.ri.gov/travel/cameras_metro.php',
  'https://www.dot.ri.gov/travel/cameras_eastbay.php',
  'https://www.dot.ri.gov/travel/cameras_ncounty.php',
  'https://www.dot.ri.gov/travel/cameras_bstonenorth.php',
  'https://www.dot.ri.gov/travel/cameras_scounty.php',
  'https://www.dot.ri.gov/travel/cameras_westbay.php',
];

class RhodeIslandBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'rhodeisland',
      timezone: 'America/New_York',
      tzAbbrev: 'ET',
    });
  }

  parseCamerasFromHtml(html) {
    const cameras = [];
    const urlRegex = /openVideoPopup2\('(https:\/\/cdn3\.wowza\.com\/[^']+\.m3u8)'\)/g;
    // Match name between </a> and either <img src="img/LIVE_STREAM or </li>, handling extra </a> tags
    const nameRegex = /<\/a>([^<]*(?:<\/a>)?[^<]*?)(?:<img\s+src="img\/LIVE_STREAM|<\/li>)/g;

    const urls = [];
    const names = [];

    let match;
    while ((match = urlRegex.exec(html)) !== null) {
      urls.push(match[1]);
    }
    while ((match = nameRegex.exec(html)) !== null) {
      const name = match[1].replace(/<\/a>/g, '').trim();
      if (name) names.push(name);
    }

    const count = Math.min(names.length, urls.length);
    for (let i = 0; i < count; i++) {
      cameras.push({ name: names[i], url: urls[i] });
    }

    return cameras;
  }

  async fetchCameras() {
    console.log('Fetching cameras from RIDOT...');

    try {
      const seen = new Set();
      const cameras = [];

      for (const pageUrl of CAMERA_PAGES) {
        const response = await Axios.get(pageUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
          },
          timeout: 15000,
        });

        const parsed = this.parseCamerasFromHtml(response.data);
        for (const cam of parsed) {
          if (!seen.has(cam.url)) {
            seen.add(cam.url);
            cameras.push({
              id: cam.url.split('/')[4],
              name: cam.name,
              url: cam.url,
              latitude: 0,
              longitude: 0,
            });
          }
        }
      }

      console.log(`Found ${cameras.length} unique streaming cameras`);
      return cameras;
    } catch (error) {
      console.error('Error fetching Rhode Island cameras:', error.message);
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

const bot = new RhodeIslandBot();
if (require.main === module) bot.start();
module.exports = RhodeIslandBot;
