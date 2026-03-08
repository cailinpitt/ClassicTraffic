const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');

const numImagesPerVideoOptions = [150, 300, 450, 600, 750, 900];

class IllinoisBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'illinois',
      timezone: 'America/Chicago',
      tzAbbrev: 'CT',
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
    console.log('Fetching cameras from IDOT ArcGIS...');

    const base = 'https://services2.arcgis.com/aIrBD8yn1TDTEXoz/arcgis/rest/services/TrafficCamerasTM_Public/FeatureServer/0/query';

    try {
      const countResponse = await Axios.get(base, {
        params: { where: "TooOld='false'", returnCountOnly: true, f: 'json' },
      });
      const total = countResponse.data.count;
      console.log(`Total cameras: ${total}`);

      const pageSize = 50;
      const offset = Math.floor(Math.random() * Math.max(0, total - pageSize));

      const response = await Axios.get(base, {
        params: {
          where: "TooOld='false'",
          outFields: 'OBJECTID,CameraLocation,CameraDirection,SnapShot,y,x',
          resultOffset: offset,
          resultRecordCount: pageSize,
          f: 'json',
        },
      });

      const cameras = (response.data.features || [])
        .filter(f => f.attributes.SnapShot)
        .map(f => {
          const a = f.attributes;
          const dir = a.CameraDirection && a.CameraDirection !== 'NONE' ? ` (${a.CameraDirection})` : '';
          return {
            id: a.OBJECTID,
            name: `${a.CameraLocation}${dir}`,
            url: a.SnapShot,
            latitude: a.y || 0,
            longitude: a.x || 0,
          };
        });

      console.log(`Found ${cameras.length} cameras`);
      return cameras;
    } catch (error) {
      console.error('Error fetching cameras:', error.message);
      return [];
    }
  }

  async downloadImage(index, retries = 3) {
    const path = this.getImagePath(index);

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const writer = Fs.createWriteStream(path);

        const response = await Axios({
          url: `${this.chosenCamera.url}?t=${Date.now()}`,
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

const bot = new IllinoisBot();
bot.start();
