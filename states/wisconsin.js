const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');
const { exec } = require('child_process');
const argv = require('minimist')(process.argv.slice(2));

const numImagesPerVideoOptions = [150, 300, 450, 600, 750, 900];
const CAMERAS_PER_PAGE = 10;

class WisconsinBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'wisconsin',
      timezone: 'America/Chicago',
      tzAbbrev: 'CT',
      framerate: 10,
      delayBetweenImageFetches: 6000,
    });
  }

  getNumImages() {
    return _.sample(numImagesPerVideoOptions);
  }

  async getSession() { return this.get511DotSession('https://511wi.gov/cctv'); }

  async fetchCameras(options = {}) {
    console.log('Fetching cameras from Wisconsin DOT...');

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
          { name: 'county', s: true },
          { name: 'roadway', s: true },
          { name: 'location' },
          { data: 6, name: '' },
        ],
        order: [
          { column: 1, dir: 'asc' },
          { column: 4, dir: 'asc' },
        ],
        start,
        length,
        search: { value: options.search || '' },
      });

      const makeUrl = (query) =>
        `https://511wi.gov/List/GetData/Cameras?query=${encodeURIComponent(JSON.stringify(query))}&lang=en-US`;

      let response;
      if (options.limit) {
        response = await Axios.get(makeUrl(makeQuery(0, options.limit)), { headers: apiHeaders });
      } else {
        // Fetch one record to get the total count
        const countResponse = await Axios.get(makeUrl(makeQuery(0, 1)), { headers: apiHeaders });
        const totalCameras = countResponse.data.recordsTotal;
        console.log(`Total cameras: ${totalCameras}`);
        const maxPage = Math.ceil(totalCameras / CAMERAS_PER_PAGE);
        const randomStart = Math.floor(Math.random() * maxPage) * CAMERAS_PER_PAGE;
        console.log(`Fetching page at offset ${randomStart}...`);
        response = await Axios.get(makeUrl(makeQuery(randomStart, CAMERAS_PER_PAGE)), { headers: apiHeaders });
      }

      const data = response.data;
      console.log(`Fetched ${data.data.length} cameras`);

      const cameras = data.data
        .filter(cam => {
          const img = cam.images && cam.images[0];
          return img && !img.disabled && !img.blocked;
        })
        .map(cam => {
          const img = cam.images[0];
          const coordMatch = cam.latLng?.geography?.wellKnownText?.match(
            /POINT \(([^ ]+) ([^ ]+)\)/
          );
          const longitude = coordMatch ? parseFloat(coordMatch[1]) : 0;
          const latitude = coordMatch ? parseFloat(coordMatch[2]) : 0;
          const hasVideo = !!(img.videoUrl && !img.videoDisabled);

          return {
            id: cam.id,
            name: cam.location || cam.roadway,
            url: hasVideo ? img.videoUrl : `https://511wi.gov${img.imageUrl}`,
            hasVideo,
            latitude,
            longitude,
          };
        });

      const videoCount = cameras.filter(c => c.hasVideo).length;
      const imageCount = cameras.filter(c => !c.hasVideo).length;
      console.log(`${cameras.length} cameras (${videoCount} video, ${imageCount} image-only)`);
      return cameras;
    } catch (error) {
      console.error('Error fetching Wisconsin cameras:', error.message);
      return [];
    }
  }

  async fetchAllCameras(highway) {
    return this.fetchCameras({ search: highway, limit: 500 });
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
      console.log(`ID ${this.chosenCamera.id}: ${this.chosenCamera.name} (${this.chosenCamera.hasVideo ? 'video' : 'image'})`);
      Fs.ensureDirSync(this.assetDirectory);

      this.startTime = new Date();

      if (this.chosenCamera.hasVideo) {
        const duration = _.sample(TrafficBot.DEFAULT_DURATION_OPTIONS);
        await this.downloadVideoSegment(duration);
      } else {
        const numImages = this.getNumImages();
        console.log(`Downloading ${numImages} images every ${this.delayBetweenImageFetches / 1000}s...`);
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

const bot = new WisconsinBot();
if (require.main === module) bot.start();
module.exports = WisconsinBot;
