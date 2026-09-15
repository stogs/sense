const Homey = require('homey');

class SenseApp extends Homey.App {

  async onInit() {
    this.log('Sense App initialized');

    // Listen for changes to app-level settings
    this.homey.settings.on('set', async (key) => {
      if (key === 'username' || key === 'password') {
        this.log('App settings credentials updated. Updating monitor devices...');
        await this.updateDeviceCredentials();
      }
    });
  }

  async updateDeviceCredentials() {
    try {
      const driver = await this.homey.drivers.getDriver('sense_monitor');
      if (!driver) return;

      const devices = driver.getDevices ? driver.getDevices() : [];
      const username = this.homey.settings.get('username') || '';
      const password = this.homey.settings.get('password') || '';

      for (const device of devices) {
        // Only parent monitor needs credentials
        if (!device.isChildAppliance) {
          this.log(`Updating Sense Monitor "${device.getName()}" with new credentials...`);
          await device.setSettings({ username, password });
        }
      }
    } catch (err) {
      this.error('Error updating device credentials:', err);
    }
  }

}

module.exports = SenseApp;
