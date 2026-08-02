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
      // will_pay_amount_cents + is_free_trial are needed because a patron inside a
      // free trial can report currently_entitled_amount_cents = 0 — see resolveTier.
      'fields[member]':    'patron_status,currently_entitled_amount_cents,will_pay_amount_cents,is_free_trial',
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

    // A patron who pays but resolves to 'none' is almost always this: the
    // membership is there, filed under a campaign id we are not looking for.
    // Log the ids so the mismatch is visible instead of being guessed at.
    if (!membership) {
      const members = included.filter(i => i.type === 'member');
      console.log('[VND patreon] no membership matched', JSON.stringify({
        want:        this.#campaignId,
        campaignIds: members.map(m => m.relationships?.campaign?.data?.id ?? null),
        memberCount: members.length,
        includedTypes: [...new Set(included.map(i => i.type))]
      }));
    }

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
    if (!membership) {
      // Either the patron supports no campaign of ours, or the campaign filter
      // in getIdentity matched nothing — worth telling apart in `wrangler tail`.
      console.log('[VND tier] none — no membership matched the campaign');
      return 'none';
    }

    const attrs    = membership.attributes ?? {};
    const status   = attrs.patron_status;
    const entitled = attrs.currently_entitled_amount_cents ?? 0;
    const willPay  = attrs.will_pay_amount_cents ?? 0;
    const inTrial  = attrs.is_free_trial === true;

    // 'active_patron' is the normal signal. Inside a free trial nothing has been
    // charged yet and the field can come back empty, so an explicit trial flag
    // stands in for it — but a patron Patreon has actively marked former or
    // declined is never let through on the strength of a stale flag.
    const active = status === 'active_patron' || (inTrial && status == null);
    if (!active) {
      // Dump the attributes verbatim. `fields[member]` limits the response to
      // the four we ask for, so this is the whole picture and carries no PII.
      console.log('[VND tier] none — inactive', JSON.stringify(attrs));
      return 'none';
    }

    // A patron in a free trial is entitled to the benefits without having paid,
    // so Patreon reports 0 entitled cents. What they are committed to pay is the
    // real entitlement. Only ever raises 0 to the pledge, never lowers a charge.
    const amount = entitled > 0 ? entitled : willPay;

    if (amount >= 1000) return 'premium'; // $10+/month — GmStudio member
    if (amount >= 600)  return 'basic';   // $6+/month  — Supporter
    if (amount >= 300)  return 'mobile';  // $3+/month  — Foundry Mobil Module Only

    console.log('[VND tier] none — below $3', JSON.stringify({ ...attrs, amount }));
    return 'none';
  }

  // ── Per-module entitlement ────────────────────────────────────────────────

  /**
   * Modules the $3 "Foundry Mobil Module Only" tier is allowed to unlock.
   * Everything else stays behind Supporter ($6) or above.
   */
  static MOBILE_TIER_MODULES = new Set(['velvet-mobile']);

  /**
   * Narrow the account-wide tier down to what a given module actually grants.
   *
   * The tier is stored once per user, but clients gate on `tier !== 'none'`, so
   * a restricted tier must be reported as 'none' to the modules it does not
   * cover — otherwise a $3 patron would unlock the whole catalogue. Doing this
   * server-side also locks out already-installed clients we cannot update.
   */
  static effectiveTier(tier, moduleId) {
    if (tier === 'mobile' && !PatreonClient.MOBILE_TIER_MODULES.has(moduleId)) return 'none';
    return tier;
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
      },
      'hopefinder-sheet': {
        none:    [],
        basic:   ['survivor-sheet'],
        premium: ['survivor-sheet']
      },
      'pf2e-velvet-sheet': {
        none:    [],
        basic:   ['velvet-sheet'],
        premium: ['velvet-sheet']
      },
      'dnd-velvet-sheets': {
        none:    [],
        basic:   ['dnd-velvet-sheet'],
        premium: ['dnd-velvet-sheet']
      },
      'velvet-journals': {
        none:    [],
        basic:   ['velvet-journals'],
        premium: ['velvet-journals']
      },
      'velvet-mobile': {
        none:    [],
        mobile:  ['mobile-shell'],
        basic:   ['mobile-shell'],
        premium: ['mobile-shell']
      },
      // The shop catalogue is served from /shops/data, which gates on this exact
      // feature name. It is also granted by vnd-enhanced, whose tier has always
      // included the shop — promoting the module must not take that away.
      'dnd-shops': {
        none:    [],
        basic:   ['dnd-shops'],
        premium: ['dnd-shops']
      },
      'directional-token-images': {
        none:    [],
        basic:   ['directional-images'],
        premium: ['directional-images']
      },
      'velvet-move': {
        none:    [],
        basic:   ['velvet-move'],
        premium: ['velvet-move']
      },
      'isometric-tokens-creator': {
        none:    [],
        basic:   ['iso-token-editor'],
        premium: ['iso-token-editor']
      }
    };
    // No fallback. `allFeatures[moduleId] ?? allFeatures['vnd-enhanced']` meant
    // an unregistered module inherited the largest feature set in the catalogue
    // — including 'dnd-shops', the one feature that is actually enforced
    // server-side. An unknown module is entitled to nothing.
    const map = allFeatures[moduleId];
    if (!map) return [];
    return map[tier] ?? [];
  }

  // ── Whitelist of known module IDs ─────────────────────────────────────────

  static VALID_MODULE_IDS = new Set([
    'vnd-enhanced', 'sf2e-cyber-sheet', 'starfinderdashboard',
    'hopefinder-sheet', 'pf2e-velvet-sheet', 'dnd-velvet-sheets',
    'velvet-journals', 'velvet-mobile',
    'dnd-shops', 'directional-token-images', 'velvet-move', 'isometric-tokens-creator'
  ]);

  static isValidModuleId(moduleId) {
    return PatreonClient.VALID_MODULE_IDS.has(moduleId);
  }
}
