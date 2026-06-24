/**
 * Patreon OAuth 2.0 client
 * Docs: https://docs.patreon.com/#oauth
 */

const PATREON_AUTH_URL  = 'https://www.patreon.com/oauth2/authorize';
const PATREON_TOKEN_URL = 'https://www.patreon.com/api/oauth2/token';
const PATREON_API_URL   = 'https://www.patreon.com/api/oauth2/v2';

export class PatreonClient {
  #clientId;
  #clientSecret;
  #redirectUri;
  #campaignId;

  constructor(env) {
    this.#clientId     = env.PATREON_CLIENT_ID;
    this.#clientSecret = env.PATREON_CLIENT_SECRET;
    this.#redirectUri  = env.PATREON_REDIRECT_URI;
    this.#campaignId   = env.PATREON_CAMPAIGN_ID;
  }

  // ── Step 1: Build the authorization URL ──────────────────────────────────

  buildAuthUrl(state) {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id:     this.#clientId,
      redirect_uri:  this.#redirectUri,
      scope:         'identity identity[email] identity.memberships',
      state
    });
    return `${PATREON_AUTH_URL}?${params}`;
  }

  // ── Step 2: Exchange code for tokens ─────────────────────────────────────

  async exchangeCode(code) {
    const body = new URLSearchParams({
      code,
      grant_type:    'authorization_code',
      client_id:     this.#clientId,
      client_secret: this.#clientSecret,
      redirect_uri:  this.#redirectUri
    });

    const resp = await fetch(PATREON_TOKEN_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });

    if (!resp.ok) throw new Error(`Patreon token exchange failed: ${resp.status}`);
    return resp.json();
  }

  // ── Step 3: Get user identity + membership ────────────────────────────────

  async getIdentity(accessToken) {
    // Query matches the working TheGMStudio.API implementation:
    // include memberships + campaign relationship so we can filter by campaign ID
    const params = new URLSearchParams({
      'include':           'memberships,memberships.campaign',
      'fields[member]':    'patron_status,currently_entitled_amount_cents',
      'fields[campaign]':  'creation_name',
      'fields[user]':      'email,full_name,thumb_url'
    });

    const resp = await fetch(`${PATREON_API_URL}/identity?${params}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (!resp.ok) throw new Error(`Patreon identity fetch failed: ${resp.status}`);
    const data = await resp.json();

    const user = data.data;
    // Find memberships (type === 'member') that belong to OUR campaign
    const included = data.included ?? [];
    const membership = included.find(i =>
      i.type === 'member' &&
      i.relationships?.campaign?.data?.id === this.#campaignId
    ) ?? null;

    return { user, membership };
  }

  // ── Refresh a Patreon access token ────────────────────────────────────────

  async refreshToken(refreshToken) {
    const body = new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      client_id:     this.#clientId,
      client_secret: this.#clientSecret
    });

    const resp = await fetch(PATREON_TOKEN_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });

    if (!resp.ok) throw new Error(`Patreon token refresh failed: ${resp.status}`);
    return resp.json();
  }

  // ── Resolve subscription tier ──────────────────────────────────────────────

  static isOwner(email, env) {
    if (!email || !env?.OWNER_EMAILS) return false;
    return env.OWNER_EMAILS.split(',').map(e => e.trim().toLowerCase()).includes(email.toLowerCase());
  }

  static resolveTier(membership) {
    if (!membership) return 'none';

    const status = membership.attributes?.patron_status;
    const cents  = membership.attributes?.currently_entitled_amount_cents ?? 0;

    // Must be an active patron (matches TheGMStudio.API CheckIfPatreon logic)
    if (status !== 'active_patron') return 'none';

    if (cents >= 1000) return 'premium'; // $10+/month
    if (cents >= 600)  return 'basic';   // $6+/month
    return 'none';
  }

  // ── Feature list per tier ─────────────────────────────────────────────────

  static featuresForTier(tier, moduleId = 'vnd-enhanced') {
    const allFeatures = {
      'vnd-enhanced': {
        none:    [],
        basic:   ['dnd-shops', 'vn-core', 'combat-stage', 'reactions'],
        premium: ['dnd-shops', 'vn-core', 'combat-stage', 'reactions', 'vs-display', 'victory-overlay',
                  'action-overlay', 'rp-stage', 'timer-auto']
      },
      'sf2e-cyber-sheet': {
        none:    [],
        basic:   ['cyber-sheet'],
        premium: ['cyber-sheet', 'cyber-sheet-fx', 'cyber-sheet-hologram']
      },
      'starfinderdashboard': {
        none:    [],
        basic:   ['dashboard'],
        premium: ['dashboard']
      }
    };
    const map = allFeatures[moduleId] ?? allFeatures['vnd-enhanced'];
    return map[tier] ?? [];
  }

  // ── Whitelist of known module IDs ─────────────────────────────────────────

  static isValidModuleId(moduleId) {
    return ['vnd-enhanced', 'sf2e-cyber-sheet', 'starfinderdashboard'].includes(moduleId);
  }
}
