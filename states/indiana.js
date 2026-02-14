const TrafficBot = require('../TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');

const numImagesPerVideoOptions = [10, 15, 20];

class IndianaBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'indiana',
      timezone: 'America/Indiana/Indianapolis',
      tzAbbrev: 'ET',
      framerate: 5,
      delayBetweenImageFetches: 60000,
    });
  }

  getNumImages() {
    return _.sample(numImagesPerVideoOptions);
  }

  getImagePath(index) {
    const Path = require('path');
    return Path.resolve(`${this.assetDirectory}camera-${index}.png`);
  }

  async createVideo() {
    console.log('Generating video...');
    const { exec } = require('child_process');

    const files = Fs.readdirSync(this.assetDirectory)
      .filter(f => f.startsWith('camera-') && f.endsWith('.png'))
      .sort((a, b) => {
        const numA = parseInt(a.match(/camera-(\d+)\.png/)[1]);
        const numB = parseInt(b.match(/camera-(\d+)\.png/)[1]);
        return numA - numB;
      });

    files.forEach((file, index) => {
      const oldPath = `${this.assetDirectory}${file}`;
      const newPath = `${this.assetDirectory}seq-${index}.png`;
      Fs.renameSync(oldPath, newPath);
    });

    const cmd = `ffmpeg -y -framerate ${this.framerate} -i ${this.assetDirectory}seq-%d.png -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" -c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p ${this.pathToVideo}`;

    await new Promise((resolve, reject) => {
      exec(cmd, (error, stdout, stderr) => {
        if (error) return reject(error);
        resolve();
      });
    });

    const stats = Fs.statSync(this.pathToVideo);
    const fileSizeInMB = stats.size / (1024 * 1024);
    console.log(`Video generated: ${this.pathToVideo} (${fileSizeInMB.toFixed(2)} MB)`);
    console.log(`Total unique images: ${this.uniqueImageCount}`);
  }

  isValidJpeg(filePath) {
    try {
      const buf = Fs.readFileSync(filePath);
      if (buf.length < 100) return false;
      // Check PNG signature (89 50 4E 47)
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true;
      // Check JPEG SOI marker (FF D8)
      if (buf[0] === 0xFF && buf[1] === 0xD8) return true;
      return false;
    } catch {
      return false;
    }
  }

  shouldAbort() {
    if (this.uniqueImageCount === 1) {
      console.log(`Camera ${this.chosenCamera.id}: ${this.chosenCamera.name} is frozen. Exiting`);
      return true;
    }
    return false;
  }

  async fetchCameras() {
    console.log('Fetching cameras from INDOT...');

    try {
      const response = await Axios.get('https://intg.carsprogram.org/cameras_v1/api/cameras', {
        headers: {
          'Accept': 'application/json',
          'Origin': 'https://511in.org',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
        },
      });

      const cameras = response.data
        .filter(cam => cam.active && cam.public && cam.views && cam.views.length > 0)
        .map(cam => {
          const view = cam.views[0];
          return {
            id: String(cam.id),
            name: cam.name,
            url: view.videoPreviewUrl || view.url,
            latitude: cam.location?.latitude || 0,
            longitude: cam.location?.longitude || 0,
          };
        })
        .filter(cam => cam.url && cam.url.endsWith('.png'));

      console.log(`Found ${cameras.length} cameras`);
      return cameras;
    } catch (error) {
      console.error('Error fetching INDOT cameras:', error.message);
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
          timeout: 10000,
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
}

const bot = new IndianaBot();
bot.run();
