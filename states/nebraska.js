const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');

const numImagesPerVideoOptions = [15, 30, 45];
const CAMERAS_PER_PAGE = 25;

const GRAPHQL_QUERY = `query ($input: ListArgs!) {
  listCameraViewsQuery(input: $input) {
    cameraViews { title uri url }
    totalRecords
  }
}`;

class NebraskaBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'nebraska',
      timezone: 'America/Chicago',
      tzAbbrev: 'CT',
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
    console.log('Fetching cameras from Nebraska 511...');

    try {
      const makeRequest = (offset, limit) => Axios.post(
        'https://www.511.nebraska.gov/api/graphql',
        {
          query: GRAPHQL_QUERY,
          variables: {
            input: {
              west: -180, south: -85, east: 180, north: 85,
              sortDirection: 'DESC', sortType: 'ROADWAY',
              freeSearchTerm: '', classificationsOrSlugs: [],
              recordLimit: limit, recordOffset: offset,
            },
          },
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'language': 'en',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
          },
        }
      );

      // Fetch one record to get total count
      const countResponse = await makeRequest(0, 1);
      const totalCameras = countResponse.data.data.listCameraViewsQuery.totalRecords;
      console.log(`Total cameras: ${totalCameras}`);

      // Fetch a random page
      const maxPage = Math.ceil(totalCameras / CAMERAS_PER_PAGE);
      const randomStart = Math.floor(Math.random() * maxPage) * CAMERAS_PER_PAGE;

      console.log(`Fetching page at offset ${randomStart}...`);
      const response = await makeRequest(randomStart, CAMERAS_PER_PAGE);

      const cameraViews = response.data.data.listCameraViewsQuery.cameraViews || [];
      console.log(`Fetched ${cameraViews.length} cameras from offset ${randomStart}`);

      const cameras = cameraViews
        .filter(cam => cam.url)
        .map(cam => ({
          id: cam.uri,
          name: cam.title,
          url: cam.url,
          latitude: 0,
          longitude: 0,
        }));

      console.log(`${cameras.length} cameras with images on this page`);
      return cameras;
    } catch (error) {
      console.error('Error fetching Nebraska cameras:', error.message);
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

const bot = new NebraskaBot();
bot.run();
