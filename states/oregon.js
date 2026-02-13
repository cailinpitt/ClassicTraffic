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

  async downloadImage(index, retries = 3) {
    const path = this.getImagePath(index);

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const writer = Fs.createWriteStream(path);

        const url = `${this.chosenCamera.url}?rand=${Date.now()}`;

        const response = await Axios({
          url,
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

const bot = new OregonBot();
bot.run();
