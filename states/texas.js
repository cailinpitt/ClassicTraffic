// TODO: Implement Texas traffic camera bot
const TrafficBot = require('../TrafficBot.js');

class TexasBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'texas',
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

const bot = new TexasBot();
bot.run();
