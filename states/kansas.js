const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');

const numImagesPerVideoOptions = [15, 20, 30, 45];

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

  getImageUrl() { return `${this.chosenCamera.url}?t=${Date.now()}`; }
  getImageHeaders() { return { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36' }; }

  getNumImages() {
    return _.sample(numImagesPerVideoOptions);
  }

  getTimeout() {
    return (Math.max(...numImagesPerVideoOptions) - 1) * (this.delayBetweenImageFetches * 4) / 1000 + 600;
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

}

const bot = new KansasBot();
if (require.main === module) bot.start();
module.exports = KansasBot;
