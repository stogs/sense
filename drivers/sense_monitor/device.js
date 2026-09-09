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

      // Fetch initial trends data immediately and poll every 15 minutes for energy totals & token refresh
      await this.updateData();

      if (this.pollInterval) clearInterval(this.pollInterval);
      this.pollInterval = setInterval(async () => {
        try {
          this.log('[POLL] Periodic check / token refresh and trends update...');
          await this.updateData();
        } catch (pollErr) {
          this.error('Error during periodic poll:', pollErr.message);
        }
      }, 15 * 60 * 1000);

      // Setup periodic WebSocket keepalive / reconnection check every 30 minutes
      if (this.reconnectInterval) clearInterval(this.reconnectInterval);
      this.reconnectInterval = setInterval(async () => {
        try {
          this.log('[WS CHECK] Checking WebSocket connection state...');
          if (this.client && typeof this.client.startRealtimeUpdates === 'function') {
            if (!this.client._socket || this.client._socket.readyState !== WebSocket.OPEN) {
              this.log('[WS CHECK] WebSocket is not open. Reconnecting...');
              if (this.client._socket) {
                await this.client.stopRealtimeUpdates();
              }
              await this.client.startRealtimeUpdates(this.monitorId);
            } else {
              this.log('[WS CHECK] WebSocket is active and connected.');
            }
          }
        } catch (wsCheckErr) {
          this.error('Error during WebSocket keepalive check:', wsCheckErr.message);
        }
      }, 30 * 60 * 1000);

    } catch (err) {
      this.error('Failed to connect to Sense:', err);
      this.setUnavailable(`Failed to connect: ${err.message}`);
    }
  }

  async updateData() {
    try {
      if (!this.monitorId) return;
      // Ensure access token is refreshed/valid before making API calls
      if (this.client && typeof this.client.refreshAccessTokenIfNeeded === 'function') {
        await this.client.refreshAccessTokenIfNeeded();
      }
      const trends = await this.client.getMonitorTrends(this.monitorId, 'America/New_York', 'DAY');
      if (trends && trends.consumption) {
        const totalKwh = trends.consumption.total !== undefined ? trends.consumption.total : 0;
        this.log(`[TRENDS] Updated daily energy consumption total: ${totalKwh} kWh`);
        if (this.hasCapability('meter_power')) {
          await this.setCapabilityValue('meter_power', Number(totalKwh) || 0);
        }
      }
    } catch (err) {
      this.error('Error fetching trends/energy data:', err.message);
    }
  }

  handleRealtimeData(payload) {
    const power = payload.w !== undefined ? payload.w : 0;
    
    // Throttle updates to at most once every 5 seconds to prevent spamming logs and capability changes
    const now = Date.now();
    if (this._lastRealtimeUpdate && now - this._lastRealtimeUpdate < 5000) {
      return;
    }
    this._lastRealtimeUpdate = now;

    if (this.hasCapability('measure_power')) {
      this.setCapabilityValue('measure_power', Number(power) || 0).catch(err => this.error('Failed to set measure_power:', err.message));
    }

    // Accumulate energy (meter_power) locally from instantaneous power using time delta (kWh = kW * hours)
    if (this.hasCapability('meter_power')) {
      if (this._lastPowerTimestamp && this._lastPowerValue !== undefined) {
        const timeDeltaHours = (now - this._lastPowerTimestamp) / (1000 * 60 * 60);
        // Average power in kilowatts over the interval
        const avgPowerKw = ((this._lastPowerValue + power) / 2) / 1000;
        const incrementalKwh = avgPowerKw * timeDeltaHours;

        if (incrementalKwh > 0 && incrementalKwh < 1.0) { // sanity check
          const currentEnergy = this.getCapabilityValue('meter_power') || 0;
          const newEnergy = Number((currentEnergy + incrementalKwh).toFixed(4));
          this.setCapabilityValue('meter_power', newEnergy).catch(err => this.error('Failed to set meter_power:', err.message));
        }
      }
      this._lastPowerTimestamp = now;
      this._lastPowerValue = power;
    }
  }

  async onDeleted() {
    this.log('SenseMonitorDevice has been deleted');
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.reconnectInterval) clearInterval(this.reconnectInterval);
    if (this.client && typeof this.client.stopRealtimeUpdates === 'function') {
      await this.client.stopRealtimeUpdates();
    }
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
