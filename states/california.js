// TODO: Implement California traffic camera bot
const TrafficBot = require('../TrafficBot.js');

class CaliforniaBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'california',
      timezone: 'America/Los_Angeles',
      tzAbbrev: 'PT',
    });
  }

  async fetchCameras() {
    throw new Error('Not implemented yet');
  }

  async downloadImage(index) {
    throw new Error('Not implemented yet');
  }
}

const bot = new CaliforniaBot();
bot.run();
