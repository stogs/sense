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
    let credentials = {};

    session.setHandler('login', async (data) => {
      credentials.username = data.username;
      credentials.password = data.password;
      this.log('[PAIR] login handler received credentials for:', credentials.username);
      return true;
    });

    session.setHandler('list_devices', async () => {
      this.log('[PAIR] list_devices handler triggered');
      
      if (!credentials.username || !credentials.password) {
        this.error('[PAIR ERROR] Credentials missing in list_devices! Credentials object:', credentials);
        throw new Error('No credentials provided in pairing session. Please restart pairing.');
      }

      this.log('[PAIR] Authenticating client for device listing with:', credentials.username);
      const client = new SenseApiClient(undefined, {
        logger: {
          debug: (msg, ...args) => { console.log('[PAIR DEBUG]', msg, ...args); this.log('[PAIR DEBUG]', msg, ...args); },
          info: (msg, ...args) => { console.log('[PAIR INFO]', msg, ...args); this.log('[INFO]', msg, ...args); },
          warn: (msg, ...args) => { console.warn('[PAIR WARN]', msg, ...args); this.error('[PAIR WARN]', msg, ...args); },
          error: (msg, ...args) => { console.error('[PAIR ERROR]', msg, ...args); this.error('[PAIR ERROR]', msg, ...args); },
        },
        fetcher: async (url, options) => {
          this.log('[API REQ]', options?.method || 'GET', url, options?.body ? String(options.body) : '');
          const res = await fetch(url, options);
          const clone = res.clone();
          try {
            const json = await clone.json();
            this.log('[API RES JSON]', url, JSON.stringify(json, null, 2));
          } catch (e) {
            const text = await clone.text();
            this.log('[API RES TEXT]', url, text);
          }
          return res;
        }
      });

      const mfaToken = await client.login(credentials.username, credentials.password);
      if (mfaToken) {
        throw new Error('MFA is enabled on your Sense account. Please disable MFA in your Sense account.');
      }

      const monitorIds = client.session?.monitorIds || [];
      this.log('[PAIR] Found monitor IDs:', monitorIds);

      if (monitorIds.length === 0) {
        throw new Error('No Sense monitors found on this account.');
      }

      const devices = monitorIds.map((id, index) => {
        return {
          name: `Sense Monitor ${index > 0 ? index + 1 : ''}`.trim(),
          data: {
            id: String(id),
          },
          store: {
            id: String(id),
          },
          settings: {
            username: credentials.username,
            password: credentials.password,
          },
        };
      });

      this.log('[PAIR] Returning devices to frontend:', JSON.stringify(devices, null, 2));
      return devices;
    });
  }

}

module.exports = SenseMonitorDriver;
