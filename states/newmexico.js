// TODO: Implement New Mexico traffic camera bot
const TrafficBot = require('../TrafficBot.js');

class NewMexicoBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'newmexico',
      timezone: 'America/Denver',
      tzAbbrev: 'MT',
    });
  }

  async fetchCameras() {
    throw new Error('Not implemented yet');
  }

  async downloadImage(index) {
    throw new Error('Not implemented yet');
  }
}

const bot = new NewMexicoBot();
bot.run();
