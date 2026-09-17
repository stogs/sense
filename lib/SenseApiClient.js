'use strict';

const EventEmitter = require('events');
const WebSocket = require('./ws');

class UnauthenticatedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnauthenticatedError';
  }
}

class SenseApiError extends Error {
  constructor(message, status, statusText) {
    super(message);
    this.name = 'SenseApiError';
    this.status = status;
    this.statusText = statusText;
  }
}

class SenseApiClient {
  constructor(session, options = {}) {
    this._session = session;
    this._apiUrl = options.apiUrl || 'https://api.sense.com/apiservice/api/v1';
    this._wssUrl = options.wssUrl || 'wss://clientrt.sense.com';
    this._autoReconnectSocket = options.autoReconnectRealtimeUpdates ?? true;
    this._socket = null;
    this._socketIsConnecting = false;
    this._reconnectTimer = null;
    this.emitter = new EventEmitter();
  }

  get session() {
    return this._session;
  }

  set session(session) {
    const changed = JSON.stringify(session) !== JSON.stringify(this._session);
    this._session = session;
    if (changed) {
      this.emitter.emit('sessionChanged', session);
    }
  }

  get isAuthenticated() {
    return !!this.session;
  }

  async login(emailAddress, password, totp = null, mfaToken = null) {
    this.session = null;
    const bodyParams = {
      email: emailAddress,
      password: password
    };
    if (mfaToken && totp) {
      bodyParams.mfa_token = mfaToken;
      bodyParams.totp = totp;
    }

    const response = await fetch(`${this._apiUrl}/authenticate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams(bodyParams)
    });

    if (response.status === 401) {
      let failedResponse;
      try {
        failedResponse = await response.json();
      } catch (e) {
        failedResponse = {};
      }
      if (failedResponse.mfa_token) {
        return failedResponse.mfa_token;
      }
      throw new SenseApiError(
        failedResponse.error_reason || 'Invalid Sense credentials.',
        response.status,
        response.statusText
      );
    }

    if (!response.ok) {
      throw new SenseApiError(
        `Failed to authenticate with Sense API: ${response.status} ${response.statusText}`,
        response.status,
        response.statusText
      );
    }

    const authResponse = await response.json();
    if (authResponse.mfa_token && !authResponse.access_token) {
      return authResponse.mfa_token;
    }

    if (!authResponse.access_token) {
      throw new SenseApiError(
        authResponse.error_reason || 'Authentication response missing access token.',
        response.status,
        response.statusText
      );
    }

    this.session = {
      emailAddress,
      userId: authResponse.user_id,
      monitorIds: (authResponse.monitors || []).map((m) => m.id),
      accessToken: authResponse.access_token,
      refreshToken: authResponse.refresh_token
    };

    return null;
  }

  async refreshAccessTokenIfNeeded() {
    if (!this.session) {
      throw new UnauthenticatedError('An attempt was made to access a resource without a valid session.');
    }

    const { accessToken, refreshToken } = this.session;
    const jwt = accessToken.startsWith('t1.v2.') ? accessToken.substring(7) : accessToken;
    let payload;

    try {
      const splitToken = jwt.split('.');
      if (splitToken.length !== 3) {
        throw new Error('Invalid access token format.');
      }
      payload = JSON.parse(Buffer.from(splitToken[1], 'base64').toString('utf8'));
      if (!payload.exp) {
        throw new Error('No expiration time in access token.');
      }
    } catch (error) {
      this.session = null;
      throw new UnauthenticatedError(`Failed to parse access token: ${error.message}`);
    }

    // Check if token expires within 15 minutes (in milliseconds)
    const expiresAt = payload.exp * 1000;
    if (expiresAt > Date.now() + 15 * 60 * 1000) {
      return accessToken;
    }

    const userId = payload.userId || payload.user_id || payload.sub || this.session.userId;
    if (!userId) {
      this.session = null;
      throw new UnauthenticatedError('No user id found in access token or session.');
    }

    // Renew token
    const response = await fetch(`${this._apiUrl}/renew`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        user_id: String(userId),
        refresh_token: refreshToken
      })
    });

    if (!response.ok) {
      throw new SenseApiError('Failed to renew access token.', response.status, response.statusText);
    }

    const responseData = await response.json();
    this.session = {
      ...this.session,
      accessToken: responseData.access_token,
      refreshToken: responseData.refresh_token
    };

    return responseData.access_token;
  }

  async getMonitorDevices(monitorId) {
    const accessToken = await this.refreshAccessTokenIfNeeded();
    const response = await fetch(`${this._apiUrl}/app/monitors/${monitorId}/devices`, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      throw new SenseApiError('Failed to get monitor devices.', response.status, response.statusText);
    }

    return response.json();
  }

  async getMonitorTrends(monitorId, timezone, scale = 'DAY', startDate) {
    const accessToken = await this.refreshAccessTokenIfNeeded();
    const startIso = startDate
      ? new Date(startDate).toISOString()
      : new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';

    const url = new URL(`${this._apiUrl}/app/history/trends`);
    url.searchParams.append('monitor_id', monitorId.toString());
    url.searchParams.append('scale', scale);
    url.searchParams.append('start', startIso);

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      throw new SenseApiError('Failed to get monitor trends.', response.status, response.statusText);
    }

    return response.json();
  }

  async startRealtimeUpdates(monitorId) {
    if (this._socket || this._socketIsConnecting) {
      return;
    }

    this._socketIsConnecting = true;
    clearTimeout(this._reconnectTimer);

    try {
      const accessToken = await this.refreshAccessTokenIfNeeded();
      const url = `${this._wssUrl}/monitors/${monitorId}/realtimefeed?access_token=${encodeURIComponent(accessToken)}`;

      this._socket = new WebSocket(url);

      this._socket.on('open', () => {
        this._socketIsConnecting = false;
      });

      this._socket.on('message', (data) => {
        try {
          const payload = typeof data === 'string' ? JSON.parse(data) : JSON.parse(data.toString('utf8'));
          this.emitter.emit('realtimeUpdate', monitorId, payload);
        } catch (err) {
          // ignore malformed frame
        }
      });

      this._socket.on('error', (err) => {
        // WebSocket connection error handled in close
      });

      this._socket.on('close', () => {
        this._socket = null;
        this._socketIsConnecting = false;
        if (this._autoReconnectSocket) {
          this._reconnectTimer = setTimeout(() => {
            this.startRealtimeUpdates(monitorId).catch(() => {});
          }, 5000);
        }
      });
    } catch (err) {
      this._socket = null;
      this._socketIsConnecting = false;
      if (this._autoReconnectSocket) {
        this._reconnectTimer = setTimeout(() => {
          this.startRealtimeUpdates(monitorId).catch(() => {});
        }, 5000);
      }
      throw err;
    }
  }

  async stopRealtimeUpdates() {
    this._autoReconnectSocket = false;
    clearTimeout(this._reconnectTimer);
    if (this._socket) {
      try {
        this._socket.close();
      } catch (e) {}
      this._socket = null;
    }
    this._socketIsConnecting = false;
  }
}

module.exports = {
  SenseApiClient,
  SenseApiError,
  UnauthenticatedError
};
