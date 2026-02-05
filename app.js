const { bluesky } = require('./keys.js');
const { sleep } = require('./util.js');

const Path = require('path');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');
const { AtpAgent } = require('@atproto/api');
const argv = require('minimist')(process.argv.slice(2));
const crypto = require('crypto');

const assetDirectory = `./assets-${uuidv4()}/`;
const pathToVideo = `${assetDirectory}camera.mp4`;
const delayBetweenImageFetches = 6000; // 6 seconds
const numImagesPerVideoOptions = [150, 300, 450, 600, 750, 900]; // 15, 30, 45, 60, 75, 90 second videos

let chosenCamera;
let agent;
let repo;
let imageHashes = new Set(); // Track hashes of downloaded images
let uniqueImageCount = 0;
let startTime;
let endTime;

const fetchCameras = async () => {
  const threeMonthsFromNow = new Date();
  threeMonthsFromNow.setMonth(threeMonthsFromNow.getMonth() + 3);
  
  // Format as YYYY-M-D (no leading zeros on month/day)
  const year = threeMonthsFromNow.getFullYear();
  const month = threeMonthsFromNow.getMonth() + 1; // getMonth() is 0-indexed
  const day = threeMonthsFromNow.getDate();
  const dateStr = `${year}-${month}-${day}`;
  
  const ohgoUrl = `https://api.ohgo.com/road-markers/multi-markers?before=${dateStr}`;
  console.log(`Fetching cameras from API (before=${dateStr})...`);
  
  try {
    const response = await Axios.get(ohgoUrl);
    const cameraMarkers = response.data.CameraMarkers || [];
    
    const cameras = [];
    cameraMarkers.forEach((marker) => {
      if (marker.Cameras && marker.Cameras.length > 0) {
        marker.Cameras.forEach((camera, index) => {
          cameras.push({
            id: `${marker.Id}-${index}`,
            name: marker.Description,
            url: camera.LargeURL,
            location: marker.Location,
            latitude: marker.Latitude,
            longitude: marker.Longitude
          });
        });
      }
    });
    
    console.log(`Fetched ${cameras.length} cameras from API`);
    return cameras;
  } catch (error) {
    console.error('Error fetching cameras:', error.message);
    return [];
  }
};

const getImageHash = (filePath) => {
  const fileBuffer = Fs.readFileSync(filePath);
  return crypto.createHash('md5').update(fileBuffer).digest('hex');
};

const downloadImage = async (index, retries = 3) => {
  const path = Path.resolve(`${assetDirectory}camera-${index}.jpg`);
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const writer = Fs.createWriteStream(path);

      const response = await Axios({
        url: chosenCamera.url,
        method: 'GET',
        responseType: 'stream',
        timeout: 10000, // 10 second timeout
      });

      return await new Promise((resolve, reject) => {
        response.data.pipe(writer);
        writer.on('finish', () => {
          setTimeout(() => {
            const hash = getImageHash(path);
            
            if (imageHashes.has(hash)) {
              console.log(`Skipping duplicate image ${index}`);
              Fs.removeSync(path); // Delete the duplicate
              resolve(false); // Return false to indicate duplicate
            } else {
              imageHashes.add(hash);
              uniqueImageCount++;
              resolve(true); // Return true to indicate unique image
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
      
      await sleep(1000 * Math.pow(2, attempt - 1));
    }
  }
};

const createVideo = async () => {
  console.log('Generating video...');

  // Rename files to be sequential (remove gaps from duplicates)
  const files = Fs.readdirSync(assetDirectory)
    .filter(f => f.startsWith('camera-') && f.endsWith('.jpg'))
    .sort((a, b) => {
      const numA = parseInt(a.match(/camera-(\d+)\.jpg/)[1]);
      const numB = parseInt(b.match(/camera-(\d+)\.jpg/)[1]);
      return numA - numB;
    });

  files.forEach((file, index) => {
    const oldPath = `${assetDirectory}${file}`;
    const newPath = `${assetDirectory}seq-${index}.jpg`;
    Fs.renameSync(oldPath, newPath);
  });

  const cmd = `ffmpeg -y -framerate 10 -i ${assetDirectory}seq-%d.jpg -c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p ${pathToVideo}`;

  await new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) return reject(error);
      resolve();
    });
  });

  const stats = Fs.statSync(pathToVideo);
  const fileSizeInMB = stats.size / (1024 * 1024);
  console.log(`Video generated: ${pathToVideo} (${fileSizeInMB.toFixed(2)} MB)`);
  console.log(`Total unique images: ${uniqueImageCount}`);
};

const getAspectRatio = async () => {
  return new Promise((resolve, reject) => {
    const cmd = `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 ${pathToVideo}`;
    exec(cmd, (error, stdout, stderr) => {
      if (error) return reject(error);
      const [width, height] = stdout.trim().split(',').map(Number);
      resolve({ width, height });
    });
  });
};

const postToBluesky = async () => {
  console.log('Uploading video to Bluesky...');

  const videoBuffer = Fs.readFileSync(pathToVideo);
  const stats = Fs.statSync(pathToVideo);
  const fileSizeInMB = stats.size / (1024 * 1024);
  console.log(`Video file size: ${fileSizeInMB.toFixed(2)} MB`);

  // Step 1: Get service auth token
  const { data: serviceAuth } = await agent.com.atproto.server.getServiceAuth({
    aud: `did:web:${agent.dispatchUrl.host}`,
    lxm: 'com.atproto.repo.uploadBlob',
    exp: Math.floor(Date.now() / 1000) + 60 * 30, // 30 minutes
  });

  const token = serviceAuth.token;

  // Step 2: Upload video to Bluesky video service
  const uploadUrl = new URL('https://video.bsky.app/xrpc/app.bsky.video.uploadVideo');
  uploadUrl.searchParams.append('did', agent.session.did);
  uploadUrl.searchParams.append('name', 'camera.mp4');

  console.log('Uploading to video service...');
  const uploadResponse = await fetch(uploadUrl.toString(), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'video/mp4',
      'Content-Length': stats.size.toString(),
    },
    body: videoBuffer,
  });

  if (!uploadResponse.ok) {
    const error = await uploadResponse.json();
    throw new Error(`Video upload failed: ${JSON.stringify(error)}`);
  }

  const jobStatus = await uploadResponse.json();
  console.log('Video uploaded, processing...');

  // Step 3: Poll for processing completion
  let blob = jobStatus.blob;
  const videoServiceAgent = new AtpAgent({ service: bluesky.videoService });

  while (!blob) {
    await sleep(1000); // Wait 1 second
    
    try {
      const { data: status } = await videoServiceAgent.app.bsky.video.getJobStatus({
        jobId: jobStatus.jobId,
      });

      console.log(`Processing: ${status.jobStatus.state}`, status.jobStatus.progress || '');

      if (status.jobStatus.blob) {
        blob = status.jobStatus.blob;
      } else if (status.jobStatus.state === 'JOB_STATE_FAILED') {
        throw new Error(`Video processing failed: ${status.jobStatus.error || 'Unknown error'}`);
      }
    } catch (error) {
      // Check if it's the "already_exists" error
      if (error.message && error.message.includes('already_exists')) {
        // The error response should contain the blob
        blob = error.blob || jobStatus.blob;
        break;
      }
      throw error;
    }
  }

  console.log('Video processing complete!');

  const aspectRatio = await getAspectRatio();

  // Format timestamps in Eastern Time (Ohio timezone)
  const formatTime = (date) => {
    return date.toLocaleTimeString('en-US', { 
      hour: 'numeric', 
      minute: '2-digit',
      hour12: true,
      timeZone: 'America/New_York'
    });
  };

  const timeRange = `${formatTime(startTime)} - ${formatTime(endTime)} ET`;

  const googleMapsUrl = `https://www.google.com/maps?q=${chosenCamera.latitude},${chosenCamera.longitude}`;
  const coordinates = `${chosenCamera.latitude},${chosenCamera.longitude}`;
  const postText = `${chosenCamera.name}\n🕒 ${timeRange}\n\n📍: ${coordinates}`;

  // Create facets for the hyperlink
  // Need to account for emoji which is multi-byte
  const byteStart = Buffer.from(`${chosenCamera.name}\n🕒 ${timeRange}\n\n📍: `).length;
  const byteEnd = byteStart + Buffer.from(coordinates).length;

  await agent.post({
    text: postText,
    facets: [
      {
        index: {
          byteStart: byteStart,
          byteEnd: byteEnd,
        },
        features: [
          {
            $type: 'app.bsky.richtext.facet#link',
            uri: googleMapsUrl,
          },
        ],
      },
    ],
    embed: {
      $type: 'app.bsky.embed.video',
      video: blob,
      aspectRatio: aspectRatio,
    },
  });

  console.log('Posted video to Bluesky successfully');
};

const cleanup = () => {
  if (argv.persist === true) return;

  if (Fs.existsSync(assetDirectory)) {
    Fs.removeSync(assetDirectory);
    console.log(`Removed ${assetDirectory}`);
  }
};

const start = async () => {
  try {
    agent = new AtpAgent({ service: bluesky.service });

    await agent.login({
      identifier: bluesky.identifier,
      password: bluesky.password,
    });

    repo = agent.session?.did;
    if (!repo) {
      console.error('Failed to get DID after login');
      return;
    }

    const cameras = await fetchCameras();
    if (cameras.length === 0) {
      console.error('No cameras available');
      return;
    }

    if (!_.isUndefined(argv.id)) {
      chosenCamera = _.find(cameras, { id: argv.id });
    } else {
      chosenCamera = _.sample(cameras);
    }

    if (!chosenCamera) {
      console.error('Could not select a camera');
      return;
    }

    console.log(`ID ${chosenCamera.id}: ${chosenCamera.name}`);
    Fs.ensureDirSync(assetDirectory);
    
    startTime = new Date();
    const numImages = _.sample(numImagesPerVideoOptions);
    console.log(`Downloading traffic camera images. ${numImages} images...`);

    for (let i = 0; i < numImages; i++) {
      await downloadImage(i);
      if (i < numImages - 1) await sleep(delayBetweenImageFetches);
    }

    if (uniqueImageCount === 1) {
      console.log(`Camera ${chosenCamera.id}: ${chosenCamera.name} is frozen. Exiting`);
      return;
    };

    endTime = new Date();

    console.log('Download complete');
    await createVideo();
    await postToBluesky();
  } catch (error) {
    console.log(error)
  } finally {
    cleanup();
  }
};

start();