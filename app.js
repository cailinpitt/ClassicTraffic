const cameras = require('./cameras.js');
const { client, compressGIF, makePost, sleep } = require('./util.js');

const Path = require('path');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');
const Moment = require('moment');
const GIFEncoder = require('gifencoder');
const { createCanvas, loadImage } = require('canvas');
const sizeOf = require('image-size');
const argv = require('minimist')(process.argv.slice(2));

const assetDirectory = './assets/';
const pathToGIF = './assets/camera.gif';
let chosenCamera = _.sample(cameras);
const numImages = 10;

const retrieveImage = async (index) => {
  const path = Path.resolve(__dirname, `assets/camera-${index}.jpg`);
  const writer = Fs.createWriteStream(path)

  const response = await Axios({
    url: chosenCamera.url,
    method: 'GET',
    responseType: 'stream'
  });

  response.data.pipe(writer);
};

const start = async () => {
  if (!_.isUndefined(argv.id))
    chosenCamera = _.find(cameras, { 'id': argv.id });

  if (_.isUndefined(chosenCamera))
    return;

  Fs.ensureDirSync(assetDirectory);

  // Retrieve 10 images from chosen traffic camera
  for (let i = 0; i < numImages; i++) {
    await retrieveImage(i);

    // Cameras refresh about every 5 seconds, so wait 6 seconds until querying again
    await sleep(6000);
  }
  
  createGIF();
};

const createGIF = async () => {
  const pathToFirstImage = Path.resolve(__dirname, `assets/camera-0.jpg`);
  const dimensions = sizeOf(pathToFirstImage);
  const encoder = new GIFEncoder(dimensions.width, dimensions.height);
  const canvas = createCanvas(dimensions.width, dimensions.height);
  const ctx = canvas.getContext('2d');

  encoder.start();
  encoder.setRepeat(0);   // 0 for repeat, -1 for no-repeat
  encoder.setDelay(200);  // frame delay in ms
  encoder.setQuality(10); // image quality. 10 is default.

  for (let i = 0; i < numImages; i++) {
    const image = await loadImage(__dirname + `/assets/camera-${i}.jpg`);
    ctx.drawImage(image, 0, 0, dimensions.width, dimensions.height);
    encoder.addFrame(ctx);
  }
  
  encoder.finish();

  Fs.writeFileSync('assets/camera.gif', encoder.out.getData());

  if (Fs.statSync(pathToGIF).size > 5000000) {
      // Twitter GIF files must be less than 5MB
      // We'll compress the GIF once to attempt to get the size down
    await compressGIF(pathToGIF, assetDirectory);
  }

  tweet();
};

// Taken from https://github.com/desmondmorris/node-twitter/tree/master/examples#chunked-media

/**
   * Step 1 of 3: Initialize a media upload
   * @return Promise resolving to String mediaId
   */
const initUpload = () => {
  const mediaType = "image/gif";
  const mediaSize = Fs.statSync(pathToGIF).size;

  return makePost('media/upload', {
    command    : 'INIT',
    total_bytes: mediaSize,
    media_type : mediaType,
  }).then(data => data.media_id_string);
};

/**
 * Step 2 of 3: Append file chunk
 * @param String mediaId    Reference to media object being uploaded
 * @return Promise resolving to String mediaId (for chaining)
 */
const appendUpload = (mediaId) => {
  const mediaData = Fs.readFileSync(pathToGIF);

  return makePost('media/upload', {
    command      : 'APPEND',
    media_id     : mediaId,
    media        : mediaData,
    segment_index: 0
  }).then(data => mediaId);
};
 
/**
 * Step 3 of 3: Finalize upload
 * @param String mediaId   Reference to media
 * @return Promise resolving to mediaId (for chaining)
 */
const finalizeUpload = (mediaId) => {
  return makePost('media/upload', {
    command : 'FINALIZE',
    media_id: mediaId
  }).then(data => mediaId);
};

const publishStatusUpdate = (mediaId) => {
  return new Promise(function(resolve, reject) {
    client.post("statuses/update", {
      status: chosenCamera.name + '\n\n' + Moment().format('hh:mm a'),
      media_ids: mediaId
    }, function(error, data, response) {
      if (error) {
        console.log(error)
        reject(error)
      } else {
        console.log("Successfully uploaded media and tweeted!")
        resolve(data)
      }
    })
  })
};

const cleanup = () => {
  if (!_.isUndefined(argv.persist) && argv.persist !== true) {
    Fs.removeSync(assetDirectory);
  }
};

const tweet = () => {
  initUpload() // Declare that you wish to upload some media
    .then(appendUpload) // Send the data for the media
    .then(finalizeUpload) // Declare that you are done uploading chunks
    .then(publishStatusUpdate) // Make tweet containing uploaded gif
    .then(cleanup); // Remove uneeded files
};

start();
