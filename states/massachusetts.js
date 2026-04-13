const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');
const { exec } = require('child_process');
const argv = require('minimist')(process.argv.slice(2));

const durationOptions = [60, 90, 120, 180, 240, 480, 960];
const CAMERAS_PER_PAGE = 25;

class MassachusettsBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'massachusetts',
      timezone: 'America/New_York',
      tzAbbrev: 'ET',
      framerate: 10,
      delayBetweenImageFetches: 6000,
    });
  }

  getCaptureFlags() { return '-rw_timeout 15000000 -headers "Referer: https://mass511.com/\\r\\nOrigin: https://mass511.com\\r\\n"'; }

  async fetchCameras(options = {}) {
    console.log('Fetching cameras from Mass511...');

    try {
      const query = `query ($input: ListArgs!) {
        listCameraViewsQuery(input: $input) {
          cameraViews {
            category
            title
            uri
            url
            sources { type src }
            parentCollection {
              title
              uri
              location { routeDesignator }
            }
          }
          totalRecords
          error { message type }
        }
      }`;

      const headers = {
        'Content-Type': 'application/json',
        'Accept': '*/*',
        'Language': 'en',
        'Origin': 'https://mass511.com',
        'Referer': 'https://mass511.com/list/cameras',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
      };

      let response;
      if (options.limit) {
        response = await Axios.post('https://mass511.com/api/graphql', {
          query,
          variables: {
            input: {
              west: -180, south: -85, east: 180, north: 85,
              sortDirection: 'DESC',
              sortType: 'ROADWAY',
              freeSearchTerm: options.search || '',
              classificationsOrSlugs: [],
              recordLimit: options.limit,
              recordOffset: 0,
            },
          },
        }, { headers });
      } else {
        // Fetch one record to get the total count
        const countResponse = await Axios.post('https://mass511.com/api/graphql', {
          query,
          variables: {
            input: {
              west: -180, south: -85, east: 180, north: 85,
              sortDirection: 'DESC',
              sortType: 'ROADWAY',
              freeSearchTerm: '',
              classificationsOrSlugs: [],
              recordLimit: 1,
              recordOffset: 0,
            },
          },
        }, { headers });

        const totalCameras = countResponse.data.data.listCameraViewsQuery.totalRecords;
        console.log(`Total cameras: ${totalCameras}`);
        const maxPage = Math.ceil(totalCameras / CAMERAS_PER_PAGE);
        const randomOffset = Math.floor(Math.random() * maxPage) * CAMERAS_PER_PAGE;
        console.log(`Fetching page at offset ${randomOffset}...`);
        response = await Axios.post('https://mass511.com/api/graphql', {
          query,
          variables: {
            input: {
              west: -180, south: -85, east: 180, north: 85,
              sortDirection: 'DESC',
              sortType: 'ROADWAY',
              freeSearchTerm: '',
              classificationsOrSlugs: [],
              recordLimit: CAMERAS_PER_PAGE,
              recordOffset: randomOffset,
            },
          },
        }, { headers });
      }

      const data = response.data.data.listCameraViewsQuery;
      if (data.error) {
        throw new Error(`API error: ${data.error.message}`);
      }

      const cameras = (data.cameraViews || [])
        .filter(cam => {
          const hlsSource = cam.sources && cam.sources.find(s => s.type === 'application/x-mpegURL');
          return hlsSource && hlsSource.src;
        })
        .map(cam => {
          const hlsSource = cam.sources.find(s => s.type === 'application/x-mpegURL');
          return {
            id: cam.uri,
            name: cam.title || cam.parentCollection?.title || 'Unknown',
            url: hlsSource.src,
            latitude: 0,
            longitude: 0,
          };
        });

      console.log(`${cameras.length} cameras with HLS streams on this page`);
      return cameras;
    } catch (error) {
      console.error('Error fetching Massachusetts cameras:', error.message);
      return [];
    }
  }

  async fetchAllCameras(highway) {
    return this.fetchCameras({ search: highway, limit: 500 });
  }

  async run() {
    this.cleanupStaleAssets();

    if (argv.list) {
      try {
        await this.listCameras();
      } catch (error) {
        console.error(error);
        process.exitCode = 1;
      }
      return;
    }

    try {
      const keys = require('../keys.js');
      const account = keys.accounts[this.accountName];
      if (!account) {
        throw new Error(`Account '${this.accountName}' not found in keys.js`);
      }

      const { AtpAgent } = require('@atproto/api');
      this.agent = new AtpAgent({ service: keys.service });

      await this.agent.login({
        identifier: account.identifier,
        password: account.password,
      });

      if (!this.agent.session?.did) {
        console.error('Failed to get DID after login');
        process.exitCode = 1;
        return;
      }

      const cameras = await this.fetchCameras();
      if (cameras.length === 0) {
        console.error('No cameras available');
        process.exitCode = 1;
        return;
      }

      if (!_.isUndefined(argv.id)) {
        this.chosenCamera = _.find(cameras, { id: argv.id });
      } else {
        const recentIds = this.getRecentCameraIds();
        const filtered = cameras.filter(c => !recentIds.includes(String(c.id)));
        const pool = filtered.length > 0 ? filtered : cameras;
        this.chosenCamera = _.sample(pool);
      }

      if (!this.chosenCamera) {
        console.error('Could not select a camera');
        process.exitCode = 1;
        return;
      }

      this.saveRecentCameraId(this.chosenCamera.id);
      console.log(`ID ${this.chosenCamera.id}: ${this.chosenCamera.name}`);
      Fs.ensureDirSync(this.assetDirectory);

      this.startTime = new Date();

      const duration = _.sample(durationOptions);
      await this.downloadVideoSegment(duration);

      this.endTime = new Date();

      if (argv['dry-run']) {
        console.log('Dry run - skipping post to Bluesky');
      } else {
        await this.postToBluesky();
      }
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    } finally {
      this.cleanup();
    }
  }
}

const bot = new MassachusettsBot();
if (require.main === module) bot.start();
module.exports = MassachusettsBot;
