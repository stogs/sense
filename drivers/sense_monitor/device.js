const Homey = require('homey');
const { SenseApiClient } = require('../../lib/SenseApiClient');

class SenseMonitorDevice extends Homey.Device {

  get isChildAppliance() {
    return Boolean(this.getStoreValue('senseDeviceId'));
  }

  get senseDeviceId() {
    return this.getStoreValue('senseDeviceId');
  }

  get monitorId() {
    return this.getStoreValue('monitorId') || (this.isChildAppliance ? null : this.getData().id);
  }

  async onInit() {
    this.log(`Initializing ${this.isChildAppliance ? 'Child Appliance' : 'Sense Monitor'} device: "${this.getName()}"`);

    // -------------------------------------------------------------------------
    // CHILD APPLIANCE
    // -------------------------------------------------------------------------
    if (this.isChildAppliance) {
      this.log(`Child appliance ready: "${this.getName()}" (Sense ID: ${this.senseDeviceId}, Parent Monitor: ${this.monitorId})`);
      this.setAvailable();
      return;
    }

    // -------------------------------------------------------------------------
    // PARENT SENSE MONITOR
    // -------------------------------------------------------------------------
    const settings = this.getSettings();
    const username = settings.username || this.homey.settings.get('username') || '';
    const password = settings.password || this.homey.settings.get('password') || '';

    if (!username || !password) {
      this.log('Missing Sense credentials in device or app settings!');
      this.setUnavailable('Please configure your Sense credentials in the app settings.');
      return;
    }

    // Keep device settings in sync with app settings if missing
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
      this.log('Authenticating Sense Monitor with Sense API...');
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

      const rawId = this.getData().id;
      this.activeMonitorId = this.getStoreValue('monitorId') || rawId || monitorIds[0];
      this.log(`Connected to Sense monitor ID: ${this.activeMonitorId}`);

      this.setAvailable();

      // Start real-time updates feed (single WebSocket connection)
      try {
        if (typeof this.client.startRealtimeUpdates === 'function') {
          this.log('Starting Sense real-time updates WebSocket feed...');
          await this.client.startRealtimeUpdates(this.activeMonitorId);
          this.client.emitter.on('realtimeUpdate', (monitorId, data) => {
            if (String(monitorId) === String(this.activeMonitorId)) {
              this.handleRealtimeData(data.payload || data);
            }
          });
        }
      } catch (wsErr) {
        this.error('Failed to start real-time updates feed, falling back to polling:', wsErr.message);
      }

      // Initial fetch for today's kWh energy trends
      await this.updateMonitorTrends();

      // Periodic 15-minute poll for energy trends
      if (this.pollInterval) clearInterval(this.pollInterval);
      this.pollInterval = setInterval(async () => {
        try {
          this.log('[POLL] Periodic check / token refresh and trends update...');
          await this.updateMonitorTrends();
        } catch (pollErr) {
          this.error('Error during periodic poll:', pollErr.message);
        }
      }, 15 * 60 * 1000);

      // Periodic 30-minute WebSocket health check
      if (this.reconnectInterval) clearInterval(this.reconnectInterval);
      this.reconnectInterval = setInterval(async () => {
        try {
          if (this.client && typeof this.client.startRealtimeUpdates === 'function') {
            const socket = this.client._socket;
            if (!socket || socket.readyState !== 1 /* WebSocket.OPEN */) {
              this.log('[WS CHECK] WebSocket is not open. Reconnecting...');
              if (this.client._socket) {
                await this.client.stopRealtimeUpdates();
              }
              await this.client.startRealtimeUpdates(this.activeMonitorId);
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

  // ---------------------------------------------------------------------------
  // CHILD APPLIANCE: Real-time update dispatcher target
  // ---------------------------------------------------------------------------
  async onRealtimePowerUpdate(watts) {
    if (this._deleted) return;
    const power = Number(watts) || 0;

    if (this.hasCapability('measure_power')) {
      this.setCapabilityValue('measure_power', power).catch(err => {
        this.error(`Failed to set measure_power on ${this.getName()}:`, err.message);
      });
    }

    // Accumulate energy usage for child appliance
    if (this.hasCapability('meter_power')) {
      const now = Date.now();
      if (this._lastPowerTimestamp && this._lastPowerValue !== undefined) {
        const timeDeltaHours = (now - this._lastPowerTimestamp) / (1000 * 60 * 60);
        const avgPowerKw = ((this._lastPowerValue + power) / 2) / 1000;
        const incrementalKwh = avgPowerKw * timeDeltaHours;

        if (incrementalKwh > 0 && incrementalKwh < 1.0) {
          const currentEnergy = this.getCapabilityValue('meter_power') || 0;
          const newEnergy = Number((currentEnergy + incrementalKwh).toFixed(4));
          this.setCapabilityValue('meter_power', newEnergy).catch(err => {
            this.error(`Failed to set meter_power on ${this.getName()}:`, err.message);
          });
        }
      }
      this._lastPowerTimestamp = now;
      this._lastPowerValue = power;
    }
  }

  // ---------------------------------------------------------------------------
  // PARENT SENSE MONITOR: Incoming WebSocket payload handler
  // ---------------------------------------------------------------------------
  handleRealtimeData(payload) {
    if (this._deleted || !payload) return;

    // 1. Update Monitor Aggregate Capabilities
    const power = payload.w !== undefined ? payload.w : 0;
    const solarPower = payload.solar_w !== undefined ? payload.solar_w : (payload.solar !== undefined ? payload.solar : 0);
    const gridPower = payload.grid_w !== undefined ? payload.grid_w : (payload.grid !== undefined ? payload.grid : 0);
    const netPower = payload.net_w !== undefined ? payload.net_w : (payload.net !== undefined ? payload.net : power);

    const now = Date.now();
    // Throttle monitor capability updates to at most once per 2 seconds
    if (!this._lastRealtimeUpdate || now - this._lastRealtimeUpdate >= 2000) {
      this._lastRealtimeUpdate = now;

      if (this.hasCapability('measure_power')) {
        this.setCapabilityValue('measure_power', Number(power) || 0).catch(this.error);
      }
      if (this.hasCapability('measure_power.solar')) {
        this.setCapabilityValue('measure_power.solar', Number(solarPower) || 0).catch(this.error);
      }
      if (this.hasCapability('measure_power.grid')) {
        this.setCapabilityValue('measure_power.grid', Number(gridPower) || 0).catch(this.error);
      }
      if (this.hasCapability('measure_power.net')) {
        this.setCapabilityValue('measure_power.net', Number(netPower) || 0).catch(this.error);
      }
    }

    // 2. Dispatch individual device wattage to all paired Child Appliances
    const payloadDevices = payload.devices || [];
    const devicePowerMap = new Map();
    for (const d of payloadDevices) {
      if (d && d.id !== undefined && d.w !== undefined) {
        devicePowerMap.set(String(d.id), d.w);
      }
    }

    const allDevices = this.driver.getDevices ? this.driver.getDevices() : [];
    for (const dev of allDevices) {
      if (dev.isChildAppliance && String(dev.monitorId) === String(this.activeMonitorId || this.monitorId)) {
        const sId = String(dev.senseDeviceId);
        // If device is in payload.devices, use its wattage; if not, it is idle/off (0 W)
        const devWatts = devicePowerMap.has(sId) ? devicePowerMap.get(sId) : 0;
        dev.onRealtimePowerUpdate(devWatts);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // PARENT SENSE MONITOR: Energy Trends (kWh)
  // ---------------------------------------------------------------------------
  async updateMonitorTrends() {
    try {
      const monId = this.activeMonitorId || this.monitorId;
      if (!monId || !this.client) return;

      if (typeof this.client.refreshAccessTokenIfNeeded === 'function') {
        await this.client.refreshAccessTokenIfNeeded();
      }

      const trends = await this.client.getMonitorTrends(monId, 'America/Chicago', 'DAY');
      if (trends && trends.consumption && Array.isArray(trends.consumption.totals)) {
        const currentHour = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }), 10) || 0;
        const todaySoFarKwh = trends.consumption.totals.slice(0, currentHour + 1).reduce((acc, val) => acc + (Number(val) || 0), 0);

        if (this.hasCapability('meter_power')) {
          await this.setCapabilityValue('meter_power', Number(todaySoFarKwh.toFixed(3)) || 0);
        }
      }
    } catch (err) {
      this.error('[TRENDS] Error fetching trends/energy data:', err.message);
    }
  }

  async onDeleted() {
    this.log(`Sense device deleted: "${this.getName()}"`);
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
    this.log(`Settings changed for "${this.getName()}":`, changedKeys);
    if (changedKeys.includes('username') || changedKeys.includes('password')) {
      if (!this.isChildAppliance) {
        this.log('Monitor credentials updated. Re-initializing connection...');
        await this.onInit();
      }
    }
  }

}

module.exports = SenseMonitorDevice;
