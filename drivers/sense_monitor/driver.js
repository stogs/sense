const Homey = require('homey');
const { SenseApiClient } = require('sense-js-sdk');

class SenseMonitorDriver extends Homey.Driver {

  async onInit() {
    this.log('SenseMonitorDriver initialized');
  }

  async onPair(session) {
    let credentials = {};

    session.setHandler('login', async (data) => {
      credentials.username = data.username;
      credentials.password = data.password;

      try {
        const client = new SenseApiClient(undefined, {
          logger: {
            debug: (msg, ...args) => { console.log('[PAIR DEBUG]', msg, ...args); this.log('[PAIR DEBUG]', msg, ...args); },
            info: (msg, ...args) => { console.log('[PAIR INFO]', msg, ...args); this.log('[PAIR INFO]', msg, ...args); },
            warn: (msg, ...args) => { console.warn('[PAIR WARN]', msg, ...args); this.error('[PAIR WARN]', msg, ...args); },
            error: (msg, ...args) => { console.error('[PAIR ERROR]', msg, ...args); this.error('[PAIR ERROR]', msg, ...args); },
          }
        });
        const mfaToken = await client.login(credentials.username, credentials.password);

        if (mfaToken) {
          throw new Error('MFA is enabled on this account. Please disable MFA or use an account without MFA.');
        }

        const monitorIds = client.session?.monitorIds;
        if (!monitorIds || monitorIds.length === 0) {
          throw new Error('No Sense monitors found on this account.');
        }

        return true;
      } catch (err) {
        this.error('Pairing login failed:', err);
        throw err;
      }
    });

    session.setHandler('list_devices', async () => {
      try {
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
