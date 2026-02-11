// TODO: Implement Iowa traffic camera bot
const TrafficBot = require('../TrafficBot.js');

class IowaBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'iowa',
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

const bot = new IowaBot();
bot.run();
