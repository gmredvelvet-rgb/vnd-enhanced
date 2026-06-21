/**
 * RS256 JWT — using Web Crypto API (native in Cloudflare Workers)
 * Private key signs (server only). Public key verifies (client + server).
 */

const ALG = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };

function b64url(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function b64urlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(padded.length + (4 - padded.length % 4) % 4, '='));
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

// Cache imported keys per request context (Worker instances are ephemeral)
let _cachedPrivateKey = null;
let _cachedPublicKey  = null;

async function getPrivateKey(privateKeyBase64url) {
  if (_cachedPrivateKey) return _cachedPrivateKey;
  const keyBytes = b64urlDecode(privateKeyBase64url);
  _cachedPrivateKey = await crypto.subtle.importKey('pkcs8', keyBytes, ALG, false, ['sign']);
  return _cachedPrivateKey;
}

async function getPublicKey(publicKeyBase64url) {
  if (_cachedPublicKey) return _cachedPublicKey;
  const keyBytes = b64urlDecode(publicKeyBase64url);
  _cachedPublicKey = await crypto.subtle.importKey('spki', keyBytes, ALG, false, ['verify']);
  return _cachedPublicKey;
}

export async function signJWT(payload, env) {
  const header  = { alg: 'RS256', typ: 'JWT', kid: 'v1' };
  const encoded = `${b64url(new TextEncoder().encode(JSON.stringify(header)))}.${b64url(new TextEncoder().encode(JSON.stringify(payload)))}`;
  const key     = await getPrivateKey(env.JWT_PRIVATE_KEY);
  const sig     = await crypto.subtle.sign(ALG.name, key, new TextEncoder().encode(encoded));
  return `${encoded}.${b64url(sig)}`;
}

export async function verifyJWT(token, env) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT format');

  const [headerB64, payloadB64, sigB64] = parts;
  const key  = await getPublicKey(env.JWT_PUBLIC_KEY);
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig  = b64urlDecode(sigB64);

  const valid = await crypto.subtle.verify(ALG.name, key, sig, data);
  if (!valid) throw new Error('Invalid JWT signature');

  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64)));
  const now     = Math.floor(Date.now() / 1000);

  if (payload.exp && payload.exp < now) throw new Error('JWT expired');
  if (payload.iat && payload.iat > now + 30) throw new Error('JWT issued in the future');

  return payload;
}

export function buildAccessToken(user, installation, features) {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub:      user.id,
    iid:      installation.installation_id,
    mid:      installation.module_id ?? 'vnd-enhanced',
    fph:      installation.fingerprint_hash.substring(0, 16),
    tier:     user.tier,
    features,
    iat:      now,
    exp:      now + 3600,    // 1 hour
    jti:      crypto.randomUUID()
  };
}
