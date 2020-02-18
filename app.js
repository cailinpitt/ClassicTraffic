const cameras = require('./cameras.js');
const keys = require('./keys.js');

const Path = require('path');
const Axios = require('axios');
const Fs = require('fs');
const _ = require('lodash');
const Twitter = require('twitter');
const Moment = require('moment');
const GIFEncoder = require('gifencoder');
const { createCanvas, loadImage } = require('canvas');
const sizeOf = require('image-size');

const pathToFile = __dirname + '/camera.gif';
const chosenCamera =  _.sample(cameras);

const client = new Twitter({
    consumer_key: keys.consumer_key,
    consumer_secret: keys.consumer_secret,
    access_token_key: keys.access_token,
    access_token_secret: keys.access_token_secret,
  });

const sleep = (ms) => {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const retrieveImage = async (index) => {
    const path = Path.resolve(__dirname, `camera-${index}.jpg`)
    const writer = Fs.createWriteStream(path)

    const response = await Axios({
        url: chosenCamera.url,
        method: 'GET',
        responseType: 'stream'
    });

    response.data.pipe(writer);
};

const download = async () => {  
    for (let i = 0; i < 5; i++) {
        await retrieveImage(i);
        await sleep(6000);
    }
    
    createGIF();
};

const createGIF = async () => {
    const dimensions = sizeOf(__dirname + '/camera-0.jpg');
    const encoder = new GIFEncoder(dimensions.width, dimensions.height);
    const canvas = createCanvas(dimensions.width, dimensions.height);
    const ctx = canvas.getContext('2d');
    encoder.start();
    encoder.setRepeat(0);   // 0 for repeat, -1 for no-repeat
    encoder.setDelay(200);  // frame delay in ms
    encoder.setQuality(10); // image quality. 10 is default.

    for (let i = 0; i < 5; i++) {
        const image = await loadImage(__dirname + `/camera-${i}.jpg`);
        ctx.drawImage(image, 0, 0, dimensions.width, dimensions.height);
        encoder.addFrame(ctx);
    }
    
    encoder.finish();

    const buffer = encoder.out.getData();
    Fs.writeFileSync('camera.gif', buffer);

    tweet(chosenCamera);
};

/*
 * Taken from https://github.com/desmondmorris/node-twitter/tree/master/examples#chunked-media
 */
/**
   * Step 1 of 3: Initialize a media upload
   * @return Promise resolving to String mediaId
   */
const initUpload = () => {
  const mediaType = "image/gif";
  const mediaSize = Fs.statSync(pathToFile).size;

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
  const mediaData = Fs.readFileSync(pathToFile);

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
        console.log(145, error)
        reject(error)
      } else {
        console.log("Successfully uploaded media and tweeted!")
        resolve(data)
      }
    })
  })
}

/**
 * (Utility function) Send a POST request to the Twitter API
 * @param String endpoint  e.g. 'statuses/upload'
 * @param Object params    Params object to send
 * @return Promise         Rejects if response is error
 */
const makePost = (endpoint, params) => {
  return new Promise((resolve, reject) => {
    client.post(endpoint, params, (error, data, response) => {
      if (error) {
        reject(error);
      } else {
        resolve(data);
      }
    });
  });
};

const tweet = () => {
  initUpload() // Declare that you wish to upload some media
    .then(appendUpload) // Send the data for the media
    .then(finalizeUpload) // Declare that you are done uploading chunks
    .then(publishStatusUpdate);
};

download();
