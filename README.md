# Classic Traffic

![Traffic Cam](example.gif)

A Bluesky bot that posts videos of Ohio traffic camera timelapses.

[@classictraffic.bsky.social](https://bsky.app/profile/classictraffic.bsky.social)

Each video consists of 150 images downloaded from a single randomly chosen traffic camera every 6 seconds, so 15 minutes worth of images compressed into 30 seconds.

## Background
Classic Traffic downloads available cameras from the [OHGO](https://ohgo.com/) road-markers API

## Installation
Create a `keys.js` file and create an object to hold your Bluesky credentials. Make sure to export the object:

```js
const bluesky = {
  identifier: '....',
  password: '...',
  service: 'https://bsky.social',
};

module.exports = {
  bluesky
};
```

Then, install dependencies:

`npm ci`

## Run
To run:

`npm run local`

To run and post a gif from a specific traffic camera:

`npm run local --id 00000000001080-0`

To run without deleting `assets` folder (contains downloaded images and generated gif):

`npm run local --persist`