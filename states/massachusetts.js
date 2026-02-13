const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');
const { exec } = require('child_process');
const argv = require('minimist')(process.argv.slice(2));

const durationOptions = [60, 90, 120, 180, 240];
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

  async fetchCameras() {
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
      const response = await Axios.post('https://mass511.com/api/graphql', {
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

  async downloadVideoSegment(duration) {
    console.log(`Recording ${duration}s of video from ${this.chosenCamera.name}...`);

    const tempPath = `${this.assetDirectory}raw.ts`;
    const MIN_FILE_SIZE = 500 * 1024;

    const captureCmd = `ffmpeg -y -rw_timeout 15000000 -headers "Referer: https://mass511.com/\r\nOrigin: https://mass511.com\r\n" -t ${duration} -i "${this.chosenCamera.url}" -map 0:v:0 -c copy "${tempPath}"`;

    await new Promise((resolve, reject) => {
      exec(captureCmd, { timeout: (duration + 60) * 1000 }, (error) => {
        if (Fs.existsSync(tempPath) && Fs.statSync(tempPath).size > MIN_FILE_SIZE) {
          return resolve();
        }
        if (error) return reject(error);
        resolve();
      });
    });

    const encodeCmd = `ffmpeg -y -i "${tempPath}" -c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p -vf "setpts=0.5*PTS" -an "${this.pathToVideo}"`;

    await new Promise((resolve, reject) => {
      exec(encodeCmd, { timeout: 120000 }, (error) => {
        if (error) return reject(error);
        resolve();
      });
    });

    Fs.removeSync(tempPath);

    const stats = Fs.statSync(this.pathToVideo);
    const fileSizeInMB = stats.size / (1024 * 1024);
    console.log(`Video saved: ${this.pathToVideo} (${fileSizeInMB.toFixed(2)} MB)`);
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
        return;
      }

      const cameras = await this.fetchCameras();
      if (cameras.length === 0) {
        console.error('No cameras available');
        return;
      }

      if (!_.isUndefined(argv.id)) {
        this.chosenCamera = _.find(cameras, { id: argv.id });
      } else {
        this.chosenCamera = _.sample(cameras);
      }

      if (!this.chosenCamera) {
        console.error('Could not select a camera');
        return;
      }

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
bot.run();
