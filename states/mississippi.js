const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');
const { exec } = require('child_process');
const argv = require('minimist')(process.argv.slice(2));

const durationOptions = [60, 90, 120, 180];

class MississippiBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'mississippi',
      timezone: 'America/Chicago',
      tzAbbrev: 'CT',
      framerate: 5,
      delayBetweenImageFetches: 6000,
    });
  }

  getNumImages() {
    return _.sample([150, 300, 450, 600]);
  }

  async fetchCameras() {
    console.log('Fetching cameras from MDOT...');

    try {
      const response = await Axios.post('https://www.mdottraffic.com/default.aspx/LoadCameraData', '{}', {
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
          'Referer': 'https://www.mdottraffic.com/',
        },
      });

      const sites = response.data.d || [];
      const cameras = sites.map(site => {
        const siteId = site.markerid.replace('camsite_', '');
        return {
          id: siteId,
          name: site.tooltip,
          url: null, // resolved later from site page
          latitude: site.lat,
          longitude: site.lon,
        };
      });

      console.log(`Found ${cameras.length} camera sites`);
      return cameras;
    } catch (error) {
      console.error('Error fetching Mississippi cameras:', error.message);
      return [];
    }
  }

  async getStreamsForSite(siteId) {
    const response = await Axios.get(`https://www.mdottraffic.com/mapbubbles/camerasite.aspx?site=${siteId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
        'Referer': 'https://www.mdottraffic.com/',
      },
    });

    const html = response.data;
    const streams = [];

    // Extract from switchImage calls: switchImage('thumbnail_url', 'stream_id', 'title', 'desc', ...)
    const switchRegex = /switchImage\('(https:\/\/[^']+)',\s*'([^']+)',\s*'([^']+)',\s*'([^']*)'/g;
    let match;
    while ((match = switchRegex.exec(html)) !== null) {
      const [, thumbUrl, streamId, title] = match;
      const hostMatch = thumbUrl.match(/https:\/\/([^/]+)/);
      if (hostMatch) {
        streams.push({
          streamId,
          title,
          host: hostMatch[1],
          hlsUrl: `https://${hostMatch[1]}/rtplive/${streamId}.stream/playlist.m3u8`,
        });
      }
    }

    // If no switchImage calls, try the initial javaimgsrc
    if (streams.length === 0) {
      const initMatch = html.match(/javaimgsrc\s*=\s*"(https:\/\/([^/]+)\/thumbnail\?[^"]*streamname=([^&]+)[^"]*)"/);
      if (initMatch) {
        const [, , host, streamname] = initMatch;
        const streamId = streamname.replace('.stream', '');
        const titleMatch = html.match(/<p id="siteTitle"[^>]*>([^<]+)<\/p>/);
        streams.push({
          streamId,
          title: titleMatch ? titleMatch[1].trim() : `Site ${siteId}`,
          host,
          hlsUrl: `https://${host}/rtplive/${streamname}/playlist.m3u8`,
        });
      }
    }

    return streams;
  }

  async downloadVideoSegment(duration) {
    console.log(`Recording ${duration}s of video from ${this.chosenCamera.name}...`);

    const tempPath = `${this.assetDirectory}raw.ts`;
    const MIN_FILE_SIZE = 500 * 1024;

    const captureCmd = `ffmpeg -y -rw_timeout 15000000 -t ${duration} -i "${this.chosenCamera.url}" -map 0:v:0 -c copy "${tempPath}"`;

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

      // Select a site
      let selectedSite;
      if (!_.isUndefined(argv.id)) {
        selectedSite = _.find(cameras, { id: String(argv.id) });
      } else {
        selectedSite = _.sample(cameras);
      }

      if (!selectedSite) {
        console.error('Could not select a camera site');
        return;
      }

      console.log(`Selected site ${selectedSite.id}: ${selectedSite.name}`);

      // Fetch streams for this site
      const streams = await this.getStreamsForSite(selectedSite.id);
      if (streams.length === 0) {
        console.error('No streams found for this site');
        return;
      }

      const stream = _.sample(streams);
      console.log(`Stream: ${stream.title} (${stream.streamId})`);

      this.chosenCamera = {
        id: stream.streamId,
        name: stream.title,
        url: stream.hlsUrl,
        latitude: selectedSite.latitude,
        longitude: selectedSite.longitude,
      };

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

const bot = new MississippiBot();
bot.run();
