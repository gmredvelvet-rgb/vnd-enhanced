/**
 * License routes:
 *   POST /token/refresh   — rotate refresh token, issue new access token
 *   POST /heartbeat       — periodic validation, returns fresh access token
 *   GET  /license/status  — check current license status (no auth needed, just query)
 *   POST /license/release — release an installation slot
 */

import { Hono }          from 'hono';
import { Supabase }      from '../supabase.js';
import { PatreonClient } from '../patreon.js';
import { signJWT, buildAccessToken } from '../jwt.js';
import { requireAuth, requireNonce, rateLimiter, signedJson } from '../middleware.js';
import { issueRefreshToken } from './auth.js';

const router = new Hono();

// ── POST /token/refresh ───────────────────────────────────────────────────────

router.post('/refresh',
  rateLimiter({ max: 10, windowSec: 3600 }),
  requireNonce,
  async (c) => {
    const { refreshToken, fingerprintHash } = c.get('body');
    if (!refreshToken || !fingerprintHash) {
      return c.json({ error: 'Missing parameters', code: 'BAD_REQUEST' }, 400);
    }

    const db = new Supabase(c.env);

    // Hash the incoming token to look it up in DB
    const hashBuf   = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(refreshToken));
    const tokenHash = btoa(String.fromCodePoint(...new Uint8Array(hashBuf)));

    const rt = await db.findOne('vnd_refresh_tokens', { token_hash: tokenHash });

    if (!rt) return c.json({ error: 'Invalid refresh token', code: 'INVALID_TOKEN' }, 401);

    // Detect token reuse — a revoked token being used is a critical signal
    if (rt.is_revoked) {
      await revokeFamily(db, rt.family_id, 'token_reuse_detected');
      await db.insert('vnd_anomalies', {
        user_id:         rt.user_id,
        installation_id: rt.installation_id,
        anomaly_type:    'refresh_token_reuse',
        severity:        'critical',
        details:         { family_id: rt.family_id }
      });
      return c.json({ error: 'Security violation', code: 'SECURITY_VIOLATION' }, 401);
    }

    if (new Date(rt.expires_at) < new Date()) {
      return c.json({ error: 'Refresh token expired', code: 'TOKEN_EXPIRED' }, 401);
    }

    // Fingerprint must match what was registered
    if (rt.fingerprint_hash !== fingerprintHash) {
      await revokeFamily(db, rt.family_id, 'fingerprint_mismatch');
      await db.insert('vnd_anomalies', {
        user_id:         rt.user_id,
        installation_id: rt.installation_id,
        anomaly_type:    'fingerprint_mismatch',
        severity:        'high',
        details:         {}
      });
      return c.json({ error: 'Device verification failed', code: 'DEVICE_MISMATCH' }, 401);
    }

    // Revoke this token (rotation — old token becomes invalid)
    await db.update('vnd_refresh_tokens', { id: rt.id }, {
      is_revoked:         true,
      revoked_at:         new Date().toISOString(),
      revocation_reason:  'rotated',
      last_used_at:       new Date().toISOString()
    });

    // Fetch user + installation
    const user         = await db.findOne('vnd_users', { id: rt.user_id });
    const installation = await db.findOne('vnd_installations', { id: rt.installation_id });

    if (user?.status !== 'active') {
      return c.json({ error: 'Account inactive', code: 'ACCOUNT_INACTIVE' }, 403);
    }
    if (installation?.status !== 'active') {
      return c.json({ error: 'Installation inactive', code: 'INSTALL_INACTIVE' }, 403);
    }

    // Issue new tokens
    const moduleId      = installation.module_id ?? 'vnd-enhanced';
    const features      = PatreonClient.featuresForTier(user.tier, moduleId);
    const jwtPayload    = buildAccessToken(user, installation, features);
    const accessToken   = await signJWT(jwtPayload, c.env);
    const { refreshToken: newRt } = await issueRefreshToken(
      db, user.id, installation.id, fingerprintHash
    );

    // Mark old RT as replaced
    await db.update('vnd_refresh_tokens', { id: rt.id }, {});

    return signedJson(c, { accessToken, refreshToken: newRt, expiresIn: 3600, features });
  }
);

// ── POST /heartbeat ───────────────────────────────────────────────────────────

router.post('/heartbeat',
  rateLimiter({ max: 8, windowSec: 3600, keyFn: (c) => c.req.header('X-Installation-ID') ?? 'unknown' }),
  requireNonce,
  requireAuth,
  async (c) => {
    const payload = c.get('jwtPayload');
    const { installationId, fingerprintHash } = c.get('body');

    if (payload.iid !== installationId) {
      return c.json({ error: 'Installation mismatch', code: 'INSTALL_MISMATCH' }, 400);
    }

    const db           = new Supabase(c.env);
    const installation = await db.findOne('vnd_installations', {
      installation_id: installationId,
      user_id:         payload.sub,
      module_id:       payload.mid ?? 'vnd-enhanced',
      status:          'active'
    });

    if (!installation) {
      return c.json({ error: 'Installation not found', code: 'INSTALL_NOT_FOUND' }, 404);
    }

    // Verify fingerprint — constant-time full comparison (prevents prefix-guessing & timing attacks)
    const fingerprintMatch = await timingSafeEqual(fingerprintHash, installation.fingerprint_hash);
    if (!fingerprintMatch) {
      await db.insert('vnd_anomalies', {
        user_id:         payload.sub,
        installation_id: installation.id,
        anomaly_type:    'heartbeat_fingerprint_drift',
        severity:        'medium',
        details:         {}
      });
      // Soft failure — fingerprints can drift slightly with browser/OS updates.
      // Logged and counted; after 5 occurrences triggers manual review.
    }

    // Update heartbeat
    await db.update('vnd_installations', { id: installation.id }, {
      last_heartbeat:  new Date().toISOString(),
      heartbeat_count: (installation.heartbeat_count ?? 0) + 1,
      updated_at:      new Date().toISOString()
    });

    // Re-verify Patreon subscription every 24 heartbeats (~6 hours if every 15min)
    const user = await db.findOne('vnd_users', { id: payload.sub });
    if (user?.status !== 'active') {
      return c.json({ error: 'Account inactive', code: 'ACCOUNT_INACTIVE' }, 403);
    }

    const shouldVerifyPatreon = (installation.heartbeat_count ?? 0) % 24 === 0;
    let tier = user.tier;

    if (shouldVerifyPatreon && user.patreon_refresh) {
      try {
        const patreon     = new PatreonClient(c.env);
        const newTokens   = await patreon.refreshToken(user.patreon_refresh);
        const { membership } = await patreon.getIdentity(newTokens.access_token);
        tier = PatreonClient.isOwner(user.email, c.env)
          ? 'premium'
          : PatreonClient.resolveTier(membership);

        await db.update('vnd_users', { id: user.id }, {
          tier,
          tier_verified_at:   new Date().toISOString(),
          patreon_access:     newTokens.access_token,
          patreon_refresh:    newTokens.refresh_token,
          patreon_expires_at: new Date(Date.now() + newTokens.expires_in * 1000).toISOString()
        });
      } catch {
        // Patreon API down — use cached tier, don't punish user
      }
    }

    const moduleId    = payload.mid ?? 'vnd-enhanced';
    const features    = PatreonClient.featuresForTier(tier, moduleId);
    const jwtPayload  = buildAccessToken({ ...user, tier }, installation, features);
    const accessToken = await signJWT(jwtPayload, c.env);

    return signedJson(c, { accessToken, expiresIn: 3600, tier, features });
  }
);

// ── GET /license/status ───────────────────────────────────────────────────────

router.get('/license/status',
  requireAuth,
  async (c) => {
    const payload = c.get('jwtPayload');
    const db      = new Supabase(c.env);
    const user    = await db.findOne('vnd_users', { id: payload.sub });
    if (!user) return c.json({ error: 'User not found', code: 'NOT_FOUND' }, 404);

    const installations = await db.findMany('vnd_installations', {
      user_id: user.id,
      status:  'active'
    });

    return signedJson(c, {
      tier:           user.tier,
      features:       PatreonClient.featuresForTier(user.tier),
      installations:  installations.map(i => ({
        installation_id: i.installation_id,
        slot:            i.slot_number,
        last_heartbeat:  i.last_heartbeat,
        world_id:        i.world_id
      })),
      maxSlots: 2
    });
  }
);

// ── POST /license/release ─────────────────────────────────────────────────────

router.post('/license/release',
  requireAuth,
  async (c) => {
    const { installationId } = await c.req.json().catch(() => ({}));
    if (!installationId) return c.json({ error: 'Missing installationId', code: 'BAD_REQUEST' }, 400);

    const payload = c.get('jwtPayload');
    const db      = new Supabase(c.env);

    const installation = await db.findOne('vnd_installations', {
      installation_id: installationId,
      user_id:         payload.sub,
      module_id:       payload.mid ?? 'vnd-enhanced'
    });

    if (!installation) return c.json({ error: 'Installation not found', code: 'NOT_FOUND' }, 404);

    await db.update('vnd_installations', { id: installation.id }, {
      status:            'revoked',
      revoked_at:        new Date().toISOString(),
      revocation_reason: 'user_released'
    });

    // Revoke all refresh tokens for this installation
    await revokeInstallationTokens(db, installation.id, 'user_released');

    // Flag in KV for immediate effect on any active JWT
    await c.env.KV.put(`revoked:install:${installationId}`, '1', { expirationTtl: 86400 * 31 });

    return c.json({ success: true });
  }
);

// ── Helpers ───────────────────────────────────────────────────────────────────

// Constant-time string comparison — prevents timing-based enumeration attacks.
// Signs both strings with a one-shot ephemeral HMAC key, then XOR-compares the MACs.
async function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const [sa, sb] = await Promise.all([
    crypto.subtle.sign('HMAC', key, enc.encode(a)),
    crypto.subtle.sign('HMAC', key, enc.encode(b))
  ]);
  const ua = new Uint8Array(sa), ub = new Uint8Array(sb);
  let diff = ua.length ^ ub.length;
  for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
  return diff === 0;
}

async function revokeFamily(db, familyId, reason) {
  const tokens = await db.findMany('vnd_refresh_tokens', { family_id: familyId, is_revoked: false });
  for (const t of tokens) {
    await db.update('vnd_refresh_tokens', { id: t.id }, {
      is_revoked:        true,
      revoked_at:        new Date().toISOString(),
      revocation_reason: reason
    });
  }
}

async function revokeInstallationTokens(db, installationId, reason) {
  const tokens = await db.findMany('vnd_refresh_tokens', {
    installation_id: installationId,
    is_revoked:      false
  });
  for (const t of tokens) {
    await db.update('vnd_refresh_tokens', { id: t.id }, {
      is_revoked:        true,
      revoked_at:        new Date().toISOString(),
      revocation_reason: reason
    });
  }
}

export default router;
