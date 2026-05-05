const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const _ = require('lodash');
const argv = require('minimist')(process.argv.slice(2));

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
  { id: 'anf-atlanta',            name: 'Midtown, Atlanta',                    wetMetUid: '3710d34f691931e30aafe0ec521ebad5', latitude: 33.7490, longitude: -84.3880 },
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

  async getSession() { return this.get511DotSession('https://511ga.org/cctv'); }

  getCaptureFlags() { return '-rw_timeout 15000000 -headers "Referer: https://511ga.org/\\r\\nOrigin: https://511ga.org\\r\\n"'; }

  async getVideoUrl() {
    if (this.chosenCamera.isOzolio) return this.getOzolioStreamUrl(this.chosenCamera.ozolioOid);
    if (this.chosenCamera.isWetMet) return this.getWetMetStreamUrl(this.chosenCamera.wetMetUid);
    return this.getAuthenticatedVideoUrl(this.chosenCamera.imageId, this.chosenCamera.url);
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

      const fixedCameras = [...GEORGIA_AQUARIUM_CAMERAS, ...ANF_WETMET_CAMERAS];

      let response;
      let includeFixed = !!options.limit; // search/highway path: include and let caller filter
      if (options.limit) {
        response = await Axios.get(makeUrl(makeQuery(0, options.limit)), { headers: apiHeaders });
      } else {
        // Fetch one record to get the total count
        const countResponse = await Axios.get(makeUrl(makeQuery(0, 1)), { headers: apiHeaders });
        const totalCameras = countResponse.data.recordsTotal;
        console.log(`Total cameras: ${totalCameras} (+ ${fixedCameras.length} fixed)`);

        // Treat the fixed list as a virtual page so each fixed camera has the same
        // per-run odds as any GA-DOT camera, instead of dominating a 10-cam page.
        const grandTotal = totalCameras + fixedCameras.length;
        if (Math.random() < fixedCameras.length / grandTotal) {
          console.log(`Returning ${fixedCameras.length} fixed cameras`);
          return fixedCameras;
        }

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

      if (includeFixed) cameras.push(...fixedCameras);
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

}

const bot = new GeorgiaBot();
if (require.main === module) bot.start();
module.exports = GeorgiaBot;
