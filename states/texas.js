const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');
const { exec } = require('child_process');
const argv = require('minimist')(process.argv.slice(2));

const durationOptions = [60, 90, 120, 180, 240, 360];
const CAMERAS_PER_PAGE = 10;

const MAPLARGE_HOST = 'https://dtx-e-cdn.maplarge.com';
const CAMERA_TABLE = 'appgeo/cameraPoint';

class TexasBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'texas',
      timezone: 'America/Chicago',
      tzAbbrev: 'CT',
    });
  }

  async fetchCameras() {
    console.log('Fetching cameras from DriveTexas...');

    const request = {
      action: 'table/query',
      query: {
        table: { name: CAMERA_TABLE },
        select: { type: 'geo.dot' },
        where: [],
        take: 10000,
        start: 0,
      },
    };

    const response = await Axios.get(`${MAPLARGE_HOST}/Api/ProcessDirect`, {
      params: { request: JSON.stringify(request) },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
      },
      timeout: 30000,
    });

    const data = response.data;
    if (!data || !data.data || !data.data.data) {
      throw new Error('Unexpected response format from MapLarge API');
    }

    // MapLarge returns columnar data: { field: [val0, val1, ...], ... }
    const cols = data.data.data;
    const count = cols.id.length;

    const cameras = [];
    for (let i = 0; i < count; i++) {
      if (cols.active[i] !== 1 || cols.problemstream[i] !== 0 || !cols.httpsurl[i]) continue;
      cameras.push({
        id: cols.id[i],
        name: cols.description[i] || cols.name[i],
        description: cols.description[i],
        route: cols.route[i],
        jurisdiction: cols.jurisdiction[i],
        url: cols.httpsurl[i],
        latitude: 0,
        longitude: 0,
      });
    }

    console.log(`Total active cameras with video: ${cameras.length}`);
    return cameras;
  }

  async downloadVideoSegment(duration) {
    console.log(`Recording ${duration}s of video from ${this.chosenCamera.name} (${this.chosenCamera.description})...`);

    const tempPath = `${this.assetDirectory}raw.ts`;
    const MIN_FILE_SIZE = 500 * 1024;

    const captureCmd = `ffmpeg -y -rw_timeout 15000000 -t ${duration} -i "${this.chosenCamera.url}" -map 0:v:0 -c copy "${tempPath}"`;

    await new Promise((resolve, reject) => {
      exec(captureCmd, { timeout: (duration + 60) * 1000 }, (error) => {
        if (Fs.existsSync(tempPath) && Fs.statSync(tempPath).size > MIN_FILE_SIZE) {
          return resolve();
        }
        if (error) return reject(error);
        resolve();
      });
    });

    const encodeCmd = `ffmpeg -y -i "${tempPath}" -c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p -vf "setpts=0.5*PTS" -an "${this.pathToVideo}"`;

    await new Promise((resolve, reject) => {
      exec(encodeCmd, { timeout: 120000 }, (error) => {
        if (error) return reject(error);
        resolve();
      });
    });

    Fs.removeSync(tempPath);

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

      // Select a random page of cameras, then pick one
      const page = _.sampleSize(cameras, CAMERAS_PER_PAGE);
      if (!_.isUndefined(argv.id)) {
        this.chosenCamera = _.find(cameras, c => c.id == argv.id);
      } else {
        this.chosenCamera = _.sample(page);
      }

      if (!this.chosenCamera) {
        console.error('Could not select a camera');
        return;
      }

      console.log(`ID ${this.chosenCamera.id}: ${this.chosenCamera.name} - ${this.chosenCamera.description} (${this.chosenCamera.jurisdiction})`);
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

const bot = new TexasBot();
bot.run();
