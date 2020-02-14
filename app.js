const cameras = require('./cameras.js');
const Path = require('path');
const Axios = require('axios');
const Fs = require('fs');
const _ = require('lodash');

const download = async () => {
    const path = Path.resolve(__dirname, 'camera.jpg')
    const writer = Fs.createWriteStream(path)

    const response = await Axios({
        url: _.sample(cameras).url,
        method: 'GET',
        responseType: 'stream'
    });

    response.data.pipe(writer)

  return new Promise((resolve, reject) => {
    writer.on('finish', resolve)
    writer.on('error', reject)
  })
};

const tweet = async () => {

};

download();