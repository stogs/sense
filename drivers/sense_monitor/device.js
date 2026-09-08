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

      // Fetch real-time updates via SDK startRealtimeUpdates if available, or fall back to startRealtimeUpdates
      try {
        if (typeof this.client.startRealtimeUpdates === 'function') {
          this.log('Starting Sense real-time updates websocket feed...');
          await this.client.startRealtimeUpdates(this.monitorId);
          this.client.emitter.on('realtimeUpdate', (monitorId, data) => {
            if (String(monitorId) === String(this.monitorId)) {
              this.handleRealtimeData(data.payload || data);
            }
          });
        }
      } catch (wsErr) {
        this.log('Failed to start real-time updates feed, falling back to polling:', wsErr.message);
      }

      // Do not poll via overview REST (which returns 0 for overview power), rely entirely on realtime websocket feed
      if (this.pollInterval) clearInterval(this.pollInterval);

    } catch (err) {
      this.error('Failed to connect to Sense:', err);
      this.setUnavailable(`Failed to connect: ${err.message}`);
    }
  }

  async updateData() {
    try {
      if (!this.monitorId) return;

      const status = await this.client.getMonitorOverview(this.monitorId);
      this.log('Sense monitor overview response:', JSON.stringify(status, null, 2));

      if (status) {
        // Sense getMonitorOverview returns consumption power as status.w or status.consumption.power
        const power = status.w !== undefined ? status.w : (status.consumption && status.consumption.power !== undefined ? status.consumption.power : (status.power !== undefined ? status.power : 0));
        
        this.log(`Overview update parsed: Power=${power}W`);

        if (this.hasCapability('measure_power')) {
          await this.setCapabilityValue('measure_power', Number(power) || 0);
          this.log(`Successfully set capability measure_power to ${Number(power) || 0}`);
        }

        if (this.hasCapability('meter_power')) {
          // Calculate or fetch energy if available in overview, or estimate/default to accumulated
          const energyKwh = status.energy !== undefined ? status.energy : 0;
          await this.setCapabilityValue('meter_power', Number(energyKwh) || 0);
          this.log(`Successfully set capability meter_power to ${Number(energyKwh) || 0}`);
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
    this.log(`[REALTIME] Received live power: ${power}W`);

    if (this.hasCapability('measure_power')) {
      this.setCapabilityValue('measure_power', Number(power) || 0).catch(err => this.error('Failed to set measure_power:', err.message));
    }
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
