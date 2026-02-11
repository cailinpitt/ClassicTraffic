// TODO: Implement Nebraska traffic camera bot
const TrafficBot = require('../TrafficBot.js');

class NebraskaBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'nebraska',
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

const bot = new NebraskaBot();
bot.run();
