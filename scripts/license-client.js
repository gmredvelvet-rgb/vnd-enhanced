/**
 * VND Enhanced — License Client
 *
 * Handles Patreon OAuth, JWT token management, device fingerprinting,
 * periodic heartbeat, and feature gating.
 *
 * All sensitive operations (token issuance, subscription verification)
 * happen on the server. This file is the client-side coordinator only.
 */

const MODULE_ID = 'vnd-enhanced';
const API_BASE  = 'https://vnd-license.gmredvelvet.workers.dev';

// RSA public key (SPKI base64url) — safe to embed; forging requires the private key (server-only).
// Used to verify RS256-signed response tokens AND access-token claims.
// Rotate both here and in wrangler.toml (JWT_PUBLIC_KEY) when you roll keys.
const RSA_PUBLIC_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3-hTzuHo9lgENNQiA4-Fm7VIdalqisZ5NhqrBioXmIXSMbEhYpy1TnPkCBAdAzXAsyX1YdTYLcMADETPnERvceLsDoAWHFZzHGxoXBkOGw0ukAyHJyrwBZxCf_bY_FSbip_-XQuTS4YuyhLPVNjbGMZdVarkegh7BKwW4CR9MDb1DMtf_NxtfNqJ3MxhfAiTxIod4AWer8esisr0IekQlPLmMPA2KggzQw9rFj61B4DAVk2F_TAXPMOKyEcX_zVGpp00JTurTsfwK2023UHKO9t98R0rG17oX0rK_x2EOBiW2Nla3NChZyR4yi8zHe0vjYhprqcwozv9wN0wbANnzwIDAQAB';

// ── Storage keys (localStorage) ───────────────────────────────────────────────
const SK = {
  accessToken:    `${MODULE_ID}:at`,
  refreshToken:   `${MODULE_ID}:rt`,
  tokenExpiry:    `${MODULE_ID}:exp`,
  installationId: `${MODULE_ID}:iid`,
  tier:           `${MODULE_ID}:tier`,
  features:       `${MODULE_ID}:features`,
};

// ── VndLicenseClient ──────────────────────────────────────────────────────────

export class VndLicenseClient {
  static #instance = null;

  #accessToken      = null;
  #refreshToken     = null;
  #tokenExpiry      = 0;
  #installationId   = null;
  #fingerprint      = null;
  #features         = [];
  #tier             = 'none';
  #heartbeatTimer        = null;
  #initialHeartbeatTimer = null;
  #lastHeartbeat         = 0;
  #gracePeriodMs    = 5 * 60 * 1000;
  #degraded         = false;
  #rsaPublicKey     = null;   // cached CryptoKey — imported once, reused

  static get instance() {
    if (!this.#instance) this.#instance = new VndLicenseClient();
    return this.#instance;
  }

  // ── Initialization ──────────────────────────────────────────────────────────

  async initialize() {
    this.#installationId = this.#getOrCreateInstallationId();
    this.#fingerprint    = await this.#computeFingerprint();
    this.#loadStoredTokens();

    // If we have a stored token, verify its RS256 signature before trusting its claims.
    // This prevents a forged JWT in localStorage from bypassing the feature gate.
    if (this.#accessToken && this.#isAccessTokenValid()) {
      try {
        await this.#loadVerifiedClaims();
      } catch {
        // Signature invalid or expired — treat as unauthenticated
        this.#clearStoredTokens();
        return false;
      }
      this.#startHeartbeat();
      return true;
    }

    // Try refresh token
    if (this.#refreshToken) {
      try {
        await this.#doRefresh();
        this.#startHeartbeat();
        return true;
      } catch {
        this.#clearStoredTokens();
      }
    }

    return false; // Needs re-authentication
  }

  // ── Feature gate ───────────────────────────────────────────────────────────

  hasFeature(featureName) {
    if (this.#degraded) return false;
    if (!this.#accessToken || !this.#isAccessTokenValid()) return false;
    return this.#features.includes(featureName);
  }

  get tier() { return this.#tier; }
  get isLicensed() { return this.#tier !== 'none' && !this.#degraded; }

  // ── OAuth flow ─────────────────────────────────────────────────────────────

  async startOAuth() {
    // Send our origin so the callback page targets postMessage precisely (not '*')
    const { url } = await this.#apiCall('/oauth/start', { origin: globalThis.location.origin, moduleId: MODULE_ID });
    const popup   = window.open(url, 'vnd-patreon-auth', 'width=600,height=700,popup=yes');

    return new Promise((resolve, reject) => {
      const expectedOrigin = new URL(API_BASE).origin;

      const handler = async (event) => {
        // Only accept messages from our backend (the popup's origin)
        if (event.origin !== expectedOrigin) return;
        if (event.data?.type !== 'vnd-auth-code') return;
        window.removeEventListener('message', handler);
        popup?.close();
        try {
          await this.activateWithCode(event.data.authCode);
          resolve(true);
        } catch (e) {
          reject(e);
        }
      };
      window.addEventListener('message', handler);

      // Fallback: user closes popup without postMessage (manual code entry)
      const interval = setInterval(() => {
        if (popup?.closed) {
          clearInterval(interval);
          window.removeEventListener('message', handler);
          resolve(false);
        }
      }, 1000);
    });
  }

  // Called when user pastes the auth code manually (or after popup postMessage)
  async activateWithCode(authCode) {
    const result = await this.#apiCall('/oauth/exchange', {
      authCode,
      installationId:  this.#installationId,
      fingerprintHash: this.#fingerprint,
      moduleId:        MODULE_ID
    });

    this.#storeTokens(result.accessToken, result.refreshToken, result.expiresIn, result.tier, result.features);
    this.#tier     = result.tier;
    this.#features = result.features ?? [];
    this.#startHeartbeat();
    // Activate VNE immediately on this client (no server round-trip needed)
    Hooks.callAll('vnd-enhanced.activate');
    // Persist the flag so other connected clients and future reloads also activate
    game.settings?.set?.(MODULE_ID, 'worldLicensed', true).catch(() => {});

    ui.notifications?.info(`VND Enhanced: Connected as ${result.tier} subscriber. Welcome!`);
  }

  // ── Release installation slot ───────────────────────────────────────────────

  async releaseInstallation() {
    try {
      await this.#apiCall('/license/release', { installationId: this.#installationId });
      this.#clearStoredTokens();
      this.#stopHeartbeat();
      game.settings?.set?.(MODULE_ID, 'worldLicensed', false).catch(() => {});
      ui.notifications?.info('VND Enhanced: Installation slot released.');
    } catch (e) {
      ui.notifications?.error(`VND Enhanced: Failed to release slot — ${e.message}`);
    }
  }

  // ── Internal: token storage ─────────────────────────────────────────────────

  #loadStoredTokens() {
    this.#accessToken  = localStorage.getItem(SK.accessToken);
    this.#refreshToken = localStorage.getItem(SK.refreshToken);
    this.#tokenExpiry  = Number.parseInt(localStorage.getItem(SK.tokenExpiry) ?? '0', 10);
    const rawFeatures  = JSON.parse(localStorage.getItem(SK.features) ?? '[]');
    this.#features     = Array.isArray(rawFeatures) ? rawFeatures : [];
    this.#tier         = localStorage.getItem(SK.tier) ?? 'none';
  }

  #storeTokens(at, rt, expiresIn, tier, features) {
    const expiry = Date.now() + expiresIn * 1000;
    this.#accessToken  = at;
    this.#refreshToken = rt;
    this.#tokenExpiry  = expiry;
    this.#tier         = tier;
    this.#features     = features ?? [];

    localStorage.setItem(SK.accessToken,  at);
    localStorage.setItem(SK.refreshToken, rt);
    localStorage.setItem(SK.tokenExpiry,  String(expiry));
    localStorage.setItem(SK.tier,         tier);
    localStorage.setItem(SK.features,     JSON.stringify(features ?? []));
  }

  #clearStoredTokens() {
    this.#accessToken  = null;
    this.#refreshToken = null;
    this.#tokenExpiry  = 0;
    this.#tier         = 'none';
    this.#features     = [];
    Object.values(SK).forEach(k => localStorage.removeItem(k));
  }

  #isAccessTokenValid() {
    return !!this.#accessToken && this.#tokenExpiry > Date.now() + 60_000; // 1-min buffer
  }

  // Verifies the stored access-token signature, then loads tier + features from its claims.
  // Throws if the token is forged, expired, or structurally invalid.
  async #loadVerifiedClaims() {
    const claims    = await this.#verifyAndParseJwt(this.#accessToken);
    this.#tier      = claims.tier     ?? 'none';
    this.#features  = claims.features ?? [];
  }

  // ── Internal: installation ID ───────────────────────────────────────────────

  #getOrCreateInstallationId() {
    let iid = localStorage.getItem(SK.installationId);
    if (!iid) {
      iid = crypto.randomUUID();
      localStorage.setItem(SK.installationId, iid);
    }
    return iid;
  }

  // ── Internal: device fingerprint ────────────────────────────────────────────

  async #computeFingerprint() {
    const components = [
      game.world?.id ?? 'unknown',
      game.version ?? '',
      this.#installationId,
      navigator.language,
      navigator.hardwareConcurrency,
      screen.width, screen.height, screen.colorDepth,
      Intl.DateTimeFormat().resolvedOptions().timeZone,
      await this.#canvasFingerprint()
    ].join('|');

    const buf  = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(components));
    return btoa(String.fromCodePoint(...new Uint8Array(buf)));
  }

  async #canvasFingerprint() {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 200; canvas.height = 50;
      const ctx = canvas.getContext('2d');
      ctx.textBaseline = 'top';
      ctx.font = '14px Arial';
      ctx.fillStyle = '#f60';
      ctx.fillRect(125, 1, 62, 20);
      ctx.fillStyle = '#069';
      ctx.fillText('vnd-fp', 2, 15);
      ctx.fillStyle = 'rgba(102,204,0,0.7)';
      ctx.fillText('vnd-fp', 4, 17);
      return canvas.toDataURL().slice(-32);
    } catch { return 'no-canvas'; }
  }

  // ── Internal: refresh ───────────────────────────────────────────────────────

  async #doRefresh() {
    const result = await this.#apiCall('/token/refresh', {
      refreshToken:    this.#refreshToken,
      fingerprintHash: this.#fingerprint
    });
    this.#storeTokens(result.accessToken, result.refreshToken, result.expiresIn, result.tier, result.features);
  }

  // ── Internal: heartbeat ─────────────────────────────────────────────────────

  #startHeartbeat() {
    this.#stopHeartbeat();
    const INTERVAL = 15 * 60 * 1000; // 15 minutes
    this.#lastHeartbeat = Date.now();

    // First heartbeat after 1 minute (let Foundry finish loading)
    this.#initialHeartbeatTimer = setTimeout(() => {
      this.#initialHeartbeatTimer = null;
      this.#doHeartbeat();
    }, 60_000);
    this.#heartbeatTimer = setInterval(() => this.#doHeartbeat(), INTERVAL);
  }

  #stopHeartbeat() {
    if (this.#initialHeartbeatTimer) {
      clearTimeout(this.#initialHeartbeatTimer);
      this.#initialHeartbeatTimer = null;
    }
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }

  async #doHeartbeat() {
    try {
      const result = await this.#apiCall('/heartbeat', {
        installationId:  this.#installationId,
        fingerprintHash: this.#fingerprint
      });

      this.#storeTokens(result.accessToken, this.#refreshToken, result.expiresIn, result.tier, result.features);
      this.#lastHeartbeat = Date.now();
      this.#degraded = false;
    } catch {
      this.#handleHeartbeatFailure();
    }
  }

  #handleHeartbeatFailure() {
    const timeSinceLast = Date.now() - this.#lastHeartbeat;
    if (timeSinceLast > this.#gracePeriodMs) {
      if (!this.#degraded) {
        this.#degraded = true;
        if (game.user?.isGM) {
          // Lock the module for all clients until the GM reconnects
          game.settings?.set?.(MODULE_ID, 'worldLicensed', false).catch(() => {});
          ui.notifications?.warn('VND Enhanced: License server unreachable. Premium features suspended until reconnected.');
        }
      }
    }
  }

  // ── Internal: API call ──────────────────────────────────────────────────────

  async #apiCall(endpoint, body, method = 'POST') {
    const nonce     = crypto.randomUUID();
    const timestamp = Date.now();

    const init = {
      method,
      headers: {
        'Content-Type':       'application/json',
        'X-Installation-ID':  this.#installationId ?? '',
      }
    };

    if (this.#accessToken) {
      init.headers['Authorization'] = `Bearer ${this.#accessToken}`;
    }

    if (method === 'POST' && body !== null) {
      init.body = JSON.stringify({ ...body, nonce, timestamp });
    }

    const url  = `${API_BASE}${endpoint}`;
    const resp = await fetch(url, init);

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: 'Network error', code: 'NETWORK_ERROR' }));
      throw new LicenseError(err.error ?? 'Request failed', err.code ?? 'API_ERROR');
    }

    const data = await resp.json();

    // Verify RS256-signed response token (anti-MITM, anti-replay)
    if (data.sig && data.payload) {
      await this.#verifyResponseSig(data.payload, data.sig);
      return data.payload;
    }

    return data;
  }

  // ── RSA helpers ─────────────────────────────────────────────────────────────

  async #importRsaPublicKey() {
    if (this.#rsaPublicKey) return this.#rsaPublicKey;
    const keyBytes = Uint8Array.from(
      atob(RSA_PUBLIC_KEY.replaceAll('-', '+').replaceAll('_', '/')),
      c => c.codePointAt(0)
    );
    this.#rsaPublicKey = await crypto.subtle.importKey(
      'spki', keyBytes,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false, ['verify']
    );
    return this.#rsaPublicKey;
  }

  // Verifies an RS256 JWT produced by signedJson on the server.
  // The JWT payload contains `ph` = SHA-256 hash of the response payload.
  async #verifyResponseSig(payload, jwt) {
    const parts = jwt.split('.');
    if (parts.length !== 3) throw new LicenseError('Malformed response token', 'SIGNATURE_INVALID');

    const [hdr, body, sig] = parts;
    const key  = await this.#importRsaPublicKey();
    const data = new TextEncoder().encode(`${hdr}.${body}`);
    const sigBytes = Uint8Array.from(
      atob(sig.replaceAll('-', '+').replaceAll('_', '/')),
      c => c.codePointAt(0)
    );

    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sigBytes, data);
    if (!valid) throw new LicenseError('Server response verification failed', 'SIGNATURE_INVALID');

    const claims = JSON.parse(atob(body.replaceAll('-', '+').replaceAll('_', '/')));
    const now    = Math.floor(Date.now() / 1000);
    if (claims.exp && claims.exp < now) throw new LicenseError('Response token expired', 'REPLAY_DETECTED');

    // Verify the response token covers exactly the payload we received
    const payloadHash = await crypto.subtle.digest(
      'SHA-256', new TextEncoder().encode(JSON.stringify(payload))
    );
    const expectedPh = btoa(String.fromCodePoint(...new Uint8Array(payloadHash)))
      .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    if (claims.ph !== expectedPh) throw new LicenseError('Response payload tampered', 'SIGNATURE_INVALID');
  }

  // Parses AND cryptographically verifies an RS256 JWT before trusting its claims.
  async #verifyAndParseJwt(token) {
    const parts = token.split('.');
    if (parts.length !== 3) throw new LicenseError('Malformed JWT', 'INVALID_TOKEN');

    const [hdr, body, sig] = parts;
    const key  = await this.#importRsaPublicKey();
    const data = new TextEncoder().encode(`${hdr}.${body}`);
    const sigBytes = Uint8Array.from(
      atob(sig.replaceAll('-', '+').replaceAll('_', '/')),
      c => c.codePointAt(0)
    );

    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sigBytes, data);
    if (!valid) throw new LicenseError('JWT signature invalid', 'INVALID_TOKEN');

    const payload = JSON.parse(atob(body.replaceAll('-', '+').replaceAll('_', '/')));
    const now     = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) throw new LicenseError('JWT expired', 'TOKEN_EXPIRED');
    return payload;
  }
}

// ── LicenseError ──────────────────────────────────────────────────────────────

export class LicenseError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LicenseError';
    this.code = code;
  }
}

// ── License Prompt UI ─────────────────────────────────────────────────────────
// Shown to GM when the module is not licensed

export class VndLicenseUI {
  static show() {
    // Only show to GM
    if (!game.user?.isGM) return;

    const id = 'vnd-license-prompt';
    if (document.getElementById(id)) return;

    const el = document.createElement('div');
    el.id = id;
    el.style.cssText = `
      position:fixed; bottom:80px; right:20px; z-index:9999;
      background:#252540; border:1px solid #c89b3c44; border-radius:12px;
      padding:20px 24px; max-width:320px; box-shadow:0 8px 32px rgba(0,0,0,.6);
      font-family:system-ui,sans-serif; color:#e0d7c8;
    `;
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <span style="font-size:1.4rem">🔐</span>
        <strong style="color:#c89b3c;font-size:1rem">VND Enhanced</strong>
      </div>
      <p style="font-size:.85rem;color:#a09080;margin-bottom:16px;line-height:1.4">
        Connect your Patreon account to enable premium features.
      </p>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button id="vnd-connect-btn" style="
          background:#c89b3c;color:#1a1a2e;border:none;border-radius:8px;
          padding:10px;font-size:.9rem;font-weight:700;cursor:pointer;width:100%
        ">Connect Patreon</button>
        <button id="vnd-code-btn" style="
          background:transparent;color:#a09080;border:1px solid #555;border-radius:8px;
          padding:8px;font-size:.8rem;cursor:pointer;width:100%
        ">I have an auth code</button>
        <button id="vnd-dismiss-btn" style="
          background:none;border:none;color:#605040;font-size:.75rem;cursor:pointer;
          text-align:right;padding:0
        ">Dismiss</button>
      </div>
    `;

    el.querySelector('#vnd-connect-btn').addEventListener('click', async () => {
      const btn = el.querySelector('#vnd-connect-btn');
      btn.textContent = 'Opening Patreon...';
      btn.disabled = true;
      try {
        const success = await VndLicenseClient.instance.startOAuth();
        if (success) el.remove();
        else { btn.textContent = 'Connect Patreon'; btn.disabled = false; }
      } catch (e) {
        btn.textContent = 'Connect Patreon'; btn.disabled = false;
        ui.notifications?.error(`VND Enhanced: ${e.message}`);
      }
    });

    el.querySelector('#vnd-code-btn').addEventListener('click', () => {
      VndLicenseUI.showCodeInput();
      el.remove();
    });

    el.querySelector('#vnd-dismiss-btn').addEventListener('click', () => el.remove());

    document.body.appendChild(el);
  }

  static showCodeInput() {
    new Dialog({
      title: 'VND Enhanced — Enter Auth Code',
      content: `
        <p style="margin-bottom:12px;font-size:.9rem">
          Paste the code shown after connecting your Patreon account.
        </p>
        <input id="vnd-auth-code-input" type="text"
          placeholder="Paste auth code here..."
          style="width:100%;padding:8px;border-radius:6px;border:1px solid #555;
                 background:#1a1a2e;color:#e0d7c8;font-family:monospace;font-size:.85rem"/>
      `,
      buttons: {
        activate: {
          label: '<i class="fas fa-key"></i> Activate',
          callback: async (html) => {
            const code = html.find('#vnd-auth-code-input').val().trim();
            if (!code) return;
            try {
              await VndLicenseClient.instance.activateWithCode(code);
            } catch (e) {
              ui.notifications?.error(`VND Enhanced: ${e.message}`);
            }
          }
        },
        cancel: { label: 'Cancel' }
      }
    }).render(true, { width: 420 });
  }
}
