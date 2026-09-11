const Homey = require('homey');
const { SenseApiClient } = require('sense-js-sdk');

class SenseMonitorDevice extends Homey.Device {

  async onInit() {
    this.log('SenseMonitorDevice has been initialized');

    const settings = this.getSettings();
    const username = settings.username || this.homey.settings.get('username') || '';
    const password = settings.password || this.homey.settings.get('password') || '';

    this.log('Device settings retrieved. Username present:', !!username, 'Password present:', !!password);

    if (!username || !password) {
      this.log('Missing username or password in device or app settings!');
      this.setUnavailable('Please configure your Sense credentials in the app settings.');
      return;
    }

    if (!settings.username || !settings.password) {
      try {
        await this.setSettings({ username, password });
      } catch (e) {
        this.log('Error saving credentials to device settings:', e.message);
      }
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
      if (this.client && typeof this.client.refreshAccessTokenIfNeeded === 'function') {
        await this.client.refreshAccessTokenIfNeeded();
      }
      const isChild = !!(this.store && this.store.senseDeviceId);
      if (isChild) {
        this.log(`[TRENDS] Skipping monitor trends update for child device: ${this.store.senseDeviceId}`);
        return;
      }
      const targetId = this.monitorId;
      this.log(`[TRENDS] Fetching trends for monitor ID: ${targetId}`);
      
      const trends = await this.client.getMonitorTrends(targetId, 'America/Chicago', 'DAY');
      if (trends && trends.consumption && Array.isArray(trends.consumption.totals)) {
        const currentHour = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }), 10) || 0;
        const todaySoFarKwh = trends.consumption.totals.slice(0, currentHour + 1).reduce((acc, val) => acc + (Number(val) || 0), 0);
        
        this.log(`[TRENDS] Total daily kWh (API): ${trends.consumption.total}, Chicago Hour: ${currentHour}, Today so far: ${todaySoFarKwh} kWh`);
        if (this.hasCapability('meter_power')) {
          await this.setCapabilityValue('meter_power', Number(todaySoFarKwh.toFixed(3)) || 0);
        }
      }
    } catch (err) {
      this.error('Error fetching trends/energy data:', err.message);
    }
  }

  handleRealtimeData(payload) {
    if (this._deleted) return;

    if (!this._loggedPayload) {
      this._loggedPayload = true;
      this.log('[REALTIME PAYLOAD SAMPLE]:', JSON.stringify(payload));
    }

    const power = payload.w !== undefined ? payload.w : 0;
    const solarPower = payload.solar_w !== undefined ? payload.solar_w : (payload.solar !== undefined ? payload.solar : 0);
    const gridPower = payload.grid_w !== undefined ? payload.grid_w : (payload.grid !== undefined ? payload.grid : 0);
    const netPower = payload.net_w !== undefined ? payload.net_w : (payload.net !== undefined ? payload.net : power);
    
    const now = Date.now();
    if (this._lastRealtimeUpdate && now - this._lastRealtimeUpdate < 5000) {
      return;
    }
    this._lastRealtimeUpdate = now;

    if (this.hasCapability('measure_power')) {
      this.setCapabilityValue('measure_power', Number(power) || 0).catch(err => this.error('Failed to set measure_power:', err.message));
    }
    if (this.hasCapability('measure_power.solar')) {
      this.setCapabilityValue('measure_power.solar', Number(solarPower) || 0).catch(err => this.error('Failed to set measure_power.solar:', err.message));
    }
    if (this.hasCapability('measure_power.grid')) {
      this.setCapabilityValue('measure_power.grid', Number(gridPower) || 0).catch(err => this.error('Failed to set measure_power.grid:', err.message));
    }
    if (this.hasCapability('measure_power.net')) {
      this.setCapabilityValue('measure_power.net', Number(netPower) || 0).catch(err => this.error('Failed to set measure_power.net:', err.message));
    }

    if (this.hasCapability('meter_power')) {
      if (this._lastPowerTimestamp && this._lastPowerValue !== undefined) {
        const timeDeltaHours = (now - this._lastPowerTimestamp) / (1000 * 60 * 60);
        const avgPowerKw = ((this._lastPowerValue + power) / 2) / 1000;
        const incrementalKwh = avgPowerKw * timeDeltaHours;

        if (incrementalKwh > 0 && incrementalKwh < 1.0) {
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
    this._deleted = true;
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.reconnectInterval) clearInterval(this.reconnectInterval);
    if (this.client && typeof this.client.stopRealtimeUpdates === 'function') {
      try {
        await this.client.stopRealtimeUpdates();
      } catch (e) {
        // ignore
      }
    }
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('SenseMonitorDevice settings changed:', changedKeys);
    if (changedKeys.includes('username') || changedKeys.includes('password')) {
      this.log('Credentials updated in settings. Re-initializing device connection...');
      await this.onInit();
    }
  }

}

module.exports = SenseMonitorDevice;
