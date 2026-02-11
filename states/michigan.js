// TODO: Implement Michigan traffic camera bot
const TrafficBot = require('../TrafficBot.js');

class MichiganBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'michigan',
      timezone: 'America/Detroit',
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

const bot = new MichiganBot();
bot.run();
