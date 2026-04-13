const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');

const numImagesPerVideoOptions = [10, 15, 20];

class WyomingBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'wyoming',
      timezone: 'America/Denver',
      tzAbbrev: 'MT',
      framerate: 5,
      delayBetweenImageFetches: 120000,
    });
  }

  getImageHeaders() { return { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36' }; }

  getNumImages() {
    return _.sample(numImagesPerVideoOptions);
  }

  getTimeout() {
    return (Math.max(...numImagesPerVideoOptions) - 1) * (this.delayBetweenImageFetches * 4) / 1000 + 600;
  }

  async fetchCameras() {
    console.log('Fetching cameras from WYDOT...');

    try {
      const response = await Axios.get('https://www.wyoroad.info/pls/Browse/WRR.Cameras', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
        },
        timeout: 30000,
      });

      const html = response.data;

      // Parse images: src="/web-cam/cache?ref=..." alt="Web Camera at LOCATION - DIRECTION showing ROUTE"
      const imgRegex = /src="(\/web-cam\/cache\?ref=[^"]+)"[^>]*alt="Web Camera at ([^"]+)"/g;
      const locations = new Map();
      let match;

      while ((match = imgRegex.exec(html)) !== null) {
        let src = match[1].replace(/&#x3D;/g, '=').replace(/&amp;/g, '&').replace(/&thumb=true$/i, '');
        const alt = match[2];

        // Parse: "I 80 Evanston - West showing I80 near Evanston"
        // or: "I 25 Cheyenne Port of Entry showing I25 near Cheyenne"
        const parts = alt.match(/^(.+?) showing (.+)$/);
        if (!parts) continue;

        const fullName = parts[1].trim();
        const routeInfo = parts[2].trim();

        // Split location and direction if present
        const dirMatch = fullName.match(/^(.+?) - (.+)$/);
        const locationName = dirMatch ? dirMatch[1].trim() : fullName;
        const direction = dirMatch ? dirMatch[2].trim() : 'default';

        // Skip "Road Surface" views - prefer traffic views
        if (direction === 'Road Surface') continue;

        const id = locationName.replace(/\s+/g, '');

        if (!locations.has(id)) {
          locations.set(id, {
            id: id,
            name: `${locationName} (${routeInfo})`,
            url: `https://www.wyoroad.info${src}`,
            latitude: 0,
            longitude: 0,
          });
        }
      }

      const cameras = Array.from(locations.values());
      console.log(`Found ${cameras.length} cameras`);
      return cameras;
    } catch (error) {
      console.error('Error fetching WYDOT cameras:', error.message);
      return [];
    }
  }
}

const bot = new WyomingBot();
if (require.main === module) bot.start();
module.exports = WyomingBot;
