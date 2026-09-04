const Homey = require('homey');

class SenseApp extends Homey.App {

  async onInit() {
    this.log('Sense App initialized');

    // Automatically ensure the Sense monitor device exists if configured in app settings or environment
    this.ensureDeviceCreated();
  }

  async ensureDeviceCreated() {
    try {
      const drivers = this.homey.drivers.getDriver('sense_monitor');
      const devices = drivers.getDevices();
      if (devices.length === 0) {
        this.log('No Sense devices found. Checking app settings for auto-creation...');
        const settings = this.homey.settings.get('sense_credentials');
        if (!settings) {
          // Fallback to check global settings or driver settings
          const drivers = this.homey.drivers.getDriver('sense_monitor');
          const existingDevices = drivers.getDevices();
          if (existingDevices.length > 0) {
            return;
          }
        }
        if (settings && settings.username && settings.password) {
          this.log('Auto-creating Sense monitor device with stored credentials...');
          const { SenseApiClient } = require('sense-js-sdk');
          const client = new SenseApiClient();
          await client.login(settings.username, settings.password);
          const monitorIds = client.session?.monitorIds || [];
          if (monitorIds.length > 0) {
            await drivers.createDevice({
              name: 'Sense Monitor',
              data: { id: monitorIds[0] },
              settings: {
                username: settings.username,
                password: settings.password
              }
            });
            this.log('Sense monitor device auto-created successfully!');
          }
        }
      }
    } catch (err) {
      this.error('Error in auto-creating device:', err);
    }
  }

}

module.exports = SenseApp;
