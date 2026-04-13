const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');

const numImagesPerVideoOptions = [10, 15, 20];
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

}

const bot = new NebraskaBot();
if (require.main === module) bot.start();
module.exports = NebraskaBot;
