/**
 * OAuth routes:
 *   GET  /oauth/start      — generate state, return Patreon auth URL
 *   GET  /oauth/callback   — handle Patreon redirect, issue tokens, close popup
 */

import { Hono }          from 'hono';
import { PatreonClient } from '../patreon.js';
import { Supabase }      from '../supabase.js';
import { signJWT, buildAccessToken } from '../jwt.js';
import { rateLimiter }   from '../middleware.js';

const router = new Hono();

// ── POST /oauth/start ─────────────────────────────────────────────────────────
// Client sends its own window.location.origin so the callback page can target
// the postMessage precisely (instead of broadcasting to '*').

router.post('/start',
  rateLimiter({ max: 20, windowSec: 60 }),
  async (c) => {
    const body   = await c.req.json().catch(() => ({}));
    const origin = parseOrigin(body.origin);

    // Reject unknown modules outright. Degrading to 'vnd-enhanced' handed the
    // caller that module's whole feature set — including 'dnd-shops', the only
    // server-gated one — and filed its installation under vnd-enhanced's slots,
    // where it evicted a real one.
    const moduleId = body.moduleId;
    if (typeof moduleId !== 'string' || !PatreonClient.isValidModuleId(moduleId)) {
      return c.json({ error: 'Unknown module', code: 'UNKNOWN_MODULE' }, 400);
    }

    const state = crypto.randomUUID();
    await c.env.KV.put(
      `oauth:state:${state}`,
      JSON.stringify({ origin, moduleId, createdAt: Date.now() }),
      { expirationTtl: 600 }
    );

    const patreon = new PatreonClient(c.env);
    const url     = patreon.buildAuthUrl(state);

    return c.json({ url, state });
  }
);

// ── GET /oauth/callback ───────────────────────────────────────────────────────

router.get('/callback', async (c) => {
  const { code, state, error } = c.req.query();

  if (error) return serveErrorPage(c, 'Patreon authorization was denied.');
  if (!code || !state) return serveErrorPage(c, 'Missing OAuth parameters.');

  // Validate CSRF state and recover stored origin
  const stateRaw = await c.env.KV.get(`oauth:state:${state}`);
  if (!stateRaw) return serveErrorPage(c, 'Invalid or expired OAuth state.');
  await c.env.KV.delete(`oauth:state:${state}`);
  const stateData     = (() => { try { return JSON.parse(stateRaw); } catch { return {}; } })();
  const allowedOrigin = parseOrigin(stateData.origin);
  // /oauth/start only ever stores a whitelisted id, so a bad one here means the
  // state was tampered with or the whitelist shrank — neither may fall through
  // to vnd-enhanced and hand out its entitlements.
  const moduleId      = stateData.moduleId;
  if (typeof moduleId !== 'string' || !PatreonClient.isValidModuleId(moduleId)) {
    return serveErrorPage(c, 'This module is not recognised by the licence server.');
  }

  try {
    const patreon = new PatreonClient(c.env);
    const db      = new Supabase(c.env);

    // Exchange code for Patreon tokens
    const tokens = await patreon.exchangeCode(code);
    const { user: patreonUser, membership } = await patreon.getIdentity(tokens.access_token);

    const email = patreonUser.attributes?.email ?? null;
    const tier  = PatreonClient.isOwner(email, c.env) ? 'premium' : PatreonClient.resolveTier(membership);

    // Upsert user in Supabase
    const user = await db.upsert('vnd_users', {
      patreon_id:         patreonUser.id,
      email:              patreonUser.attributes?.email ?? null,
      username:           patreonUser.attributes?.full_name ?? null,
      tier,
      tier_verified_at:   new Date().toISOString(),
      patreon_access:     tokens.access_token,
      patreon_refresh:    tokens.refresh_token,
      patreon_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      updated_at:         new Date().toISOString()
    }, 'patreon_id');

    if (user.status !== 'active') return serveErrorPage(c, 'Your account has been suspended.');

    // The tier stored on the account is global; this module may grant less than
    // that. Say so here — announcing the account tier and then failing at
    // /oauth/exchange with TIER_INSUFFICIENT tells the patron nothing.
    // (`tier === 'none'` keeps its existing path: no membership is a separate
    //  case, and the client already surfaces it after the exchange.)
    const moduleTier = PatreonClient.effectiveTier(tier, moduleId);
    if (tier !== 'none' && moduleTier === 'none') {
      return serveErrorPage(c,
        `Your Patreon tier does not include ${moduleId}. ` +
        `This module requires the Supporter ($6) tier or above.`
      );
    }

    // Opaque random auth code — does NOT embed user data (avoids info leak via base64 decode)
    const authCode = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');

    // Store auth code → { userId, moduleId } in KV (5-minute TTL, single-use)
    await c.env.KV.put(
      `authcode:${authCode}`,
      JSON.stringify({ userId: user.id, moduleId }),
      { expirationTtl: 300 }
    );

    // Badge the module-scoped tier, not the account-wide one
    return serveSuccessPage(c, { authCode, tier: moduleTier, username: user.username, allowedOrigin });
  } catch (err) {
    console.error('OAuth callback error:', err);
    return serveErrorPage(c, 'An error occurred during authentication. Please try again.');
  }
});

// ── POST /oauth/exchange ──────────────────────────────────────────────────────
// The Foundry client calls this to exchange the auth code for real tokens.

router.post('/exchange',
  rateLimiter({
    max: 20,
    windowSec: 3600,
    keyFn: (c) => c.req.header('X-Installation-ID') ?? c.req.header('CF-Connecting-IP') ?? 'unknown'
  }),
  async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.authCode || !body?.installationId || !body?.fingerprintHash) {
    return c.json({ error: 'Missing parameters', code: 'BAD_REQUEST' }, 400);
  }

  const { authCode, installationId, fingerprintHash } = body;
  // Must be a module the server knows. The old fallback to 'vnd-enhanced' also
  // defeated the MODULE_MISMATCH check below: both sides degraded to the same
  // value, so a mismatch could never be detected.
  const moduleId = body.moduleId;
  if (typeof moduleId !== 'string' || !PatreonClient.isValidModuleId(moduleId)) {
    return c.json({ error: 'Unknown module', code: 'UNKNOWN_MODULE' }, 400);
  }

  // Validate and consume the auth code
  const authCodeRaw = await c.env.KV.get(`authcode:${authCode}`);
  if (!authCodeRaw) return c.json({ error: 'Invalid or expired auth code', code: 'INVALID_CODE' }, 400);
  await c.env.KV.delete(`authcode:${authCode}`);

  // Auth code stores { userId, moduleId } — verify the client's moduleId matches what was requested
  let userId;
  try {
    const parsed = JSON.parse(authCodeRaw);
    userId = parsed.userId;
    // If the stored code has a moduleId (new format), verify it matches the client's claim
    if (parsed.moduleId && parsed.moduleId !== moduleId) {
      return c.json({ error: 'Module ID mismatch', code: 'MODULE_MISMATCH' }, 400);
    }
  } catch {
    // Legacy format: raw userId string (old auth codes issued before multi-module support)
    userId = authCodeRaw;
  }

  const db   = new Supabase(c.env);
  const user = await db.findOne('vnd_users', { id: userId });
  if (user?.status !== 'active') {
    return c.json({ error: 'User not found or suspended', code: 'USER_INVALID' }, 403);
  }

  // Reject before claiming a slot: a restricted tier must not burn an
  // installation slot on a module it is not entitled to.
  const tier = PatreonClient.effectiveTier(user.tier, moduleId);
  if (tier === 'none') {
    return c.json({
      error: 'Your Patreon tier does not include this module.',
      code:  'TIER_INSUFFICIENT'
    }, 403);
  }

  const MAX_SLOTS = 2;

  // Fetch ALL rows for this user across ALL modules — needed to assign globally unique
  // slot_numbers (avoiding unique constraint conflicts between modules).
  const allUserInstalls = await db.findMany('vnd_installations', { user_id: userId });
  // Per-module view: used for MAX_SLOTS enforcement and re-activation detection.
  const allInstalls = allUserInstalls.filter(i => (i.module_id ?? 'vnd-enhanced') === moduleId);

  // Check if this installation_id already exists on this user (re-activation)
  let installation = allInstalls.find(i => i.installation_id === installationId) ?? null;

  // Also check globally. An ID held by ANOTHER account is a real conflict; the
  // caller's own row is not, even when it is filed under a different module —
  // activations made before a module reached isValidModuleId were recorded
  // under the 'vnd-enhanced' fallback, and must be allowed to migrate.
  if (!installation) {
    const foreign = await db.findOne('vnd_installations', { installation_id: installationId });
    if (foreign && foreign.user_id !== userId) {
      return c.json({ error: 'Installation ID conflict', code: 'INSTALL_CONFLICT' }, 409);
    }
    installation = foreign ?? null;
  }

  if (installation) {
    // Re-activation on same world — update in place. module_id is rewritten so
    // a row adopted from the old fallback lands on the module it is really for.
    installation = await db.update('vnd_installations',
      { id: installation.id },
      {
        module_id:        moduleId,
        fingerprint_hash: fingerprintHash,
        status:           'active',
        updated_at:       new Date().toISOString()
      }
    );
  } else if (allInstalls.length >= MAX_SLOTS) {
    // Table is full (UNIQUE on slot_number covers all statuses) — must overwrite a row.
    // Prefer evicting revoked/inactive slots first, then least-recently-heartbeated active slot.
    const toEvict = [...allInstalls].sort((a, b) => {
      const aActive = a.status === 'active' ? 1 : 0;
      const bActive = b.status === 'active' ? 1 : 0;
      if (aActive !== bActive) return aActive - bActive;
      return new Date(a.last_heartbeat ?? 0) - new Date(b.last_heartbeat ?? 0);
    })[0];

    // Only revoke tokens when displacing an active slot
    if (toEvict.status === 'active') {
      const oldTokens = await db.findMany('vnd_refresh_tokens', { installation_id: toEvict.id });
      for (const t of oldTokens) {
        if (!t.is_revoked) {
          await db.update('vnd_refresh_tokens', { id: t.id }, {
            is_revoked: true, revoked_at: new Date().toISOString(), revocation_reason: 'auto_replaced'
          });
        }
      }
      await c.env.KV.put(`revoked:install:${toEvict.installation_id}`, '1', { expirationTtl: 86400 * 31 });
    }

    installation = await db.update('vnd_installations', { id: toEvict.id }, {
      installation_id:   installationId,
      fingerprint_hash:  fingerprintHash,
      status:            'active',
      last_heartbeat:    null,
      heartbeat_count:   0,
      revoked_at:        null,
      revocation_reason: null,
      updated_at:        new Date().toISOString()
    });
  } else {
    // Truly fresh — pick a slot_number not used by ANY module for this user
    // (avoids unique constraint conflicts when user activates multiple modules)
    const usedSlots = new Set(allUserInstalls.map(i => i.slot_number));
    const slotNumber = [1, 2, 3, 4, 5, 6, 7, 8].find(n => !usedSlots.has(n)) ?? (allUserInstalls.length + 1);
    installation = await db.insert('vnd_installations', {
      installation_id:  installationId,
      user_id:          userId,
      module_id:        moduleId,
      slot_number:      slotNumber,
      fingerprint_hash: fingerprintHash,
      status:           'active'
    });
  }

  if (!installation) {
    return c.json({ error: 'Failed to claim installation slot', code: 'SLOT_ERROR' }, 500);
  }

  // Issue access + refresh tokens — always against the module-scoped tier
  const features    = PatreonClient.featuresForTier(tier, moduleId);
  const jwtPayload  = buildAccessToken({ ...user, tier }, installation, features);
  const accessToken = await signJWT(jwtPayload, c.env);
  const { refreshToken } = await issueRefreshToken(db, user.id, installation.id, fingerprintHash);

  await db.insert('vnd_audit', {
    event_type:      'activation',
    user_id:         user.id,
    installation_id: installation.id,
    details:         { slot: installation.slot_number, module_id: moduleId }
  });

  return c.json({
    accessToken,
    refreshToken,
    expiresIn: 3600,
    tier,
    features
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function issueRefreshToken(db, userId, installationId, fingerprintHash) {
  const raw       = crypto.randomUUID() + crypto.randomUUID(); // 72 chars
  const hashBuf   = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  const tokenHash = btoa(String.fromCodePoint(...new Uint8Array(hashBuf)));

  const rt = await db.insert('vnd_refresh_tokens', {
    token_hash:       tokenHash,
    user_id:          userId,
    installation_id:  installationId,
    fingerprint_hash: fingerprintHash,
    expires_at:       new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    family_id:        crypto.randomUUID()
  });

  return { refreshToken: raw, rt };
}

// Expose for reuse in license routes
export { issueRefreshToken };

// ── HTML pages ────────────────────────────────────────────────────────────────

function serveSuccessPage(c, { authCode, tier, username, allowedOrigin }) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>VND Enhanced — Authenticated</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;background:#1a1a2e;color:#e0d7c8;
         min-height:100vh;display:flex;align-items:center;justify-content:center}
    .card{background:#252540;border-radius:16px;padding:40px;max-width:460px;
          width:100%;text-align:center;box-shadow:0 8px 40px rgba(0,0,0,.5)}
    .icon{font-size:48px;margin-bottom:16px}
    h1{font-size:1.5rem;margin-bottom:8px;color:#c89b3c}
    .sub{color:#a09080;margin-bottom:28px;font-size:.95rem}
    .tier{display:inline-block;padding:4px 14px;border-radius:20px;
          background:#c89b3c22;color:#c89b3c;font-size:.85rem;
          border:1px solid #c89b3c44;margin-bottom:24px}
    .code-label{font-size:.85rem;color:#a09080;margin-bottom:8px}
    .code{background:#111;border-radius:10px;padding:14px 18px;
          font-family:monospace;font-size:.9rem;letter-spacing:.05em;
          word-break:break-all;color:#7ecb9b;border:1px solid #333;
          margin-bottom:16px;user-select:all}
    .btn{display:inline-block;background:#c89b3c;color:#1a1a2e;border:none;
         border-radius:8px;padding:12px 28px;font-size:1rem;font-weight:700;
         cursor:pointer;margin-bottom:8px}
    .btn:active{opacity:.8}
    .note{font-size:.8rem;color:#706050;margin-top:16px}
    .copied{color:#7ecb9b;font-size:.85rem;margin-top:8px;display:none}
  </style>
</head>
<body>
<div class="card">
  <div class="icon">✅</div>
  <h1>Patreon Connected!</h1>
  <p class="sub">Welcome, ${escHtml(username ?? 'adventurer')}.</p>
  <span class="tier">${escHtml(tier.toUpperCase())} tier</span>

  <p class="code-label">Paste this code in your Foundry module settings:</p>
  <div class="code" id="code">${escHtml(authCode)}</div>

  <button class="btn" onclick="copyCode()">Copy Code</button>
  <div class="copied" id="copied">Copied to clipboard!</div>
  <p class="note">This code expires in 5 minutes. Return to FoundryVTT to complete activation.</p>
</div>
<script>
  function copyCode(){
    navigator.clipboard.writeText(document.getElementById('code').textContent.trim());
    document.getElementById('copied').style.display='block';
    setTimeout(()=>document.getElementById('copied').style.display='none',3000);
  }
  // postMessage only to the stored Foundry origin (never to '*')
  const _target = ${allowedOrigin ? `'${escJs(allowedOrigin)}'` : `window.location.origin`};
  try{ window.opener?.postMessage({ type:'vnd-auth-code', authCode:'${escJs(authCode)}' }, _target); }catch(e){}
</script>
</body>
</html>`;
  return c.html(html);
}

function serveErrorPage(c, message) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>VND Enhanced — Error</title>
  <style>
    body{font-family:system-ui,sans-serif;background:#1a1a2e;color:#e0d7c8;
         min-height:100vh;display:flex;align-items:center;justify-content:center}
    .card{background:#252540;border-radius:16px;padding:40px;max-width:400px;
          width:100%;text-align:center}
    h1{color:#e05555;margin-bottom:12px}
    p{color:#a09080;font-size:.95rem}
  </style>
</head>
<body>
<div class="card">
  <div style="font-size:48px;margin-bottom:16px">❌</div>
  <h1>Authentication Failed</h1>
  <p>${escHtml(message)}</p>
  <p style="margin-top:16px;font-size:.85rem">You can close this window and try again from FoundryVTT.</p>
</div>
</body>
</html>`;
  return c.html(html, 400);
}

/**
 * Shape a real origin can take: scheme, host (DNS name, IPv4, or bracketed
 * IPv6), optional port. Nothing else.
 *
 * URL parsing alone is NOT enough here, which is easy to get wrong: WHATWG host
 * parsing rejects `<` and `>` but happily keeps `'`, `"` and a backtick inside
 * a hostname, so `new URL("http://x'+alert(1)+'").origin` round-trips intact.
 * Since the value lands in a JS string literal, that is a quote away from an
 * escape. This whitelist is what actually makes the value safe.
 */
const ORIGIN_RE = /^https?:\/\/(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:.]+\])(?::\d{1,5})?$/;

/**
 * Reduce a client-supplied origin to `scheme://host[:port]`, or null.
 *
 * The value is echoed into the OAuth success page as a JS string literal, so it
 * is never trusted verbatim: the old `startsWith('http')` check let
 * `http://x</script><script>…` through, closing the script tag and running
 * attacker code on this origin — where the victim's auth code sits in the DOM.
 */
export function parseOrigin(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return ORIGIN_RE.test(url.origin) ? url.origin : null;
  } catch {
    return null;
  }
}

function escHtml(str) {
  return String(str ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
}

// Defence in depth behind parseOrigin: `<` and `>` are escaped so no value can
// close the surrounding <script>, and the line terminators JS treats as breaks
// are escaped so none can terminate the string literal early.
export function escJs(str) {
  return String(str ?? '')
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll('"', '\\"')
    .replaceAll('<', '\\x3C')
    .replaceAll('>', '\\x3E')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    // Written as regex escapes on purpose: the raw U+2028/U+2029 code points
    // are line terminators, and pasting them into this source would break
    // the very literal meant to neutralise them.
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export default router;
