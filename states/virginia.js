// TODO: Implement Virginia traffic camera bot
const TrafficBot = require('../TrafficBot.js');

class VirginiaBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'virginia',
      timezone: 'America/New_York',
      tzAbbrev: 'ET',
    });
  }

  async fetchCameras() {
    throw new Error('Not implemented yet');
  }

  async downloadImage(index) {
    throw new Error('Not implemented yet');
  }
}

const bot = new VirginiaBot();
bot.run();
