// TODO: Implement North Dakota traffic camera bot
const TrafficBot = require('../TrafficBot.js');

class NorthDakotaBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'northdakota',
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

const bot = new NorthDakotaBot();
bot.run();
