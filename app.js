const Homey = require('homey');

class SenseApp extends Homey.App {

  async onInit() {
    this.log('Sense App initialized');
  }

}

module.exports = SenseApp;
