const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');
const { exec } = require('child_process');
const argv = require('minimist')(process.argv.slice(2));

const numImagesPerVideoOptions = [10, 15, 20];

const JANE_BYRNE_CAMERA = {
  id: 'jane-byrne',
  name: 'Jane Byrne Interchange (I-90/94/290)',
  url: 'https://media.travelmidwest.com:8443/GTIS/IK-0L.stream_GTIS/playlist.m3u8',
  hasVideo: true,
  latitude: 41.8799,
  longitude: -87.6545,
};

const SKYDECK_CAMERAS = [
  {
    id: 'skydeck-east',
    name: 'Willis Tower Skydeck',
    fecnetworkId: '22820',
    pageUrl: 'https://www.earthcam.com/usa/illinois/chicago/skydeck/',
    hasVideo: true,
    isEarthCam: true,
    latitude: 41.8789,
    longitude: -87.6359,
  },
  {
    id: 'skydeck-west',
    name: 'Willis Tower Skydeck (West View)',
    fecnetworkId: '42881',
    pageUrl: 'https://www.earthcam.com/usa/illinois/chicago/skydeck/',
    hasVideo: true,
    isEarthCam: true,
    latitude: 41.8789,
    longitude: -87.6359,
  },
  {
    id: 'skydeck-north',
    name: 'Willis Tower Skydeck (North View)',
    fecnetworkId: '27623',
    pageUrl: 'https://www.earthcam.com/usa/illinois/chicago/skydeck/',
    hasVideo: true,
    isEarthCam: true,
    latitude: 41.8789,
    longitude: -87.6359,
  },
];

const MIDWAY_CAMERA = {
  id: 'midway-airport',
  name: 'Chicago Midway Airport',
  fecnetworkId: '22172',
  pageUrl: 'https://www.earthcam.com/usa/illinois/chicago/midwayairport/',
  hasVideo: true,
  isEarthCam: true,
  latitude: 41.7868,
  longitude: -87.7522,
};

const MIDWAY_YOUTUBE_CAMERA = {
  id: 'midway-airport-youtube',
  name: 'Chicago Midway Airport',
  youtubeId: '67BCsiW-1Io',
  hasVideo: true,
  isYouTube: true,
  latitude: 41.7868,
  longitude: -87.7522,
};

const CINDYS_ROOFTOP_CAMERA = {
  id: 'cindys-rooftop',
  name: "Cindy's Rooftop",
  wetMetUid: 'e610a1ff04cc219eb91c779e8861c124',
  hasVideo: true,
  isWetMet: true,
  latitude: 41.8807,
  longitude: -87.6279,
};

const CHICAGO_RIVER_CAMERA = {
  id: 'chicago-river',
  name: 'Chicago River',
  wetMetUid: '4f3e81c8ba5bf5a0ff1768c88aba1f8c',
  hasVideo: true,
  isWetMet: true,
  latitude: 41.8887,
  longitude: -87.6281,
};

const CNW_POWERHOUSE_CAMERA = {
  id: 'cnw-powerhouse',
  name: 'Chicago & North Western Power House',
  youtubeId: 'InQ0-b4DkCw',
  hasVideo: true,
  isYouTube: true,
  latitude: 41.8819,
  longitude: -87.6373,
};

const WRIGLEY_CAMERA = {
  id: 'wrigley-field',
  name: 'Wrigley Field',
  shareApiClient: 'tJ90CoLmq7TzrY396Yd88LOc-jcDgi0ca-YNv3MI9rc!.tJ90CoLmq7TzrY396Yd88G8-6CLOrQYCFNszQ91PWAs!.tJ90CoLmq7TzrY396Yd88DGHDxm0NvViWeCn-Q5a6NQ!',
  shareApiContext: 'tJ90CoLmq7TzrY396Yd88DGHDxm0NvViWeCn-Q5a6NQ!',
  hasVideo: true,
  isEarthCamNet: true,
  latitude: 41.947119,
  longitude: -87.656272,
};

class IllinoisBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'illinois',
      timezone: 'America/Chicago',
      tzAbbrev: 'CT',
      framerate: 5,
      delayBetweenImageFetches: 300000,
      maxImageCollectionMs: 90 * 60 * 1000,
    });
  }

  getNumImages() {
    return _.sample(numImagesPerVideoOptions);
  }

  getTimeout() {
    return (Math.max(...numImagesPerVideoOptions) - 1) * this.delayBetweenImageFetches / 1000 + 600;
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
            hasVideo: false,
            latitude: a.y || 0,
            longitude: a.x || 0,
          };
        });

      cameras.push(JANE_BYRNE_CAMERA);
      cameras.push(...SKYDECK_CAMERAS);
      cameras.push(MIDWAY_CAMERA);
      cameras.push(MIDWAY_YOUTUBE_CAMERA);
      cameras.push(CINDYS_ROOFTOP_CAMERA);
      cameras.push(CHICAGO_RIVER_CAMERA);
      cameras.push(CNW_POWERHOUSE_CAMERA);
      cameras.push(WRIGLEY_CAMERA);
      console.log(`Found ${cameras.length} cameras (including Jane Byrne, Skydeck, and Midway Airport live video)`);
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
          timeout: 20000,
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

  async getCurrentChunklistUrl() {
    const masterResponse = await Axios.get(this.chosenCamera.url);
    const lines = masterResponse.data.split('\n').filter(l => l.trim() && !l.startsWith('#'));
    if (!lines[0]) throw new Error('No chunklist found in master playlist');
    const base = this.chosenCamera.url.substring(0, this.chosenCamera.url.lastIndexOf('/') + 1);
    return lines[0].startsWith('http') ? lines[0].trim() : base + lines[0].trim();
  }

  async downloadVideoSegment(duration) {
    console.log(`Recording ${duration}s of video from ${this.chosenCamera.name} in 60s segments...`);

    const SEG_DURATION = (this.chosenCamera.isEarthCam || this.chosenCamera.isEarthCamNet || this.chosenCamera.isYouTube || this.chosenCamera.isWetMet) ? 300 : 60;
    const numSegments = Math.ceil(duration / SEG_DURATION);
    const segmentPaths = [];

    const getNextUrl = () => {
      if (this.chosenCamera.isEarthCam) return this.getEarthCamStreamUrl(this.chosenCamera.fecnetworkId, this.chosenCamera.pageUrl);
      if (this.chosenCamera.isEarthCamNet) return this.getEarthCamNetStreamUrl(this.chosenCamera.shareApiClient, this.chosenCamera.shareApiContext);
      if (this.chosenCamera.isWetMet) return this.getWetMetStreamUrl(this.chosenCamera.wetMetUid);
      if (this.chosenCamera.isYouTube) return Promise.resolve(null); // URL not needed; yt-dlp handles fetching inline
      return this.getCurrentChunklistUrl();
    };

    // Pre-fetch the first URL before the loop starts
    let nextUrlPromise = getNextUrl();

    for (let i = 0; i < numSegments; i++) {
      const segDuration = Math.min(SEG_DURATION, duration - i * SEG_DURATION);
      const segPath = `${this.assetDirectory}seg-${i}.ts`;
      console.log(`Segment ${i + 1}/${numSegments} (${segDuration}s)...`);

      let chunklistUrl;
      try {
        chunklistUrl = await nextUrlPromise;
      } catch (err) {
        console.log(`Failed to get chunklist for segment ${i + 1}: ${err.message}`);
        // Fetch fresh for next segment before skipping
        if (i + 1 < numSegments) {
          nextUrlPromise = getNextUrl();
        }
        continue;
      }

      const referer = this.chosenCamera.isEarthCam ? 'https://www.earthcam.com/'
        : this.chosenCamera.isEarthCamNet ? 'https://share.earthcam.net/'
        : null;
      const earthCamFlags = referer ? `-headers 'Referer: ${referer}\\r\\n' ` : '';
      // For YouTube: streamlink downloads HLS segments using its own Python HTTP client,
      // which respects --force-ipv4 at the socket level. This avoids the problem where
      // yt-dlp/ffmpeg use different IPv6 source addresses than the one the CDN URL was
      // signed for, causing 403s. ffmpeg reads the piped bytes and makes no network calls.
      const captureCmd = this.chosenCamera.isYouTube
        ? `streamlink --force-ipv4 -o - "https://www.youtube.com/watch?v=${this.chosenCamera.youtubeId}" best | ffmpeg -y -t ${segDuration} -i pipe:0 -map 0:v:0 -c copy "${segPath}"`
        : `ffmpeg -y -rw_timeout 15000000 -t ${segDuration} ${earthCamFlags}-i "${chunklistUrl}" -map 0:v:0 -c copy "${segPath}"`;

      await new Promise((resolve) => {
        exec(captureCmd, { timeout: (segDuration + 30) * 1000 }, (error, _stdout, stderr) => {
          if (Fs.existsSync(segPath) && Fs.statSync(segPath).size > 100 * 1024) {
            segmentPaths.push(segPath);
          } else {
            const reason = error ? error.message : 'file too small or missing';
            console.log(`Segment ${i + 1} failed: ${reason}`);
            if (stderr) console.log(`ffmpeg stderr: ${stderr.slice(-500)}`);
            if (Fs.existsSync(segPath)) Fs.removeSync(segPath);
          }
          resolve();
        });

        // Pre-fetch next URL while this segment is recording
        if (i + 1 < numSegments) {
          const prefetchAfterMs = Math.max(0, (segDuration - 10) * 1000);
          setTimeout(() => {
            nextUrlPromise = getNextUrl();
          }, prefetchAfterMs);
        }
      });
    }

    if (segmentPaths.length === 0) {
      throw new Error('No segments captured');
    }

    console.log(`Captured ${segmentPaths.length}/${numSegments} segments, concatenating...`);
    const tempPath = `${this.assetDirectory}raw.ts`;

    await new Promise((resolve, reject) => {
      exec(`cat ${segmentPaths.map(p => `"${p}"`).join(' ')} > "${tempPath}"`, (error) => {
        if (error) return reject(error);
        resolve();
      });
    });

    segmentPaths.forEach(p => Fs.removeSync(p));

    const setpts = this.getSetpts(duration);
    const outputDurationS = duration / this.videoSpeedFactor;
    const targetBitrateKbps = Math.floor((90 * 1024 * 1024 * 8) / outputDurationS / 1000);
    const encodeCmd = `ffmpeg -y -i "${tempPath}" -c:v libx264 -preset ultrafast -b:v ${targetBitrateKbps}k -pix_fmt yuv420p -vf "setpts=${setpts}*PTS" -an "${this.pathToVideo}"`;

    await new Promise((resolve, reject) => {
      exec(encodeCmd, { timeout: (duration * 2 + 300) * 1000 }, (error) => {
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
      if (argv.event === 'sunrise' || argv.event === 'sunset') this.sunEvent = argv.event;
      console.log(`ID ${this.chosenCamera.id}: ${this.chosenCamera.name} (${this.chosenCamera.hasVideo ? 'video' : 'image'})`);
      Fs.ensureDirSync(this.assetDirectory);

      this.startTime = new Date();

      if (this.chosenCamera.hasVideo) {
        const duration = argv.duration ? parseInt(argv.duration) : _.sample(TrafficBot.DEFAULT_DURATION_OPTIONS);
        await this.downloadVideoSegment(duration);
      } else {
        const numImages = this.getNumImages();
        console.log(`Downloading ${numImages} images every ${this.delayBetweenImageFetches / 1000}s...`);

        if (this.chosenCamera.latitude && this.chosenCamera.longitude) {
          this.weatherStart = await this.fetchWeather(this.chosenCamera.latitude, this.chosenCamera.longitude);
        }

        let currentDelay = this.delayBetweenImageFetches;
        const maxDelay = this.delayBetweenImageFetches * 4;
        const collectionStart = Date.now();
        for (let i = 0; i < numImages; i++) {
          const countBefore = this.uniqueImageCount;
          await this.downloadImage(i);
          const wasUnique = this.uniqueImageCount > countBefore;
          if (i >= 9 && this.shouldAbort()) return;
          if (i < numImages - 1) {
            if (!wasUnique) {
              const newDelay = Math.min(Math.round(currentDelay * 1.5), maxDelay);
              if (newDelay !== currentDelay) {
                console.log(`Duplicate image, increasing interval to ${newDelay / 1000}s`);
                currentDelay = newDelay;
              }
            } else {
              currentDelay = this.delayBetweenImageFetches;
            }
            if (Date.now() - collectionStart + currentDelay > this.maxImageCollectionMs) {
              console.log(`Max collection time reached after ${i + 1} images, stopping early`);
              break;
            }
            await this.sleep(currentDelay);
          }
        }

        if (this.chosenCamera.latitude && this.chosenCamera.longitude) {
          this.weatherEnd = await this.fetchWeather(this.chosenCamera.latitude, this.chosenCamera.longitude);
        }

        if (this.shouldAbort()) return;
        await this.createVideo();
      }

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

const bot = new IllinoisBot();
if (require.main === module) bot.start();
module.exports = IllinoisBot;
