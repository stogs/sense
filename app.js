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
    // Disabled auto-creation so users can properly pair via Homey UI if desired,
    // but let's make sure it doesn't interfere.
    this.log('Device auto-creation bypassed to allow normal pairing/discovery.');
  }

}

module.exports = SenseApp;
