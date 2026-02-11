// TODO: Implement Indiana traffic camera bot
const TrafficBot = require('../TrafficBot.js');

class IndianaBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'indiana',
      timezone: 'America/Indiana/Indianapolis',
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

const bot = new IndianaBot();
bot.run();
