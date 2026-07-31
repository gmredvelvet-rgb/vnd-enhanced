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

// i18n shortcuts (safe after the i18nInit hook — every call site runs at setup or later)
const L  = (key)       => game.i18n.localize(`${MODULE_ID}.license.${key}`);
const LF = (key, data) => game.i18n.format(`${MODULE_ID}.license.${key}`, data);

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
  #retryTimer       = null;   // one-off quick retry after a transient failure
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
      } catch (e) {
        if (this.#isTransient(e)) {
          // Server unreachable at world load — KEEP the credentials and let the
          // heartbeat's refresh path recover automatically (first attempt ~60s).
          // The persisted worldLicensed flag keeps the world running meanwhile.
          this.#startHeartbeat();
          return false;
        }
        // Definitive rejection — these tokens are dead, re-auth is required.
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
  get installationId() { return this.#installationId; }
  // True when a refresh token is stored — auto-recovery is possible, so the
  // re-auth prompt should NOT be shown for a transient outage.
  get hasStoredCredentials() { return !!this.#refreshToken; }

  // Transport/server hiccups: safe to retry later, must never destroy tokens.
  // Everything else (revoked, expired refresh, device mismatch, conflict…) is
  // a definitive verdict from the license server.
  #isTransient(e) {
    if (!(e instanceof LicenseError)) return true; // unexpected runtime error — don't nuke auth over it
    return ['NETWORK_ERROR', 'INTERNAL_ERROR', 'RATE_LIMITED', 'NOT_FOUND', 'API_ERROR'].includes(e.code);
  }

  // ── License status (for the management UI) ─────────────────────────────────

  // Fetches tier + installation slots from the server. Refreshes the access
  // token first if it has expired (the endpoint requires a valid token).
  async getStatus() {
    if (!this.#isAccessTokenValid()) {
      if (!this.#refreshToken) throw new LicenseError('Not authenticated', 'NOT_AUTHENTICATED');
      await this.#doRefresh();
    }
    return this.#apiCall('/license/status', null, 'GET');
  }

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

    ui.notifications?.info(LF('connected', { tier: result.tier }));
  }

  // ── Release installation slot ───────────────────────────────────────────────

  // Releases an installation slot. With no argument, releases THIS device
  // (deactivating the module here); pass another installation's id to free a
  // slot burned by an old browser/machine without touching the current one.
  async releaseInstallation(installationId = this.#installationId) {
    try {
      await this.#apiCall('/license/release', { installationId });
      if (installationId === this.#installationId) {
        this.#clearStoredTokens();
        this.#stopHeartbeat();
        game.settings?.set?.(MODULE_ID, 'worldLicensed', false).catch(() => {});
      }
      ui.notifications?.info(L('released'));
      return true;
    } catch (e) {
      ui.notifications?.error(LF('releaseFailed', { message: e.message }));
      return false;
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
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
  }

  async #doHeartbeat() {
    try {
      await this.#heartbeatOnce();
    } catch {
      // /heartbeat requires a valid access token (1h TTL). After >1h offline
      // (laptop sleep, network outage) the token is expired and every heartbeat
      // would 401 forever. Recover via the refresh-token flow, then retry once.
      try {
        if (!this.#refreshToken) throw new LicenseError('no refresh token', 'UNAUTHORIZED');
        await this.#doRefresh();
        await this.#heartbeatOnce();
      } catch (e2) {
        if (!this.#isTransient(e2)) {
          // Server definitively rejected us (subscription ended / revoked).
          // SOFT GATE: nothing is suspended — the module keeps every feature.
          // We just clear the dead tokens and let the periodic reminder resume.
          this.#clearStoredTokens();
          this.#stopHeartbeat();
          this.#degraded = true;
          if (game.user?.isGM) {
            game.settings?.set?.(MODULE_ID, 'worldLicensed', false).catch(() => {});
            VndLicenseUI.startReminder();
          }
          return;
        }
        this.#handleHeartbeatFailure();
      }
    }
  }

  async #heartbeatOnce() {
    const result = await this.#apiCall('/heartbeat', {
      installationId:  this.#installationId,
      fingerprintHash: this.#fingerprint
    });

    this.#storeTokens(result.accessToken, this.#refreshToken, result.expiresIn, result.tier, result.features);

    // Recovered after a degraded period — restore the world flag + stop the reminder
    if (this.#degraded) {
      this.#degraded = false;
      if (game.user?.isGM) {
        game.settings?.set?.(MODULE_ID, 'worldLicensed', true).catch(() => {});
        VndLicenseUI.stopReminder();
        ui.notifications?.info(L('reconnected'));
      }
    }
  }

  #handleHeartbeatFailure() {
    // Transient outage (server unreachable / 5xx / rate-limited). SOFT GATE:
    // never suspend, never nag a paying customer over a network blip. Keep the
    // world flag as-is and just retry — a single blip recovers in ~90s.
    if (!this.#retryTimer) {
      this.#retryTimer = setTimeout(() => {
        this.#retryTimer = null;
        this.#doHeartbeat();
      }, 90_000);
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
    let resp;
    try {
      resp = await fetch(url, init);
    } catch {
      // fetch() rejects on DNS failure / offline / server down — a transport
      // problem, never an auth verdict. Callers must not burn tokens over it.
      throw new LicenseError('License server unreachable', 'NETWORK_ERROR');
    }

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      // 5xx = server-side trouble → retryable; only 4xx codes carry auth meaning
      const fallbackCode = resp.status >= 500 ? 'INTERNAL_ERROR' : 'API_ERROR';
      throw new LicenseError(err.error ?? 'Request failed', err.code ?? fallbackCode);
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

// ── Settings-menu shim ───────────────────────────────────────────────────────
// game.settings.registerMenu instantiates and renders this class; we redirect
// to the dialog-based manager instead of a real FormApplication sheet.
export class VndLicenseMenu extends FormApplication {
  render() {
    VndLicenseUI.showManager();
    return this;
  }
  async _updateObject() { /* nothing to persist */ }
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

// ── Soft-gate reminder cadence ────────────────────────────────────────────────
// This module is NEVER gated: an unlicensed world keeps every feature and only
// receives a periodic reminder that it's running unlicensed. Mirrors the Velvet
// Journals model. Nothing here may ever block functionality.
const REMINDER_MS  = 10 * 60 * 1000;  // remind every 10 minutes
const AUTO_HIDE_MS = 30 * 1000;       // the reminder card lingers 30s then leaves

// Read the world-level flag the GM writes, so players reach the same verdict
// without contacting the server.
export function isWorldLicensed() {
  try { return game.settings.get(MODULE_ID, 'worldLicensed') === true; }
  catch { return false; }
}

export class VndLicenseUI {
  static #reminderTimer = null;
  static #hideTimer     = null;

  // Start the periodic unlicensed reminder. Safe to call repeatedly (restarts a
  // single timer). Re-checks the licence on every tick, so connecting mid-session
  // silences it without a reload.
  static startReminder() {
    VndLicenseUI.#clearReminderTimer();
    if (isWorldLicensed()) return;
    VndLicenseUI.#reminderTimer = setInterval(() => {
      if (isWorldLicensed()) { VndLicenseUI.stopReminder(); return; }
      VndLicenseUI.show({ autoHide: true });
    }, REMINDER_MS);
  }

  static stopReminder() {
    VndLicenseUI.#clearReminderTimer();
    const el = document.getElementById('vnd-license-prompt');
    if (el) el.remove();
  }

  static #clearReminderTimer() {
    if (VndLicenseUI.#reminderTimer) clearInterval(VndLicenseUI.#reminderTimer);
    VndLicenseUI.#reminderTimer = null;
  }

  static #cancelAutoHide() {
    if (VndLicenseUI.#hideTimer) clearTimeout(VndLicenseUI.#hideTimer);
    VndLicenseUI.#hideTimer = null;
  }

  static show({ autoHide = false } = {}) {
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
        ${L('connectHint')}
      </p>
      ${VndLicenseUI.migrationNotice()}
      <div style="display:flex;flex-direction:column;gap:8px">
        <button id="vnd-connect-btn" style="
          background:#c89b3c;color:#1a1a2e;border:none;border-radius:8px;
          padding:10px;font-size:.9rem;font-weight:700;cursor:pointer;width:100%
        ">${L('connectBtn')}</button>
        <button id="vnd-code-btn" style="
          background:transparent;color:#a09080;border:1px solid #555;border-radius:8px;
          padding:8px;font-size:.8rem;cursor:pointer;width:100%
        ">${L('haveCode')}</button>
        <button id="vnd-dismiss-btn" style="
          background:none;border:none;color:#605040;font-size:.75rem;cursor:pointer;
          text-align:right;padding:0
        ">${L('dismiss')}</button>
      </div>
    `;

    el.querySelector('#vnd-connect-btn').addEventListener('click', async () => {
      VndLicenseUI.#cancelAutoHide();
      const btn = el.querySelector('#vnd-connect-btn');
      btn.textContent = L('connecting');
      btn.disabled = true;
      try {
        const success = await VndLicenseClient.instance.startOAuth();
        if (success) { VndLicenseUI.stopReminder(); el.remove(); }
        else { btn.textContent = L('connectBtn'); btn.disabled = false; }
      } catch (e) {
        btn.textContent = L('connectBtn'); btn.disabled = false;
        ui.notifications?.error(`VND Enhanced: ${e.message}`);
      }
    });

    el.querySelector('#vnd-code-btn').addEventListener('click', () => {
      VndLicenseUI.#cancelAutoHide();
      VndLicenseUI.showCodeInput();
      el.remove();
    });

    el.querySelector('#vnd-dismiss-btn').addEventListener('click', () => el.remove());

    // Reading the card must not make it vanish mid-sentence.
    el.addEventListener('pointerenter', () => VndLicenseUI.#cancelAutoHide());

    document.body.appendChild(el);

    if (autoHide) {
      VndLicenseUI.#hideTimer = setTimeout(() => {
        VndLicenseUI.#hideTimer = null;
        el.remove();
      }, AUTO_HIDE_MS);
    }
  }

  // ── License Manager (module settings → Manage License) ─────────────────────
  // Shows tier + the 2 installation slots and lets the GM free a slot without
  // support tickets (localStorage-keyed installs burn a slot per browser).

  static async showManager() {
    if (!game.user?.isGM) return;
    const client = VndLicenseClient.instance;
    if (!client.isLicensed) { VndLicenseUI.show(); return; }

    let status;
    try {
      status = await client.getStatus();
    } catch (e) {
      ui.notifications?.warn(`VND Enhanced: ${e.message}`);
      VndLicenseUI.show();
      return;
    }

    const esc = (s) => { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; };
    const ownIid = client.installationId;
    const installs = status.installations ?? [];

    const rows = installs.map(i => {
      const isThis = i.installation_id === ownIid;
      const hb = i.last_heartbeat ? new Date(i.last_heartbeat).toLocaleString() : '—';
      return `<tr>
        <td style="text-align:center">${esc(String(i.slot ?? '?'))}</td>
        <td><code>${esc((i.installation_id ?? '').slice(0, 8))}…</code>${isThis ? ` <strong>(${L('thisDevice')})</strong>` : ''}</td>
        <td>${esc(hb)}</td>
        <td style="text-align:center">
          <button type="button" class="vnd-lm-release" data-iid="${esc(i.installation_id)}" data-this="${isThis ? '1' : '0'}"
                  style="line-height:1.4;padding:2px 10px;">
            <i class="fas fa-unlink"></i> ${L('release')}
          </button>
        </td>
      </tr>`;
    }).join('');

    const content = `
      <div style="font-size:.9em">
        <p style="margin:0 0 10px">
          <strong>${L('tier')}:</strong> ${esc(status.tier ?? 'none')}
          &nbsp;·&nbsp; <strong>${L('slots')}:</strong> ${installs.length}/${esc(String(status.maxSlots ?? 2))}
        </p>
        <table style="width:100%;border-collapse:collapse">
          <thead><tr>
            <th style="text-align:center">#</th>
            <th style="text-align:left">${L('installation')}</th>
            <th style="text-align:left">${L('lastSeen')}</th>
            <th></th>
          </tr></thead>
          <tbody>${rows || `<tr><td colspan="4" style="text-align:center;opacity:.7">${L('noInstallations')}</td></tr>`}</tbody>
        </table>
        <p style="font-size:.82em;opacity:.75;margin:10px 0 0">${L('hint')}</p>
      </div>`;

    const dialog = new Dialog({
      title: L('managerTitle'),
      content,
      buttons: { close: { label: game.i18n.localize('Close') } },
      render: (html) => {
        html.find('.vnd-lm-release').on('click', async (e) => {
          const btn    = e.currentTarget;
          const iid    = btn.dataset.iid;
          const isThis = btn.dataset.this === '1';
          const ok = await Dialog.confirm({
            title: L('releaseConfirmTitle'),
            content: `<p>${isThis ? L('releaseConfirmThis') : L('releaseConfirmOther')}</p>`
          });
          if (!ok) return;
          btn.disabled = true;
          const released = await client.releaseInstallation(iid);
          dialog.close();
          if (released && !isThis) VndLicenseUI.showManager(); // refresh the slot list
        });
      }
    }, { width: 520 });
    dialog.render(true);
  }

  /**
   * Transitional notice for patrons whose earlier activation stopped validating.
   * Being asked to re-authorise out of the blue looks like a scam, so say what
   * changed and — just as important — what did not: no new charge, same
   * subscription, same slots. Remove once the migration has settled.
   */
  static migrationNotice() {
    return `
      <div style="margin-bottom:12px;padding:10px 12px;border-radius:6px;
                  border:1px solid #c89b3c55;background:#c89b3c14;font-size:.85rem;line-height:1.45">
        <strong style="color:#c89b3c">${L('migrationTitle')}</strong><br/>
        ${L('migrationBody')}
      </div>`;
  }

  static showCodeInput() {
    new Dialog({
      title: L('codeTitle'),
      content: `
        ${VndLicenseUI.migrationNotice()}
        <p style="margin-bottom:12px;font-size:.9rem">
          ${L('codeHint')}
        </p>
        <input id="vnd-auth-code-input" type="text"
          placeholder="${L('codePh')}"
          style="width:100%;padding:8px;border-radius:6px;border:1px solid #555;
                 background:#1a1a2e;color:#e0d7c8;font-family:monospace;font-size:.85rem"/>
      `,
      buttons: {
        activate: {
          label: `<i class="fas fa-key"></i> ${L('activate')}`,
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
