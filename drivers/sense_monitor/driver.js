const Homey = require('homey');
const { SenseApiClient } = require('../../lib/SenseApiClient');

class SenseMonitorDriver extends Homey.Driver {

  async onInit() {
    this.log('SenseMonitorDriver initialized');
  }

  createSenseClient() {
    return new SenseApiClient(undefined, {
      logger: {
        debug: (msg, ...args) => this.log('[SDK DEBUG]', msg, ...args),
        info: (msg, ...args) => this.log('[SDK INFO]', msg, ...args),
        warn: (msg, ...args) => this.error('[SDK WARN]', msg, ...args),
        error: (msg, ...args) => this.error('[SDK ERROR]', msg, ...args),
      }
    });
  }

  async onPair(session) {
    this.log('[PAIR] onPair session started');
    let authenticatedClient = null;

    // Check if credentials are already set in App Settings
    const getSavedCredentials = () => {
      const username = this.homey.settings.get('username') || '';
      const password = this.homey.settings.get('password') || '';
      return { username, password };
    };

    // Auto-advance to list_devices if credentials already exist
    session.setHandler('showView', async (viewId) => {
      this.log(`[PAIR] Current view: ${viewId}`);
      if (viewId === 'login_credentials' && !session._hasCheckedInitialLogin) {
        session._hasCheckedInitialLogin = true;
        const { username, password } = getSavedCredentials();
        if (username && password) {
          this.log('[PAIR] Saved credentials found, skipping login view directly to list_devices');
          await session.showView('list_devices');
        }
      }
    });

    // Handle credentials submission from login_credentials view
    session.setHandler('login', async (data) => {
      this.log('[PAIR] Login view submitted');
      const username = (data.username || '').trim();
      const password = data.password || '';

      if (!username || !password) {
        throw new Error('Please enter both your Sense email/username and password.');
      }

      const client = this.createSenseClient();
      this.log('[PAIR] Attempting authentication with Sense API...');
      const mfaToken = await client.login(username, password);

      if (mfaToken) {
        throw new Error('MFA is enabled on this Sense account. Please disable MFA or use an account without MFA.');
      }

      // Save valid credentials for future use
      await this.homey.settings.set('username', username);
      await this.homey.settings.set('password', password);
      authenticatedClient = client;

      this.log('[PAIR] Login successful, saved credentials to app settings');
      return true;
    });

    // Handle device discovery for list_devices template
    session.setHandler('list_devices', async () => {
      this.log('[PAIR] list_devices handler called');
      let client = authenticatedClient;

      if (!client) {
        const { username, password } = getSavedCredentials();
        if (!username || !password) {
          throw new Error('No Sense credentials found. Please log in first.');
        }

        client = this.createSenseClient();
        this.log('[PAIR] Authenticating using saved credentials...');
        const mfaToken = await client.login(username, password);
        if (mfaToken) {
          throw new Error('MFA is enabled on this Sense account. Please disable MFA.');
        }
        authenticatedClient = client;
      }

      const monitorIds = client.session?.monitorIds || [];
      this.log('[PAIR] Found monitor IDs from API:', monitorIds);

      if (monitorIds.length === 0) {
        throw new Error('No Sense monitors found on this account.');
      }

      const { username, password } = getSavedCredentials();
      const devices = [];

      for (const id of monitorIds) {
        // 1. Primary Sense Monitor
        devices.push({
          name: `Sense Monitor ${monitorIds.length > 1 ? id : ''}`.trim(),
          data: {
            id: String(id)
          },
          store: {
            monitorId: String(id)
          },
          capabilities: [
            'measure_power',
            'meter_power',
            'measure_power.solar',
            'measure_power.grid',
            'measure_power.net'
          ],
          settings: {
            username: username,
            password: password
          }
        });

        // 2. Detected Appliances / Smart Plugs under this Monitor
        try {
          const monitorDevices = await client.getMonitorDevices(id);
          this.log(`[PAIR] Fetched ${Array.isArray(monitorDevices) ? monitorDevices.length : 0} devices for monitor ${id}`);

          if (Array.isArray(monitorDevices)) {
            for (const dev of monitorDevices) {
              if (!dev.id || !dev.name) continue;

              devices.push({
                name: dev.name,
                data: {
                  id: `sense_device_${dev.id}`
                },
                store: {
                  senseDeviceId: String(dev.id),
                  monitorId: String(id)
                },
                capabilities: ['measure_power', 'meter_power'],
                settings: {
                  device_type: dev.type || '',
                  device_make: dev.make || '',
                  device_model: dev.model || ''
                }
              });
            }
          }
        } catch (devErr) {
          this.error('[PAIR] Error fetching monitor devices for pairing:', devErr.message);
        }
      }

      this.log(`[PAIR] Returning ${devices.length} devices to Homey for selection`);
      return devices;
    });
  }

}

module.exports = SenseMonitorDriver;
