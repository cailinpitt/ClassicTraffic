// TODO: Implement Minnesota traffic camera bot
const TrafficBot = require('../TrafficBot.js');

class MinnesotaBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'minnesota',
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

const bot = new MinnesotaBot();
bot.run();
