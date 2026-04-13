const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');

const numImagesPerVideoOptions = [150, 300, 450, 600, 750, 900];

class MichiganBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'michigan',
      timezone: 'America/Detroit',
      tzAbbrev: 'ET',
      framerate: 10,
      delayBetweenImageFetches: 6000,
      threadProbability: 0.25,
    });
  }

  getImageHeaders() { return { Referer: 'https://mdotjboss.state.mi.us/MiDrive/cameras' }; }

  getNumImages() {
    return _.sample(numImagesPerVideoOptions);
  }

  async fetchCameras() {
    console.log('Fetching cameras from MiDrive...');

    try {
      const response = await Axios.get('https://mdotjboss.state.mi.us/MiDrive//camera/list', {
        headers: {
          'Accept': 'application/json',
          'Referer': 'https://mdotjboss.state.mi.us/MiDrive/cameras',
          'X-Requested-With': 'XMLHttpRequest',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
        },
      });

      const cameras = response.data
        .filter(cam => {
          const srcMatch = cam.image && cam.image.match(/src="([^"]+)"/);
          return srcMatch;
        })
        .map(cam => {
          const srcMatch = cam.image.match(/src="([^"]+)"/);
          const idMatch = cam.image.match(/id="(\d+)Img"/);
          const coordMatch = cam.county && cam.county.match(/lat=([-\d.]+)&lon=([-\d.]+)/);

          return {
            id: idMatch ? idMatch[1] : srcMatch[1],
            name: `${cam.route}${cam.location}`.trim(),
            url: srcMatch[1],
            latitude: coordMatch ? parseFloat(coordMatch[1]) : 0,
            longitude: coordMatch ? parseFloat(coordMatch[2]) : 0,
          };
        });

      console.log(`Found ${cameras.length} cameras`);
      return cameras;
    } catch (error) {
      console.error('Error fetching Michigan cameras:', error.message);
      return [];
    }
  }
}

const bot = new MichiganBot();
if (require.main === module) bot.start();
module.exports = MichiganBot;
