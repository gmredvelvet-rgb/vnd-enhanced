/**
 * Regression check for voice-activity portraits.
 *
 * Two layers, same shape as verify-combat-formation.mjs:
 *   1. Behavioural — stubs the handful of globals scripts/voice-activity.js
 *      touches (game / document / window / navigator) and drives the real
 *      module: payload validation, loudness clamping, painting, the re-apply
 *      after a rebuild, push-to-talk, and the auto-spotlight debounce.
 *   2. Structural  — greps main.js / settings.js / the stylesheet / both
 *      language files for the wiring points that fail SILENTLY if someone
 *      edits them later: the socket branch, the two re-apply calls, the
 *      injected spotlight hooks, and the rule that the bob animation must
 *      never land on the <img> elements that carry an inline transform.
 *
 * Run:  node tools/verify-voice-activity.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

let failures = 0;
let checks = 0;
function check(label, cond) {
  checks++;
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label}`); }
}
function section(name) { console.log(`\n${name}`); }

/* ==========================================================================
 *  Stubs
 * ======================================================================= */

// Minimal element: only what _paint() actually touches.
class StubEl {
  constructor(actorId, cls) {
    this.dataset = { id: actorId };
    this._cls = new Set([cls]);
    this._props = new Map();
    this.classList = {
      toggle: (c, on) => { on ? this._cls.add(c) : this._cls.delete(c); },
      contains: (c) => this._cls.has(c)
    };
    this.style = {
      setProperty: (k, v) => this._props.set(k, v),
      removeProperty: (k) => this._props.delete(k),
      getPropertyValue: (k) => this._props.get(k) ?? ''
    };
  }
  get lift() { return this._props.get('--vne-voice-lift') ?? ''; }
  get on() { return this._cls.has('vne-voice-on'); }
}

// actorId → [slot, castPortrait]
let DOM = new Map();
function seedDom(...actorIds) {
  DOM = new Map();
  for (const id of actorIds) DOM.set(id, [new StubEl(id, 'vne-rp-slot'), new StubEl(id, 'vne-cast-portrait')]);
}

globalThis.document = {
  // The module only ever queries by [data-id="…"]; pulling the id back out of
  // the selector is enough to stand in for a real query engine.
  querySelectorAll(sel) {
    const m = /data-id="([^"]*)"/.exec(sel);
    return m ? (DOM.get(m[1]) ?? []) : [];
  }
};

// Captured timers, fired by hand so the debounces are testable without waiting.
let TIMERS = [];
globalThis.setTimeout = (fn, ms) => { TIMERS.push({ fn, ms }); return TIMERS.length; };
globalThis.clearTimeout = (h) => { if (h) TIMERS[h - 1] = null; };
function fireTimers() {
  const pending = TIMERS.filter(Boolean);
  TIMERS = [];
  for (const t of pending) t.fn();
}

globalThis.window = { setInterval: () => 1, clearInterval: () => {}, addEventListener: () => {} };
// Node 24 exposes a read-only `navigator`; redefine it so the module sees no
// mediaDevices, i.e. the insecure-origin path it would meet over plain http.
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
globalThis.ui = { notifications: { warn: () => {} } };

// The module registers its disconnect sweep here; the harness fires it by hand.
const HOOKS = new Map();
globalThis.Hooks = { on: (name, fn) => HOOKS.set(name, fn) };

const SETTINGS = new Map();
let EMITTED = [];
const KNOWN_ACTORS = new Set(['actor-a', 'actor-b']);

globalThis.game = {
  settings: {
    get: (_id, key) => {
      if (!SETTINGS.has(key)) throw new Error(`unregistered setting ${key}`);
      return SETTINGS.get(key);
    }
  },
  actors: { get: (id) => (KNOWN_ACTORS.has(id) ? { id } : undefined) },
  user: { id: 'user-1', character: null },
  socket: { emit: (_chan, payload) => EMITTED.push(payload) },
  i18n: { localize: (k) => k }
};
globalThis.canvas = { tokens: { controlled: [] } };

function resetSettings() {
  SETTINGS.clear();
  SETTINGS.set('voiceActivityEnabled', true);
  SETTINGS.set('voiceAutoSpotlight', false);
  SETTINGS.set('voiceInputMode', 'ptt');
  SETTINGS.set('voiceThreshold', -45);
  SETTINGS.set('voiceActorId', '');
  EMITTED = [];
  TIMERS = [];
  game.user.character = null;
  canvas.tokens.controlled = [];
}
resetSettings();

const { handleVoiceSocket, reapplyVoiceState, setPushToTalk, initVoiceActivity, applyVoiceMode } =
  await import('../scripts/voice-activity.js');

// The module keeps live state (its own speaking flag, the speaker list) that a
// settings reset does not touch — same as a real session. Blocks that care must
// hand it back deliberately.
function silenceAll() {
  setPushToTalk(false);
  for (const id of KNOWN_ACTORS) handleVoiceSocket({ actorId: id, speaking: false, level: 0 });
  EMITTED = [];
  TIMERS = [];
}

/* ==========================================================================
 *  1. Behavioural
 * ======================================================================= */

section('Payload validation');
{
  resetSettings();
  seedDom('actor-a');
  handleVoiceSocket({ type: 'vnSpeaking', actorId: 'actor-a', speaking: true, level: 2 });
  check('a valid payload lights the portrait', DOM.get('actor-a')[0].on);

  handleVoiceSocket({ type: 'vnSpeaking', actorId: 'actor-a', speaking: false, level: 0 });
  check('speaking:false clears the class', !DOM.get('actor-a')[0].on);
  check('speaking:false clears the lift property', DOM.get('actor-a')[0].lift === '');

  // Unknown ids never reach a selector — the injection guard.
  seedDom('actor-a');
  handleVoiceSocket({ actorId: 'nope"], [data-id="actor-a', speaking: true, level: 1 });
  check('an unknown actor id is refused', !DOM.get('actor-a')[0].on);
  handleVoiceSocket({ actorId: 42, speaking: true, level: 1 });
  check('a non-string actor id is refused', !DOM.get('actor-a')[0].on);

  SETTINGS.set('voiceActivityEnabled', false);
  handleVoiceSocket({ actorId: 'actor-a', speaking: true, level: 1 });
  check('nothing paints while the world setting is off', !DOM.get('actor-a')[0].on);
}

section('Loudness buckets');
{
  resetSettings();
  seedDom('actor-a');
  const slot = () => DOM.get('actor-a')[0];

  handleVoiceSocket({ actorId: 'actor-a', speaking: true, level: 1 });
  const quiet = slot().lift;
  handleVoiceSocket({ actorId: 'actor-a', speaking: true, level: 3 });
  const loud = slot().lift;
  check('a louder bucket lifts the portrait further', parseFloat(loud) > parseFloat(quiet));

  handleVoiceSocket({ actorId: 'actor-a', speaking: true, level: 99 });
  check('an out-of-range level is clamped to the top bucket', slot().lift === loud);

  handleVoiceSocket({ actorId: 'actor-a', speaking: true, level: NaN });
  check('a non-finite level still paints (falls back to 1)', slot().on);
}

section('Re-apply after a rebuild');
{
  resetSettings();
  seedDom('actor-a', 'actor-b');
  handleVoiceSocket({ actorId: 'actor-a', speaking: true, level: 2 });
  check('actor-a is lit before the rebuild', DOM.get('actor-a')[0].on);

  seedDom('actor-a', 'actor-b');            // stands in for innerHTML = …
  check('the rebuild cleared the class', !DOM.get('actor-a')[0].on);
  reapplyVoiceState();
  check('re-apply restores the speaker', DOM.get('actor-a')[0].on);
  check('re-apply restores the cast portrait too', DOM.get('actor-a')[1].on);
  check('re-apply leaves silent actors alone', !DOM.get('actor-b')[0].on);

  handleVoiceSocket({ actorId: 'actor-a', speaking: false, level: 0 });
  seedDom('actor-a');
  reapplyVoiceState();
  check('a speaker who stopped is not resurrected by a later rebuild', !DOM.get('actor-a')[0].on);
}

section('Push-to-talk and actor resolution');
{
  resetSettings();
  seedDom('actor-a', 'actor-b');
  SETTINGS.set('voiceInputMode', 'off');
  setPushToTalk(true);
  check('push-to-talk is inert while the input mode is off', EMITTED.length === 0);

  resetSettings();
  silenceAll();
  SETTINGS.set('voiceInputMode', 'ptt');
  game.user.character = { id: 'actor-a' };
  setPushToTalk(true);
  check('the held key broadcasts speaking', EMITTED.at(-1)?.speaking === true);
  check('it resolves the assigned character', EMITTED.at(-1)?.actorId === 'actor-a');
  setPushToTalk(false);
  check('releasing the key broadcasts silence', EMITTED.at(-1)?.speaking === false);

  // Selected token stands in when the user voices nobody by default — the GM case.
  resetSettings();
  silenceAll();
  SETTINGS.set('voiceInputMode', 'ptt');
  canvas.tokens.controlled = [{ actor: { id: 'actor-b' } }];
  setPushToTalk(true);
  check('with no assigned character it uses the selected token', EMITTED.at(-1)?.actorId === 'actor-b');

  // An explicit override outranks both.
  resetSettings();
  silenceAll();
  SETTINGS.set('voiceInputMode', 'ptt');
  SETTINGS.set('voiceActorId', 'actor-a');
  game.user.character = { id: 'actor-b' };
  setPushToTalk(true);
  check('the override outranks the assigned character', EMITTED.at(-1)?.actorId === 'actor-a');

  resetSettings();
  silenceAll();
  SETTINGS.set('voiceInputMode', 'ptt');
  SETTINGS.set('voiceActorId', '  Actor.actor-b  ');
  setPushToTalk(true);
  check('the override accepts a pasted Document UUID', EMITTED.at(-1)?.actorId === 'actor-b');

  resetSettings();
  silenceAll();
  SETTINGS.set('voiceInputMode', 'ptt');
  SETTINGS.set('voiceActorId', 'ghost-actor');
  setPushToTalk(true);
  check('an override pointing at a deleted actor broadcasts nothing', EMITTED.length === 0);
}

section('Auto-spotlight');
{
  resetSettings();
  silenceAll();
  SETTINGS.set('voiceAutoSpotlight', true);
  seedDom('actor-a', 'actor-b');

  let spotlit = null;
  const hooks = {
    enterSpotlight: (id) => { spotlit = id; },
    exitSpotlight: () => { spotlit = null; },
    getSpotlightActorId: () => spotlit
  };
  initVoiceActivity(hooks);

  handleVoiceSocket({ actorId: 'actor-a', speaking: true, level: 2 });
  check('the spotlight does not jump before the debounce', spotlit === null);
  fireTimers();
  check('a sustained speaker takes the spotlight', spotlit === 'actor-a');

  handleVoiceSocket({ actorId: 'actor-a', speaking: false, level: 0 });
  fireTimers();
  check('silence releases the spotlight it set', spotlit === null);

  // A spotlight the GM placed by hand is never stolen.
  spotlit = 'actor-b';
  handleVoiceSocket({ actorId: 'actor-a', speaking: true, level: 2 });
  fireTimers();
  check('a manual spotlight is not stolen', spotlit === 'actor-b');

  handleVoiceSocket({ actorId: 'actor-a', speaking: false, level: 0 });
  fireTimers();
  check('nor is a manual spotlight released on silence', spotlit === 'actor-b');

  // With the option off the hooks are never called at all.
  resetSettings();
  SETTINGS.set('voiceAutoSpotlight', false);
  spotlit = null;
  handleVoiceSocket({ actorId: 'actor-a', speaking: true, level: 2 });
  fireTimers();
  check('the option off leaves the spotlight alone', spotlit === null);
}

section('Disconnect sweep');
{
  resetSettings();
  silenceAll();
  seedDom('actor-a', 'actor-b');
  initVoiceActivity({});
  const onUserConnected = HOOKS.get('userConnected');
  check('the module subscribes to userConnected', typeof onUserConnected === 'function');

  handleVoiceSocket({ actorId: 'actor-a', speaking: true, level: 2, senderId: 'user-2' });
  handleVoiceSocket({ actorId: 'actor-b', speaking: true, level: 2, senderId: 'user-3' });
  onUserConnected?.({ id: 'user-2' }, false);
  check('a dropped client stops bobbing', !DOM.get('actor-a')[0].on);
  check('other speakers are untouched', DOM.get('actor-b')[0].on);

  seedDom('actor-a', 'actor-b');
  reapplyVoiceState();
  check('the dropped speaker is not restored on the next rebuild', !DOM.get('actor-a')[0].on);
  check('the surviving speaker still is', DOM.get('actor-b')[0].on);

  onUserConnected?.({ id: 'user-3' }, true);
  check('a connecting client clears nothing', DOM.get('actor-b')[0].on);
}

section('Turning the feature off');
{
  resetSettings();
  silenceAll();
  seedDom('actor-a');
  handleVoiceSocket({ actorId: 'actor-a', speaking: true, level: 2 });
  SETTINGS.set('voiceActivityEnabled', false);
  applyVoiceMode();
  check('disabling the world setting clears live highlights', !DOM.get('actor-a')[0].on);
  seedDom('actor-a');
  reapplyVoiceState();
  check('and the speaker list was emptied', !DOM.get('actor-a')[0].on);
}

/* ==========================================================================
 *  2. Structural — wiring that fails silently
 * ======================================================================= */

section('Battlefield coverage');
{
  resetSettings();
  silenceAll();
  seedDom('actor-a');
  DOM.get('actor-a').push(new StubEl('actor-a', 'vne-bf-unit'));
  handleVoiceSocket({ actorId: 'actor-a', speaking: true, level: 2 });
  check('a battlefield unit lights up too', DOM.get('actor-a')[2].on);
  handleVoiceSocket({ actorId: 'actor-a', speaking: false, level: 0 });
  check('and goes dark again', !DOM.get('actor-a')[2].on);
}

section('Wiring in main.js');
{
  const main = read('scripts/main.js');
  check('imports the voice-activity entry points',
    /import \{[^}]*initVoiceActivity[^}]*handleVoiceSocket[^}]*reapplyVoiceState[^}]*setPushToTalk[^}]*\} from "\.\/voice-activity\.js"/.test(main));
  check('routes vnSpeaking on the socket', /msg\.type === "vnSpeaking"[\s\S]{0,120}handleVoiceSocket\(msg\)/.test(main));

  // The branch has to sit ABOVE the GM-only cutoff or players never see it.
  const speakingAt = main.indexOf('msg.type === "vnSpeaking"');
  const gmCutoffAt = main.indexOf('// All other message types are GM-side operations');
  check('the vnSpeaking branch precedes the GM-only cutoff',
    speakingAt > -1 && gmCutoffAt > -1 && speakingAt < gmCutoffAt);

  check('re-applies after the stage rebuild',
    /stage\.innerHTML = html;[\s\S]{0,160}reapplyVoiceState\(\)/.test(main));
  check('re-applies after the side panel rebuild',
    /panel\.appendChild\(indicator\);[\s\S]{0,120}reapplyVoiceState\(\)/.test(main));
  check('re-applies after the battlefield rebuild',
    /_bindBattlefieldUnit\);[\s\S]{0,120}reapplyVoiceState\(\)/.test(main));
  check('registers the push-to-talk keybinding',
    /keybindings\.register\(ID, "voicePushToTalk"[\s\S]{0,320}setPushToTalk\(false\)/.test(main));
  check('injects all three spotlight hooks',
    /initVoiceActivity\(\{[\s\S]{0,320}enterSpotlight[\s\S]{0,160}exitSpotlight[\s\S]{0,160}getSpotlightActorId/.test(main));
}

section('Wiring in settings.js');
{
  const st = read('scripts/settings.js');
  for (const key of ['voiceActivityEnabled', 'voiceAutoSpotlight', 'voiceInputMode', 'voiceThreshold', 'voiceActorId'])
    check(`registers ${key}`, st.includes(`game.settings.register(ID, "${key}"`));
  check('the world switch and the input mode both re-apply on change',
    (st.match(/onChange: applyVoiceMode/g) ?? []).length >= 2);
  check('the microphone setting is client-scoped',
    /"voiceInputMode"[\s\S]{0,200}scope: "client"/.test(st));
}

section('Stylesheet');
{
  const css = read('styles/module.css');
  check('defines the composed bob keyframes', /@keyframes vne-voice-bob/.test(css));
  check('carries the base scale through a custom property',
    /vne-voice-bob[\s\S]{0,260}scale\(var\(--vne-voice-scale\)\)/.test(css));
  check('re-declares the base scale for spotlight focus',
    /\.vne-spotlight-focus \{ --vne-voice-scale/.test(css));
  check('animates the slot, never the positioned <img>',
    !/\.vne-(rp|cast|bf)-img[^{]*\{[^}]*animation:\s*vne-voice-bob/.test(css));
  check('composes the battlefield anchor rather than replacing it',
    /@keyframes vne-voice-bob-bf[\s\S]{0,240}var\(--vne-voice-anchor\)/.test(css));
  check('keeps the pinned-unit anchor in the custom property',
    /\.vne-bf-placed \{ --vne-voice-anchor: translate\(-50%, -100%\)/.test(css));
  check('honours prefers-reduced-motion',
    /prefers-reduced-motion[\s\S]{0,200}animation: none/.test(css));
}

section('Localization');
{
  const keys = ['voiceActivityEnabled', 'voiceAutoSpotlight', 'voiceInputMode', 'voiceThreshold'];
  for (const lang of ['en', 'es']) {
    const json = JSON.parse(read(`language/${lang}.json`))['vnd-enhanced'];
    for (const k of keys)
      check(`${lang}: settings.${k} has name + hint`, !!json.settings?.[k]?.name && !!json.settings?.[k]?.hint);
    check(`${lang}: input mode lists all three choices`,
      ['off', 'mic', 'ptt'].every(c => !!json.settings?.voiceInputMode?.[c]));
    check(`${lang}: settings.voiceActorId has name + hint`,
      !!json.settings?.voiceActorId?.name && !!json.settings?.voiceActorId?.hint);
    check(`${lang}: keybinding label present`, !!json.keybindings?.voicePushToTalk);
    check(`${lang}: both microphone warnings present`,
      !!json.voice?.insecureContext && !!json.voice?.micDenied);
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
