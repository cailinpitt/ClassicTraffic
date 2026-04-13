const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');

const numImagesPerVideoOptions = [10, 15, 20];

class AlabamaBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'alabama',
      timezone: 'America/Chicago',
      tzAbbrev: 'CT',
      framerate: 5,
      delayBetweenImageFetches: 900000,
      maxImageCollectionMs: 14400000, // 4 hours — stop collecting early if delays inflate
    });
  }

  getImageHeaders() { return { Referer: 'https://algotraffic.com/' }; }

  getNumImages() {
    return _.sample(numImagesPerVideoOptions);
  }

  getTimeout() {
    return 18000; // 5 hours: up to 4h image collection + 1h buffer to process and post
  }

  async fetchCameras() {
    console.log('Fetching cameras from ALDOT...');

    try {
      const response = await Axios.get('https://api.algotraffic.com/v4.0/Cameras', {
        headers: {
          'Accept': 'application/json',
          'Origin': 'https://algotraffic.com',
          'Referer': 'https://algotraffic.com/',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
        },
      });

      const data = response.data;
      console.log(`Total cameras: ${data.length}`);

      const cameras = data
        .filter(cam => cam.snapshotImageUrl && cam.accessLevel === 'Public')
        .map(cam => {
          const loc = cam.location;
          const route = loc.displayRouteDesignator || '';
          const cross = loc.displayCrossStreet || '';
          const city = loc.city || '';
          const direction = loc.direction || '';

          let name = route;
          if (cross) name += ` at ${cross}`;
          if (city) name += `, ${city}`;
          if (direction) name += ` (${direction})`;

          return {
            id: cam.id,
            name,
            url: cam.snapshotImageUrl,
            latitude: loc.latitude || 0,
            longitude: loc.longitude || 0,
          };
        });

      console.log(`${cameras.length} active cameras`);
      return cameras;
    } catch (error) {
      console.error('Error fetching Alabama cameras:', error.message);
      return [];
    }
  }
}

const bot = new AlabamaBot();
if (require.main === module) bot.start();
module.exports = AlabamaBot;
