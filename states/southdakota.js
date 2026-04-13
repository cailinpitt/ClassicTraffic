const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');

const numImagesPerVideoOptions = [10, 15, 20];

class SouthDakotaBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'southdakota',
      timezone: 'America/Chicago',
      tzAbbrev: 'CT',
      framerate: 5,
      delayBetweenImageFetches: 600000,
    });
  }

  getNumImages() {
    return _.sample(numImagesPerVideoOptions);
  }

  getTimeout() {
    return (Math.max(...numImagesPerVideoOptions) - 1) * this.delayBetweenImageFetches / 1000 + 600;
  }

  async fetchCameras() {
    console.log('Fetching cameras from SD511...');

    try {
      const response = await Axios.get('https://sd.cdn.iteris-atis.com/geojson/icons/metadata/icons.cameras.geojson', {
        headers: {
          'Referer': 'https://www.sd511.org/',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
          'Accept': 'application/json',
        },
      });

      const features = response.data.features || [];
      const cameras = [];

      for (const f of features) {
        const p = f.properties;
        if (!p || !p.cameras || p.cameras.length === 0) continue;

        const coords = f.geometry?.coordinates || [0, 0];
        const latitude = parseFloat(coords[1]);
        const longitude = parseFloat(coords[0]);

        for (const cam of p.cameras) {
          if (!cam.image) continue;

          cameras.push({
            id: `${f.id}-${cam.id}`,
            name: cam.description || `${p.name} - ${cam.name}`,
            url: cam.image,
            latitude,
            longitude,
          });
        }
      }

      console.log(`Found ${cameras.length} camera views`);
      return cameras;
    } catch (error) {
      console.error('Error fetching South Dakota cameras:', error.message);
      return [];
    }
  }

}

const bot = new SouthDakotaBot();
if (require.main === module) bot.start();
module.exports = SouthDakotaBot;
