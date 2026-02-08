const TrafficBot = require('./TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');

const numImagesPerVideoOptions = [150, 300, 450, 600, 750, 900];

class OhioBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'ohio',
      timezone: 'America/New_York',
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
    const threeMonthsFromNow = new Date();
    threeMonthsFromNow.setMonth(threeMonthsFromNow.getMonth() + 3);

    const year = threeMonthsFromNow.getFullYear();
    const month = threeMonthsFromNow.getMonth() + 1;
    const day = threeMonthsFromNow.getDate();
    const dateStr = `${year}-${month}-${day}`;

    const ohgoUrl = `https://api.ohgo.com/road-markers/multi-markers?before=${dateStr}`;
    console.log(`Fetching cameras from API (before=${dateStr})...`);

    try {
      const response = await Axios.get(ohgoUrl);
      const cameraMarkers = response.data.CameraMarkers || [];

      const cameras = [];
      cameraMarkers.forEach((marker) => {
        if (marker.Cameras && marker.Cameras.length > 0) {
          marker.Cameras.forEach((camera, index) => {
            cameras.push({
              id: `${marker.Id}-${index}`,
              name: marker.Description,
              url: camera.LargeURL,
              location: marker.Location,
              latitude: marker.Latitude,
              longitude: marker.Longitude
            });
          });
        }
      });

      console.log(`Fetched ${cameras.length} cameras from API`);
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
          url: this.chosenCamera.url,
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

const bot = new OhioBot();
bot.run();
