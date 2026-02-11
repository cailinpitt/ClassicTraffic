// TODO: Implement Wyoming traffic camera bot
const TrafficBot = require('../TrafficBot.js');

class WyomingBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'wyoming',
      timezone: 'America/Denver',
      tzAbbrev: 'MT',
    });
  }

  async fetchCameras() {
    throw new Error('Not implemented yet');
  }

  async downloadImage(index) {
    throw new Error('Not implemented yet');
  }
}

const bot = new WyomingBot();
bot.run();
