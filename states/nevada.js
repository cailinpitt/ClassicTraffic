const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');
const { exec } = require('child_process');
const argv = require('minimist')(process.argv.slice(2));

const durationOptions = [30, 45, 60, 90, 120];
const CAMERAS_PER_PAGE = 10;

class NevadaBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'nevada',
      timezone: 'America/Los_Angeles',
      tzAbbrev: 'PT',
      framerate: 10,
      delayBetweenImageFetches: 0,
    });
  }

  // Not used — we download video directly
  getNumImages() { return 0; }
  downloadImage() {}

  async getSession() {
    console.log('Fetching session from nvroads.com...');
    const response = await Axios.get('https://www.nvroads.com/cctv', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
      },
      maxRedirects: 5,
    });

    const setCookies = response.headers['set-cookie'] || [];
    const cookieString = setCookies.map(c => c.split(';')[0]).join('; ');

    const tokenMatch = response.data.match(
      /<input[^>]*name="__RequestVerificationToken"[^>]*value="([^"]+)"/
    );
    if (!tokenMatch) {
      throw new Error('Could not find verification token in page');
    }

    return {
      cookies: cookieString,
      token: tokenMatch[1],
    };
  }

  async fetchCameras() {
    console.log('Fetching cameras from Nevada DOT...');

    try {
      const session = await this.getSession();

      const apiHeaders = {
        '__requestverificationtoken': session.token,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Cookie': session.cookies,
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
      };

      const makeQuery = (start, length) => ({
        columns: [
          { data: null, name: '' },
          { name: 'sortOrder', s: true },
          { name: 'region', s: true },
          { name: 'roadway', s: true },
          { data: 4, name: '' },
        ],
        order: [
          { column: 1, dir: 'asc' },
          { column: 2, dir: 'asc' },
          { column: 3, dir: 'asc' },
        ],
        start,
        length,
        search: { value: '' },
      });

      const makeUrl = (query) =>
        `https://www.nvroads.com/List/GetData/Cameras?query=${encodeURIComponent(JSON.stringify(query))}&lang=en-US`;

      // Fetch one record to get the total count
      const countResponse = await Axios.get(makeUrl(makeQuery(0, 1)), { headers: apiHeaders });
      const totalCameras = countResponse.data.recordsTotal;
      console.log(`Total cameras: ${totalCameras}`);

      const maxPage = Math.ceil(totalCameras / CAMERAS_PER_PAGE);
      const randomStart = Math.floor(Math.random() * maxPage) * CAMERAS_PER_PAGE;

      console.log(`Fetching page at offset ${randomStart}...`);
      const response = await Axios.get(makeUrl(makeQuery(randomStart, CAMERAS_PER_PAGE)), { headers: apiHeaders });

      const data = response.data;
      console.log(`Total cameras: ${data.recordsTotal}, fetched ${data.data.length} from offset ${randomStart}`);

      const cameras = data.data
        .filter(cam => {
          const img = cam.images && cam.images[0];
          return img && img.videoUrl && !img.videoDisabled && !img.disabled && !img.blocked;
        })
        .map(cam => {
          const img = cam.images[0];
          const coordMatch = cam.latLng?.geography?.wellKnownText?.match(
            /POINT \(([^ ]+) ([^ ]+)\)/
          );
          const longitude = coordMatch ? parseFloat(coordMatch[1]) : 0;
          const latitude = coordMatch ? parseFloat(coordMatch[2]) : 0;

          return {
            id: cam.id,
            name: cam.location || cam.roadway,
            url: img.videoUrl,
            latitude,
            longitude,
          };
        });

      console.log(`${cameras.length} cameras with active video on this page`);
      return cameras;
    } catch (error) {
      console.error('Error fetching Nevada cameras:', error.message);
      return [];
    }
  }

  async downloadVideoSegment(duration) {
    console.log(`Recording ${duration}s of video from ${this.chosenCamera.name}...`);

    const cmd = `ffmpeg -y -i "${this.chosenCamera.url}" -t ${duration} -c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p "${this.pathToVideo}"`;

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

      const duration = _.sample(durationOptions);
      this.startTime = new Date();
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

const bot = new NevadaBot();
bot.run();
