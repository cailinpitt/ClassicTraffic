// TODO: Implement Kansas traffic camera bot
const TrafficBot = require('../TrafficBot.js');

class KansasBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'kansas',
      timezone: 'America/Chicago',
      tzAbbrev: 'CT',
    });
  }

  async fetchCameras() {
    throw new Error('Not implemented yet');
  }

  async downloadImage(index) {
    throw new Error('Not implemented yet');
  }
}

const bot = new KansasBot();
bot.run();
