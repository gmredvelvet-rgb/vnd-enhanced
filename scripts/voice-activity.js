/**
 * VND Enhanced – voice-activity.js
 *
 * "Who is talking right now" → the portrait moves and the stage focuses on them.
 *
 * Deliberately platform-agnostic: nothing here knows or cares about Discord.
 * Each client measures ONLY its own microphone, locally, and broadcasts a
 * boolean plus a coarse loudness bucket over the socket the module already
 * owns. No audio ever leaves the machine and no peer connection is negotiated,
 * which is why this keeps working in worlds where Foundry's own A/V never
 * connects — that needs WebRTC peers (and usually a TURN server), this needs
 * nothing but the websocket that is already open. Talk on Discord, Teamspeak or
 * into the void: if the microphone hears you, the portrait animates.
 *
 * Two capture modes, picked per client:
 *   mic  – microphone level with hysteresis. Requires a secure context
 *          (https:// or localhost). On plain http `navigator.mediaDevices` does
 *          not exist at all, so we say so and fall back to push-to-talk.
 *   ptt  – a held keybinding. Works on any origin, but only registers while the
 *          Foundry window holds keyboard focus (bind it to the same key as your
 *          Discord push-to-talk and it feels automatic).
 *
 * State is strictly ephemeral: speaking never touches world data or `saveData`.
 * It is a CSS class applied on arrival and re-applied after a stage re-render.
 */

const ID = "vnd-enhanced";
const T  = (key) => game.i18n.localize(`${ID}.${key}`);

// ── Tuning ────────────────────────────────────────────────────────────────────
const TICK_MS     = 50;    // microphone sampling cadence
const ATTACK_MS   = 90;    // sustained loudness before we call it speech
const RELEASE_MS  = 380;   // sustained silence before we call it over — long
                           // enough to ride through the gaps between words
const MIN_SEND_MS = 150;   // floor between level-only broadcasts
const SPOT_IN_MS  = 400;   // sustained speech before the auto-spotlight moves
const SPOT_OUT_MS = 1400;  // silence before the auto-spotlight releases

// ── Local capture state ───────────────────────────────────────────────────────
let _stream    = null;
let _ctx       = null;
let _analyser  = null;
let _samples   = null;
let _timer     = null;
let _speaking  = false;
let _level     = 0;
let _pttDown   = false;
let _aboveSince = 0;
let _belowSince = 0;
let _lastSentAt = 0;

// ── Remote state ──────────────────────────────────────────────────────────────
// actorId → { level, userId }, for every actor currently speaking anywhere.
// The owning user is kept so a client that drops off mid-sentence can be swept:
// nobody is left to send its speaking:false, and the portrait would otherwise
// bob for the rest of the session.
const _speakers = new Map();

// Callbacks handed in by main.js so this file never has to import back into it.
let _hooks = {};

// Auto-spotlight bookkeeping
let _autoSpotActor = null;
let _autoSpotTimer = null;

// ── Settings shortcuts ────────────────────────────────────────────────────────
// Every read is guarded: these can be called from hooks that fire before
// registerSettings() on a slow client.
function _get(key, fallback) {
  try { return game.settings.get(ID, key); }
  catch { return fallback; }
}
const _featureOn = () => _get("voiceActivityEnabled", false) === true;
const _mode      = () => _get("voiceInputMode", "off");

/* -------------------------------------------- */
/*  Who does my voice animate?                  */
/* -------------------------------------------- */

/**
 * Resolved locally by the speaker and sent with the broadcast, so receivers
 * never have to guess. Client-scope settings are not readable by other clients,
 * which makes local resolution the only workable place for this.
 * @returns {string|null} actor id, or null when this user voices nobody
 */
function _resolveVoiceActor() {
  // Accepts a bare id or an "Actor.xxxx" UUID: the sidebar's context menu only
  // offers "Copy Document UUID", so that is the form most people will paste.
  const raw = String(_get("voiceActorId", "") ?? "").trim();
  const override = raw.startsWith("Actor.") ? raw.slice(6) : raw;
  if (override && game.actors.get(override)) return override;
  if (game.user.character?.id) return game.user.character.id;
  // GM voicing an NPC: the token they have selected is who they are speaking as.
  return canvas?.tokens?.controlled?.[0]?.actor?.id ?? null;
}

/* -------------------------------------------- */
/*  Broadcast                                   */
/* -------------------------------------------- */

function _publish(speaking, level) {
  const changed = speaking !== _speaking;
  if (!changed && level === _level) return;
  const now = performance.now();
  if (!changed && (now - _lastSentAt) < MIN_SEND_MS) return;

  _speaking  = speaking;
  _level     = level;
  _lastSentAt = now;

  const actorId = _resolveVoiceActor();
  if (!actorId) return;

  const payload = { type: "vnSpeaking", actorId, speaking, level, senderId: game.user.id };
  game.socket.emit(`module.${ID}`, payload);
  handleVoiceSocket(payload);   // emit() does not loop back to the sender
}

/* -------------------------------------------- */
/*  Microphone capture                          */
/* -------------------------------------------- */

async function _startMic() {
  if (_stream) return true;

  // On an insecure origin the API is absent entirely — this is not a denied
  // permission, so there is no prompt to show and no point retrying.
  if (!navigator.mediaDevices?.getUserMedia) {
    ui.notifications?.warn(T("voice.insecureContext"));
    return false;
  }

  try {
    _stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false }
    });
  } catch (err) {
    console.warn(`${ID} | microphone unavailable:`, err);
    ui.notifications?.warn(T("voice.micDenied"));
    return false;
  }

  _ctx = new (window.AudioContext || window.webkitAudioContext)();
  // Autoplay policy can hand back a suspended context; toggling the setting is
  // itself a user gesture, so this normally resolves immediately.
  if (_ctx.state === "suspended") await _ctx.resume().catch(() => {});

  _analyser = _ctx.createAnalyser();
  _analyser.fftSize = 512;
  _analyser.smoothingTimeConstant = 0.2;
  // Source → analyser and nowhere else: never connected to the destination, so
  // the user does not hear themselves.
  _ctx.createMediaStreamSource(_stream).connect(_analyser);
  _samples = new Float32Array(_analyser.fftSize);

  // Note: a backgrounded browser TAB throttles this to ~1Hz. Another window on
  // top (Discord, typically) does not, which is the case that matters here.
  _timer = window.setInterval(_tick, TICK_MS);
  return true;
}

function _stopMic() {
  if (_timer) { window.clearInterval(_timer); _timer = null; }
  _stream?.getTracks().forEach(t => t.stop());
  _ctx?.close().catch(() => {});
  _stream = _ctx = _analyser = _samples = null;
  _aboveSince = _belowSince = 0;
  if (_speaking) _publish(false, 0);
}

function _tick() {
  if (!_analyser || _pttDown) return;   // push-to-talk overrides the meter

  _analyser.getFloatTimeDomainData(_samples);
  let sum = 0;
  for (let i = 0; i < _samples.length; i++) sum += _samples[i] * _samples[i];
  const rms = Math.sqrt(sum / _samples.length);
  const db  = rms > 0 ? 20 * Math.log10(rms) : -100;

  const threshold = Number(_get("voiceThreshold", -45));
  const now = performance.now();
  if (db >= threshold) { _belowSince = 0; if (!_aboveSince) _aboveSince = now; }
  else                 { _aboveSince = 0; if (!_belowSince) _belowSince = now; }

  let speaking = _speaking;
  if (!_speaking && _aboveSince && (now - _aboveSince) >= ATTACK_MS)  speaking = true;
  if (_speaking  && _belowSince && (now - _belowSince) >= RELEASE_MS) speaking = false;

  // Loudness bucket 1..3, measured over a 30 dB window above the threshold, so
  // shouting bobs the portrait harder than muttering.
  const level = speaking
    ? Math.max(1, Math.min(3, Math.ceil(((db - threshold) / 30) * 3)))
    : 0;
  _publish(speaking, level);
}

/* -------------------------------------------- */
/*  Push-to-talk                                */
/* -------------------------------------------- */

/** Bound to the keybinding registered in main.js. Held key wins over the meter. */
export function setPushToTalk(down) {
  if (!_featureOn() || _mode() === "off") return;
  _pttDown = down;
  if (down) _publish(true, 2);
  else {
    _aboveSince = _belowSince = 0;
    _publish(false, 0);   // the meter, if running, re-asserts on the next tick
  }
}

/* -------------------------------------------- */
/*  Receiving + painting                        */
/* -------------------------------------------- */

/**
 * Socket entry point, called by the router in main.js.
 *
 * SECURITY NOTE: like every other broadcast in this module, the payload is
 * client-supplied and cannot be authenticated without socketlib. The blast
 * radius is a portrait that bobs when it should not — nothing is persisted and
 * nothing is granted. The actor id is still validated against game.actors
 * before it reaches a selector, so a crafted id cannot escape into the query.
 */
export function handleVoiceSocket(msg) {
  if (!_featureOn()) return;
  const actorId = typeof msg?.actorId === "string" ? msg.actorId : null;
  if (!actorId || !game.actors.get(actorId)) return;

  const speaking = !!msg.speaking;
  const level = Number.isFinite(msg.level) ? Math.max(0, Math.min(3, Math.trunc(msg.level))) : 1;

  if (speaking) _speakers.set(actorId, { level, userId: msg.senderId ?? null });
  else          _speakers.delete(actorId);

  _paint(actorId, speaking, level);
  _updateAutoSpotlight();
}

/** Drops everything a user was voicing — used when that client disconnects. */
function _clearUser(userId) {
  let changed = false;
  for (const [actorId, entry] of [..._speakers]) {
    if (entry.userId !== userId) continue;
    _speakers.delete(actorId);
    _paint(actorId, false, 0);
    changed = true;
  }
  if (changed) _updateAutoSpotlight();
}

function _paint(actorId, speaking, level) {
  const nodes = document.querySelectorAll(
    `.vne-rp-slot[data-id="${actorId}"], .vne-cast-portrait[data-id="${actorId}"], ` +
    `.vne-bf-unit[data-id="${actorId}"]`
  );
  for (const el of nodes) {
    el.classList.toggle("vne-voice-on", speaking);
    if (speaking) el.style.setProperty("--vne-voice-lift", `${2 + level * 2.5}px`);
    else          el.style.removeProperty("--vne-voice-lift");
  }
}

/**
 * The stage is rebuilt with innerHTML on every patch, which wipes these classes
 * — same problem the spotlight overlay has. Called from _patchVNStage.
 */
export function reapplyVoiceState() {
  if (!_speakers.size) return;
  for (const [actorId, entry] of _speakers) _paint(actorId, true, entry.level);
}

/* -------------------------------------------- */
/*  Auto-spotlight                              */
/* -------------------------------------------- */

/**
 * Moves the existing Spotlight Mode to whoever is talking. Debounced in both
 * directions so a cough does not yank the stage around, and it never steals a
 * spotlight the GM placed by hand — it only releases one it set itself.
 */
function _updateAutoSpotlight() {
  if (_get("voiceAutoSpotlight", false) !== true) return;
  if (!_hooks.enterSpotlight || !_hooks.exitSpotlight || !_hooks.getSpotlightActorId) return;

  clearTimeout(_autoSpotTimer);
  const next = [..._speakers.keys()].pop() ?? null;

  if (next) {
    if (next === _autoSpotActor) return;
    _autoSpotTimer = setTimeout(() => {
      const current = _hooks.getSpotlightActorId();
      if (current && current !== _autoSpotActor) return;   // GM placed it by hand
      _autoSpotActor = next;
      _hooks.enterSpotlight(next);
    }, SPOT_IN_MS);
  } else {
    _autoSpotTimer = setTimeout(() => {
      if (_autoSpotActor && _hooks.getSpotlightActorId() === _autoSpotActor) _hooks.exitSpotlight();
      _autoSpotActor = null;
    }, SPOT_OUT_MS);
  }
}

/* -------------------------------------------- */
/*  Lifecycle                                   */
/* -------------------------------------------- */

/**
 * Starts or stops capture to match the current settings. Safe to call at any
 * time — it is the onChange handler for every setting the feature owns.
 */
export function applyVoiceMode() {
  const wanted = _featureOn() && _mode() === "mic";
  if (wanted) _startMic();
  else        _stopMic();

  if (!_featureOn()) {
    // Feature switched off world-wide: drop everyone's highlight locally.
    for (const actorId of [..._speakers.keys()]) _paint(actorId, false, 0);
    _speakers.clear();
  }
}

export function initVoiceActivity(hooks = {}) {
  _hooks = hooks;
  applyVoiceMode();
  // A client that vanishes mid-sentence never gets to send its speaking:false.
  globalThis.Hooks?.on("userConnected", (user, active) => { if (!active) _clearUser(user?.id); });
  // Release the microphone cleanly on reload rather than leaving the browser's
  // recording indicator lit until the tab dies.
  window.addEventListener("beforeunload", _stopMic, { once: true });
}
