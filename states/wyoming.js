const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');

const numImagesPerVideoOptions = [10, 15, 20];

// WYDOT hex-encodes slashes and ampersands in both hrefs and titles.
function decodeEntities(str) {
  return String(str)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

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

      // Parse links: <a href="/web-cam/cache?ref=..." title="View camera at LOCATION - DIRECTION on ROUTE">
      const imgRegex = /<a\s+href="(\/web-cam\/cache\?ref=[^"]+)"[^>]*?title="View camera at ([^"]+)"/g;
      const locations = new Map();
      let match;

      while ((match = imgRegex.exec(html)) !== null) {
        let src = decodeEntities(match[1]).replace(/&thumb=true$/i, '');
        const alt = decodeEntities(match[2]);

        // Parse: "I 80 Evanston - West on I80"
        // or: "I 25 Cheyenne Port of Entry on I25"
        // Greedy first group so the split lands on the final " on ".
        const parts = alt.match(/^(.*) on (.+)$/);
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
