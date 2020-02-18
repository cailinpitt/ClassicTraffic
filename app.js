const cameras = require('./cameras.js');
const keys = require('./keys.js');
const Path = require('path');
const Axios = require('axios');
const Fs = require('fs');
const _ = require('lodash');
const Twitter = require('twitter');

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
    let index = 0;
    

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

    encoder.createReadStream().pipe(Fs.createWriteStream('camera.gif'));
 
    encoder.start();
    encoder.setRepeat(0);   // 0 for repeat, -1 for no-repeat
    encoder.setDelay(500);  // frame delay in ms
    encoder.setQuality(5); // image quality. 10 is default.

    for (let i = 0; i < 5; i++) {
        const image = await loadImage(__dirname + `/camera-${i}.jpg`);
        ctx.drawImage(image, 0, 0, dimensions.width, dimensions.height);
        encoder.addFrame(ctx);
    }
    
    encoder.finish();

    tweet(chosenCamera);
};

/*
 * Taken from https://coderrocketfuel.com/article/publish-text-image-gif-and-video-twitter-posts-with-node-js
 */
function initializeMediaUpload() {
    const mediaType = "image/gif";
    const mediaSize = Fs.statSync(pathToFile).size;
 
    return new Promise(function(resolve, reject) {
        client.post("media/upload", {
        command: "INIT",
        total_bytes: mediaSize,
        media_type: mediaType
        }, function(error, data, response) {
            console.log(data)
        if (error) {
            console.log(error)
            reject(error)
        } else {
            resolve(data.media_id_string)
        }
        })
    })
}
 
function appendFileChunk(mediaId) {

const mediaData = Fs.readFileSync(pathToFile);
  return new Promise(function(resolve, reject) {
    client.post("media/upload", {
      command: "APPEND",
      media_id: mediaId,
      media: mediaData,
      segment_index: 0
    }, function(error, data, response) {
      if (error) {
        console.log(error)
        reject(error)
      } else {
        resolve(mediaId)
      }
    })
  })
}
 
function finalizeUpload(mediaId) {
  return new Promise(function(resolve, reject) {
    client.post("media/upload", {
      command: "FINALIZE",
      media_id: mediaId
    }, function(error, data, response) {
      if (error) {
        console.log(error)
        reject(error)
      } else {
        resolve(mediaId)
      }
    })
  })
}
 
function publishStatusUpdate(mediaId) {
  return new Promise(function(resolve, reject) {
    client.post("statuses/update", {
      status: chosenCamera.name,
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
}

const tweet = () => {
    initializeMediaUpload()
        .then(appendFileChunk)
        .then(finalizeUpload)
        .then(publishStatusUpdate);
};

download();
