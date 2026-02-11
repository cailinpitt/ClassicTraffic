// TODO: Implement New Hampshire traffic camera bot
const TrafficBot = require('../TrafficBot.js');

class NewHampshireBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'newhampshire',
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

const bot = new NewHampshireBot();
bot.run();
