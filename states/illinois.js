// TODO: Implement Illinois traffic camera bot
const TrafficBot = require('../TrafficBot.js');

class IllinoisBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'illinois',
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

const bot = new IllinoisBot();
bot.run();
