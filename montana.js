const TrafficBot = require('./TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');

const NUM_IMAGES = 96; // 24 hours * 4 images per hour (every 15 min)

class MontanaBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'montana',
      timezone: 'America/Denver',
      tzAbbrev: 'MT',
      framerate: 5,
      delayBetweenImageFetches: 900000, // 15 minutes
      is24HourTimelapse: true,
    });

    this.lockedCameraUrl = null;
  }

  getNumImages() {
    return NUM_IMAGES;
  }

  async fetchCameras() {
    console.log('Fetching cameras from Montana MDT...');

    try {
      const response = await Axios.get('https://app.mdt.mt.gov/atms/public/cameras');
      const html = response.data;

      const imageRegex = /src="(https:\/\/mdt\.mt\.gov\/other\/WebAppData\/External\/RRS\/RWIS\/([^"]+\.jpg))"/g;
      const cameraMap = new Map();
      let match;

      while ((match = imageRegex.exec(html)) !== null) {
        const fullUrl = match[1];
        const filename = match[2];

        const parts = filename.match(/^(.+?)-(\d+)-(\d+)-\d+-\d+-\d+-\d+-\d+-\d+\.jpg$/);

        if (parts) {
          const cameraName = parts[1];
          const siteId = parts[2];
          const cameraNum = parts[3];

          const uniqueId = `${cameraName}-${siteId}-${cameraNum}`.toLowerCase();

          if (!cameraMap.has(uniqueId)) {
            const displayName = cameraName.replace(/-/g, ' ')
              .split(' ')
              .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
              .join(' ');

            cameraMap.set(uniqueId, {
              id: uniqueId,
              name: displayName,
              url: fullUrl,
              baseUrl: `https://mdt.mt.gov/other/WebAppData/External/RRS/RWIS/${cameraName}-${siteId}`,
              cameraNum: cameraNum,
              latitude: 0,
              longitude: 0
            });
          }
        }
      }

      const cameras = Array.from(cameraMap.values());
      console.log(`Fetched ${cameras.length} cameras from Montana`);
      return cameras;
    } catch (error) {
      console.error('Error fetching Montana cameras:', error.message);
      return [];
    }
  }

  async downloadImage(index) {
    const path = this.getImagePath(index);

    console.log(`Fetching current image for ${this.chosenCamera.name}...`);

    try {
      const response = await Axios.get('https://app.mdt.mt.gov/atms/public/cameras');
      const html = response.data;

      let imageUrl;

      if (!this.lockedCameraUrl) {
        const idParts = this.chosenCamera.id.split('-');
        const cameraName = idParts.slice(0, -2).join('-');
        const siteId = idParts[idParts.length - 2];

        const pattern = new RegExp(`src="(https://mdt\\.mt\\.gov/other/WebAppData/External/RRS/RWIS/${cameraName}-${siteId}-(\\d+)-\\d+-\\d+-\\d+-\\d+-\\d+-\\d+\\.jpg)"`, 'i');
        const match = html.match(pattern);

        if (!match) {
          console.error(`Could not find current image URL for ${this.chosenCamera.name}`);
          throw new Error('Camera image not found on page');
        }

        imageUrl = match[1];
        const capturedCameraNum = match[2];

        this.lockedCameraUrl = `${cameraName}-${siteId}-${capturedCameraNum}`;
        console.log(`Locked onto camera angle: ${this.lockedCameraUrl}`);
      } else {
        const pattern = new RegExp(`src="(https://mdt\\.mt\\.gov/other/WebAppData/External/RRS/RWIS/${this.lockedCameraUrl}-\\d+-\\d+-\\d+-\\d+-\\d+-\\d+\\.jpg)"`, 'i');
        const match = html.match(pattern);

        if (!match) {
          console.error(`Could not find current image URL for locked camera ${this.lockedCameraUrl}`);
          throw new Error('Camera image not found on page');
        }

        imageUrl = match[1];
      }

      console.log(`Downloading: ${imageUrl}`);

      const writer = Fs.createWriteStream(path);
      const imageResponse = await Axios({
        url: imageUrl,
        method: 'GET',
        responseType: 'stream',
        timeout: 10000,
      });

      return new Promise((resolve, reject) => {
        imageResponse.data.pipe(writer);
        writer.on('finish', () => {
          setTimeout(() => {
            try {
              const isUnique = this.checkAndStoreImage(path, index);
              if (isUnique) {
                console.log(`Downloaded image ${index + 1}/${NUM_IMAGES}`);
              }
              resolve(isUnique);
            } catch (err) {
              reject(err);
            }
          }, 100);
        });
        writer.on('error', reject);
      });
    } catch (error) {
      console.error(`Error downloading image ${index}:`, error.message);
      throw error;
    }
  }
}

const bot = new MontanaBot();
bot.run();
