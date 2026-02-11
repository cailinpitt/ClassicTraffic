// TODO: Implement Missouri traffic camera bot
const TrafficBot = require('../TrafficBot.js');

class MissouriBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'missouri',
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

const bot = new MissouriBot();
bot.run();
