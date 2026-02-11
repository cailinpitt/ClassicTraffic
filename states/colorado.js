// TODO: Implement Colorado traffic camera bot
const TrafficBot = require('../TrafficBot.js');

class ColoradoBot extends TrafficBot {
  constructor() {
    super({
      accountName: 'colorado',
      timezone: 'America/Denver',
      tzAbbrev: 'MT',
    });
  }

  async fetchCameras() {
    throw new Error('Not implemented yet');
  }

  async downloadImage(index) {
    throw new Error('Not implemented yet');
  }
}

const bot = new ColoradoBot();
bot.run();
