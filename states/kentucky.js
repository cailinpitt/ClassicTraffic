const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');

const numImagesPerVideoOptions = [150, 300, 450, 600, 750, 900];

class KentuckyBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'kentucky',
      timezone: 'America/New_York',
      tzAbbrev: 'ET',
      framerate: 10,
      delayBetweenImageFetches: 6000,
      threadProbability: 0.25,
    });
  }

  getImageUrl() { return `${this.chosenCamera.url}?t=${Date.now()}`; }
  getImageHeaders() { return { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36' }; }

  getNumImages() {
    return _.sample(numImagesPerVideoOptions);
  }

  async fetchCameras() {
    console.log('Fetching cameras from KYTC...');

    try {
      const response = await Axios.get('https://services2.arcgis.com/CcI36Pduqd0OR4W9/arcgis/rest/services/trafficCamerasCur_Prd/FeatureServer/0/query', {
        params: {
          where: "snapshot LIKE '%milestone%'",
          outFields: 'OBJECTID,description,snapshot,latitude,longitude',
          f: 'json',
          resultRecordCount: 1000,
        },
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
        },
      });

      const cameras = (response.data.features || [])
        .filter(f => f.attributes.snapshot && f.attributes.description)
        .map(f => {
          const a = f.attributes;
          return {
            id: String(a.OBJECTID),
            name: a.description,
            url: a.snapshot.replace(/^http:/, 'https:'),
            latitude: a.latitude || 0,
            longitude: a.longitude || 0,
          };
        });

      console.log(`Found ${cameras.length} cameras`);
      return cameras;
    } catch (error) {
      console.error('Error fetching KYTC cameras:', error.message);
      return [];
    }
  }

}

const bot = new KentuckyBot();
if (require.main === module) bot.start();
module.exports = KentuckyBot;
