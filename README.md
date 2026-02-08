# Classic Traffic

![Traffic Cam](example.gif)

Bluesky bots that post videos of traffic camera timelapses.

## Bots

### Ohio - [@classictraffic.bsky.social](https://bsky.app/profile/classictraffic.bsky.social)
Each video consists of 150-900 images downloaded from a single randomly chosen traffic camera every 6 seconds at 10 fps, so 15-90 minutes worth of images compressed into 15-90 seconds. Cameras sourced from the [OHGO](https://ohgo.com/) road-markers API.

### Montana - [@montanatrafficcams.bsky.social](https://bsky.app/profile/montanatrafficcams.bsky.social)
24-hour timelapses from Montana DOT cameras. Images captured every 15 minutes, played back at 5 fps. Cameras sourced from [Montana MDT](https://www.mdt.mt.gov/).

## Installation
Create a `keys.js` file with your Bluesky credentials:

```js
module.exports = {
    // Shared Bluesky service URLs
    service: 'https://bsky.social',
    videoService: 'https://video.bsky.app',

    // Account credentials
    accounts: {
        ohio: {
            identifier: '...',
            password: '...',
        },
        montana: {
            identifier: '...',
            password: '...',
        },
    },
};
```

Then, install dependencies:

`npm ci`

## Run

### Ohio
`node app.js`

With a specific camera:
`node app.js --id 00000000001080-0`

### Montana
`node montana.js`

With a specific camera:
`node montana.js --id helmville-301003-03`

### Options
| Flag | Description |
|------|-------------|
| `--list` | List available cameras and exit (no login required) |
| `--dry-run` | Do everything except post to Bluesky |
| `--persist` | Keep the assets folder (downloaded images and video) |
| `--id <id>` | Use a specific camera instead of random |

## Architecture

The project uses a class-based architecture with `TrafficBot` as the base class. Each bot extends this class and implements camera-specific logic.

### TrafficBot (base class)

Handles the common workflow:
1. Login to Bluesky
2. Fetch and select a camera (calls subclass `fetchCameras()`)
3. Download images over time (calls subclass `downloadImage()`)
4. Create timelapse video with ffmpeg
5. Upload and post to Bluesky
6. Cleanup temp files

### Constructor Config

| Property | Type | Description |
|----------|------|-------------|
| `accountName` | string | Key in `keys.js` accounts object (e.g., `'ohio'`) |
| `timezone` | string | IANA timezone for timestamps (e.g., `'America/New_York'`) |
| `tzAbbrev` | string | Timezone abbreviation for display (e.g., `'ET'`) |
| `framerate` | number | Video playback fps |
| `delayBetweenImageFetches` | number | Milliseconds between downloads |
| `is24HourTimelapse` | boolean | If true, shows "24-Hour Timelapse:" in post |

### Required Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `fetchCameras()` | `Promise<Camera[]>` | Fetch available cameras from data source |
| `downloadImage(index)` | `Promise<boolean>` | Download image at index, return true if unique |
| `getNumImages()` | `number` | Number of images to capture |

### Optional Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `shouldAbort()` | `boolean` | Return true to skip video/post (e.g., frozen camera) |

### Helper Methods

| Method | Description |
|--------|-------------|
| `this.getImagePath(index)` | Get file path for image |
| `this.checkAndStoreImage(path, index)` | Dedupe check, deletes duplicates, updates count |
| `this.sleep(ms)` | Async sleep |

### Camera Object

```js
{
  id: string,        // Unique identifier
  name: string,      // Display name
  url: string,       // Image URL
  latitude: number,  // GPS lat (0 if unknown)
  longitude: number  // GPS long (0 if unknown)
}
```

## Adding a New Bot

1. Add credentials to `keys.js`:
```js
accounts: {
    // ...existing accounts...
    newstate: {
        identifier: '...',
        password: '...',
    },
}
```

2. Create a new file (e.g., `newstate.js`) that extends `TrafficBot`:
```js
const TrafficBot = require('./TrafficBot.js');
const Axios = require('axios');
const Fs = require('fs-extra');

class NewStateBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'newstate',
      timezone: 'America/Chicago',
      tzAbbrev: 'CT',
      framerate: 10,
      delayBetweenImageFetches: 6000,
      is24HourTimelapse: false,
    });
  }

  getNumImages() {
    return 300;
  }

  async fetchCameras() {
    // Fetch cameras from your data source
    const response = await Axios.get('https://example.com/cameras');
    return response.data.map(cam => ({
      id: cam.id,
      name: cam.name,
      url: cam.imageUrl,
      latitude: cam.lat || 0,
      longitude: cam.lng || 0,
    }));
  }

  async downloadImage(index) {
    const path = this.getImagePath(index);
    const writer = Fs.createWriteStream(path);
    const response = await Axios({
      url: this.chosenCamera.url,
      method: 'GET',
      responseType: 'stream',
    });

    return new Promise((resolve, reject) => {
      response.data.pipe(writer);
      writer.on('finish', () => {
        setTimeout(() => {
          try {
            resolve(this.checkAndStoreImage(path, index));
          } catch (err) {
            reject(err);
          }
        }, 100);
      });
      writer.on('error', reject);
    });
  }
}

const bot = new NewStateBot();
bot.run();
```