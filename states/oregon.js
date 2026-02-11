// TODO: Implement Oregon traffic camera bot
const TrafficBot = require('../TrafficBot.js');

class OregonBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'oregon',
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

const bot = new OregonBot();
bot.run();
