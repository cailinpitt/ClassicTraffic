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
            'Referer': 'https://mdotjboss.state.mi.us/MiDrive/cameras',
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

const bot = new MichiganBot();
bot.run();
