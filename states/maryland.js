// TODO: Implement Maryland traffic camera bot
const TrafficBot = require('../TrafficBot.js');

class MarylandBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'maryland',
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

const bot = new MarylandBot();
bot.run();
