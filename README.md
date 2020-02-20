# Classic Traffic

![Traffic Cam](example.gif)

A twitter bot that tweets gifs of traffic cameras images.

[@classic_traffic](https://twitter.com/classic_traffic)

## Background
Classic Traffic uses a `cameras.js` file containing the traffic cameras image url's to download from. The file consists of an array of objects, with each object having the following properties:

```js
{
    "id": ...,
    "name": ...,
    "url": ...,
    "city": ...,
    "rushHourPriority": ...,
},
```

### id <number>
The id of the camera

### name <string>
The name of the camera, tweeted along with gif

### url <string>
url of traffic camera image

### city <string> (optional)
city where traffic camera is located. Not used for anything

### rushHourPriority <boolean>
if true, Classic Traffic will give the camera priority during the hours of 7:00 AM to 9:00 AM, and 4:00 PM to 7:00 PM. During these hours, Classic Traffic will only tweet gifs from camera's with this property set to `true`

## Installation
First, create `keys.js` file with a `keys` object containing the Twitter API keys. Make sure to export the object:

```js
const keys = {
    consumer_key: '<consumer_key>',
    consumer_secret: '<consumer_secret>',
    access_token: '<access_token>',
    access_token_secret: '<access_token_secret>'
};

module.exports = keys;
```

Then, install dependencies:

`npm ci`

## Run
To run:

`node app.js`

To run and tweet a gif from a specific traffic camera:

`node app.js --id 20`

To run without deleting `assets` folder (contains downloaded images and generated gif):

`node app.js --persist`