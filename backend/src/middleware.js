/**
 * Hono middleware: auth, rate limiting, nonce validation, response signing.
 */

import { verifyJWT, signJWT } from './jwt.js';

// ── Auth middleware ───────────────────────────────────────────────────────────

export async function requireAuth(c, next) {
  const header = c.req.header('Authorization') ?? '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) return c.json({ error: 'Missing authorization', code: 'UNAUTHORIZED' }, 401);

  try {
    const payload = await verifyJWT(token, c.env);

    // Response-signature tokens (signedJson) are minted with the same key pair
    // and therefore verify here too. They carry no subject, so every route
    // happened to reject them further down — by accident, not by design. Refuse
    // anything that is not an access token before any of it is trusted.
    if (payload.type === 'res' || !payload.sub || !payload.iid || !payload.jti) {
      return c.json({ error: 'Invalid token', code: 'INVALID_TOKEN' }, 401);
    }

    const revoked   = await c.env.KV.get(`revoked:jwt:${payload.jti}`);
    if (revoked) return c.json({ error: 'Token revoked', code: 'TOKEN_REVOKED' }, 401);

    const instRevoked = await c.env.KV.get(`revoked:install:${payload.iid}`);
    if (instRevoked) return c.json({ error: 'Installation revoked', code: 'INSTALL_REVOKED' }, 401);

    c.set('jwtPayload', payload);
  } catch (e) {
    return c.json({ error: 'Invalid token', code: 'INVALID_TOKEN' }, 401);
  }

  return next();
}

// ── Rate limiter (KV-based sliding window) ────────────────────────────────────

export function rateLimiter({ max, windowSec, keyFn }) {
  return async (c, next) => {
    const identifier = typeof keyFn === 'function' ? keyFn(c) : c.req.header('CF-Connecting-IP') ?? 'unknown';
    const path = new URL(c.req.url).pathname.replaceAll('/', '_');
    const key  = `rl:${path}:${identifier}`;

    // The window start is stored with the counter. Re-putting a bare counter
    // reset the TTL on every request, so a caller under sustained load could
    // never fall out of its own window and stayed rate-limited indefinitely.
    const raw     = await c.env.KV.get(key);
    const now     = Date.now();
    const parsed  = raw ? JSON.parse(raw) : null;
    const started = parsed?.t ?? now;
    const elapsed = Math.floor((now - started) / 1000);
    const expired = elapsed >= windowSec;

    const current = expired ? 0 : (parsed?.n ?? 0);
    if (current >= max) {
      return c.json({ error: 'Too many requests', code: 'RATE_LIMITED' }, 429);
    }

    // Not atomic — KV has no compare-and-set, so two simultaneous requests can
    // both read the same count. Acceptable for a soft throttle; never rely on
    // this as a security control.
    await c.env.KV.put(
      key,
      JSON.stringify({ n: current + 1, t: expired ? now : started }),
      { expirationTtl: expired ? windowSec : Math.max(60, windowSec - elapsed) }
    );

    return next();
  };
}

// ── Nonce validation (anti-replay) ────────────────────────────────────────────

export async function requireNonce(c, next) {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'Invalid body', code: 'BAD_REQUEST' }, 400);

  const { nonce, timestamp } = body;

  // Timestamp must be within ±60 seconds
  if (!timestamp || Math.abs(Date.now() - timestamp) > 60_000) {
    return c.json({ error: 'Request timestamp invalid', code: 'TIMESTAMP_INVALID' }, 400);
  }

  // Nonce must be present and not seen before
  if (!nonce || typeof nonce !== 'string' || nonce.length < 16) {
    return c.json({ error: 'Invalid nonce', code: 'NONCE_INVALID' }, 400);
  }

  const nonceKey   = `nonce:${nonce}`;
  const nonceUsed  = await c.env.KV.get(nonceKey);
  if (nonceUsed) {
    return c.json({ error: 'Nonce already used', code: 'REPLAY_DETECTED' }, 400);
  }

  // Mark nonce as used (TTL = 120s, well beyond the 60s timestamp window)
  await c.env.KV.put(nonceKey, '1', { expirationTtl: 120 });

  // Attach parsed body so the route doesn't have to parse again
  c.set('body', body);
  return next();
}

// CORS lives in index.js, on hono/cors. A second hand-rolled implementation
// used to sit here, unreferenced — it read as the active policy during audits
// while the real one was elsewhere. Foundry is self-hosted on arbitrary
// domains, so `origin: '*'` there is deliberate: there are no cookies and no
// ambient credentials, so security comes from token validation, not CORS.

// ── Response signing (RS256 asymmetric) ───────────────────────────────────────
// Server signs with RSA private key. Client verifies with embedded public key.
// Unlike HMAC, the public key is safe to embed in client JS — forging is impossible
// without the private key (which never leaves the server).

export async function signedJson(c, data, status = 200) {
  const ts         = Math.floor(Date.now() / 1000);
  const payloadStr = JSON.stringify(data);

  // Hash the payload so the signature binds to exact response content
  const hashBuf     = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payloadStr));
  const payloadHash = btoa(String.fromCodePoint(...new Uint8Array(hashBuf)))
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

  // Sign a compact JWT: type=res, ph=payload-hash, short 60s TTL
  const sig = await signJWT({ type: 'res', ph: payloadHash, iat: ts, exp: ts + 60 }, c.env);

  return c.json({ payload: data, sig }, status);
}
