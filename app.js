const cameras = require('./cameras.js');
const keys = require('./keys.js');
const Path = require('path');
const Axios = require('axios');
const Fs = require('fs');
const _ = require('lodash');
const Twit = require('twit');

const T = new Twit({
    consumer_key: keys.consumer_key,
    consumer_secret: keys.consumer_secret,
    access_token: keys.access_token,
    access_token_secret: keys.access_token_secret,
  });

const download = async () => {
    const chosenCamera =  _.sample(cameras);
    const path = Path.resolve(__dirname, 'camera.jpg')
    const writer = Fs.createWriteStream(path)

    const response = await Axios({
        url: chosenCamera.url,
        method: 'GET',
        responseType: 'stream'
    });

    response.data.pipe(writer)

    writer.on('finish', () => {

        const file = Fs.readFileSync('./camera.jpg', { encoding: 'base64' });

        T.post('media/upload', { media_data: file }, function (err, data, response) {
            const media_id = data.media_id_string;
            const text = chosenCamera.name + "\n\n" + new Date().toLocaleTimeString();
            const meta_params = { media_id, alt_text: { text } }

            T.post('media/metadata/create', meta_params, function (err, data, response) {
                const params = { status: text, media_ids: [media_id] }
                    
                    T.post('statuses/update', params);
            });
        });
    });
};

download();