const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const _ = require('lodash');

const numImagesPerVideoOptions = [15, 20, 30, 45];

class WashingtonBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'washington',
      timezone: 'America/Los_Angeles',
      tzAbbrev: 'PT',
      framerate: 10,
      delayBetweenImageFetches: 120000,
    });
  }

  getImageUrl() { return `${this.chosenCamera.url}?a=${Date.now()}`; }

  getNumImages() {
    return _.sample(numImagesPerVideoOptions);
  }

  getTimeout() {
    return (Math.max(...numImagesPerVideoOptions) - 1) * (this.delayBetweenImageFetches * 4) / 1000 + 600;
  }

  async fetchCameras() {
    console.log('Fetching cameras from WSDOT...');

    try {
      const response = await Axios.get('https://data.wsdot.wa.gov/mobile/Cameras.json', {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
        },
      });

      const items = response.data?.cameras?.items || [];

      const cameras = items
        .filter(cam => cam.url && cam.title)
        .map(cam => ({
          id: String(cam.id),
          name: cam.title,
          url: cam.url,
          latitude: cam.lat || 0,
          longitude: cam.lon || 0,
        }));

      console.log(`Found ${cameras.length} cameras`);
      return cameras;
    } catch (error) {
      console.error('Error fetching WSDOT cameras:', error.message);
      return [];
    }
  }

}

const bot = new WashingtonBot();
if (require.main === module) bot.start();
module.exports = WashingtonBot;
