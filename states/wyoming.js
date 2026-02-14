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

  getNumImages() {
    return _.sample(numImagesPerVideoOptions);
  }

  shouldAbort() {
    if (this.uniqueImageCount === 1) {
      console.log(`Camera ${this.chosenCamera.id}: ${this.chosenCamera.name} is frozen. Exiting`);
      return true;
    }
    return false;
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
        let src = match[1].replace(/&#x3D;/g, '=').replace(/&amp;/g, '&');
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

  async downloadImage(index, retries = 3) {
    const path = this.getImagePath(index);

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const writer = Fs.createWriteStream(path);

        const response = await Axios({
          url: this.chosenCamera.url,
          method: 'GET',
          responseType: 'stream',
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
          },
        });

        return await new Promise((resolve, reject) => {
          response.data.pipe(writer);
          writer.on('finish', () => {
            setTimeout(() => {
              try {
                const isUnique = this.checkAndStoreImage(path, index);
                resolve(isUnique);
              } catch (err) {
                reject(err);
              }
            }, 100);
          });
          writer.on('error', reject);
        });
      } catch (error) {
        console.log(`Error downloading image ${index} (attempt ${attempt}/${retries}): ${error.message}`);
        if (Fs.existsSync(path)) {
          Fs.removeSync(path);
        }

        if (attempt === retries) {
          throw error;
        }

        await this.sleep(1000 * Math.pow(2, attempt - 1));
      }
    }
  }
}

const bot = new WyomingBot();
bot.run();
