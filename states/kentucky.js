// TODO: Implement Kentucky traffic camera bot
const TrafficBot = require('../TrafficBot.js');

class KentuckyBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'kentucky',
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

const bot = new KentuckyBot();
bot.run();
