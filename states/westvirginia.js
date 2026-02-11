// TODO: Implement West Virginia traffic camera bot
const TrafficBot = require('../TrafficBot.js');

class WestVirginiaBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'westvirginia',
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

const bot = new WestVirginiaBot();
bot.run();
