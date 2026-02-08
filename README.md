# Classic Traffic

![Traffic Cam](example.gif)

Bluesky bots that post videos of traffic camera timelapses.

![US Map](map.svg)

## Bots

### Ohio - [@classictraffic.bsky.social](https://bsky.app/profile/classictraffic.bsky.social)
Each video consists of 150-900 images downloaded from a single randomly chosen traffic camera every 6 seconds at 10 fps, so 15-90 minutes worth of images compressed into 15-90 seconds. Cameras sourced from the [OHGO](https://ohgo.com/) road-markers API.

### Montana - [@montanatrafficcams.bsky.social](https://bsky.app/profile/montanatrafficcams.bsky.social)
24-hour timelapses from Montana DOT cameras. Images captured every 15 minutes, played back at 5 fps. Cameras sourced from [Montana MDT](https://www.mdt.mt.gov/).

### Nevada - [@nevadatrafficcams.bsky.social](https://bsky.app/profile/nevadatrafficcams.bsky.social)
Live video clips (30 seconds to 5 minutes) captured directly from HLS streams. Randomly selects a page of 10 cameras from the 645+ available, then picks one. Cameras sourced from [NVRoads](https://www.nvroads.com/).

### Florida - [@floridatrafficcams.bsky.social](https://bsky.app/profile/floridatrafficcams.bsky.social)
Live video clips (30 seconds to 5 minutes) captured from DIVAS-authenticated HLS streams. Randomly selects from 4500+ cameras. Cameras sourced from [FL511](https://fl511.com/).

### Wisconsin - [@wisconsintrafficcams.bsky.social](https://bsky.app/profile/wisconsintrafficcams.bsky.social)
Live video clips (30 seconds to 5 minutes) captured directly from HLS streams. Randomly selects from 480+ cameras. Cameras sourced from [511WI](https://511wi.gov/).

### Utah - [@utahtrafficcams.bsky.social](https://bsky.app/profile/utahtrafficcams.bsky.social)
Image timelapses from 2000+ Utah DOT cameras. Images captured every 2 minutes, played back at 10 fps. Cameras sourced from [Utah 511](https://prod-ut.ibi511.com/).

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
        nevada: {
            identifier: '...',
            password: '...',
        },
        florida: {
            identifier: '...',
            password: '...',
        },
        wisconsin: {
            identifier: '...',
            password: '...',
        },
        utah: {
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
```
node states/ohio.js
# or
npm run ohio
```

With a specific camera:
```
node states/ohio.js --id 00000000001080-0
```

### Montana
```
node states/montana.js
# or
npm run montana
```

With a specific camera:
```
node states/montana.js --id helmville-301003-03
```

### Nevada
```
node states/nevada.js
# or
npm run nevada
```

### Florida
```
node states/florida.js
# or
npm run florida
```

### Wisconsin
```
node states/wisconsin.js
# or
npm run wisconsin
```

### Utah
```
node states/utah.js
# or
npm run utah
```

### Options
| Flag | Description |
|------|-------------|
| `--list` | List available cameras and exit (no login required) |
| `--dry-run` | Do everything except post to Bluesky |
| `--persist` | Keep the assets folder (downloaded images and video) |
| `--id <id>` | Use a specific camera instead of random |

## Project Structure

```
states/          # State-specific bot implementations
  ohio.js        # Image timelapse bot (OHGO API)
  montana.js     # 24-hour image timelapse bot (MDT)
  nevada.js      # Live HLS video clip bot (NVRoads)
  florida.js     # Live HLS video clip bot with DIVAS auth (FL511)
  wisconsin.js   # Live HLS video clip bot (511WI)
  utah.js        # Image timelapse bot (Utah 511)
TrafficBot.js    # Base class with shared workflow
keys.js          # Bluesky credentials (gitignored)
assets/          # Temporary download directory (gitignored)
map.svg          # US map highlighting active states
```

## Architecture

The project uses a class-based architecture with `TrafficBot` as the base class. There are two patterns:

**Image timelapse bots** (Ohio, Montana, Utah) extend `TrafficBot` and use the standard workflow: download images over time, deduplicate, stitch into video with ffmpeg, and post.

**Live video clip bots** (Nevada, Florida, Wisconsin) override `run()` to skip the image loop entirely. They capture a segment of a live HLS video stream directly with ffmpeg. Florida adds an extra DIVAS authentication step to obtain a secure token for the HLS streams.

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

### Required Methods (image timelapse bots)

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
  url: string,       // Image or video stream URL
  latitude: number,  // GPS lat (0 if unknown)
  longitude: number  // GPS long (0 if unknown)
}
```

## Adding a New Bot

1. Add credentials to `keys.js`

2. Create a new file in `states/` that extends `TrafficBot`. See existing bots for examples:
   - **Image timelapse**: Use `states/ohio.js` as a template. Implement `fetchCameras()`, `downloadImage()`, and `getNumImages()`.
   - **Live video clip**: Use `states/nevada.js` as a template. Override `run()` and add a `downloadVideoSegment()` method.
   - **Live video clip with auth**: Use `states/florida.js` as a template if the HLS streams require token authentication.

3. Add an npm script to `package.json`:
```json
"scripts": {
    "newstate": "node states/newstate.js"
}
```

## Credits

US map SVG adapted from a [GitHub Gist by coryetzkorn](https://gist.github.com/coryetzkorn/3077873), originally sourced from [Wikipedia](https://en.wikipedia.org/wiki/File:Blank_US_Map_(states_only).svg) (public domain).
