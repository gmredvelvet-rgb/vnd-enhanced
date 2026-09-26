/**
 * Regression check for the Combat Mode battlefield.
 *
 * Two layers:
 *   1. Behavioural — imports scripts/combat-formation.js (pure, Foundry-free)
 *      and drives the formation maths, HP presentation and HTML escaping.
 *   2. Structural  — greps the real main.js / template / stylesheets for the
 *      wiring points that fail SILENTLY if someone edits them later: the FX
 *      anchor lookup, the target highlight, the grid rows, and Role Mode's
 *      own renderer still being reachable.
 *
 * Run:  node tools/verify-combat-formation.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  computeFormation, resolveMaxPerRow, hpPresentation, hpColor,
  buildUnitHtml, buildFormationHtml, buildBattlefieldHtml,
  escapeHtml, sanitizeStyle, DEFAULT_MAX_PER_ROW,
  isPlaced, splitPlaced, clamp01
} from '../scripts/combat-formation.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

let failures = 0;
let checks = 0;
const ok = (label, pass, extra = '') => {
  checks++;
  if (!pass) failures++;
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`);
};
const eq = (label, actual, expected) =>
  ok(label, JSON.stringify(actual) === JSON.stringify(expected),
     failuresDetail(actual, expected));
const failuresDetail = (a, e) => JSON.stringify(a) === JSON.stringify(e)
  ? '' : `got ${JSON.stringify(a)}, want ${JSON.stringify(e)}`;

// ── 1. Formation maths (§4) ──────────────────────────────────────────────────
console.log('\nformation rows');

eq('0 combatants → no rows',  computeFormation(0), []);
eq('3 → one full row',        computeFormation(3), [[0, 1, 2]]);
eq('4 → 3 + 1',               computeFormation(4), [[0, 1, 2], [3]]);
eq('6 → 3 + 3',               computeFormation(6), [[0, 1, 2], [3, 4, 5]]);
eq('9 → 3 + 3 + 3',           computeFormation(9), [[0, 1, 2], [3, 4, 5], [6, 7, 8]]);
eq('maxPerRow 2, 5 units',    computeFormation(5, { maxPerRow: 2 }), [[0, 1], [2, 3], [4]]);

// Property sweep: no row may exceed maxPerRow (that is what would push a
// combatant off-screen — §11 forbids horizontal overflow), and every
// combatant must appear exactly once, in order.
{
  let rowsOk = true, orderOk = true;
  for (let per = 1; per <= 5; per++) {
    for (let n = 0; n <= 30; n++) {
      const rows = computeFormation(n, { maxPerRow: per });
      if (rows.some(r => r.length > per)) rowsOk = false;
      const flat = rows.flat();
      if (flat.length !== n || flat.some((v, i) => v !== i)) orderOk = false;
    }
  }
  ok('no row ever exceeds maxPerRow (1..5 × 0..30 units)', rowsOk);
  ok('every combatant placed exactly once, in order', orderOk);
}

eq('maxPerRow 1 is honoured', computeFormation(3, { maxPerRow: 1 }), [[0], [1], [2]]);
eq('maxPerRow 0 falls back to the default, never hangs',
   computeFormation(3, { maxPerRow: 0 }), [[0, 1, 2]]);
eq('maxPerRow NaN falls back to the default',
   computeFormation(3, { maxPerRow: NaN }), [[0, 1, 2]]);
ok('garbage count is treated as empty',
   computeFormation(NaN).length === 0 && computeFormation(-4).length === 0);

// ── 2. Responsive column count (§11) ─────────────────────────────────────────
console.log('\nresponsive columns');
eq('1366x768  → 3 per row',   resolveMaxPerRow(1366), 3);
eq('1920x1080 → 3 per row',   resolveMaxPerRow(1920), 3);
eq('2560x1440 → 4 per row',   resolveMaxPerRow(2560), 4);
eq('phone (640) → 2 per row', resolveMaxPerRow(640),  2);
eq('unknown width → default', resolveMaxPerRow(NaN),  DEFAULT_MAX_PER_ROW);
ok('column count never leaves the 2..4 band',
   [320, 800, 1024, 1280, 1440, 1920, 2200, 3440, 7680]
     .every(w => resolveMaxPerRow(w) >= 2 && resolveMaxPerRow(w) <= 4));

// ── 3. HP presentation (§14) ─────────────────────────────────────────────────
console.log('\nHP');
ok('no HP block → nothing rendered', hpPresentation(null) === null);
ok('max 0 → nothing rendered',       hpPresentation({ value: 0, max: 0 }) === null);
{
  const full = hpPresentation({ value: 36, max: 36 }, { side: 'enemy' });
  ok('36/36 reads 100%', full.percent === 100, `got ${full.percent}`);
  ok('numbers formatted "36 / 36"', full.text === '36 / 36', `got "${full.text}"`);

  const hidden = hpPresentation({ value: 36, max: 36 }, { side: 'enemy', showNumbers: false });
  ok('bar still renders when numbers are hidden', hidden.percent === 100);
  ok('enemy digits withheld from players', hidden.text === '', `got "${hidden.text}"`);

  const overkill = hpPresentation({ value: -12, max: 100 });
  ok('overkill clamps to 0% (never a negative bar)', overkill.percent === 0);

  ok('enemy bars are red',        hpColor(1, 'enemy') === '#c0392b');
  ok('healthy player bar green',  hpColor(0.9, 'player') === '#4caf50');
  ok('wounded player bar amber',  hpColor(0.4, 'player') === '#f09800');
  ok('critical player bar red',   hpColor(0.1, 'player') === '#e53935');
}

// ── 4. Unit markup + escaping ────────────────────────────────────────────────
console.log('\nunit markup');
{
  const html = buildUnitHtml({
    id: 'abc', name: 'Ember Hound', img: 'x.webp', side: 'enemy',
    hp: { value: 36, max: 36 }, isActive: true
  });
  ok('carries the actor id for FX/target lookups', html.includes('data-id="abc"'));
  ok('keyboard reachable', html.includes('role="button"') && html.includes('tabindex="0"'));
  ok('active turn marked', html.includes('vne-bf-active') && html.includes('vne-bf-turn-mark'));
  ok('name rendered', html.includes('Ember Hound'));
  ok('HP bar rendered', html.includes('vne-bf-hp-fill'));
  ok('no card wrapper around the art (§7)', !html.includes('vne-cast-portrait'));

  const hostile = buildUnitHtml({
    id: '"><script>x</script>', name: '<img src=x onerror=alert(1)>',
    imgStyle: 'transform:scale(1);background:url(evil.png)" onload="alert(1)'
  });
  ok('name is HTML-escaped', !hostile.includes('<img src=x'));
  ok('id is attribute-escaped', !hostile.includes('<script>'));
  // Inspect the style attribute itself, not the surrounding markup — asserting
  // on the raw string would match the attribute's own closing quote.
  const styleAttr = /style="([^"]*)"/.exec(hostile)?.[1] ?? null;
  ok('style attribute is present and closed', styleAttr !== null);
  ok('style cannot smuggle url()', !styleAttr.includes('url('));
  // The payload tried to close style="" and open an event handler. With quotes
  // stripped the whole thing stays trapped inside the style value.
  ok('style cannot break out into an event handler', !/onload\s*=\s*"/i.test(hostile));

  const noNums = buildUnitHtml({ id: 'e', hp: { value: 5, max: 10 }, showHpNumbers: false });
  ok('bar without digits when withheld',
     noNums.includes('vne-bf-hp-fill') && !noNums.includes('vne-bf-hp-text'));
}

ok('escapeHtml covers the five metacharacters',
   escapeHtml(`<>&"'`) === '&lt;&gt;&amp;&quot;&#39;');
ok('sanitizeStyle drops quotes and brackets',
   !/[<>"'`]/.test(sanitizeStyle(`a<b>"c'd\`e`)));

// ── 5. Battlefield assembly (§2/§5) ──────────────────────────────────────────
console.log('\nbattlefield');
{
  const mk = (n, side) => Array.from({ length: n }, (_, i) =>
    ({ id: `${side}${i}`, name: `${side}${i}`, side }));

  const html = buildBattlefieldHtml({
    enemies: mk(4, 'enemy'), players: mk(3, 'player'), maxPerRow: 3
  });
  ok('enemy area comes first (top of the field)',
     html.indexOf('vne-bf-area-enemy') < html.indexOf('vne-bf-area-player'));
  ok('VS separator between the formations', html.includes('vne-bf-vs'));
  eq('4 enemies + 3 players → 3 rows total',
     (html.match(/vne-bf-row/g) || []).length, 3);
  eq('all 7 combatants rendered',
     (html.match(/class="vne-bf-unit/g) || []).length, 7);
  ok('areas carry no border/box chrome in the markup',
     !/style="[^"]*border/.test(html));

  const oneSided = buildBattlefieldHtml({ enemies: mk(2, 'enemy'), players: [] });
  ok('no VS label when only one side is present', !oneSided.includes('<span>VS</span>'));

  const empty = buildBattlefieldHtml({ enemies: [], players: [], emptyLabel: 'Nobody' });
  ok('empty battlefield shows its hint', empty.includes('vne-bf-empty') && empty.includes('Nobody'));

  eq('formation rows wrap units, not the other way round',
     (buildFormationHtml(mk(5, 'enemy'), { maxPerRow: 3 }).match(/vne-bf-row/g) || []).length, 2);
}

// ── 5b. Manual placement (GM drag) ───────────────────────────────────────────
console.log('\nmanual placement');
{
  const mk = (n, side, extra = () => ({})) => Array.from({ length: n }, (_, i) =>
    ({ id: `${side}${i}`, name: `${side}${i}`, side, ...extra(i) }));

  ok('a unit without coordinates stays in the formation', !isPlaced({ id: 'a' }));
  ok('a unit with coordinates is pinned', isPlaced({ id: 'a', x: 0.5, y: 0.5 }));
  ok('half a coordinate is not a placement', !isPlaced({ id: 'a', x: 0.5 }));

  const { flow, placed } = splitPlaced([
    { id: 'a' }, { id: 'b', x: 0.2, y: 0.8 }, { id: 'c' }
  ]);
  eq('placed units leave the flow', flow.map(u => u.id), ['a', 'c']);
  eq('placed units are collected', placed.map(u => u.id), ['b']);

  eq('coordinates are clamped into the field', [clamp01(-3), clamp01(0.4), clamp01(9)], [0, 0.4, 1]);

  const html = buildBattlefieldHtml({
    enemies: mk(4, 'enemy', i => (i === 0 ? { x: 0.1, y: 0.2 } : {})),
    players: mk(3, 'player'),
    maxPerRow: 3
  });
  ok('a free layer holds the pinned combatants', html.includes('vne-bf-free'));
  ok('the pinned unit carries percentage coordinates',
     /vne-bf-placed[^>]*style="left:10\.000%;top:20\.000%;"/.test(html));
  // The whole point of pinning: the rest close ranks instead of leaving a hole.
  eq('3 remaining enemies collapse back to a single row',
     (html.match(/vne-bf-row/g) || []).length, 2);
  eq('nobody is lost when a unit is pinned',
     (html.match(/class="vne-bf-unit/g) || []).length, 7);

  const offField = buildUnitHtml({ id: 'x', x: -5, y: 40, canPlace: true });
  ok('out-of-range coordinates cannot park a unit off screen',
     /left:0\.000%;top:100\.000%;/.test(offField));
  ok('a pinned unit offers a way back to the formation',
     offField.includes('vne-bf-reset'));
  ok('players are never offered the placement controls',
     !buildUnitHtml({ id: 'x', x: 0.5, y: 0.5, canPlace: false }).includes('vne-bf-reset'));
  ok('unpinned units carry no reset button',
     !buildUnitHtml({ id: 'x', canPlace: true }).includes('vne-bf-reset'));
}

// ── 6. Wiring that fails silently if edited (structural) ─────────────────────
console.log('\nintegration wiring');
{
  const main = read('scripts/main.js');
  const tpl  = read('templates/vnMain.hbs');
  // Comments stripped: several of them quote the very values being asserted on
  // (e.g. "at bottom:80px it covered a portrait"), which would match first.
  const css  = read('styles/module.css').replace(/\/\*[\s\S]*?\*\//g, '');

  ok('main.js imports the formation module',
     /from ["']\.\/combat-formation\.js["']/.test(main));

  // The single most breakable link: damage floaters, hit shake, Sequencer/AA
  // screen FX and CSS projectiles all resolve their anchor here.
  const anchor = main.slice(main.indexOf('function _getPortraitContainer'),
                            main.indexOf('function _getPortraitScreenCenter'));
  ok('FX anchor lookup knows the battlefield', anchor.includes('.vne-bf-unit'));
  ok('battlefield anchor is tried BEFORE the hidden RP slot',
     anchor.indexOf('.vne-bf-unit') < anchor.indexOf('.vne-rp-slot'));

  ok('target highlight reaches the battlefield (§12)',
     /\.vne-bf-unit\[data-id\][\s\S]{0,220}vne-bf-targeted/.test(main));

  // Regression: the RP stage's offsets are absolute pixels tuned for a ~78vh
  // stage. Replaying them inside a battlefield cell translated the artwork out
  // of view and left names and HP bars floating over an empty field.
  // Comments stripped: the code there explains the offsets it deliberately drops.
  const unitData = main.slice(main.indexOf('function _bfUnitData'),
                              main.indexOf('function _patchBattlefield'))
    .replace(/\/\/[^\n]*/g, '');
  ok('battlefield does not replay the RP stage pixel offsets',
     !/translateY|translateX|worldOffsetY/.test(unitData));
  ok('battlefield still honours the portrait mirror',
     /mirrorX/.test(unitData) && /scaleX\(\$\{mirror\}\)/.test(unitData));
  ok('edit-mode preview uses the same mirror-only transform',
     !/bfImgEl[\s\S]{0,120}stageStyle/.test(main));

  // Regression: the GM controls every actor, so ownership must not drive colour.
  ok('ownership is not GM-wide', /isOwned:\s*!game\.user\.isGM &&/.test(main));
  ok('names never resolve to the theme accent (blood red under DD)',
     !/\.vne-bf-\w*\s*\.vne-bf-name\s*\{[^}]*var\(--vne-accent/.test(css));

  // Battlefield size is its own field: sharing the RP slider would mean
  // resizing for combat silently re-frames every roleplay scene.
  ok('battlefield size is a separate field from the RP scale',
     /bfScale/.test(main) && /_bindPortraitQuickCtrl\(unit, actorId, "bfScale"\)/.test(main));
  ok('resizing grows the character from its feet',
     /\.vne-bf-img\s*\{[^}]*transform-origin:\s*bottom center/.test(css));

  // Drag must not steal the click that targets a combatant.
  ok('drag is separated from click by a movement threshold',
     /BF_DRAG_THRESHOLD_PX/.test(main));
  ok('placement is GM-only', /canPlace:\s*game\.user\.isGM/.test(main));
  ok('positions are stored as fractions, never pixels',
     /bfX: pos\.x, bfY: pos\.y/.test(main) && !/bfX:\s*e\.clientX/.test(main));

  // The FAB sits at the height of the front rank under the option, so it only
  // moves there — the released position must be untouched by default.
  const bottomOf = (re) => Number(
    /bottom:\s*(\d+)px/.exec(re.exec(css)?.[1] ?? '')?.[1] ?? Number.NaN);
  const fabBase = bottomOf(/^#vne-toggle-fab\s*\{([^}]*)\}/m);
  const fabRpg  = bottomOf(/^body\.vne-rpg-style #vne-toggle-fab\s*\{([^}]*)\}/m);
  eq('classic: VN toggle keeps its released position', fabBase, 80);
  ok('option docks the VN toggle clear of the formation',
     Number.isFinite(fabRpg) && fabRpg <= 20, `bottom: ${fabRpg}px`);
  ok('option reserves the corner the FAB sits in',
     /body\.vne-rpg-style \.vne-combat-hud\s*\{[^}]*padding:[^;]*68px/.test(css));
  ok('combat mode renders the formation under the option',
     /else if \(_isRpgStyle\(\)\) _patchBattlefield\(d\)/.test(main));
  ok('HP updates patch bars in place, not by re-render',
     main.includes('_patchBattlefieldHP(actor.id)'));
  ok('formation reflows on viewport breakpoints',
     /perRow !== wasPerRow|perRow === wasPerRow/.test(main));

  // Role Mode must be untouched (§17).
  ok('Role Mode renderer still reachable',
     /if \(!d\.combatMode\)\s+_patchVNStage\(d, worldOffsetY\)/.test(main));
  ok('Role Mode slot markup intact', main.includes('vne-rp-slot') && main.includes('vne-rp-nameplate'));
  ok('Role Mode reactions intact', main.includes('vne-rp-reactions'));
  ok('Action Bubbles untouched — no bubble code in this module',
     !/bubble/i.test(main));

  // Template
  ok('battlefield lives inside the stage', tpl.includes('id="vne-battlefield"'));
  ok('combat controls keep their id (listeners bind by id)',
     tpl.includes('id="vne-combat-controls"'));
  ok('HUD wrapper present', tpl.includes('id="vne-combat-hud"'));
  ok('HUD has active + target slots',
     tpl.includes('id="vne-hud-active"') && tpl.includes('id="vne-hud-target"'));
  ok('RP stage element still in the template', tpl.includes('id="vne-rp-stage"'));

  // Layout rows must stay a complete 1..5 set or something lands on top of
  // something else.
  // Anchor on a rule whose selector starts the line, so a descendant selector
  // that merely *contains* the same text (e.g. ".vne-ui-collapsed .vne-top-bar")
  // is not mistaken for the base rule.
  const row = (sel) => {
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`^${esc}\\s*\\{([^}]*)\\}`, 'm').exec(css);
    if (!m) return null;
    const g = /grid-row:\s*(\d+)/.exec(m[1]);
    return g ? Number(g[1]) : null;
  };
  // CLASSIC (default) rows — the released arrangement, controls above the stage.
  eq('classic: top bar on row 1',       row('.vne-top-bar'), 1);
  eq('classic: carousel on row 2',      row('#vne-unified-carousel'), 2);
  eq('classic: combat controls on row 3', row('.vne-combat-hud'), 3);
  eq('classic: stage on row 4',         row('.vne-stage'), 4);
  eq('classic: bottom bar on row 5',    row('.vne-bottom-bar'), 5);
  ok('classic ui layer keeps the released five-row template',
     /grid-template-rows:\s*auto auto auto 1fr auto/.test(css));

  // RPG Classic Style swaps rows 3 and 4 so the HUD drops below the stage.
  ok('option moves the stage up to row 3',
     /body\.vne-rpg-style \.vne-stage\s*\{[^}]*grid-row:\s*3/.test(css));
  ok('option moves the HUD down to row 4',
     /body\.vne-rpg-style \.vne-combat-hud\s*\{[^}]*grid-row:\s*4/.test(css));
  ok('option re-flows the ui layer so the stage is the flexible row',
     /body\.vne-rpg-style \.vne-ui-layer\s*\{[^}]*grid-template-rows:\s*auto auto 1fr auto auto/.test(css));

  // HUD-only is the one exception: it has no battlefield, so it keeps the panels
  // and the three-column stage — hence the optional :not(.vne-hud-only).
  ok('side panels hidden in combat ONLY under the option (§2)',
     /body\.vne-rpg-style(:not\(\.vne-hud-only\))? #vne-main\.vne-combat-mode \.vne-side-panel\s*\{[^}]*display:\s*none/.test(css));
  ok('stage collapses to one column ONLY under the option',
     /body\.vne-rpg-style(:not\(\.vne-hud-only\))? #vne-main\.vne-combat-mode \.vne-stage[\s\S]{0,320}grid-template-columns:\s*1fr/.test(css));
  ok('battlefield cannot show without the option',
     /body:not\(\.vne-rpg-style\) \.vne-battlefield\s*\{[^}]*display:\s*none/.test(css));
  ok('HUD character/target blocks are hidden in the classic layout',
     /\.vne-combat-hud > \.vne-hud-slot\s*\{\s*display:\s*none/.test(css));
  ok('no visible grid: formation areas declare no border',
     !/\.vne-bf-(area|row)[^{]*\{[^}]*\bborder\s*:/.test(css));
  ok('battlefield art wrapper is a positioning context for FX overlays',
     /\.vne-bf-art\s*\{[^}]*position:\s*relative/.test(css));
  // flex-basis 0 is what guarantees a row can never be wider than the field.
  ok('units share the row width instead of overflowing it',
     /^\.vne-bf-unit\s*\{[^}]*flex:\s*1 1 0/m.test(css));

  // The duel overlays the battlefield, so under the option it must be opt-in —
  // but the released semantics of combatManualReveal survive without it.
  ok('duel is opt-in under the option',
     /_isRpgStyle\(\)\) return !d\.vsRevealed;/.test(main));
  ok('classic duel behaviour is preserved verbatim',
     /return game\.settings\.get\(ID, "combatManualReveal"\) && !d\.vsRevealed;/.test(main));
  ok('reveal button visibility is driven by the computed flag',
     /vne-vs-reveal-toggle[\s\S]{0,260}unless showVsReveal/.test(tpl));
  // HUD-only never shows the duel, so it masks the flag off entirely.
  ok('reveal flag is on under the option, or in manual mode',
     /showVsReveal:\s*(!hudOnly && \()?_isRpgStyle\(\) \|\| game\.settings\.get\(ID, "combatManualReveal"\)/.test(main));
}

// ── 8. The option itself ─────────────────────────────────────────────────────
// Everything the battlefield changes hangs off one switch, and OFF must be the
// released behaviour. These checks are the contract for that promise.
console.log('\nRPG Classic Style option');
{
  const settings = read('scripts/settings.js');
  const main     = read('scripts/main.js');

  ok('setting is registered', /register\(ID, "combatRpgStyle"/.test(settings));
  ok('setting is visible in the config UI',
     /"combatRpgStyle"[\s\S]{0,240}config:\s*true/.test(settings));
  ok('setting defaults to OFF so existing worlds are untouched',
     /"combatRpgStyle"[\s\S]{0,320}default:\s*false/.test(settings));
  ok('setting is world-scoped (one layout per table)',
     /"combatRpgStyle"[\s\S]{0,200}scope:\s*"world"/.test(settings));
  ok('flipping it rebuilds the open window',
     /"combatRpgStyle"[\s\S]{0,420}vnd-enhanced\.rerender/.test(settings));
  ok('body class drives every CSS branch',
     /applyRpgStyle[\s\S]{0,300}classList\.toggle\("vne-rpg-style"/.test(settings));
  ok('body class is applied on ready', /applyRpgStyle\(\);/.test(settings));
  ok('main.js reads the option through one helper',
     /function _isRpgStyle\(\)/.test(main));
  ok('helper survives being called before settings register',
     /_isRpgStyle[\s\S]{0,220}catch\s*\{/.test(main));

  const en = JSON.parse(read('language/en.json'))['vnd-enhanced'].settings;
  const es = JSON.parse(read('language/es.json'))['vnd-enhanced'].settings;
  ok('option is named and explained in en + es',
     !!en?.combatRpgStyle?.name && !!en?.combatRpgStyle?.hint &&
     !!es?.combatRpgStyle?.name && !!es?.combatRpgStyle?.hint);
}

// ── 7. i18n coverage ─────────────────────────────────────────────────────────
console.log('\ni18n');
{
  const en = JSON.parse(read('language/en.json'))['vnd-enhanced'];
  const es = JSON.parse(read('language/es.json'))['vnd-enhanced'];
  const needed = [['ui', 'battlefieldEmpty'], ['combat', 'hudActive'],
                  ['combat', 'hudTarget'],    ['combat', 'hudNoTarget'],
                  ['combat', 'bfResetPos']];
  for (const [group, key] of needed) {
    ok(`${group}.${key} present in en + es`,
       typeof en?.[group]?.[key] === 'string' && typeof es?.[group]?.[key] === 'string');
  }
}

console.log(`\n${failures ? 'FAILED' : 'PASSED'} — ${checks - failures}/${checks} checks`);
process.exit(failures ? 1 : 0);
