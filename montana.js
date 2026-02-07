const { bluesky, montana } = require('./keys.js');
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

const assetDirectory = `./montana-assets-${uuidv4()}/`;
const pathToVideo = `${assetDirectory}camera.mp4`;
const numImages = 96; // 24 hours * 4 images per hour (every 15 min)
const delayBetweenImageFetches = 900000; // 15 minutes in milliseconds

let chosenCamera;
let agent;
let repo;
let imageHashes = new Set(); // Track hashes of downloaded images
let uniqueImageCount = 0;
let startTime;
let endTime;
let lockedCameraUrl; // Store the exact camera pattern we're tracking

const fetchCameras = async () => {
  console.log('Fetching cameras from Montana MDT...');
  
  try {
    const response = await Axios.get('https://app.mdt.mt.gov/atms/public/cameras');
    const html = response.data;
    
    let cameras = [];
    
    // Parse camera data from the HTML - find actual image URLs that are currently displayed
    // Pattern: <img src="https://mdt.mt.gov/other/WebAppData/External/RRS/RWIS/{Name}-{ID}-{Num}-{timestamp}.jpg">
    const imageRegex = /src="(https:\/\/mdt\.mt\.gov\/other\/WebAppData\/External\/RRS\/RWIS\/([^"]+\.jpg))"/g;
    
    const cameraMap = new Map();
    let match;
    
    while ((match = imageRegex.exec(html)) !== null) {
      const fullUrl = match[1];
      const filename = match[2];
      
      // Extract camera info from filename
      // Example: Helmville-301003-03-2-7-2026-14-45-10.jpg
      const parts = filename.match(/^(.+?)-(\d+)-(\d+)-\d+-\d+-\d+-\d+-\d+-\d+\.jpg$/);
      
      if (parts) {
        const cameraName = parts[1];
        const siteId = parts[2];
        const cameraNum = parts[3];
        
        const uniqueId = `${cameraName}-${siteId}-${cameraNum}`.toLowerCase();
        
        // Only store the first occurrence of each camera (newest image)
        if (!cameraMap.has(uniqueId)) {
          const displayName = cameraName.replace(/-/g, ' ')
            .split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');
          
          cameraMap.set(uniqueId, {
            id: uniqueId,
            name: displayName,
            url: fullUrl, // Store the actual current image URL
            baseUrl: `https://mdt.mt.gov/other/WebAppData/External/RRS/RWIS/${cameraName}-${siteId}`,
            cameraNum: cameraNum,
            latitude: 0,
            longitude: 0
          });
        }
      }
    }
    
    cameras = Array.from(cameraMap.values());
    console.log(`Fetched ${cameras.length} cameras from Montana`);
    return cameras;
  } catch (error) {
    console.error('Error fetching Montana cameras:', error.message);
    return [];
  }
};

const getImageHash = (filePath) => {
  const fileBuffer = Fs.readFileSync(filePath);
  return crypto.createHash('md5').update(fileBuffer).digest('hex');
};

const downloadImage = async (index) => {
  const path = Path.resolve(`${assetDirectory}camera-${index}.jpg`);
  
  // Refetch the camera page to get the current image URL
  console.log(`Fetching current image for ${chosenCamera.name}...`);
  
  try {
    const response = await Axios.get('https://app.mdt.mt.gov/atms/public/cameras');
    const html = response.data;
    
    let imageUrl;
    
    if (!lockedCameraUrl) {
      // First download - find ANY camera for this location and lock onto it
      const idParts = chosenCamera.id.split('-');
      const cameraName = idParts.slice(0, -2).join('-');
      const siteId = idParts[idParts.length - 2];
      
      // Match: McGuire-Creek-269006-{ANY_NUM}-{timestamp}.jpg
      const pattern = new RegExp(`src="(https://mdt\\.mt\\.gov/other/WebAppData/External/RRS/RWIS/${cameraName}-${siteId}-(\\d+)-\\d+-\\d+-\\d+-\\d+-\\d+-\\d+\\.jpg)"`, 'i');
      const match = html.match(pattern);
      
      if (!match) {
        console.error(`Could not find current image URL for ${chosenCamera.name}`);
        throw new Error('Camera image not found on page');
      }
      
      imageUrl = match[1];
      const capturedCameraNum = match[2];
      
      // Lock onto this specific camera angle
      lockedCameraUrl = `${cameraName}-${siteId}-${capturedCameraNum}`;
      console.log(`Locked onto camera angle: ${lockedCameraUrl}`);
    } else {
      // Subsequent downloads - use the locked camera angle
      const pattern = new RegExp(`src="(https://mdt\\.mt\\.gov/other/WebAppData/External/RRS/RWIS/${lockedCameraUrl}-\\d+-\\d+-\\d+-\\d+-\\d+-\\d+\\.jpg)"`, 'i');
      const match = html.match(pattern);
      
      if (!match) {
        console.error(`Could not find current image URL for locked camera ${lockedCameraUrl}`);
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
          const hash = getImageHash(path);
          
          if (imageHashes.has(hash)) {
            console.log(`Skipping duplicate image ${index}`);
            Fs.removeSync(path);
            resolve(false);
          } else {
            imageHashes.add(hash);
            uniqueImageCount++;
            console.log(`Downloaded image ${index + 1}/${numImages}`);
            resolve(true);
          }
        }, 100);
      });
      writer.on('error', reject);
    });
  } catch (error) {
    console.error(`Error downloading image ${index}:`, error.message);
    throw error;
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

  const cmd = `ffmpeg -y -framerate 5 -i ${assetDirectory}seq-%d.jpg -c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p ${pathToVideo}`;

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

  // Format timestamps in Mountain Time (Montana timezone)
  const formatTime = (date) => {
    return date.toLocaleTimeString('en-US', { 
      hour: 'numeric', 
      minute: '2-digit',
      hour12: true,
      timeZone: 'America/Denver'
    });
  };

  const timeRange = `${formatTime(startTime)} - ${formatTime(endTime)} MT`;

  let postText;
  let facets = [];

  // Only include coordinates if we have them
  if (chosenCamera.latitude !== 0 && chosenCamera.longitude !== 0) {
    const googleMapsUrl = `https://www.google.com/maps?q=${chosenCamera.latitude},${chosenCamera.longitude}`;
    const coordinates = `${chosenCamera.latitude},${chosenCamera.longitude}`;
    postText = `${chosenCamera.name}\n🕒 24-Hour Timelapse: ${timeRange}\n\n📍: ${coordinates}`;

    // Create facets for the hyperlink
    const byteStart = Buffer.from(`${chosenCamera.name}\n🕒 24-Hour Timelapse: ${timeRange}\n\n📍: `).length;
    const byteEnd = byteStart + Buffer.from(coordinates).length;

    facets = [
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
    ];
  } else {
    // No coordinates available
    postText = `${chosenCamera.name}\n🕒 24-Hour Timelapse: ${timeRange}`;
  }

  await agent.post({
    text: postText,
    ...(facets.length > 0 && { facets }),
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

  Fs.readdirSync('./')
    .filter((f) => f.startsWith('assets-'))
    .forEach((f) => Fs.removeSync(`./${f}`));

  console.log('Removed old assets');
};

const start = async () => {
  cleanup();

  agent = new AtpAgent({ service: bluesky.service });

  await agent.login({
    identifier: montana.identifier,
    password: montana.password,
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

  console.log('Downloading traffic camera images...');
  
  startTime = new Date();

  for (let i = 0; i < numImages; i++) {
    await downloadImage(i);
    if (i < numImages - 1) await sleep(delayBetweenImageFetches);
  }

  endTime = new Date();

  console.log('Download complete');
  await createVideo();
  await postToBluesky();
};

start();