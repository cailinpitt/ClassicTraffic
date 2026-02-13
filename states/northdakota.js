const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');

const numImagesPerVideoOptions = [10, 15, 20];

class NorthDakotaBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'northdakota',
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
    console.log('Fetching cameras from North Dakota DOT...');

    try {
      const response = await Axios.get('https://travelfiles.dot.nd.gov/geojson/cameras/1770735753007/cameras.json', {
        headers: {
          'Referer': 'https://travel.dot.nd.gov/',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
          'Accept': 'application/json',
        },
      });

      const features = response.data.features || [];
      const cameras = [];

      for (const f of features) {
        const props = f.properties;
        if (!props || !props.Cameras || props.Cameras.length === 0) continue;

        const coords = f.geometry?.coordinates || [0, 0];
        const longitude = parseFloat(coords[0]);
        const latitude = parseFloat(coords[1]);

        for (const cam of props.Cameras) {
          if (!cam.FullPath) continue;
          // Skip pavement-only views
          if (cam.Direction === 'Pavement') continue;

          cameras.push({
            id: `${f.id}-${cam.Direction}`,
            name: cam.Description.replace(/ - NDDOT$/, ''),
            url: cam.FullPath,
            latitude,
            longitude,
          });
        }
      }

      console.log(`Found ${cameras.length} camera views`);
      return cameras;
    } catch (error) {
      console.error('Error fetching North Dakota cameras:', error.message);
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
            'Referer': 'https://travel.dot.nd.gov/',
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

const bot = new NorthDakotaBot();
bot.run();
