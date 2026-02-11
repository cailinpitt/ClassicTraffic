// TODO: Implement South Dakota traffic camera bot
const TrafficBot = require('../TrafficBot.js');

class SouthDakotaBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'southdakota',
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

const bot = new SouthDakotaBot();
bot.run();
