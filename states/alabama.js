const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');

const numImagesPerVideoOptions = [15, 30, 45];

class AlabamaBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'alabama',
      timezone: 'America/Chicago',
      tzAbbrev: 'CT',
      framerate: 5,
      delayBetweenImageFetches: 900000,
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
            'Referer': 'https://algotraffic.com/',
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

const bot = new AlabamaBot();
bot.run();
