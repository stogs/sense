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
    let pendingMfaToken = null;
    let tempClient = null;

    session.setHandler('login', async (data) => {
      credentials.username = data.username;
      credentials.password = data.password;

      try {
        tempClient = new SenseApiClient(undefined, {
          logger: {
            debug: (msg, ...args) => { console.log('[PAIR DEBUG]', msg, ...args); this.log('[PAIR DEBUG]', msg, ...args); },
            info: (msg, ...args) => { console.log('[PAIR INFO]', msg, ...args); this.log('[PAIR INFO]', msg, ...args); },
            warn: (msg, ...args) => { console.warn('[PAIR WARN]', msg, ...args); this.error('[PAIR WARN]', msg, ...args); },
            error: (msg, ...args) => { console.error('[PAIR ERROR]', msg, ...args); this.error('[PAIR ERROR]', msg, ...args); },
          }
        });
        const mfaToken = await tempClient.login(credentials.username, credentials.password);

        if (mfaToken) {
          pendingMfaToken = mfaToken;
          return { mfaRequired: true };
        }

        const monitorIds = tempClient.session?.monitorIds;
        if (!monitorIds || monitorIds.length === 0) {
          throw new Error('No Sense monitors found on this account.');
        }

        return { mfaRequired: false };
      } catch (err) {
        this.error('Pairing login failed:', err);
        throw err;
      }
    });

    session.setHandler('mfa', async (data) => {
      try {
        if (!pendingMfaToken) {
          throw new Error('No pending MFA session found.');
        }
        await tempClient.completeMfaLogin(pendingMfaToken, data.otp, new Date());
        const monitorIds = tempClient.session?.monitorIds;
        if (!monitorIds || monitorIds.length === 0) {
          throw new Error('No Sense monitors found on this account.');
        }
        return true;
      } catch (err) {
        this.error('MFA verification failed:', err);
        throw err;
      }
    });

    session.setHandler('list_devices', async () => {
      try {
        if (tempClient && tempClient.isAuthenticated) {
          const monitorIds = tempClient.session?.monitorIds || [];
          return monitorIds.map((id, index) => {
            return {
              name: `Sense Monitor ${index > 0 ? index + 1 : ''}`.trim(),
              data: {
                id: id,
              },
              settings: {
                username: credentials.username,
                password: credentials.password,
              },
            };
          });
        }

        const client = new SenseApiClient(undefined, {
          logger: {
            debug: (msg, ...args) => { console.log('[PAIR DEBUG]', msg, ...args); this.log('[PAIR DEBUG]', msg, ...args); },
            info: (msg, ...args) => { console.log('[PAIR INFO]', msg, ...args); this.log('[INFO]', msg, ...args); },
            warn: (msg, ...args) => { console.warn('[PAIR WARN]', msg, ...args); this.error('[PAIR WARN]', msg, ...args); },
            error: (msg, ...args) => { console.error('[PAIR ERROR]', msg, ...args); this.error('[PAIR ERROR]', msg, ...args); },
          }
        });
        await client.login(credentials.username, credentials.password);
        const monitorIds = client.session?.monitorIds || [];

        return monitorIds.map((id, index) => {
          return {
            name: `Sense Monitor ${index > 0 ? index + 1 : ''}`.trim(),
            data: {
              id: id,
            },
            settings: {
              username: credentials.username,
              password: credentials.password,
            },
          };
        });
      } catch (err) {
        this.error('Failed to list devices during pairing:', err);
        throw err;
      }
    });
  }

}

module.exports = SenseMonitorDriver;
