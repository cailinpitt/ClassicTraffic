// TODO: Implement Washington traffic camera bot
const TrafficBot = require('../TrafficBot.js');

class WashingtonBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'washington',
      timezone: 'America/Los_Angeles',
      tzAbbrev: 'PT',
    });
  }

  async fetchCameras() {
    throw new Error('Not implemented yet');
  }

  async downloadImage(index) {
    throw new Error('Not implemented yet');
  }
}

const bot = new WashingtonBot();
bot.run();
