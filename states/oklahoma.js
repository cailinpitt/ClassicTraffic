const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');
const { exec } = require('child_process');
const argv = require('minimist')(process.argv.slice(2));


class OklahomaBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'oklahoma',
      timezone: 'America/Chicago',
      tzAbbrev: 'CT',
      framerate: 10,
      delayBetweenImageFetches: 6000,
    });
  }

  getCaptureFlags() { return '-rw_timeout 15000000 -headers "Referer: https://oktraffic.org/\r\n"'; }

  async getVideoUrl() {
    // Stream keys rotate frequently, so re-fetch the latest key immediately before recording
    const response = await Axios.get(`https://oktraffic.org/api/MapCameras/${this.chosenCamera.id}`, {
      params: { filter: JSON.stringify({ include: 'streamDictionary' }) },
      headers: {
        'Accept': 'application/json',
        'Referer': 'https://oktraffic.org/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
      },
    });
    const streamSrc = response.data?.streamDictionary?.streamSrc;
    if (!streamSrc) throw new Error(`No streamSrc for camera ${this.chosenCamera.id}`);
    console.log(`Refreshed stream URL for ${this.chosenCamera.name}`);
    return streamSrc;
  }

  async fetchCameras() {
    console.log('Fetching cameras from oktraffic.org...');

    try {
      const response = await Axios.get('https://oktraffic.org/api/CameraPoles', {
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Referer': 'https://oktraffic.org/',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
          'filter': JSON.stringify({
            include: [
              {
                relation: 'mapCameras',
                scope: {
                  include: 'streamDictionary',
                  where: {
                    status: { neq: 'Out Of Service' },
                    type: 'Web',
                    blockAtis: { neq: '1' },
                  },
                },
              },
            ],
          }),
        },
      });

      const poles = response.data || [];
      const cameras = [];

      for (const pole of poles) {
        for (const cam of pole.mapCameras || []) {
          const sd = cam.streamDictionary;
          if (!sd || !sd.streamSrc) continue;

          cameras.push({
            id: cam.id,
            name: cam.location || sd.streamName || pole.name,
            url: sd.streamSrc,
            latitude: parseFloat(cam.latitude) || 0,
            longitude: parseFloat(cam.longitude) || 0,
          });
        }
      }

      console.log(`Found ${cameras.length} active cameras`);
      return cameras;
    } catch (error) {
      console.error('Error fetching Oklahoma cameras:', error.message);
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
      this.ensureAssetDir();

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

const bot = new OklahomaBot();
if (require.main === module) bot.start();
module.exports = OklahomaBot;
