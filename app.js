const Homey = require('homey');
const { SenseApiClient } = require('sense-js-sdk');

class SenseApp extends Homey.App {

  async onInit() {
    this.log('Sense App initialized');
    setTimeout(() => {
      this.ensureDeviceCreated();
    }, 2000);
  }

  async ensureDeviceCreated() {
    try {
      const driver = await this.homey.drivers.getDriver('sense_monitor');
      if (!driver) {
        this.log('Driver sense_monitor not found yet.');
        return;
      }

      const devices = driver.getDevices ? driver.getDevices() : [];
      if (devices.length > 0) {
        this.log('Sense device already exists:', devices[0].getName());
        return;
      }

      this.log('No Sense devices found. Creating default auto-provisioned device via driver...');
      
      await driver.createDevice({
        name: 'Sense Monitor',
        data: {
          id: 'default_sense_monitor',
        },
        settings: {
          username: '',
          password: '',
        },
      });
      this.log('Successfully auto-created Sense Monitor device!');
    } catch (err) {
      this.error('Error in auto-creating device:', err);
    }
  }

}

module.exports = SenseApp;
