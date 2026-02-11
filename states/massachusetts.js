// TODO: Implement Massachusetts traffic camera bot
const TrafficBot = require('../TrafficBot.js');

class MassachusettsBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'massachusetts',
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

const bot = new MassachusettsBot();
bot.run();
