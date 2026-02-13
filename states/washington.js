const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');
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

  async downloadImage(index, retries = 3) {
    const path = this.getImagePath(index);

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const writer = Fs.createWriteStream(path);

        const response = await Axios({
          url: `${this.chosenCamera.url}?a=${Date.now()}`,
          method: 'GET',
          responseType: 'stream',
          timeout: 10000,
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

const bot = new WashingtonBot();
bot.run();
