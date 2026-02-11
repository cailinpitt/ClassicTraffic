// TODO: Implement Maine traffic camera bot
const TrafficBot = require('../TrafficBot.js');

class MaineBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'maine',
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

const bot = new MaineBot();
bot.run();
