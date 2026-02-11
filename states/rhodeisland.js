// TODO: Implement Rhode Island traffic camera bot
const TrafficBot = require('../TrafficBot.js');

class RhodeIslandBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'rhodeisland',
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

const bot = new RhodeIslandBot();
bot.run();
