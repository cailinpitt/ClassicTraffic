const keys = require('./keys.js');

const Twitter = require('twitter');

const client = new Twitter({
  consumer_key: keys.consumer_key,
  consumer_secret: keys.consumer_secret,
  access_token_key: keys.access_token,
  access_token_secret: keys.access_token_secret,
});

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
  sleep,
  makePost,
};
