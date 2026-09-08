const Homey = require('homey');
const { SenseApiClient } = require('sense-js-sdk');

class SenseMonitorDevice extends Homey.Device {

  async onInit() {
    this.log('SenseMonitorDevice has been initialized');

    let username = '';
    let password = '';
    try {
      const settings = this.getSettings();
      username = settings && settings.username ? settings.username : '';
      password = settings && settings.password ? settings.password : '';
    } catch (e) {
      this.log('Error getting device settings:', e.message);
    }

    // Fallback to app-level settings if device settings are empty
    if (!username || !password) {
      try {
        const appSettings = this.homey.settings.get();
        if (appSettings) {
          username = username || appSettings.username || '';
          password = password || appSettings.password || '';
        }
      } catch (e) {
        this.log('Error getting app settings:', e.message);
      }

      if (username && password) {
        this.log('Inherited credentials from app-level settings.');
        try {
          await this.setSettings({ username, password });
        } catch (e) {
          this.log('Error setting device settings:', e.message);
        }
      }
    }

    this.log('Device settings retrieved. Username present:', !!username, 'Password present:', !!password);

    if (!username || !password) {
      this.log('Missing username or password in device or app settings!');
      this.setUnavailable('Please configure your Sense credentials in the app settings.');
      return;
    }

    this.client = new SenseApiClient(undefined, {
      logger: {
        debug: () => {},
        info: () => {},
        warn: (msg, ...args) => {
          console.warn('[SENSE WARN]', msg, ...args);
          this.error('[SENSE WARN]', msg, ...args);
        },
        error: (msg, ...args) => {
          console.error('[SENSE ERROR]', msg, ...args);
          this.error('[SENSE ERROR]', msg, ...args);
        },
      }
    });

    try {
      this.log('Authenticating with Sense API...');
      const mfaToken = await this.client.login(username, password);

      if (mfaToken) {
        this.setUnavailable('MFA is enabled on this Sense account. Please disable MFA or use an account without MFA.');
        return;
      }

      const monitorIds = this.client.session?.monitorIds;
      if (!monitorIds || monitorIds.length === 0) {
        this.setUnavailable('No Sense monitors found on this account.');
        return;
      }

      this.monitorId = this.getData().id || monitorIds[0];
      this.log(`Connected to Sense monitor ID: ${this.monitorId}`);

      this.setAvailable();

      // Fetch initial data immediately
      await this.updateData();

      // Poll data every 5 minutes (300,000 ms) using REST overview API
      if (this.pollInterval) clearInterval(this.pollInterval);
      this.pollInterval = setInterval(async () => {
        await this.updateData();
      }, 5 * 60 * 1000);

    } catch (err) {
      this.error('Failed to connect to Sense:', err);
      this.setUnavailable(`Failed to connect: ${err.message}`);
    }
  }

  async updateData() {
    try {
      if (!this.monitorId) return;

      const status = await this.client.getMonitorStatus(this.monitorId);
      this.log('Sense monitor status response:', JSON.stringify(status, null, 2));

      if (status) {
        // Sense getMonitorStatus returns top-level w, solar_w, grid_w etc.
        const power = status.w !== undefined ? status.w : 0;
        const solarPower = status.solar_w !== undefined ? status.solar_w : 0;
        const gridPower = status.grid_w !== undefined ? status.grid_w : power;
        const netPower = gridPower - solarPower;

        this.log(`Status update parsed: Power=${power}W, Solar=${solarPower}W, Grid=${gridPower}W, Net=${netPower}W`);

        if (this.hasCapability('measure_power')) {
          await this.setCapabilityValue('measure_power', Number(power) || 0);
        }
        if (this.hasCapability('measure_power.solar')) {
          await this.setCapabilityValue('measure_power.solar', Number(solarPower) || 0);
        }
        if (this.hasCapability('measure_power.grid')) {
          await this.setCapabilityValue('measure_power.grid', Number(gridPower) || 0);
        }
        if (this.hasCapability('measure_power.net')) {
          await this.setCapabilityValue('measure_power.net', Number(netPower) || 0);
        }
      }
    } catch (err) {
      this.error('Error updating Sense monitor data:', err);
      // Try to re-login if unauthenticated
      if (err.name === 'UnauthenticatedError' || (err.message && err.message.includes('401'))) {
        try {
          const settings = this.getSettings();
          await this.client.login(settings.username, settings.password);
        } catch (loginErr) {
          this.error('Re-login failed:', loginErr);
        }
      }
    }
  }

  handleRealtimeData(payload) {
    // Payload contains total power 'w', 'grid_w', 'solar_w', etc.
    const power = payload.w !== undefined ? payload.w : 0;
    const solarPower = payload.solar_w !== undefined ? payload.solar_w : 0;
    const gridPower = payload.grid_w !== undefined ? payload.grid_w : power;
    const netPower = gridPower - solarPower;

    this.setCapabilityValue('measure_power', Number(power) || 0).catch(this.error);
    this.setCapabilityValue('measure_power.solar', Number(solarPower) || 0).catch(this.error);
    this.setCapabilityValue('measure_power.grid', Number(gridPower) || 0).catch(this.error);
    this.setCapabilityValue('measure_power.net', Number(netPower) || 0).catch(this.error);
  }

  async onAdded() {
    this.log('SenseMonitorDevice has been added');
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('SenseMonitorDevice settings changed:', changedKeys);
    if (changedKeys.includes('username') || changedKeys.includes('password')) {
      this.log('Credentials updated in settings. Re-initializing device connection...');
      // Restart initialization or re-trigger connection
      await this.onInit();
    }
  }

}

module.exports = SenseMonitorDevice;
