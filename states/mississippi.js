// TODO: Implement Mississippi traffic camera bot
const TrafficBot = require('../TrafficBot.js');

class MississippiBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'mississippi',
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

const bot = new MississippiBot();
bot.run();
