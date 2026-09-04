const Homey = require('homey');
const { SenseApiClient } = require('sense-js-sdk');

class SenseMonitorDevice extends Homey.Device {

  async onInit() {
    this.log('SenseMonitorDevice has been initialized');

    const settings = this.getSettings();
    const username = settings.username;
    const password = settings.password;

    if (!username || !password) {
      this.setUnavailable('Please configure your Sense credentials in device settings.');
      return;
    }

    this.client = new SenseApiClient(undefined, {
      logger: {
        debug: (msg, ...args) => this.log('[DEBUG]', msg, ...args),
        info: (msg, ...args) => this.log('[INFO]', msg, ...args),
        warn: (msg, ...args) => this.log('[WARN]', msg, ...args),
        error: (msg, ...args) => this.error('[ERROR]', msg, ...args),
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

      this.monitorId = monitorIds[0];
      this.log(`Connected to Sense monitor ID: ${this.monitorId}`);

      this.setAvailable();

      // Fetch initial data
      await this.updateData();

      // Poll data every 30 seconds
      this.pollInterval = setInterval(async () => {
        await this.updateData();
      }, 30000);

      // Start real-time updates if supported
      try {
        await this.client.startRealtimeUpdates(this.monitorId);
        this.client.emitter.on('realtimeUpdate', (monitorId, data) => {
          if (data.type === 'data_change' && data.payload) {
            this.handleRealtimeData(data.payload);
          }
        });
        this.log('Real-time WebSocket updates started.');
      } catch (wsErr) {
        this.log('Could not start real-time updates, relying on polling:', wsErr.message);
      }

    } catch (err) {
      this.error('Failed to connect to Sense:', err);
      this.setUnavailable(`Failed to connect: ${err.message}`);
    }
  }

  async updateData() {
    try {
      if (!this.monitorId) return;

      const overview = await this.client.getMonitorOverview(this.monitorId);
      if (overview && overview.consumption) {
        const power = overview.consumption.power || 0;
        const solarPower = overview.solar ? (overview.solar.power || 0) : 0;
        const gridPower = overview.grid ? (overview.grid.power || 0) : power;
        const netPower = gridPower - solarPower;

        this.log(`Power update: Consumption=${power}W, Solar=${solarPower}W, Grid=${gridPower}W`);

        if (this.hasCapability('measure_power')) {
          await this.setCapabilityValue('measure_power', power);
        }
        if (this.hasCapability('measure_power.solar')) {
          await this.setCapabilityValue('measure_power.solar', solarPower);
        }
        if (this.hasCapability('measure_power.grid')) {
          await this.setCapabilityValue('measure_power.grid', gridPower);
        }
        if (this.hasCapability('measure_power.net')) {
          await this.setCapabilityValue('measure_power.net', netPower);
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
    this.log('Realtime WebSocket payload received:', JSON.stringify(payload));
    // Payload typically contains w (active power) etc.
    if (payload.w !== undefined) {
      const power = payload.w;
      this.setCapabilityValue('measure_power', power).catch(this.error);
    }
    if (payload.solar_w !== undefined) {
      const solarPower = payload.solar_w;
      this.setCapabilityValue('measure_power.solar', solarPower).catch(this.error);
    }
    if (payload.grid_w !== undefined) {
      const gridPower = payload.grid_w;
      this.setCapabilityValue('measure_power.grid', gridPower).catch(this.error);
    }
  }

  async onDeleted() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
    try {
      if (this.client) {
        await this.client.stopRealtimeUpdates();
      }
    } catch (e) {
      // ignore
    }
    this.log('SenseMonitorDevice deleted');
  }

}

module.exports = SenseMonitorDevice;
