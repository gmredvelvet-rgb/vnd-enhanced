/**
 * Standalone check for the tier gate — run with:  node scripts/verify-tiers.js
 *
 * Exercises PatreonClient.resolveTier (including the $3 free trial) and
 * PatreonClient.effectiveTier (tier × module matrix). No network, no DB.
 * Exits non-zero if any expectation fails.
 */

import { PatreonClient } from '../src/patreon.js';

let failures = 0;

function check(actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  return ok ? 'ok' : `FAIL (esperado ${expected})`;
}

// Shape of what Patreon returns inside `included` for a member of our campaign
function member({ status = 'active_patron', cents = 0, willPay, freeTrial } = {}) {
  const attributes = { patron_status: status, currently_entitled_amount_cents: cents };
  if (willPay   !== undefined) attributes.will_pay_amount_cents = willPay;
  if (freeTrial !== undefined) attributes.is_free_trial         = freeTrial;
  return { type: 'member', attributes };
}

// ── 1. resolveTier ────────────────────────────────────────────────────────────

const tierCases = [
  ['sin membresía (null)',              null,                                                        'none'],
  ['patrón inactivo con $6',            member({ status: 'former_patron', cents: 600 }),             'none'],
  ['$1/mes activo',                     member({ cents: 100 }),                                      'none'],
  ['$3/mes activo',                     member({ cents: 300 }),                                      'mobile'],
  ['$6/mes activo',                     member({ cents: 600 }),                                      'basic'],
  ['$10/mes activo',                    member({ cents: 1000 }),                                     'premium'],
  ['$3 en prueba gratuita (cents 0)',   member({ cents: 0, willPay: 300, freeTrial: true }),         'mobile'],
  ['$6 en prueba gratuita (cents 0)',   member({ cents: 0, willPay: 600, freeTrial: true }),         'basic'],
  ['prueba gratuita cancelada',         member({ status: 'declined_patron', cents: 0, willPay: 300, freeTrial: true }), 'none'],
  ['trial sin will_pay (degradado)',    member({ cents: 0, freeTrial: true }),                       'none'],
  ['$6 sin campos nuevos (Patreon viejo)', member({ cents: 600 }),                                   'basic'],
  ['atributos ausentes',                { type: 'member' },                                          'none']
];

console.log('\n== resolveTier ==============================================================');
console.log('caso                                     | cents | will_pay | trial | tier    | check');
console.log('-----------------------------------------+-------+----------+-------+---------+-------');
for (const [label, m, expected] of tierCases) {
  const a      = m?.attributes ?? {};
  const tier   = PatreonClient.resolveTier(m);
  const cents  = m === null ? '—' : String(a.currently_entitled_amount_cents ?? '—');
  const pay    = a.will_pay_amount_cents ?? '—';
  const trial  = a.is_free_trial === true ? 'sí' : '—';
  console.log(
    `${label.padEnd(40)} | ${cents.padStart(5)} | ${String(pay).padStart(8)} | ` +
    `${String(trial).padStart(5)} | ${tier.padEnd(7)} | ${check(tier, expected)}`
  );
}

// ── 2. effectiveTier — matriz tier × módulo ───────────────────────────────────

const MODULES = [
  'velvet-mobile', 'vnd-enhanced', 'sf2e-cyber-sheet', 'starfinderdashboard',
  'hopefinder-sheet', 'pf2e-velvet-sheet', 'dnd-velvet-sheets', 'velvet-journals'
];
const TIERS = ['none', 'mobile', 'basic', 'premium'];

// 'mobile' solo abre velvet-mobile; el resto de tiers pasan sin recortar
const expectedEff = (tier, moduleId) =>
  tier === 'mobile' && moduleId !== 'velvet-mobile' ? 'none' : tier;

console.log('\n== effectiveTier (tier × módulo) ============================================');
console.log(`${'módulo'.padEnd(22)}| ${TIERS.map(t => t.padEnd(9)).join('| ')}`);
console.log('-'.repeat(22) + '+' + TIERS.map(() => '-'.repeat(10)).join('+'));
for (const moduleId of MODULES) {
  const cells = TIERS.map(tier => {
    const eff = PatreonClient.effectiveTier(tier, moduleId);
    const ok  = eff === expectedEff(tier, moduleId);
    if (!ok) failures++;
    return `${eff}${ok ? '' : ' !!'}`.padEnd(9);
  });
  console.log(`${moduleId.padEnd(22)}| ${cells.join('| ')}`);
}

// Un moduleId desconocido nunca debe abrirse al tier 'mobile'
console.log(`\nmoduleId desconocido + 'mobile' -> ${PatreonClient.effectiveTier('mobile', 'no-such-module')} ` +
            `| ${check(PatreonClient.effectiveTier('mobile', 'no-such-module'), 'none')}`);

// ── 3. Coherencia con isValidModuleId y featuresForTier ───────────────────────

console.log('\n== módulos / features ======================================================');
console.log(`${'módulo'.padEnd(22)}| válido | features(mobile)   | features(basic)`);
console.log('-'.repeat(22) + '+--------+--------------------+-----------------');
for (const moduleId of MODULES) {
  const valid = PatreonClient.isValidModuleId(moduleId);
  if (!valid) failures++;
  // Lo que el cliente recibiría de verdad: el tier ya recortado por effectiveTier
  const fMobile = PatreonClient.featuresForTier(PatreonClient.effectiveTier('mobile', moduleId), moduleId);
  const fBasic  = PatreonClient.featuresForTier(PatreonClient.effectiveTier('basic',  moduleId), moduleId);
  // Solo velvet-mobile puede entregar features a un patrón de $3
  const mobileOk = moduleId === 'velvet-mobile' ? fMobile.length > 0 : fMobile.length === 0;
  if (!mobileOk) failures++;
  if (fBasic.length === 0) failures++;
  console.log(
    `${moduleId.padEnd(22)}| ${(valid ? 'sí' : 'NO !!').padEnd(7)}| ` +
    `${(fMobile.join(',') || '(ninguna)').padEnd(19)}| ${fBasic.join(',').slice(0, 40) || '(ninguna) !!'}`
  );
}

// velvet-mobile no debe estar bloqueado por el fallback a 'vnd-enhanced'
const fallbackLeak = PatreonClient.isValidModuleId('velvet-mobile');
console.log(`\nvelvet-mobile en isValidModuleId -> ${fallbackLeak} | ${check(fallbackLeak, true)}`);

console.log(
  failures === 0
    ? '\n✅ Todo correcto: ninguna comprobación falló.\n'
    : `\n❌ ${failures} comprobación(es) fallaron.\n`
);
process.exit(failures === 0 ? 0 : 1);
