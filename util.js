const keys = require('./keys.js');

const compress_images = require('compress-images');
const Twitter = require('twitter');

const client = new Twitter({
  consumer_key: keys.consumer_key,
  consumer_secret: keys.consumer_secret,
  access_token_key: keys.access_token,
  access_token_secret: keys.access_token_secret,
});

const compressGIF = (input, outputFolder) => {
  return new Promise((resolve, reject) => {
    compress_images(input, outputFolder, {compress_force: true, autoupdate: true}, false,
        {jpg: {engine: 'mozjpeg', command: ['-quality', '60']}},
        {png: {engine: 'pngquant', command: ['--quality=20-50']}},
        {svg: {engine: 'svgo', command: '--multipass'}},
        {gif: {engine: 'gifsicle', command: ['--colors', '96', '--optimize', '-O3']}}, (error, completed) => {
          if (error) {
              reject(error);
          }
          else {
              resolve(completed);
          }
        }
    );
  });
};

const sleep = (ms) => {
  return new Promise(resolve => setTimeout(resolve, ms));
};

// Taken from https://github.com/desmondmorris/node-twitter/tree/master/examples#chunked-media

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

module.exports = {
  client,
  compressGIF,
  sleep,
  makePost,
};
