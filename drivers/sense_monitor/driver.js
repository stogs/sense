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

    session.setHandler('login', async (data) => {
      this.log('[PAIR] login handler called with username:', data.username ? data.username.replace(/(?<=.{2}).(?=[^@]*?.@)/g, '*') : 'empty');
      const client = new SenseApiClient();
      const mfaToken = await client.login(data.username, data.password);
      if (mfaToken) {
        throw new Error('MFA is enabled on your Sense account. Please disable MFA in your Sense account.');
      }
      
      const monitorIds = client.session?.monitorIds || [];
      this.log('[PAIR] Successfully logged in. Found monitor IDs:', monitorIds);
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
            username: data.username,
            password: data.password
          }
        };
      });

      this.log('[PAIR] Returning devices array directly from login:', JSON.stringify(devices, null, 2));
      return devices;
    });
  }

}

module.exports = SenseMonitorDriver;
