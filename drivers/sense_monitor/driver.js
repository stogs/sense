const Homey = require('homey');
const { SenseApiClient } = require('sense-js-sdk');

class SenseMonitorDriver extends Homey.Driver {

  async onInit() {
    this.log('SenseMonitorDriver initialized');
  }

  async onPair(session) {
    this.log('[PAIR] onPair session started');

    session.setHandler('list_devices', async () => {
      this.log('[PAIR] list_devices handler called');
      
      let username = '';
      let password = '';
      try {
        username = this.homey.settings.get('username') || '';
        password = this.homey.settings.get('password') || '';
      } catch (e) {
        this.log('[PAIR] Error reading settings via get(key):', e.message);
      }

      if (!username || !password) {
        try {
          const appSettings = this.homey.settings.get('settings');
          if (appSettings) {
            username = username || appSettings.username || '';
            password = password || appSettings.password || '';
          }
        } catch (e) {
          this.log('[PAIR] Error getting app settings with key:', e.message);
        }

        if (!username || !password) {
          try {
            const rawSettings = this.homey.settings.get();
            if (rawSettings) {
              username = username || rawSettings.username || '';
              password = password || rawSettings.password || '';
            }
          } catch (e) {
            this.log('[PAIR] Error getting raw app settings:', e.message);
          }
        }
      }

      this.log('[PAIR] Credentials present - username:', !!username, 'password:', !!password);

      if (!username || !password) {
        throw new Error('Please configure your Sense credentials in the Homey App settings first.');
      }

      const client = new SenseApiClient(undefined, {
        logger: {
          debug: (msg, ...args) => this.log('[SDK DEBUG]', msg, ...args),
          info: (msg, ...args) => this.log('[SDK INFO]', msg, ...args),
          warn: (msg, ...args) => this.error('[SDK WARN]', msg, ...args),
          error: (msg, ...args) => this.error('[SDK ERROR]', msg, ...args),
        }
      });

      const mfaToken = await client.login(username, password);
      if (mfaToken) {
        throw new Error('MFA is enabled on your Sense account. Please disable MFA in your Sense account.');
      }

      const monitorIds = client.session?.monitorIds || [];
      this.log('[PAIR] Found monitor IDs from API:', monitorIds);

      if (monitorIds.length === 0) {
        throw new Error('No Sense monitors found on this account.');
      }

      const devices = [];
      for (const id of monitorIds) {
        devices.push({
          name: `Sense Monitor ${monitorIds.length > 1 ? id : ''}`.trim(),
          data: {
            id: String(id)
          },
          store: {
            id: String(id)
          },
          settings: {
            username: username,
            password: password
          }
        });

        try {
          const monitorDevices = await client.getMonitorDevices(id);
          this.log(`[PAIR] Fetched monitor devices for monitor ${id}:`, JSON.stringify(monitorDevices));
          
          // Support various array shapes returned by client.getMonitorDevices(id)
          let devList = [];
          if (Array.isArray(monitorDevices)) {
            devList = monitorDevices;
          } else if (monitorDevices && typeof monitorDevices === 'object') {
            if (Array.isArray(monitorDevices.devices)) {
              devList = monitorDevices.devices;
            } else {
              devList = Object.values(monitorDevices).flat().filter(d => d && typeof d === 'object');
            }
          }

          for (const dev of devList) {
            const devId = dev.id || dev.device_id || dev.uuid;
            const devName = dev.name || dev.label || dev.device_name;
            if (!devId || !devName) continue;

            devices.push({
              name: String(devName),
              data: {
                id: `sense_device_${devId}`,
                senseDeviceId: String(devId)
              },
              store: {
                senseDeviceId: String(devId),
                monitorId: String(id)
              },
              parentId: String(id),
              capabilities: ['measure_power', 'meter_power'],
              settings: {
                device_type: dev.type || dev.device_type || '',
                device_make: dev.make || '',
                device_model: dev.model || ''
              }
            });
          }
        } catch (devErr) {
          this.error('[PAIR] Failed to fetch monitor devices for pairing:', devErr.message);
        }
      }

      this.log('[PAIR] Returning devices array to Homey frontend:', JSON.stringify(devices, null, 2));
      return devices;
    });

    session.setHandler('device_list', async () => {
      // Handled by view emission
    });
  }

}

module.exports = SenseMonitorDriver;
