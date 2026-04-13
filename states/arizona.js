const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');

const numImagesPerVideoOptions = [30, 45, 60, 90];
const CAMERAS_PER_PAGE = 10;

class ArizonaBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'arizona',
      timezone: 'America/Phoenix',
      tzAbbrev: 'MST',
      framerate: 10,
      delayBetweenImageFetches: 60000,
    });
  }

  getNumImages() {
    return _.sample(numImagesPerVideoOptions);
  }

  async getSession() { return this.get511DotSession('https://www.az511.gov/cctv'); }

  async fetchCameras() {
    console.log('Fetching cameras from Arizona DOT...');

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
          { name: 'city', s: true },
          { name: 'roadway', s: true },
          { name: 'location' },
          { data: 5, name: '' },
        ],
        order: [
          { column: 1, dir: 'asc' },
          { column: 3, dir: 'asc' },
        ],
        start,
        length,
        search: { value: '' },
      });

      const makeUrl = (query) =>
        `https://www.az511.gov/List/GetData/Cameras?query=${encodeURIComponent(JSON.stringify(query))}&lang=en-US`;

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
          return img && img.imageUrl && !img.disabled && !img.blocked;
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
            url: `https://www.az511.gov${img.imageUrl}`,
            latitude,
            longitude,
          };
        });

      console.log(`${cameras.length} cameras with images on this page`);
      return cameras;
    } catch (error) {
      console.error('Error fetching Arizona cameras:', error.message);
      return [];
    }
  }

}

const bot = new ArizonaBot();
if (require.main === module) bot.start();
module.exports = ArizonaBot;
