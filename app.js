const Homey = require('homey');
const { SenseApiClient } = require('sense-js-sdk');

class SenseApp extends Homey.App {

  async onInit() {
    this.log('Sense App initialized');

    // Listen for changes to app-level settings
    this.homey.settings.on('set', async (key) => {
      if (key === 'username' || key === 'password') {
        this.log('App settings credentials updated. Checking device...');
        await this.updateDeviceCredentials();
      }
    });

    setTimeout(() => {
      this.ensureDeviceCreated();
    }, 2000);
  }

  async updateDeviceCredentials() {
    try {
      const driver = await this.homey.drivers.getDriver('sense_monitor');
      if (!driver) return;

      const devices = driver.getDevices ? driver.getDevices() : [];
      if (devices.length > 0) {
        const device = devices[0];
        const appSettings = this.homey.settings.get();
        const username = appSettings.username || '';
        const password = appSettings.password || '';

        this.log('Updating existing device settings with new app-level credentials...');
        await device.setSettings({
          username: username,
          password: password,
        });
      }
    } catch (err) {
      this.error('Error updating device credentials:', err);
    }
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

      const appSettings = this.homey.settings.get();
      const username = appSettings.username || '';
      const password = appSettings.password || '';

      this.log('No Sense devices found. Creating default auto-provisioned device with app-level settings...');
      
      await driver.createDevice({
        name: 'Sense Monitor',
        data: {
          id: 'default_sense_monitor',
        },
        settings: {
          username: username,
          password: password,
        },
      });
      this.log('Successfully auto-created Sense Monitor device!');
    } catch (err) {
      this.error('Error in auto-creating device:', err);
    }
  }

}

module.exports = SenseApp;
