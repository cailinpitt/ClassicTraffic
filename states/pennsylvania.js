// TODO: Implement Pennsylvania traffic camera bot
const TrafficBot = require('../TrafficBot.js');

class PennsylvaniaBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'pennsylvania',
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

const bot = new PennsylvaniaBot();
bot.run();
