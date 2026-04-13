const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');

const numImagesPerVideoOptions = [10, 15, 20];

class OregonBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'oregon',
      timezone: 'America/Los_Angeles',
      tzAbbrev: 'PT',
      framerate: 5,
      delayBetweenImageFetches: 300000,
    });
  }

  getImageUrl() { return `${this.chosenCamera.url}?rand=${Date.now()}`; }
  getImageHeaders() { return { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36' }; }

  getNumImages() {
    return _.sample(numImagesPerVideoOptions);
  }

  async fetchCameras() {
    console.log('Fetching cameras from TripCheck...');

    try {
      const response = await Axios.get('https://www.tripcheck.com/Scripts/map/data/cctvinventory.js', {
        headers: {
          'Accept': '*/*',
          'Referer': 'https://www.tripcheck.com/',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
        },
        timeout: 15000,
      });

      const features = response.data.features || [];

      const cameras = features
        .filter(f => f.attributes && f.attributes.filename)
        .map(f => {
          const a = f.attributes;
          return {
            id: String(a.cameraId),
            name: a.title.trim(),
            url: `https://tripcheck.com/RoadCams/cams/${a.filename}`,
            latitude: a.latitude || 0,
            longitude: a.longitude || 0,
          };
        });

      console.log(`Found ${cameras.length} cameras`);
      return cameras;
    } catch (error) {
      console.error('Error fetching Oregon cameras:', error.message);
      return [];
    }
  }

}

const bot = new OregonBot();
if (require.main === module) bot.start();
module.exports = OregonBot;
