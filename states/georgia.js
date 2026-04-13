const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');
const { exec } = require('child_process');
const argv = require('minimist')(process.argv.slice(2));

const durationOptions = [60, 90, 120, 180, 240, 360, 480, 960];
const numImagesPerVideoOptions = [150, 300, 450, 600, 750, 900];
const CAMERAS_PER_PAGE = 10;
const DIVAS_AUTH_URL = 'https://divas.cloud/VDS-API/SecureTokenUri/GetSecureTokenUriBySourceId';

const GEORGIA_AQUARIUM_CAMERAS = [
  { id: 'ga-aquarium-ocean-voyager',      name: 'Georgia Aquarium - Ocean Voyager',         ozolioOid: 'EMB_PNKJ00000043' },
  { id: 'ga-aquarium-beluga',             name: 'Georgia Aquarium - Beluga Whales',          ozolioOid: 'EMB_MUFZ00000624' },
  { id: 'ga-aquarium-sharks',             name: 'Georgia Aquarium - Predators of the Deep',  ozolioOid: 'EMB_OLQS00000697' },
  { id: 'ga-aquarium-penguins',           name: 'Georgia Aquarium - African Penguins',       ozolioOid: 'EMB_TEEZ0000008E' },
  { id: 'ga-aquarium-sea-lions',          name: 'Georgia Aquarium - California Sea Lions',   ozolioOid: 'EMB_GFVG0000003E' },
  { id: 'ga-aquarium-barrier-reef',       name: 'Georgia Aquarium - Indo-Pacific Reef',      ozolioOid: 'EMB_EECM00000453' },
  { id: 'ga-aquarium-jellies',            name: 'Georgia Aquarium - Jellies',                ozolioOid: 'EMB_AHAJ0000010B' },
  { id: 'ga-aquarium-puffins',            name: 'Georgia Aquarium - Puffins',                ozolioOid: 'EMB_ZZKB00000796' },
  { id: 'ga-aquarium-sea-otters',         name: 'Georgia Aquarium - Southern Sea Otters',    ozolioOid: 'EMB_TWUL00000089' },
].map(c => ({ ...c, hasVideo: true, isOzolio: true, latitude: 33.7633, longitude: -84.3940 }));

const ANF_WETMET_CAMERAS = [
  { id: 'anf-atlanta-airport',    name: 'Hartsfield-Jackson Atlanta Airport', wetMetUid: 'a06f42ff3a95a5f55419bc079aee63c9', latitude: 33.6407, longitude: -84.4277 },
  { id: 'anf-centennial-park',    name: 'Centennial Olympic Park',             wetMetUid: '90fb863b5c7d2eef0c3c762f49124b25', latitude: 33.7606, longitude: -84.3951 },
  { id: 'anf-atlanta',            name: 'Atlanta',                             wetMetUid: '3710d34f691931e30aafe0ec521ebad5', latitude: 33.7490, longitude: -84.3880 },
  { id: 'anf-stone-mountain',     name: 'Stone Mountain',                      wetMetUid: '81d98658a7c8e2572d82aa3e3730f76d', latitude: 33.8039, longitude: -84.1704 },
  { id: 'anf-lake-lanier',        name: 'Lake Lanier',                         wetMetUid: 'c74c586d140dbf5da41cadc3afa772f0', latitude: 34.1870, longitude: -83.9710 },
  { id: 'anf-sandy-springs',      name: 'Sandy Springs',                       wetMetUid: 'b2061239d5e3970ea83193ee89a9ead7', latitude: 33.9304, longitude: -84.3733 },
  { id: 'anf-marietta',           name: 'Marietta',                            wetMetUid: '4fe18c0dd5ed97b0dc14dee71ea63a5a', latitude: 33.9526, longitude: -84.5499 },
  { id: 'anf-cobb-county',        name: 'Cobb County',                         wetMetUid: 'f5a44a1c9ad2c07be2dd2f1cce2627d2', latitude: 33.9400, longitude: -84.5200 },
  { id: 'anf-dekalb-i85',         name: 'I-85 in DeKalb County',               wetMetUid: 'd90996bd208c3de6612c9238890dcbaf', latitude: 33.7490, longitude: -84.2870 },
  { id: 'anf-studios',            name: 'Atlanta News First Studios',           wetMetUid: '9666ec3fe12a3a9155e2052e726636e1', latitude: 33.7490, longitude: -84.3880 },
].map(c => ({ ...c, hasVideo: true, isWetMet: true }));

class GeorgiaBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'georgia',
      timezone: 'America/New_York',
      tzAbbrev: 'ET',
      framerate: 10,
      delayBetweenImageFetches: 6000,
    });

    this.session = null;
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

  async getSession() {
    console.log('Fetching session from 511ga.org...');
    const response = await Axios.get('https://511ga.org/cctv', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
      },
      maxRedirects: 5,
    });

    const setCookies = response.headers['set-cookie'] || [];
    const cookieString = setCookies.map(c => c.split(';')[0]).join('; ');

    const tokenMatch = response.data.match(
      /<input[^>]*name="__RequestVerificationToken"[^>]*value="([^"]+)"/
    );
    if (!tokenMatch) {
      throw new Error('Could not find verification token in page');
    }

    return {
      cookies: cookieString,
      token: tokenMatch[1],
    };
  }

  async getAuthenticatedVideoUrl(cameraId, originalVideoUrl) {
    console.log('Authenticating video stream...');

    // Step 1: Get auth data from 511ga
    const authResp = await Axios.get(`https://511ga.org/Camera/GetVideoUrl?imageId=${cameraId}`, {
      headers: {
        Cookie: this.session.cookies,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
        'X-Requested-With': 'XMLHttpRequest',
        '__requestverificationtoken': this.session.token,
      },
    });

    // If the response is a string, it's already the final URL
    if (typeof authResp.data === 'string') {
      return authResp.data;
    }

    // Step 2: Exchange auth data for a secure token via DIVAS
    const divasResp = await Axios.post(DIVAS_AUTH_URL, authResp.data, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
        'Origin': 'https://511ga.org',
        'Referer': 'https://511ga.org/',
      },
    });

    // Step 3: Append token query string to original URL
    const authenticatedUrl = originalVideoUrl + divasResp.data;
    console.log('Video stream authenticated');
    return authenticatedUrl;
  }

  async fetchCameras(options = {}) {
    console.log('Fetching cameras from Georgia DOT...');

    try {
      this.session = await this.getSession();

      const apiHeaders = {
        '__requestverificationtoken': this.session.token,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Cookie': this.session.cookies,
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
      };

      const makeQuery = (start, length) => ({
        columns: [
          { data: null, name: '' },
          { name: 'sortOrder', s: true },
          { name: 'roadway', s: true },
          { data: 3, name: '' },
        ],
        order: [
          { column: 1, dir: 'asc' },
          { column: 2, dir: 'asc' },
        ],
        start,
        length,
        search: { value: options.search || '' },
      });

      const makeUrl = (query) =>
        `https://511ga.org/List/GetData/Cameras?query=${encodeURIComponent(JSON.stringify(query))}&lang=en-US`;

      let response;
      if (options.limit) {
        response = await Axios.get(makeUrl(makeQuery(0, options.limit)), { headers: apiHeaders });
      } else {
        // Fetch one record to get the total count
        const countResponse = await Axios.get(makeUrl(makeQuery(0, 1)), { headers: apiHeaders });
        const totalCameras = countResponse.data.recordsTotal;
        console.log(`Total cameras: ${totalCameras}`);
        const maxPage = Math.ceil(totalCameras / CAMERAS_PER_PAGE);
        const randomStart = Math.floor(Math.random() * maxPage) * CAMERAS_PER_PAGE;
        console.log(`Fetching page at offset ${randomStart}...`);
        response = await Axios.get(makeUrl(makeQuery(randomStart, CAMERAS_PER_PAGE)), { headers: apiHeaders });
      }

      const data = response.data;
      console.log(`Fetched ${data.data.length} cameras`);

      const cameras = data.data
        .filter(cam => {
          const img = cam.images && cam.images[0];
          return img && !img.disabled && !img.blocked;
        })
        .map(cam => {
          const img = cam.images[0];
          const coordMatch = cam.latLng?.geography?.wellKnownText?.match(
            /POINT \(([^ ]+) ([^ ]+)\)/
          );
          const longitude = coordMatch ? parseFloat(coordMatch[1]) : 0;
          const latitude = coordMatch ? parseFloat(coordMatch[2]) : 0;
          const hasVideo = !!(img.videoUrl && !img.videoDisabled);

          return {
            id: cam.id,
            imageId: img.id,
            name: cam.location || cam.roadway,
            url: hasVideo ? img.videoUrl : `https://511ga.org${img.imageUrl}`,
            hasVideo,
            latitude,
            longitude,
          };
        });

      cameras.push(...GEORGIA_AQUARIUM_CAMERAS);
      cameras.push(...ANF_WETMET_CAMERAS);
      const videoCount = cameras.filter(c => c.hasVideo).length;
      const imageCount = cameras.filter(c => !c.hasVideo).length;
      console.log(`${cameras.length} cameras (${videoCount} video, ${imageCount} image-only)`);
      return cameras;
    } catch (error) {
      console.error('Error fetching Georgia cameras:', error.message);
      return [];
    }
  }

  async fetchAllCameras(highway) {
    return this.fetchCameras({ search: highway, limit: 500 });
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
          timeout: 20000,
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

  async getWetMetStreamUrl(uid) {
    console.log(`Fetching WetMet stream URL for ${uid}...`);
    const response = await Axios.get(`https://api.wetmet.net/widgets/stream/frame.php?uid=${uid}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36' },
    });
    const match = response.data.match(/var vurl = '([^']+)'/);
    if (!match) throw new Error(`Could not find stream URL for WetMet uid ${uid}`);
    return match[1];
  }

  async getOzolioStreamUrl(oid) {
    console.log(`Fetching Ozolio stream URL for ${oid}...`);
    const initResp = await Axios.get(`https://relay.ozolio.com/ses.api?cmd=init&oid=${oid}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36' },
    });
    const sessionId = initResp.data?.session?.id;
    if (!sessionId) throw new Error(`Could not get Ozolio session for ${oid}`);

    const openResp = await Axios.get(`https://relay.ozolio.com/ses.api?cmd=open&oid=${sessionId}&output=1&format=M3U8`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36' },
    });
    const streamUrl = openResp.data?.output?.source;
    if (!streamUrl) throw new Error(`Could not get Ozolio stream URL for ${oid}`);
    return streamUrl;
  }

  async downloadVideoSegment(duration) {
    const streamUrl = this.chosenCamera.isOzolio
      ? await this.getOzolioStreamUrl(this.chosenCamera.ozolioOid)
      : this.chosenCamera.isWetMet
        ? await this.getWetMetStreamUrl(this.chosenCamera.wetMetUid)
        : await this.getAuthenticatedVideoUrl(this.chosenCamera.imageId, this.chosenCamera.url);
    const authenticatedUrl = streamUrl;

    this.getSetpts(duration);
    console.log(`Recording ${duration}s of video from ${this.chosenCamera.name} at ${this.videoSpeedFactor}x...`);

    const tempPath = `${this.assetDirectory}raw.ts`;
    const MIN_FILE_SIZE = 500 * 1024;

    const captureCmd = `ffmpeg -y -rw_timeout 15000000 -headers "Referer: https://511ga.org/\r\nOrigin: https://511ga.org\r\n" -t ${duration} -i "${authenticatedUrl}" -map 0:v:0 -c copy "${tempPath}"`;

    await new Promise((resolve, reject) => {
      exec(captureCmd, { timeout: (duration + 60) * 1000 }, (error) => {
        if (Fs.existsSync(tempPath) && Fs.statSync(tempPath).size > MIN_FILE_SIZE) {
          return resolve();
        }
        if (error) return reject(error);
        resolve();
      });
    });

    const encodeCmd = `ffmpeg -y -i "${tempPath}" -c:v libx264 -preset ultrafast -crf 28 -maxrate 10M -bufsize 20M -pix_fmt yuv420p -vf "setpts=${this.getSetpts(duration)}*PTS" -an "${this.pathToVideo}"`;

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
      console.log(`ID ${this.chosenCamera.id}: ${this.chosenCamera.name} (${this.chosenCamera.hasVideo ? 'video' : 'image'})`);
      Fs.ensureDirSync(this.assetDirectory);

      this.startTime = new Date();

      if (this.chosenCamera.hasVideo) {
        const duration = _.sample(durationOptions);
        const maxRetries = _.isUndefined(argv.id) ? 3 : 1;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            await this.downloadVideoSegment(duration);
            break;
          } catch (e) {
            if (attempt === maxRetries) throw e;
            console.log(`Stream failed for ${this.chosenCamera.id}, trying another camera...`);
            this.cleanup();
            this.chosenCamera = _.sample(cameras);
            console.log(`ID ${this.chosenCamera.id}: ${this.chosenCamera.name}`);
            Fs.ensureDirSync(this.assetDirectory);
          }
        }
      } else {
        const numImages = this.getNumImages();
        console.log(`Downloading ${numImages} images every ${this.delayBetweenImageFetches / 1000}s...`);
        for (let i = 0; i < numImages; i++) {
          await this.downloadImage(i);
          if (i < numImages - 1) await this.sleep(this.delayBetweenImageFetches);
        }

        if (this.shouldAbort()) {
          return;
        }

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

const bot = new GeorgiaBot();
if (require.main === module) bot.start();
module.exports = GeorgiaBot;
