const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');
const { exec } = require('child_process');
const argv = require('minimist')(process.argv.slice(2));

const durationOptions = [30, 45, 60, 90, 120, 180];

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

  async downloadVideoSegment(duration) {
    console.log(`Recording ${duration}s of video from ${this.chosenCamera.name}...`);

    const cmd = `ffmpeg -y -headers "Referer: https://oktraffic.org/\r\n" -i "${this.chosenCamera.url}" -t ${duration} -c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p "${this.pathToVideo}"`;

    await new Promise((resolve, reject) => {
      exec(cmd, { timeout: (duration + 30) * 1000 }, (error) => {
        if (error) return reject(error);
        resolve();
      });
    });

    const stats = Fs.statSync(this.pathToVideo);
    const fileSizeInMB = stats.size / (1024 * 1024);
    console.log(`Video saved: ${this.pathToVideo} (${fileSizeInMB.toFixed(2)} MB)`);
  }

  async run() {
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

const bot = new OklahomaBot();
bot.run();
