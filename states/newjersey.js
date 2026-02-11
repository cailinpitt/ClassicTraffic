// TODO: Implement New Jersey traffic camera bot
const TrafficBot = require('../TrafficBot.js');

class NewJerseyBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'newjersey',
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

const bot = new NewJerseyBot();
bot.run();
