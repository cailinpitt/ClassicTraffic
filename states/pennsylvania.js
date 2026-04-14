const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');
const argv = require('minimist')(process.argv.slice(2));

const numImagesPerVideoOptions = [150, 300, 450, 600, 750, 900];
const CAMERAS_PER_PAGE = 30;
const PA_AUTH_URL = 'https://pa.arcadis-ivds.com/api/SecureTokenUri/GetSecureTokenUriBySourceId';

class PennsylvaniaBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'pennsylvania',
      timezone: 'America/New_York',
      tzAbbrev: 'ET',
      framerate: 10,
      delayBetweenImageFetches: 6000,
    });

    this.session = null;
  }

  getNumImages() {
    return _.sample(numImagesPerVideoOptions);
  }

  async getSession() { return this.get511DotSession('https://www.511pa.com/cctv'); }

  getCaptureFlags() { return '-rw_timeout 15000000 -headers "Referer: https://www.511pa.com/\\r\\nOrigin: https://www.511pa.com\\r\\n"'; }
  async getVideoUrl() { return this.getAuthenticatedVideoUrl(this.chosenCamera.imageId, this.chosenCamera.url); }

  async getAuthenticatedVideoUrl(imageId, originalVideoUrl) {
    console.log('Authenticating video stream...');

    // Step 1: Get auth data from 511pa
    const authResp = await Axios.get(`https://www.511pa.com/Camera/GetVideoUrl?imageId=${imageId}`, {
      headers: {
        Cookie: this.session.cookies,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
        'X-Requested-With': 'XMLHttpRequest',
        '__requestverificationtoken': this.session.token,
      },
    });

    // If the response is a string, it's already the final URL
    if (typeof authResp.data === 'string') {
      return authResp.data;
    }

    // Step 2: Exchange auth data for a secure token via PA arcadis endpoint
    const divasResp = await Axios.post(PA_AUTH_URL, authResp.data, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
        'Origin': 'https://www.511pa.com',
        'Referer': 'https://www.511pa.com/',
      },
    });

    // Step 3: Append token query string to original URL
    const authenticatedUrl = originalVideoUrl + divasResp.data;
    console.log('Video stream authenticated');
    return authenticatedUrl;
  }

  async fetchCameras() {
    console.log('Fetching cameras from Pennsylvania DOT...');

    try {
      this.session = await this.getSession();

      const apiHeaders = {
        '__requestverificationtoken': this.session.token,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Cookie': this.session.cookies,
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
      };

      const makeQuery = (start, length) => ({
        columns: [
          { data: null, name: '' },
          { name: 'sortOrder', s: true },
          { name: 'dotDistrict', s: true },
          { name: 'county', s: true },
          { name: 'roadway', s: true },
          { name: 'turnpikeOnly' },
          { name: 'location' },
          { name: 'cameraName' },
          { name: 'district' },
          { data: 9, name: '' },
        ],
        order: [
          { column: 1, dir: 'asc' },
          { column: 2, dir: 'asc' },
        ],
        start,
        length,
        search: { value: '' },
      });

      const makeUrl = (query) =>
        `https://www.511pa.com/List/GetData/Cameras?query=${encodeURIComponent(JSON.stringify(query))}&lang=en-US`;

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
            imageId: img.id,
            name: cam.location || cam.roadway,
            url: hasVideo ? img.videoUrl : `https://www.511pa.com${img.imageUrl}`,
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
      console.error('Error fetching Pennsylvania cameras:', error.message);
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
      console.log(`ID ${this.chosenCamera.id}: ${this.chosenCamera.name} (${this.chosenCamera.hasVideo ? 'video' : 'image'})`);
      this.ensureAssetDir();

      this.startTime = new Date();

      if (this.chosenCamera.hasVideo) {
        const duration = _.sample(TrafficBot.DEFAULT_DURATION_OPTIONS);
        if (_.isUndefined(argv.id)) {
          const videoCameras = _.shuffle(cameras.filter(c => c.hasVideo));
          // Start with the already-chosen camera, then try others in shuffled order
          const firstIdx = videoCameras.findIndex(c => c.id === this.chosenCamera.id);
          if (firstIdx > 0) {
            const [first] = videoCameras.splice(firstIdx, 1);
            videoCameras.unshift(first);
          }
          let succeeded = false;
          let first = true;
          for (const cam of videoCameras.slice(0, 10)) {
            this.chosenCamera = cam;
            if (!first) {
              console.log(`ID ${this.chosenCamera.id}: ${this.chosenCamera.name}`);
            }
            first = false;
            try {
              await this.downloadVideoSegment(duration);
              succeeded = true;
              break;
            } catch (e) {
              console.log(`Stream failed for ${this.chosenCamera.id}, trying another camera...`);
              this.cleanup();
              this.ensureAssetDir();
            }
          }
          if (!succeeded) throw new Error('All video cameras failed');
        } else {
          await this.downloadVideoSegment(duration);
        }
      } else {
        const numImages = this.getNumImages();
        console.log(`Downloading ${numImages} images every ${this.delayBetweenImageFetches / 1000}s...`);
        if (await this.collectImages(numImages)) return;

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

const bot = new PennsylvaniaBot();
if (require.main === module) bot.start();
module.exports = PennsylvaniaBot;
