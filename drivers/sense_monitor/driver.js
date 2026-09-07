const Homey = require('homey');
const { SenseApiClient } = require('sense-js-sdk');

class SenseMonitorDriver extends Homey.Driver {

  async onInit() {
    this.log('SenseMonitorDriver initialized');
  }

  async createDevice(options) {
    const devices = this.getDevices();
    this.log('Current devices in driver:', devices.length);
    // Homey drivers in SDK v3 manage device storage/creation during pairing or app state
    return null;
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
          const appSettings = this.homey.settings.get();
          if (appSettings) {
            username = username || appSettings.username || '';
            password = password || appSettings.password || '';
          }
        } catch (e) {
          this.log('[PAIR] Error reading settings via get():', e.message);
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

      const devices = monitorIds.map((id, index) => {
        return {
          name: `Sense Monitor ${index > 0 ? index + 1 : ''}`.trim(),
          data: {
            id: String(id)
          },
          settings: {
            username: username,
            password: password
          }
        };
      });

      this.log('[PAIR] Returning devices array to Homey frontend:', JSON.stringify(devices, null, 2));
      return devices;
    });
  }

}

module.exports = SenseMonitorDriver;
