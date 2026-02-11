// TODO: Implement Louisiana traffic camera bot
const TrafficBot = require('../TrafficBot.js');

class LouisianaBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'louisiana',
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

const bot = new LouisianaBot();
bot.run();
