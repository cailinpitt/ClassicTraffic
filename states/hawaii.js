// TODO: Implement Hawaii traffic camera bot
const TrafficBot = require('../TrafficBot.js');

class HawaiiBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'hawaii',
      timezone: 'Pacific/Honolulu',
      tzAbbrev: 'HST',
    });
  }

  async fetchCameras() {
    throw new Error('Not implemented yet');
  }

  async downloadImage(index) {
    throw new Error('Not implemented yet');
  }
}

const bot = new HawaiiBot();
bot.run();
