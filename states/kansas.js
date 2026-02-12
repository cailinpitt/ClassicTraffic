const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');

const numImagesPerVideoOptions = [150, 300, 450, 600, 750, 900];

const GRAPHQL_URL = 'https://www.kandrive.gov/api/graphql';
const GRAPHQL_QUERY = `query ($input: ListArgs!) {
  listCameraViewsQuery(input: $input) {
    cameraViews {
      category
      title
      uri
      url
      parentCollection {
        title
        uri
        location {
          routeDesignator
        }
      }
    }
    totalRecords
  }
}`;

class KansasBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'kansas',
      timezone: 'America/Chicago',
      tzAbbrev: 'CT',
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
    console.log('Fetching cameras from KanDrive...');

    try {
      const cameras = [];
      let offset = 0;
      const limit = 100;
      let totalRecords = Infinity;

      while (offset < totalRecords) {
        const response = await Axios.post(GRAPHQL_URL, {
          query: GRAPHQL_QUERY,
          variables: {
            input: {
              west: -180,
              south: -85,
              east: 180,
              north: 85,
              sortDirection: 'DESC',
              sortType: 'ROADWAY',
              freeSearchTerm: '',
              classificationsOrSlugs: [],
              recordLimit: limit,
              recordOffset: offset,
            },
          },
        }, {
          headers: {
            'Content-Type': 'application/json',
            'Accept': '*/*',
            'Origin': 'https://www.kandrive.gov',
            'Referer': 'https://www.kandrive.gov/',
            'Language': 'en',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
          },
        });

        const data = response.data.data.listCameraViewsQuery;
        totalRecords = data.totalRecords;

        for (const view of data.cameraViews) {
          if (view.category !== 'IMAGE' || !view.url) continue;

          // uri is like "camera/3929/1723738802" - extract camera ID
          const uriParts = view.uri.split('/');
          const id = uriParts[1] || view.uri;

          // Strip the cache-busting timestamp from the base URL
          const baseUrl = view.url.replace(/\?\d+$/, '');

          cameras.push({
            id,
            name: view.title,
            url: baseUrl,
            latitude: 0,
            longitude: 0,
          });
        }

        offset += limit;
      }

      console.log(`Found ${cameras.length} cameras`);
      return cameras;
    } catch (error) {
      console.error('Error fetching KanDrive cameras:', error.message);
      return [];
    }
  }

  async downloadImage(index, retries = 3) {
    const path = this.getImagePath(index);

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const writer = Fs.createWriteStream(path);

        // Add fresh timestamp for cache-busting
        const url = `${this.chosenCamera.url}?${Date.now()}`;

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

const bot = new KansasBot();
bot.run();
