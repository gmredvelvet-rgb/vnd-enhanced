/**
 * Behavioural check of the A2/A3 client fixes, against the real files.
 *
 * Stubs just enough browser + Foundry to instantiate a licence client, then
 * drives the two paths that were broken:
 *   A2 — two concurrent refreshes must produce ONE call to /token/refresh.
 *   A3 — a network failure at startup must NOT destroy stored credentials.
 */
import { webcrypto } from 'node:crypto';

// Root of the Foundry modules directory. Defaults to this repo's parent, so the
// script works from a checkout without configuration; override for other layouts:
//   node tools/verify-license-clients.mjs /path/to/Data/modules
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const M = (process.argv[2] ?? path.resolve(HERE, '..', '..')).replaceAll('\\', '/').replace(/\/?$/, '/');

const TARGETS = [
  ['pf2e-velvet-sheet',       M + 'pf2e-velvet-sheet/scripts/license-client.mjs',      'VelvetLicenseClient'],
  ['dnd-velvet-sheets',       M + 'dnd-velvet-sheets/scripts/license-client.mjs',      'AAALicenseClient'],
  ['hopefinder-sheet',        M + 'hopefinder-sheet/scripts/license-client.mjs',       null],
  ['sf2e-cyber-sheet',        M + 'sf2e-cyber-sheet/scripts/license-client.js',        null],
  ['starfinderdashboard',     M + 'starfinderdashboard/scripts/license-client.js',     null],
  ['dnd-shops',               M + 'dnd-shops/scripts/license-client.js',               'DndShopsLicenseClient'],
  ['vnd-enhanced',            M + 'vnd-enhanced/scripts/license-client.js',            'VndLicenseClient'],
  ['velvet-journals',         M + 'velvet-journals/scripts/license.js',                'default'],
  ['directional-token-images', M + 'directional-token-images/scripts/license/license.js', 'default'],
  ['velvet-mobile',           M + 'velvet-mobile/scripts/license/license-client.mjs',  'LicenseClient']
];

let failures = 0;
const say = (mod, label, ok, extra = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`);
};

// ── Browser + Foundry stubs ───────────────────────────────────────────────────

function installGlobals(store) {
  // Node 20+ defines crypto and navigator as accessor properties, so plain
  // assignment throws — redefine them instead.
  const def = (name, value) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

  if (!globalThis.crypto) def('crypto', webcrypto);
  def('navigator', { language: 'en', hardwareConcurrency: 8 });
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };
  globalThis.screen = { width: 1920, height: 1080, colorDepth: 24 };
  globalThis.document = { createElement: () => { throw new Error('no canvas'); }, getElementById: () => null, body: null };
  globalThis.window = { addEventListener() {}, removeEventListener() {}, open: () => null };
  globalThis.game = { world: { id: 'w' }, version: '13', user: { isGM: true }, settings: { get: () => false, set: async () => {} } };
  globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };
  globalThis.Hooks = { callAll() {}, on() {}, once() {} };
  globalThis.FormApplication = class {};
  globalThis.Dialog = class { render() {} };
  globalThis.foundry = { utils: { escapeHTML: (s) => s }, applications: { api: {} } };
}

async function loadClient(path, exportName) {
  const mod = await import('file:///' + path);
  if (exportName && mod[exportName]) return mod[exportName];
  // Fall back to the first export that looks like a licence client class.
  for (const v of Object.values(mod)) {
    if (typeof v === 'function' && v.prototype && 'initialize' in v.prototype) return v;
  }
  throw new Error('no client class exported from ' + path);
}

// Fresh instance every time: these clients are singletons keyed on a static.
function freshInstance(Cls) {
  const c = new Cls();
  return c;
}

// ── The two checks ────────────────────────────────────────────────────────────

async function checkRefreshMutex(mod, Cls, store) {
  store[`${mod}:rt`] = 'stored-refresh-token';
  store[`${mod}:iid`] = 'iid-1';

  let refreshCalls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });

  globalThis.fetch = async (url) => {
    if (String(url).includes('/token/refresh')) {
      refreshCalls++;
      await gate; // hold both callers inside the request window
      return {
        ok: true,
        json: async () => ({ accessToken: 'a.b.c', refreshToken: 'new-rt', expiresIn: 3600, tier: 'basic', features: ['x'] })
      };
    }
    return { ok: true, json: async () => ({}) };
  };

  const client = freshInstance(Cls);
  client.__store = store;
  // Reach the private #doRefresh via the public path that uses it: initialize()
  // loads the stored refresh token and rotates it.
  const a = client.initialize();
  const b = client.initialize();
  release();
  await Promise.allSettled([a, b]);

  say(mod, 'A2 refresh serializado', refreshCalls === 1, `llamadas a /token/refresh = ${refreshCalls}`);
}

async function checkOfflineKeepsCredentials(mod, Cls, store) {
  store[`${mod}:rt`] = 'stored-refresh-token';
  store[`${mod}:iid`] = 'iid-1';
  store[`${mod}:tier`] = 'basic';

  // Exactly what an offline browser does: fetch() rejects.
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };

  const client = freshInstance(Cls);
  await client.initialize().catch(() => {});

  const kept = store[`${mod}:rt`] === 'stored-refresh-token';
  say(mod, 'A3 credenciales sobreviven al corte de red', kept,
    kept ? '' : 'el refresh token fue borrado');
}

// ── Run ───────────────────────────────────────────────────────────────────────

console.log('\n== Comportamiento de los clientes de licencia ==============================');
for (const [mod, path, exportName] of TARGETS) {
  console.log(`\n${mod}`);
  try {
    const store = {};
    installGlobals(store);
    const Cls = await loadClient(path, exportName);
    await checkRefreshMutex(mod, Cls, store);

    const store2 = {};
    installGlobals(store2);
    await checkOfflineKeepsCredentials(mod, Cls, store2);
  } catch (err) {
    failures++;
    console.log(`  FAIL no se pudo ejercitar — ${err.message}`);
  }
}

console.log(
  failures === 0
    ? '\n✅ Todo correcto: ninguna comprobación falló.\n'
    : `\n❌ ${failures} comprobación(es) fallaron.\n`
);
process.exit(failures === 0 ? 0 : 1);
