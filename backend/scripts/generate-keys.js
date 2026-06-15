/**
 * Run with: node scripts/generate-keys.js
 * Generates an RSA-2048 key pair for JWT RS256 signing AND response signing.
 *
 * Output:
 *   - JWT_PRIVATE_KEY: set as Worker secret  (wrangler secret put JWT_PRIVATE_KEY)
 *   - JWT_PUBLIC_KEY:  set as Worker var in wrangler.toml AND embed in client JS (RSA_PUBLIC_KEY)
 *
 * The same RSA key pair covers both access-token JWTs and signed API responses.
 * No separate RESPONSE_SIGN_SECRET is needed.
 */

import { webcrypto } from 'node:crypto';

const { subtle } = webcrypto;

const keyPair = await subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify']
);

const privateKeyBuffer = await subtle.exportKey('pkcs8', keyPair.privateKey);
const publicKeyBuffer  = await subtle.exportKey('spki',  keyPair.publicKey);

const toBase64url = (buf) => Buffer.from(buf).toString('base64url');
const toPem = (buf, type) => {
  const b64 = Buffer.from(buf).toString('base64');
  const body = b64.match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${type}-----\n${body}\n-----END ${type}-----`;
};

console.log('\n=== JWT_PRIVATE_KEY (wrangler secret put JWT_PRIVATE_KEY) ===');
console.log(toBase64url(privateKeyBuffer));

console.log('\n=== JWT_PUBLIC_KEY (wrangler.toml [vars]) ===');
console.log(toBase64url(publicKeyBuffer));

console.log('\n=== RSA_PUBLIC_KEY (embed in license-client.js AND ai-generator.js) ===');
console.log(toBase64url(publicKeyBuffer));
