const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');
const crypto = require('crypto');
const { exec } = require('child_process');
const argv = require('minimist')(process.argv.slice(2));

const durationOptions = [60, 90, 120, 180, 240, 360];
const AES_KEY = 'lIo3M)_83,ALC0Wz';
const AES_IV = '.%A}8Qvqm23jYVc9';

class NewJerseyBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'newjersey',
      timezone: 'America/New_York',
      tzAbbrev: 'ET',
      framerate: 10,
      delayBetweenImageFetches: 6000,
    });

    this.token = null;
  }

  encryptBody(plaintext) {
    const cipher = crypto.createCipheriv('aes-128-cbc', AES_KEY, AES_IV);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return encrypted;
  }

  async login511() {
    console.log('Logging in to 511nj.org...');
    const loginBody = JSON.stringify({ username: 'public', password: '', role: 'public' });

    const response = await Axios.post('https://511nj.org/account/login', {
      encryptedData: this.encryptBody(loginBody),
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://511nj.org',
        'Referer': 'https://511nj.org/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
      },
    });

    this.token = response.data.data
      ? response.data.data.accessToken
      : response.data.accessToken;

    if (!this.token) {
      throw new Error('Failed to obtain access token');
    }
    console.log('Authenticated');
  }

  async fetchCameras() {
    console.log('Fetching cameras from New Jersey DOT...');

    try {
      await this.login511();

      const camBody = JSON.stringify({ tourId: 3 });

      const response = await Axios.post('https://511nj.org/client/trafficMap/getCameraDataByTourId', {
        encryptedData: this.encryptBody(camBody),
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Token': `Bearer ${this.token}`,
          'Accept': 'application/json',
          'Origin': 'https://511nj.org',
          'Referer': 'https://511nj.org/camera',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
        },
      });

      const allCameras = response.data.data || [];
      console.log(`Total cameras from API: ${allCameras.length}`);

      // Filter to cameras with accessible HLS streams (xcmdata host)
      const cameras = allCameras
        .filter(cam => {
          const detail = cam.cameraMainDetail && cam.cameraMainDetail.find(
            d => d.camera_use_flag === 'HLS' && d.url && d.url.includes('xcmdata')
          );
          return !!detail;
        })
        .map(cam => {
          const detail = cam.cameraMainDetail.find(
            d => d.camera_use_flag === 'HLS' && d.url.includes('xcmdata')
          );
          return {
            id: cam.id,
            name: `${cam.name}${cam.deviceDescription ? ' ' + cam.deviceDescription : ''}`,
            url: detail.url,
            latitude: parseFloat(cam.latitude) || 0,
            longitude: parseFloat(cam.longitude) || 0,
          };
        });

      console.log(`${cameras.length} cameras with accessible HLS streams`);
      return cameras;
    } catch (error) {
      console.error('Error fetching New Jersey cameras:', error.message);
      return [];
    }
  }

  async downloadVideoSegment(duration) {
    console.log(`Recording ${duration}s of video from ${this.chosenCamera.name}...`);

    const tempPath = `${this.assetDirectory}raw.ts`;
    const MIN_FILE_SIZE = 500 * 1024;

    const captureCmd = `ffmpeg -y -rw_timeout 15000000 -headers "Referer: https://511nj.org/\r\nOrigin: https://511nj.org\r\n" -t ${duration} -i "${this.chosenCamera.url}" -map 0:v:0 -c copy "${tempPath}"`;

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

const bot = new NewJerseyBot();
bot.run();
