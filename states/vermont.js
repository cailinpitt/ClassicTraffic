const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');

const numImagesPerVideoOptions = [15, 30, 45];
const CAMERAS_PER_PAGE = 10;

class VermontBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'vermont',
      timezone: 'America/New_York',
      tzAbbrev: 'ET',
      framerate: 5,
      delayBetweenImageFetches: 120000,
    });
  }

  getNumImages() {
    return _.sample(numImagesPerVideoOptions);
  }

  getTimeout() {
    return (Math.max(...numImagesPerVideoOptions) - 1) * (this.delayBetweenImageFetches * 4) / 1000 + 600;
  }

  async getSession() { return this.get511DotSession('https://newengland511.org/cctv'); }

  async fetchCameras() {
    console.log('Fetching cameras from Vermont DOT...');

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
          { name: 'state', search: { value: 'Vermont' }, s: true },
          { name: 'roadway', s: true },
          { name: 'location' },
          { data: 5, name: '' },
        ],
        order: [
          { column: 2, dir: 'asc' },
          { column: 1, dir: 'asc' },
        ],
        start,
        length,
        search: { value: '' },
      });

      const makeUrl = (query) =>
        `https://newengland511.org/List/GetData/Cameras?query=${encodeURIComponent(JSON.stringify(query))}&lang=en`;

      // Fetch one record to get the total count
      const countResponse = await Axios.get(makeUrl(makeQuery(0, 1)), { headers: apiHeaders });
      const totalCameras = countResponse.data.recordsFiltered;
      console.log(`Total cameras: ${totalCameras}`);

      const maxPage = Math.ceil(totalCameras / CAMERAS_PER_PAGE);
      const randomStart = Math.floor(Math.random() * maxPage) * CAMERAS_PER_PAGE;

      console.log(`Fetching page at offset ${randomStart}...`);
      const response = await Axios.get(makeUrl(makeQuery(randomStart, CAMERAS_PER_PAGE)), { headers: apiHeaders });

      const data = response.data;
      console.log(`Total cameras: ${data.recordsFiltered}, fetched ${data.data.length} from offset ${randomStart}`);

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
            url: `https://newengland511.org${img.imageUrl}`,
            latitude,
            longitude,
          };
        });

      console.log(`${cameras.length} cameras with images on this page`);
      return cameras;
    } catch (error) {
      console.error('Error fetching Vermont cameras:', error.message);
      return [];
    }
  }

}

const bot = new VermontBot();
if (require.main === module) bot.start();
module.exports = VermontBot;
