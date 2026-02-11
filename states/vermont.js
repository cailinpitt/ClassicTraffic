// TODO: Implement Vermont traffic camera bot
const TrafficBot = require('../TrafficBot.js');

class VermontBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'vermont',
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

const bot = new VermontBot();
bot.run();
