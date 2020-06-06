const keys = require('./keys.js');

const compress_images = require('compress-images');
const Moment = require('moment');

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
const makePost = (endpoint, client, params) => {
  return new Promise((resolve, reject) => {
    client.post(endpoint, params, (error, data) => {
      if (error) {
        reject(error);
      } else {
        resolve(data);
      }
    });
  });
};

const isRushHour = () => {
  // Is the current time between 7:00 AM - 9:00 AM or 4:00 PM - 7:00 PM?
  const isRushHour = Moment().isBetween(Moment({ hour: 7, minute: 0}), Moment({ hour: 9, minute: 0})) ||
    Moment().isBetween(Moment({ hour: 16, minute: 0}), Moment({ hour: 19, minute: 0}));

  // Is today Saturday or Sunday?
  const isNotWeekend = Moment().day() !== 6 && Moment().day() !== 7;

  return isRushHour && isNotWeekend;
};

module.exports = {
  compressGIF,
  isRushHour,
  sleep,
  makePost,
};
