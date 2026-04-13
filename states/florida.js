const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const _ = require('lodash');
const argv = require('minimist')(process.argv.slice(2));

const numImagesPerVideoOptions = [150, 300, 450, 600, 750, 900];
const CAMERAS_PER_PAGE = 10;
const DIVAS_AUTH_URL = 'https://divas.cloud/VDS-API/SecureTokenUri/GetSecureTokenUriBySourceId';

class FloridaBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'florida',
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

  async getSession() { return this.get511DotSession('https://fl511.com/cctv'); }

  getCaptureFlags() { return '-rw_timeout 15000000 -headers "Referer: https://fl511.com/\\r\\nOrigin: https://fl511.com\\r\\n"'; }
  async getVideoUrl() { return this.getAuthenticatedVideoUrl(this.chosenCamera.id, this.chosenCamera.url); }

  async getAuthenticatedVideoUrl(cameraId, originalVideoUrl) {
    console.log('Authenticating video stream...');

    // Step 1: Get auth data from fl511
    const authResp = await Axios.get(`https://fl511.com/Camera/GetVideoUrl?imageId=${cameraId}`, {
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

    // Step 2: Exchange auth data for a secure token via DIVAS
    const divasResp = await Axios.post(DIVAS_AUTH_URL, authResp.data, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
        'Origin': 'https://fl511.com',
        'Referer': 'https://fl511.com/',
      },
    });

    // Step 3: Append token query string to original URL
    const authenticatedUrl = originalVideoUrl + divasResp.data;
    console.log('Video stream authenticated');
    return authenticatedUrl;
  }

  async fetchCameras(options = {}) {
    console.log('Fetching cameras from Florida DOT...');

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
          { name: 'region', s: true },
          { name: 'county', s: true },
          { name: 'roadway', s: true },
          { name: 'location' },
          { name: 'direction', s: true },
          { data: 7, name: '' },
        ],
        order: [
          { column: 1, dir: 'asc' },
          { column: 2, dir: 'asc' },
        ],
        start,
        length,
        search: { value: options.search || '' },
      });

      const makeUrl = (query) =>
        `https://fl511.com/List/GetData/Cameras?query=${encodeURIComponent(JSON.stringify(query))}&lang=en-US`;

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
            url: hasVideo ? img.videoUrl : `https://fl511.com${img.imageUrl}`,
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
      console.error('Error fetching Florida cameras:', error.message);
      return [];
    }
  }

  async fetchAllCameras(highway) {
    return this.fetchCameras({ search: highway, limit: 500 });
  }

}

const bot = new FloridaBot();
if (require.main === module) bot.start();
module.exports = FloridaBot;
