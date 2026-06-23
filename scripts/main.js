/**
 * VND Enhanced – main.js
 *
 * Key design principles:
 *  1. Active / speaking character is always CENTER, LARGE, bright with nameplate
 *  2. Side characters are dimmed smaller portraits — click any to make them speak
 *  3. Scenes are switched via a quick thumbnail bar at the bottom
 *  4. Adding actors: click + button or drag actor from sidebar onto side panel
 *  5. Editing portraits: enter Edit Mode, right-click portrait
 */

import { registerSettings } from "./settings.js";
import { VndLicenseClient, VndLicenseUI } from "./license-client.js";
import { VNDAIGenerator } from "./ai-generator.js";

const ID = "vnd-enhanced";

// Per-client local hide — non-GM players close/open without affecting others
let _playerLocalHidden    = false;
let _playerLocalUIHidden  = false;

// ── VS Combat Display state ───────────────────────────────────────────────────
// Each side is updated permanently on two events: (a) their turn starts, (b) they are targeted.
// No timers — the most recent event always wins and persists until a new event overwrites it.
let _vsLeft  = null;  // { img, name, hp, hpMax } — PC shown on left (leftCast)
let _vsRight = null;  // { img, name, hp, hpMax } — NPC shown on right (rightCast)

// ── Turn timer state ─────────────────────────────────────────────────────────
let _timerInterval    = null;
let _timerSecondsLeft = 0;
let _timerEnabled     = false;
let _timerMinutes     = 2;
let _timerAutoReset   = false;   // if true, timer restarts automatically on each turn change
let _timerStartedAt   = 0;       // Date.now() at timer start — for drift-free countdown
let _timerDurationMs  = 0;       // total duration in ms

// ── Combat state ─────────────────────────────────────────────────────────────
let _lastCombatTurns = [];       // snapshot { actorId, defeated }[] for deleteCombat victory check
const _autoReactionTimers = new Map();  // actorId → debounce timeout handle

// ── Ghost Token Bridge state ──────────────────────────────────────────────────
// actorId → TokenDocument: hidden off-screen canvas tokens for VFX system compatibility
let _ghostTokens = new Map();

// ── Persona / Fire Emblem combat effects state ────────────────────────────────
const _lastKnownHP       = new Map();  // actorId → last observed HP value
const _nextHpChangeCrit  = new Set();  // actorIds whose next HP change was preceded by a crit roll
let _lastTurnChangeMs    = 0;          // timestamp of last turn change — used to suppress auto turn-start rolls
const _pendingFloaters   = new Map();  // actorId → { delta, isCrit, timerId } — delayed to allow PF2e raw-damage override
let   _lastTurnCardTimer      = null;  // setTimeout handle for auto-dismiss of turn card
let   _lastTurnCardInnerTimer = null;  // setTimeout handle for card fade-out (inner removal)

// Seed _lastKnownHP for all current cast members so the first delta is tracked correctly.
// Safe to call multiple times — only writes entries that don't already exist.
function _seedCastHP(d = getData()) {
  for (const p of [...(d.leftCast ?? []), ...(d.rightCast ?? [])]) {
    if (_lastKnownHP.has(p.id)) continue;
    const actor = game.actors?.get(p.id);
    const hp = actor?.system?.attributes?.hp?.value
            ?? actor?.system?.hp?.value
            ?? null;
    if (hp !== null) _lastKnownHP.set(p.id, hp);
  }
}

function _timerDisplayStr() {
  if (!_timerEnabled && _timerSecondsLeft === 0) return "--:--";
  const m = Math.floor(_timerSecondsLeft / 60);
  const s = _timerSecondsLeft % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function _patchTimerDisplay() {
  const el = document.getElementById("vne-timer-display");
  if (!el) return;
  el.textContent = _timerDisplayStr();
  el.classList.toggle("vne-timer-running", _timerEnabled);
  el.classList.toggle("vne-timer-low", _timerEnabled && _timerSecondsLeft <= 30);
}

function _stopTurnTimer() {
  if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
  _timerEnabled = false;
  _timerSecondsLeft = 0;
  _patchTimerDisplay();
  const btn = document.getElementById("vne-timer-toggle-btn");
  if (btn) { btn.classList.remove("vne-active"); btn.title = "Start turn timer"; const i = btn.querySelector("i"); if (i) i.className = "fas fa-hourglass-start"; }
}

function _patchTimerAutoBtn() {
  const btn = document.getElementById("vne-timer-auto-btn");
  if (!btn) return;
  btn.classList.toggle("vne-active", _timerAutoReset);
  btn.title = _timerAutoReset
    ? "Auto-reset ON — reinicia el timer en cada turno (click para desactivar)"
    : "Auto-reset OFF — el timer no se reinicia solo (click para activar)";
}

function _startTurnTimer(minutes) {
  _stopTurnTimer();
  _timerMinutes     = minutes;
  _timerDurationMs  = minutes * 60 * 1000;
  _timerStartedAt   = Date.now();
  _timerSecondsLeft = minutes * 60;
  _timerEnabled     = true;
  _patchTimerDisplay();
  const btn = document.getElementById("vne-timer-toggle-btn");
  if (btn) { btn.classList.add("vne-active"); btn.title = "Stop timer"; const i = btn.querySelector("i"); if (i) i.className = "fas fa-hourglass-half"; }
  // 250ms tick with Date.now() — immune to tab throttling drift
  let _timerLastDisplayedSecs = _timerSecondsLeft;
  _timerInterval = setInterval(() => {
    const elapsed = Date.now() - _timerStartedAt;
    _timerSecondsLeft = Math.max(0, Math.ceil((_timerDurationMs - elapsed) / 1000));
    if (_timerSecondsLeft !== _timerLastDisplayedSecs) {
      _timerLastDisplayedSecs = _timerSecondsLeft;
      _patchTimerDisplay();
    }
    if (_timerSecondsLeft === 0) {
      _stopTurnTimer();
      game.combat?.nextTurn().catch(() => {});
    }
  }, 250);
}

function _getRoundTier(round) {
  if (round >= 7) return 3;
  if (round >= 5) return 2;
  if (round >= 3) return 1;
  return 0;
}

function _patchCombatDisplay() {
  const combat = game.combat;
  const round   = combat?.round ?? 0;
  const name    = combat?.combatant?.name ?? "";
  const roundEl = document.getElementById("vne-round-num");
  const nameEl  = document.getElementById("vne-turn-name");
  if (roundEl) roundEl.textContent = round || "–";
  if (nameEl)  nameEl.textContent  = name;

  // Visual escalation by round tier
  const main = document.getElementById("vne-main");
  if (main) {
    main.classList.remove("vne-round-tier-1", "vne-round-tier-2", "vne-round-tier-3");
    const tier = _getRoundTier(round);
    if (tier > 0) main.classList.add(`vne-round-tier-${tier}`);
  }
}

// ── Data helpers ─────────────────────────────────────────────────────────────

function getData() {
  const d = foundry.utils.deepClone(game.settings.get(ID, "vnData"));
  if (!Array.isArray(d.stagePlayers))  d.stagePlayers  = [];
  if (!Array.isArray(d.stageNPCs))     d.stageNPCs     = [];
  if (!Array.isArray(d.leftCast))      d.leftCast      = [];
  if (!Array.isArray(d.rightCast))     d.rightCast     = [];
  if (!Array.isArray(d.locationList))  d.locationList  = [];
  if (d.portraits == null || typeof d.portraits !== "object") d.portraits = {};
  if (d.location  == null || typeof d.location  !== "object") d.location  = {
    id: "", name: "???", parent: "", backgroundImage: "", weather: "", time: ""
  };
  return d;
}

async function saveData(data, opts = {}) {
  if (!game.user.isGM) {
    // Non-GM clients must use specific socket messages (vnAddToStage, vnRemoveFromStage, vnReaction).
    // Direct data injection via saveData is not permitted for non-GM users.
    console.warn("VNE | saveData() called by non-GM — ignored. Use specific socket events.");
    return;
  }
  await game.settings.set(ID, "vnData", data, opts);
}

function defaultPortrait(actor) {
  if (!actor) return null;
  const actorImg = (actor.img && !actor.img.includes("mystery-man")) ? actor.img : null;
  const tokenImg = (actor.prototypeToken?.texture?.src && !actor.prototypeToken.texture.src.includes("mystery-man"))
    ? actor.prototypeToken.texture.src : null;
  const img = actorImg || tokenImg || "icons/svg/mystery-man.svg";
  return {
    id: actor.id,
    name: actor.name,
    title: "",
    img,
    scale: 100,
    offsetX: 0,
    offsetY: 0,
    mirrorX: false,
    reactions: { default: img },
    activeReaction: "default"
  };
}

function getPortraitImg(p) {
  if (p.reactions && p.activeReaction && p.reactions[p.activeReaction]) {
    return p.reactions[p.activeReaction];
  }
  if (p.reactions?.default) return p.reactions.default;
  return p.img;
}

function canControlActor(actorId) {
  if (game.user.isGM) return true;
  const actor = game.actors.get(actorId);
  return actor?.isOwner ?? false;
}

// Pre-process a portrait for the template (apply worldOffsetY, build style string)
function templatePortrait(p, side, stageActorIds, worldOffsetY, editMode, combatMode = false) {
  const scaleX = (side === "left" ? !p.mirrorX : p.mirrorX) ? 1 : -1;
  const scaleVal = (p.scale || 100) / 100;
  const oy = (p.offsetY || 0) - worldOffsetY;
  const ox = p.offsetX || 0;
  const isCombatTarget = side === "right" && combatMode;
  // Use actorId from the token document to support unlinked tokens
  const isTargeted = isCombatTarget
    ? [...(game.user.targets ?? [])].some(t => (t.document?.actorId ?? t.actorId ?? t.actor?.id) === p.id)
    : false;
  // "Your turn" indicator: active combatant AND owned by this client AND not GM (GM sees it for all)
  const isActiveCombatant = combatMode && stageActorIds instanceof Set && stageActorIds.has(p.id);
  const isYourTurn = isActiveCombatant && !game.user.isGM && canControlActor(p.id);
  return {
    ...p,
    img: getPortraitImg(p),
    isActive: stageActorIds instanceof Set ? stageActorIds.has(p.id) : false,
    isOwned: canControlActor(p.id),
    isCombatTarget,
    isTargeted,
    isYourTurn,
    imgStyle: `transform: scale(${scaleVal}) scaleX(${scaleX});`,
    editMode
  };
}

function isOnStage(actorId, d) {
  return (d.stagePlayers || []).includes(actorId) || (d.stageNPCs || []).includes(actorId);
}

async function addToStage(actorId) {
  if (!actorId) return;
  if (game.user.isGM) {
    const d = getData();
    if (isOnStage(actorId, d)) return;
    const inLeft  = d.leftCast.some(p => p.id === actorId);
    const inRight = d.rightCast.some(p => p.id === actorId);
    if (!inLeft && !inRight) return;
    if (inLeft  && d.stagePlayers.length < 5) d.stagePlayers.push(actorId);
    else if (inRight && d.stageNPCs.length < 5) d.stageNPCs.push(actorId);
    else { ui.notifications?.warn("VNE: Stage is full (max 5 per row)."); return; }
    await saveData(d, { change: "stageChange" });
  } else {
    const actor = game.actors.get(actorId);
    if (!actor?.isOwner) return;
    game.socket.emit(`module.${ID}`, { type: "vnAddToStage", actorId, senderId: game.user.id });
  }
}

async function removeFromStage(actorId) {
  if (!actorId) return;
  if (game.user.isGM) {
    const d = getData();
    const wasInPlayers = d.stagePlayers.includes(actorId);
    const wasInNPCs    = d.stageNPCs.includes(actorId);
    if (!wasInPlayers && !wasInNPCs) return;
    d.stagePlayers = d.stagePlayers.filter(id => id !== actorId);
    d.stageNPCs    = d.stageNPCs.filter(id => id !== actorId);
    await saveData(d, { change: "stageChange" });
  } else {
    const actor = game.actors.get(actorId);
    if (!actor?.isOwner) return;
    game.socket.emit(`module.${ID}`, { type: "vnRemoveFromStage", actorId, senderId: game.user.id });
  }
}

// ── Reaction helpers ──────────────────────────────────────────────────────────

function _applyReaction(d, actorId, reactionName) {
  for (const side of ["leftCast", "rightCast"]) {
    const p = d[side].find(x => x.id === actorId);
    if (p) p.activeReaction = reactionName;
  }
  if (d.portraits[actorId]) d.portraits[actorId].activeReaction = reactionName;
}

// Auto-reaction thresholds: keys checked in order for each tier
const _AUTO_REACTION_TIERS = [
  { maxPct: 0.25, keys: ["critical", "ko", "dying", "near_death"] },
  { maxPct: 0.50, keys: ["hurt",     "wounded", "injured", "damaged"] },
];

async function _applyAutoReaction(actorId) {
  if (!game.user.isGM) return;
  const d = getData();
  let portrait = null;
  for (const side of ["leftCast", "rightCast"]) {
    portrait = d[side].find(p => p.id === actorId);
    if (portrait) break;
  }
  if (!portrait) return;

  const actor = game.actors.get(actorId);
  const hp    = actor?.system?.attributes?.hp ?? actor?.system?.hp ?? null;
  if (!hp || !hp.max || hp.max <= 0) return;

  const pct       = Math.max(0, hp.value / hp.max);
  const reactions = portrait.reactions ?? { default: portrait.img };

  // Find which reaction key to use for current HP tier
  let targetKey = null;
  for (const tier of _AUTO_REACTION_TIERS) {
    if (pct <= tier.maxPct) {
      targetKey = tier.keys.find(k => reactions[k]);
      if (targetKey) break;
    }
  }

  // Fall back to default if above all thresholds or no matching key found
  const finalKey = targetKey ?? "default";
  if (!reactions[finalKey]) return;                       // key doesn't exist, skip
  if (portrait.activeReaction === finalKey) return;       // already set, no save needed

  _applyReaction(d, actorId, finalKey);
  await saveData(d, { change: "castChange" });
}

async function setReaction(actorId, reactionName) {
  if (game.user.isGM) {
    const d = getData();
    _applyReaction(d, actorId, reactionName);
    await saveData(d, { change: "castChange" });
  } else {
    const actor = game.actors.get(actorId);
    if (!actor?.isOwner) return;
    game.socket.emit(`module.${ID}`, { type: "vnReaction", actorId, reactionName, senderId: game.user.id });
  }
}

// ── Portrait quick-adjust helpers ─────────────────────────────────────────────

// Applies `changes` (scale, mirrorX, offsetX, offsetY…) to an actor's portrait
// across every cast list that contains it, then saves.
async function _quickAdjustPortrait(actorId, changes) {
  if (!game.user.isGM) return;
  const d = getData();
  let found = false;
  for (const key of ["leftCast", "rightCast", "rpCast"]) {
    const idx = (d[key] || []).findIndex(p => p.id === actorId);
    if (idx >= 0) { Object.assign(d[key][idx], changes); found = true; }
  }
  if (!found) return;
  const p = d.leftCast.find(x => x.id === actorId)
          || d.rightCast.find(x => x.id === actorId)
          || (d.rpCast || []).find(x => x.id === actorId);
  if (p) d.portraits[actorId] = { ...p };
  await saveData(d, { change: "castChange" });
}

// Returns the HTML string for the inline quick-control toolbar.
function _portraitQuickCtrlHtml() {
  return `<div class="vne-portrait-quick-ctrl">
    <div class="vne-portrait-qbtn" data-action="scale-down" title="Shrink (−10%)"><i class="fas fa-search-minus"></i></div>
    <div class="vne-portrait-qbtn" data-action="mirror"     title="Voltear izq/der"><i class="fas fa-arrows-alt-h"></i></div>
    <div class="vne-portrait-qbtn" data-action="scale-up"   title="Enlarge (+10%)"><i class="fas fa-search-plus"></i></div>
  </div>`;
}

// Binds click events on the quick-ctrl buttons inside `container` for `actorId`.
function _bindPortraitQuickCtrl(container, actorId) {
  container.querySelectorAll(".vne-portrait-qbtn").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (!game.user.isGM) return;
      const d = getData();
      const p = d.leftCast.find(x => x.id === actorId)
              || d.rightCast.find(x => x.id === actorId)
              || (d.rpCast || []).find(x => x.id === actorId);
      if (!p) return;
      const action = btn.dataset.action;
      if      (action === "scale-up")   await _quickAdjustPortrait(actorId, { scale: Math.min(300, (p.scale || 100) + 10) });
      else if (action === "scale-down") await _quickAdjustPortrait(actorId, { scale: Math.max(20,  (p.scale || 100) - 10) });
      else if (action === "mirror")     await _quickAdjustPortrait(actorId, { mirrorX: !p.mirrorX });
    });
  });
}

// setSpeaker kept as thin backward-compat wrapper → addToStage/removeFromStage
async function setSpeaker(actorId) {
  if (!actorId) return;
  const d = getData();
  if (isOnStage(actorId, d)) await removeFromStage(actorId);
  else await addToStage(actorId);
}

// ── Combat Stage helpers ──────────────────────────────────────────────────────

function targetActorToken(actorId) {
  // Ghost tokens exist only for Sequencer/AA VFX routing — PF2e damage targeting
  // requires the real map token. Prefer real tokens; ghost is last resort only.
  let token = canvas.tokens?.placeables?.find(
    t => (t.document?.actorId ?? t.actor?.id) === actorId
      && !t.document?.flags?.[ID]?.isGhost
  ) ?? null;

  if (!token) {
    const d = getData();
    if (d.showVN && d.combatMode) {
      const ghostDoc = _ghostTokens.get(actorId);
      if (ghostDoc?.id) token = canvas.tokens?.get(ghostDoc.id) ?? null;
      if (!token) {
        token = canvas.tokens?.placeables?.find(
          t => t.document?.flags?.[ID]?.isGhost && t.document?.actorId === actorId
        ) ?? null;
      }
    }
  }

  if (!token) {
    ui.notifications?.warn("VNE: No token found on this scene for that actor.");
    return;
  }

  const alreadyTargeted = [...(game.user.targets ?? [])].some(t => t.id === token.id);
  token.setTarget(!alreadyTargeted, { user: game.user, releaseOthers: false });
}

function getVNECastTokens(d = getData()) {
  const actorIds = new Set([
    ...(d.leftCast ?? []), ...(d.rightCast ?? [])
  ].map(p => p.id));
  return (canvas.tokens?.placeables ?? []).filter(t => {
    if (!actorIds.has(t.document?.actorId ?? t.actor?.id)) return false;
    // Exclude ghost tokens created by VNE — they exist for VFX only and must not enter the combat tracker
    if (t.document?.flags?.[ID]?.isGhost) return false;
    return true;
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// GHOST TOKEN MANAGER — CAPA 1
// Hidden off-screen canvas tokens that give Sequencer, AA, and PF2E real
// TokenDocument objects to attach effects to while visuals render on HTML portraits.
// ═══════════════════════════════════════════════════════════════════════════════

async function _createGhostToken(actorId) {
  if (!game.user.isGM) return null;
  if (_ghostTokens.has(actorId)) return _ghostTokens.get(actorId);

  const actor = game.actors.get(actorId);
  if (!actor || !canvas.scene) return null;

  // Stack ghost tokens at the bottom-right corner of the scene (inside canvas bounds).
  // NOT hidden — hidden tokens are not accessible on player clients so Sequencer
  // can't resolve their position. alpha:0.001 makes them effectively invisible
  // while remaining in canvas.tokens for all clients (Sequencer needs this).
  const gridSize  = canvas.scene.grid?.size ?? 100;
  const sceneW    = canvas.scene.width  ?? 4000;
  const sceneH    = canvas.scene.height ?? 3000;
  const x = Math.max(0, sceneW - gridSize * 2 - (_ghostTokens.size * gridSize));
  const y = Math.max(0, sceneH - gridSize * 2);

  const tokenData = actor.prototypeToken?.toObject?.() ?? {};
  const createData = {
    ...tokenData,
    actorId,
    actorLink: true,
    hidden: false,
    alpha: 0.001,         // Practically invisible without being "hidden"
    vision: false,        // Don't affect Fog of War (v11)
    sight: { enabled: false }, // Don't affect Fog of War (v12+)
    x,
    y,
    name: actor.name,
    flags: { [ID]: { isGhost: true } },
  };

  try {
    const [doc] = await canvas.scene.createEmbeddedDocuments("Token", [createData]);
    if (doc) _ghostTokens.set(actorId, doc);
    return doc ?? null;
  } catch (e) {
    console.warn("VNE | Ghost token creation failed:", e);
    return null;
  }
}

async function _destroyGhostTokens() {
  if (!game.user.isGM || !_ghostTokens.size) return;
  const ids = [];
  for (const doc of _ghostTokens.values()) {
    if (doc?.id) ids.push(doc.id);
  }
  _ghostTokens.clear();
  if (ids.length && canvas.scene) {
    try {
      await canvas.scene.deleteEmbeddedDocuments("Token", ids);
    } catch (e) {
      console.warn("VNE | Ghost token cleanup failed:", e);
    }
  }
}

// Returns the TokenDocument for actorId's ghost token (or null).
function getGhostTokenDoc(actorId) {
  return _ghostTokens.get(actorId) ?? null;
}

// Returns the live PlaceableObject (canvas token) for actorId's ghost token (or null).
function getGhostTokenObject(actorId) {
  const doc = _ghostTokens.get(actorId);
  if (!doc?.id) return null;
  return canvas.tokens?.get(doc.id) ?? null;
}

// Reconciles the ghost token set with the current VN cast: removes stale entries,
// creates missing ones. Safe to call multiple times.
async function _syncGhostTokens(d) {
  if (!game.user.isGM) return;
  const allIds = [
    ...(d.leftCast ?? []), ...(d.rightCast ?? [])
  ].map(p => p.id);

  // Delete ghosts for actors no longer in cast
  for (const [actorId, doc] of [..._ghostTokens.entries()]) {
    if (!allIds.includes(actorId)) {
      _ghostTokens.delete(actorId);
      if (doc?.id && canvas.scene) {
        try { await canvas.scene.deleteEmbeddedDocuments("Token", [doc.id]); } catch { /* ignore */ }
      }
    }
  }

  // Create ghosts for any cast member that doesn't have one yet
  for (const actorId of allIds) {
    if (!_ghostTokens.has(actorId)) {
      await _createGhostToken(actorId);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PORTRAIT SCREEN HELPERS — CAPA 2
// Convert portrait DOM elements to absolute screen-pixel coordinates used by
// Sequencer's screenSpaceAboveUI() and the CSS projectile system.
// ═══════════════════════════════════════════════════════════════════════════════

function _getPortraitContainer(actorId) {
  // Prefer the big stage portrait over the small panel card
  return document.querySelector(`.vne-rp-slot[data-id="${actorId}"]`)
      ?? document.querySelector(`.vne-cast-portrait[data-id="${actorId}"]`)
      ?? null;
}

// Returns { x, y, width, height } in screen pixels (viewport-absolute), or null.
function _getPortraitScreenCenter(actorId) {
  const el = _getPortraitContainer(actorId);
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  return {
    x:      rect.left + rect.width  / 2,
    y:      rect.top  + rect.height / 2,
    width:  rect.width,
    height: rect.height,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCREEN-SPACE VFX SYSTEM — CAPA 2
// Renders Sequencer effects above all Foundry UI at portrait pixel positions,
// and provides a CSS projectile path for source→target animations.
// ═══════════════════════════════════════════════════════════════════════════════

function _playVNEScreenEffect(actorId, file, { durationMs = 2000, scale = 1.5 } = {}) {
  if (typeof durationMs !== "number" || !isFinite(durationMs) || durationMs <= 0) durationMs = 2000;
  if (!game.modules.get("sequencer")?.active) {
    _playVNFx(actorId, file, durationMs, getData());
    return;
  }

  const pos = _getPortraitScreenCenter(actorId);
  if (!pos) return;

  try {
    new Sequence()
      .effect()
        .file(file)
        .screenSpaceAboveUI()
        .screenSpaceAnchor({ x: 0, y: 0 })
        .screenSpacePosition({ x: pos.x, y: pos.y })
        .scale(scale)
        .duration(durationMs)
        .fadeIn(200)
        .fadeOut(300)
      .play();
  } catch (e) {
    console.warn("VNE | Screen-space VFX failed, falling back to HTML overlay:", e);
    _playVNFx(actorId, file, durationMs, getData());
  }
}

// Animates a video element from sourcePos to targetPos via CSS transition.
// Used for projectile effects between two portrait positions.
function _renderProjectileCSS(sourcePos, targetPos, file, { durationMs = 800 } = {}) {
  const vid = document.createElement("video");
  vid.src         = file;
  vid.autoplay    = true;
  vid.muted       = true;
  vid.loop        = false;
  vid.playsInline = true;

  // Inline style: fixed position, starts at source, z-index above all Foundry UI
  Object.assign(vid.style, {
    position:       "fixed",
    left:           `${sourcePos.x}px`,
    top:            `${sourcePos.y}px`,
    transform:      "translate(-50%, -50%)",
    width:          "96px",
    height:         "96px",
    objectFit:      "contain",
    zIndex:         String(1e13),
    pointerEvents:  "none",
    transition:     `left ${durationMs}ms linear, top ${durationMs}ms linear`,
  });

  document.body.appendChild(vid);

  // Defer target position so the browser registers the starting position first
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      vid.style.left = `${targetPos.x}px`;
      vid.style.top  = `${targetPos.y}px`;
    });
  });

  setTimeout(() => vid.remove(), durationMs + 600);
}

function getCollectionArray(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (collection.contents) return collection.contents;
  return [...collection];
}

async function ensureActiveEncounterForVNE() {
  if (!game.user.isGM) return game.combat ?? null;
  const scene = canvas.scene ?? game.scenes?.current;
  if (!scene) return game.combat ?? null;

  let combat = game.combat;
  if (!combat || combat.scene?.id !== scene.id) {
    combat = getCollectionArray(game.combats).find(c => c.scene?.id === scene.id) ?? null;
  }
  if (!combat) {
    try {
      combat = await Combat.create({ scene: scene.id, active: true });
    } catch (e) {
      console.error("VNE | Failed to create combat encounter:", e);
      ui.notifications?.error("VNE: Could not create combat encounter.");
      return null;
    }
  } else if (!combat.active) {
    try {
      await combat.update({ active: true });
    } catch (e) {
      console.warn("VNE | Failed to activate combat:", e);
    }
  }

  const castTokens = getVNECastTokens();
  if (!castTokens.length) {
    ui.notifications?.warn("Combat Stage is active, but no VN cast tokens were found on this scene.");
    return combat;
  }

  const existingTokenIds = new Set(getCollectionArray(combat.combatants).map(c => c.tokenId));
  const combatants = castTokens
    .filter(t => !existingTokenIds.has(t.document?.id ?? t.id))
    .map(t => ({
      tokenId: t.document?.id ?? t.id,
      sceneId: scene.id,
      actorId: t.document?.actorId ?? t.actor?.id,
      hidden: t.document?.hidden ?? false
    }));
  if (combatants.length) {
    try {
      await combat.createEmbeddedDocuments("Combatant", combatants);
    } catch (e) {
      console.warn("VNE | Failed to add combatants:", e);
    }
  }
  return combat;
}

async function toggleHideUI() {
  if (!game.user.isGM) {
    _playerLocalUIHidden = !_playerLocalUIHidden;
    document.getElementById("vne-ui-layer")?.classList.toggle("vne-ui-collapsed", _playerLocalUIHidden);
    return;
  }
  const d = getData();
  d.hideUI = !d.hideUI;
  await saveData(d, { change: "hideUI" });
}

// Sidebar lift strategy:
//   1. Move #sidebar to document.body so it escapes #interface's stacking context.
//   2. Force position:fixed so it's not pushed off-screen by body's flex layout.
//   3. Expand content so it's immediately visible.
// Inline styles survive Foundry's re-renders of the sidebar's *content* because
// Foundry only updates innerHTML, not the element's own style attribute.
let _sidebarOriginalParent  = null;
let _sidebarOriginalNextSib = null;
const _sideScrollOffset = { left: 0, right: 0 };

function _mountSidebar() {
  const sidebar = document.getElementById("sidebar");
  if (!sidebar) return;
  const zIndex = (game.settings.get(ID, "zIndex") || 90) + 5;
  if (sidebar.parentElement !== document.body) {
    _sidebarOriginalParent  = sidebar.parentElement;
    _sidebarOriginalNextSib = sidebar.nextElementSibling;
    document.body.appendChild(sidebar);
  }
  // body.game is display:flex — without position:fixed sidebar would be pushed off-screen.
  sidebar.style.setProperty("position", "fixed",    "important");
  sidebar.style.setProperty("right",    "0",         "important");
  sidebar.style.setProperty("top",      "0",         "important");
  sidebar.style.setProperty("height",   "100%",      "important");
  sidebar.style.setProperty("z-index",  `${zIndex}`, "important");
  // Expand content so the panel is visible right away
  ui.sidebar?.expand?.();
}

function _unmountSidebar() {
  const sidebar = document.getElementById("sidebar");
  if (!sidebar) return;
  sidebar.style.removeProperty("position");
  sidebar.style.removeProperty("right");
  sidebar.style.removeProperty("top");
  sidebar.style.removeProperty("height");
  sidebar.style.removeProperty("z-index");
  if (_sidebarOriginalParent) {
    _sidebarOriginalParent.insertBefore(sidebar, _sidebarOriginalNextSib);
    _sidebarOriginalParent  = null;
    _sidebarOriginalNextSib = null;
  }
}

function _toggleFoundrySidebar() {
  if (!ui.sidebar) return;
  // v12: ui.sidebar._collapsed (boolean); v13: ui.sidebar.expanded (boolean, inverted logic)
  const isOpen = ui.sidebar.expanded ?? !ui.sidebar._collapsed ?? true;
  if (isOpen) ui.sidebar.collapse();
  else ui.sidebar.expand();
}

async function toggleCombatStage() {
  if (!game.user.isGM) return;
  const d = getData();
  d.combatMode = !d.combatMode;
  if (d.combatMode) {
    const combat = await ensureActiveEncounterForVNE();
    if (!combat) {
      d.combatMode = false;
      ui.notifications?.warn("VNE: Could not activate Combat Stage — encounter creation failed.");
      return;
    }
    await _syncGhostTokens(d);
  } else {
    await _destroyGhostTokens();
  }
  await saveData(d, { change: "combatMode" });
}

function openActorSheet(actorId) {
  const actor = game.actors.get(actorId);
  if (!actor) {
    ui.notifications?.warn("Actor not found.");
    return;
  }
  actor.sheet?.render(true);
}

function closePortraitActionMenu() {
  document.getElementById("vne-portrait-action-menu")?.remove();
}

function showPortraitActionMenu(trigger, actorId, side) {
  closePortraitActionMenu();
  const actor = game.actors.get(actorId);
  if (!actor) {
    ui.notifications?.warn("Actor not found.");
    return;
  }

  const inCombat = !!game.combat?.combatants.find(c => c.actorId === actorId);
  const initiativeBtn = `<button type="button" data-action="initiative"><i class="fas fa-dice-d20"></i><span>Roll Initiative</span></button>`;
  const removeVNBtn    = game.user.isGM ? `<button type="button" data-action="removeVN"><i class="fas fa-user-minus"></i><span>Remove from VN</span></button>` : "";
  const removeCombatBtn = (game.user.isGM && inCombat) ? `<button type="button" data-action="removeCombat"><i class="fas fa-skull"></i><span>Remove from combat</span></button>` : "";

  const menu = document.createElement("div");
  menu.id = "vne-portrait-action-menu";
  menu.className = "vne-portrait-action-menu";
  menu.innerHTML = `
    <button type="button" data-action="sheet"><i class="fas fa-id-card"></i><span>Open character sheet</span></button>
    <button type="button" data-action="target"><i class="fas fa-crosshairs"></i><span>Select as target</span></button>
    ${inCombat ? initiativeBtn : ""}
    <button type="button" data-action="speaker"><i class="fas fa-comment-dots"></i><span>Set as speaker</span></button>
    ${removeVNBtn}
    ${removeCombatBtn}`;

  menu.addEventListener("click", async (event) => {
    const action = event.target.closest("button")?.dataset.action;
    if (!action) return;
    event.stopPropagation();
    closePortraitActionMenu();

    if (action === "sheet") {
      openActorSheet(actorId);
      return;
    }
    if (action === "target") {
      targetActorToken(actorId);
      return;
    }
    if (action === "initiative") {
      const combat = game.combat;
      if (!combat) { ui.notifications?.warn("No active combat."); return; }
      const combatant = combat.combatants.find(c => c.actorId === actorId);
      if (!combatant) { ui.notifications?.warn("Actor is not in the combat tracker."); return; }
      await combat.rollInitiative([combatant.id]);
      return;
    }
    if (action === "speaker") {
      if (isOnStage(actorId, getData())) await removeFromStage(actorId);
      else await addToStage(actorId);
      return;
    }
    if (action === "removeVN") {
      if (!game.user.isGM) return;
      const d = getData();
      d.leftCast     = d.leftCast.filter(p => p.id !== actorId);
      d.rightCast    = d.rightCast.filter(p => p.id !== actorId);
      d.stagePlayers = d.stagePlayers.filter(id => id !== actorId);
      d.stageNPCs    = d.stageNPCs.filter(id => id !== actorId);
      await saveData(d, { change: "castChange" });
      return;
    }
    if (action === "removeCombat") {
      if (!game.user.isGM) return;
      const combatant = game.combat?.combatants?.find(c => c.actorId === actorId);
      if (combatant) await game.combat.deleteEmbeddedDocuments("Combatant", [combatant.id]);
    }
  });

  document.body.appendChild(menu);
  const rect = trigger.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const left = Math.min(rect.right + 8, window.innerWidth - menuRect.width - 8);
  const top = Math.min(rect.top + 8, window.innerHeight - menuRect.height - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
  setTimeout(() => document.addEventListener("click", closePortraitActionMenu, { once: true }), 0);
}

function _showActionImageOverlay({ imagePath, actorName = "", actionName = "", rollType = "attack" }) {
  if (!imagePath) return;
  const main = document.getElementById("vne-main");
  if (!main || main.style.display === "none") return;
  document.getElementById("vne-action-overlay")?.remove();
  const tClass = ({ attack: "vne-ao-attack", attack1: "vne-ao-attack", attack2: "vne-ao-attack",
    attack3: "vne-ao-attack", damage: "vne-ao-damage", critical: "vne-ao-critical",
    spell: "vne-ao-spell", save: "vne-ao-save", heal: "vne-ao-heal" })[rollType] ?? "vne-ao-attack";
  const overlay = document.createElement("div");
  overlay.id = "vne-action-overlay";
  overlay.className = `vne-action-overlay ${tClass}`;
  overlay.innerHTML = `
    <div class="vne-ao-flash"></div>
    <img class="vne-ao-img" src="${_esc(imagePath)}" />
    <div class="vne-ao-label">
      ${actorName ? `<span class="vne-ao-actor">${_esc(actorName)}</span>` : ""}
      ${actionName ? `<span class="vne-ao-action">${_esc(actionName)}</span>` : ""}
    </div>`;
  // Fade out portraits (center speaker + VS sides) while overlay plays
  const portraitImgs = document.querySelectorAll(".vne-center-img, .vne-vs-img");
  portraitImgs.forEach(el => { el.style.transition = "opacity 0.2s"; el.style.opacity = "0"; });
  main.appendChild(overlay);
  setTimeout(() => {
    overlay.remove();
    portraitImgs.forEach(el => { el.style.transition = "opacity 0.5s"; el.style.opacity = ""; });
  }, 3500);
}

// ── Victory State ────────────────────────────────────────────────────────────

function _showVictoryOverlay() {
  const main = document.getElementById("vne-main");
  if (!main || main.style.display === "none") return;
  document.getElementById("vne-victory-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "vne-victory-overlay";
  overlay.className = "vne-victory-overlay";
  overlay.innerHTML = `
    <div class="vne-victory-rays"></div>
    <div class="vne-victory-text">
      <span class="vne-victory-title">¡VICTORIA!</span>
      <span class="vne-victory-sub">El combate ha concluido</span>
    </div>`;
  main.appendChild(overlay);

  // Auto-remove after 4 s and switch back to VN mode
  setTimeout(async () => {
    overlay.classList.add("vne-victory-fadeout");
    setTimeout(() => overlay.remove(), 600);
    if (game.user.isGM) {
      const d = getData();
      if (d.combatMode) {
        d.combatMode = false;
        await saveData(d, { change: "combatMode" });
      }
    }
  }, 4000);
}

// Determine victory: called when deleteCombat fires or all enemies are defeated.
// Only triggers if VNE is open in combat mode. Broadcasts to all clients via socket.
function _checkVictoryCondition(turnsSnapshot) {
  if (!game.user.isGM) return;
  const d = getData();
  if (!d.showVN || !d.combatMode) return;

  const turns    = turnsSnapshot ?? [];
  const leftIds  = new Set(d.leftCast.map(p => p.id));
  const rightIds = new Set(d.rightCast.map(p => p.id));

  const leftAlive        = turns.some(c => leftIds.has(c.actorId)  && !c.defeated);
  const rightAll         = turns.filter(c => rightIds.has(c.actorId));
  const rightAllDefeated = rightAll.length > 0 && rightAll.every(c => c.defeated);

  if (leftAlive && rightAllDefeated) {
    // Broadcast to all clients — they each show the overlay locally
    game.socket.emit(`module.${ID}`, { type: "vnVictory", senderId: game.user.id });
    _showVictoryOverlay(); // also show for GM (socket doesn't loop back to sender)
  }
}

// ── VS Combat Display ─────────────────────────────────────────────────────────

function _renderVSDisplay() {
  const d = getData();
  const stage = document.querySelector(".vne-stage");
  if (!stage) return;
  if (!d.showVN || !d.combatMode) {
    document.getElementById("vne-combat-vs")?.remove();
    return;
  }
  let vsEl = document.getElementById("vne-combat-vs");
  if (!vsEl) {
    vsEl = document.createElement("div");
    vsEl.id = "vne-combat-vs";
    vsEl.className = "vne-combat-vs";
    stage.appendChild(vsEl);
  }
  const mkHpBar = (p, side) => {
    if (p.hp == null || p.hpMax == null || p.hpMax <= 0) return "";
    const pct    = Math.max(0, Math.min(100, Math.round((p.hp / p.hpMax) * 100)));
    const color  = pct > 50 ? "#4caf50" : pct > 25 ? "#ff9800" : "#f44336";
    const fillW  = pct === 0 ? "100%" : `${pct}%`;
    const fillOp = pct === 0 ? "0.28"  : "1";
    // Numbers: GM always sees them; players only see their own side (left = PCs)
    const showNums = game.user.isGM || side === "left";
    return `<div class="vne-vs-hp-bar-wrap" title="${p.hp}/${p.hpMax} HP">
      <div class="vne-vs-hp-bar" style="width:${fillW};background:${color};opacity:${fillOp};"></div>
    </div>${showNums ? `<div class="vne-vs-hp-text">${p.hp}/${p.hpMax}</div>` : ""}`;
  };
  const mkSide = (p, side) => p
    ? `<div class="vne-vs-img-wrap"><img class="vne-vs-img" src="${_esc(p.img || 'icons/svg/mystery-man.svg')}" style="${p.imgStyle || ''}" onerror="this.src='icons/svg/mystery-man.svg'" /></div><div class="vne-vs-name">${_esc(p.name)}</div>${mkHpBar(p, side)}`
    : "";
  const showVS = !!(_vsLeft || _vsRight);
  vsEl.innerHTML = `
    <div class="vne-vs-side vne-vs-left">${mkSide(_vsLeft, "left")}</div>
    <div class="vne-vs-sep">${showVS ? "<span>VS</span>" : ""}</div>
    <div class="vne-vs-side vne-vs-right">${mkSide(_vsRight, "right")}</div>`;
}

function _vsDataFromPortrait(p, side = "left") {
  const actor = game.actors.get(p.id);
  const hp    = actor?.system?.attributes?.hp?.value ?? null;
  const hpMax = actor?.system?.attributes?.hp?.max   ?? null;
  const scaleVal = (p.scale || 100) / 100;
  const scaleX   = (side === "left" ? !p.mirrorX : p.mirrorX) ? 1 : -1;
  const worldOffsetY = game.settings.get?.(ID, "worldOffsetY") ?? 0;
  const oy = (p.offsetY || 0) - worldOffsetY;
  const ox = p.offsetX || 0;
  const imgStyle = `transform:translateY(${oy}px) translateX(${ox}px) scale(${scaleVal}) scaleX(${scaleX});`;
  return { img: getPortraitImg(p), name: p.name, hp, hpMax, imgStyle };
}

// Called on turn change — updates the side that corresponds to the active combatant.
// Also seeds whichever side is still empty by scanning all combat.turns.
function _updateVSFromCombat() {
  const d = getData();
  if (!d.showVN || !d.combatMode) return;
  const combat = game.combat;
  if (!combat) {
    _vsLeft = null;
    _vsRight = null;
    document.getElementById("vne-combat-vs")?.remove();
    return;
  }
  // Update the active combatant's side
  const currentId = combat.combatant?.actorId;
  if (currentId) {
    const leftP  = d.leftCast.find(p => p.id === currentId);
    const rightP = d.rightCast.find(p => p.id === currentId);
    if (leftP)  _vsLeft  = _vsDataFromPortrait(leftP,  "left");
    if (rightP) _vsRight = _vsDataFromPortrait(rightP, "right");
  }
  // Seed any side that is still empty from the full turn order
  if (!_vsLeft || !_vsRight) {
    for (const turn of (combat.turns ?? [])) {
      if (!_vsLeft) {
        const p = d.leftCast.find(q => q.id === turn.actorId);
        if (p) _vsLeft  = _vsDataFromPortrait(p, "left");
      }
      if (!_vsRight) {
        const p = d.rightCast.find(q => q.id === turn.actorId);
        if (p) _vsRight = _vsDataFromPortrait(p, "right");
      }
      if (_vsLeft && _vsRight) break;
    }
  }
  _renderVSDisplay();
}

// Called when a token is targeted — puts the target "al frente" on their own side.
// This state persists until the next turn change or a new target on that same side.
function _updateVSOnTarget(actorId, side) {
  const d = getData();
  const castP = side === "right"
    ? d.rightCast.find(p => p.id === actorId)
    : d.leftCast.find(p => p.id === actorId);
  if (!castP) return;
  const portrait = _vsDataFromPortrait(castP, side);  // preserves hp/hpMax for HP bars
  if (side === "right") _vsRight = portrait;
  else                  _vsLeft  = portrait;
  _renderVSDisplay();
}

// ═══════════════════════════════════════════════════════════════════════════════
// PERSONA / FIRE EMBLEM COMBAT SYSTEM
// ─ Turn Card:       Full-screen dramatic portrait announcement on turn change
// ─ Damage Floaters: Animated numbers when HP changes
// ─ Crit Overlay:    Epic screen flash on critical hit or fumble
// ─ Hit Shake:       Portrait trembles when taking damage
// ═══════════════════════════════════════════════════════════════════════════════

// ── Turn Card ─────────────────────────────────────────────────────────────────
// Persona 5–style cinematic turn announcement shown to all clients.

function _showTurnCard(combatant) {
  if (!combatant) return;
  const d = getData();
  if (!d.showVN || !d.combatMode) return;
  if (!game.user.isGM) {
    // Normalize showForIds: empty array treated as null (same as visible computation)
    const showForIds = (d.showForIds && d.showForIds.length > 0) ? d.showForIds : null;
    if (showForIds && !showForIds.includes(game.user.id)) return;
    if (_playerLocalHidden) return;
  }
  // Only show for actors that belong to the VN cast
  const isPlayer = d.leftCast.some(p => p.id === combatant.actorId);
  const isEnemy  = d.rightCast.some(p => p.id === combatant.actorId);
  if (!isPlayer && !isEnemy) return;

  const portrait = d.leftCast.find(p => p.id === combatant.actorId)
                ?? d.rightCast.find(p => p.id === combatant.actorId);
  const actor = combatant.actor ?? game.actors.get(combatant.actorId);
  const img   = portrait ? getPortraitImg(portrait)
                          : (actor?.img ?? "icons/svg/mystery-man.svg");
  const name  = combatant.name || actor?.name || "???";
  const theme = isPlayer ? "vne-tc-player" : "vne-tc-enemy";
  const label = isPlayer ? "PLAYER TURN" : "ENEMY TURN";

  // Remove any existing card immediately (cancel both pending timers first)
  clearTimeout(_lastTurnCardTimer);
  clearTimeout(_lastTurnCardInnerTimer);
  document.getElementById("vne-turn-card")?.remove();

  const card = document.createElement("div");
  card.id = "vne-turn-card";
  card.className = `vne-turn-card ${theme}`;
  card.innerHTML = `
    <div class="vne-tc-bg"></div>
    <div class="vne-tc-slash vne-tc-slash1"></div>
    <div class="vne-tc-slash vne-tc-slash2"></div>
    <div class="vne-tc-slash vne-tc-slash3"></div>
    <div class="vne-tc-portrait-wrap">
      <img class="vne-tc-portrait" src="${_esc(img)}" onerror="this.src='icons/svg/mystery-man.svg'"/>
    </div>
    <div class="vne-tc-text-wrap">
      <div class="vne-tc-phase-label">${_esc(label)}</div>
      <div class="vne-tc-name">${_esc(name)}</div>
      <div class="vne-tc-turn-word">TURNO</div>
    </div>
    <div class="vne-tc-flare"></div>
  `;

  document.body.appendChild(card);

  // Auto-dismiss: fade-out after 1.3s, remove after 1.8s (half the original duration)
  _lastTurnCardInnerTimer = null;
  _lastTurnCardTimer = setTimeout(() => {
    card.classList.add("vne-tc-out");
    _lastTurnCardInnerTimer = setTimeout(() => {
      card.remove();
      _lastTurnCardInnerTimer = null;
    }, 500);
  }, 1300);
}

// ── Damage Floaters ───────────────────────────────────────────────────────────
// Float animated numbers over portrait on HP change.

function _showDamageFloater(actorId, delta, isCrit = false) {
  if (delta === 0) return;
  const el = _getPortraitContainer(actorId);
  if (!el) return;

  const isDamage = delta < 0;
  const floater  = document.createElement("div");
  const text = isDamage ? String(delta) : `+${delta}`;

  floater.className = [
    "vne-damage-floater",
    isDamage ? "vne-df-damage" : "vne-df-heal",
    isCrit   ? "vne-df-crit"   : "",
  ].filter(Boolean).join(" ");

  floater.textContent = isCrit && isDamage ? `⚡${text}` : text;

  // Position centered over the portrait element
  const rect = el.getBoundingClientRect();
  floater.style.left = `${rect.left + rect.width  / 2}px`;
  floater.style.top  = `${rect.top  + rect.height * 0.25}px`;

  document.body.appendChild(floater);
  setTimeout(() => floater.remove(), isCrit ? 1600 : 1350);
}

// ── Portrait Hit Shake ────────────────────────────────────────────────────────
// Shake the portrait element when it receives damage.

function _applyPortraitHitShake(actorId, isCrit = false) {
  const el = _getPortraitContainer(actorId);
  if (!el) return;
  const cls = isCrit ? "vne-portrait-crit-shake" : "vne-portrait-hit-shake";
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), isCrit ? 700 : 550);
}

// ── Critical / Fumble Overlay ─────────────────────────────────────────────────
// Full-screen overlay with "¡CRÍTICO!" or "¡PIFIA!" + radial burst.

function _showCriticalAnimation(type, actorId = null) {
  const d = getData();
  if (!d.showVN) return;
  if (!game.user.isGM) {
    const showForIds = (d.showForIds && d.showForIds.length > 0) ? d.showForIds : null;
    if (showForIds && !showForIds.includes(game.user.id)) return;
    if (_playerLocalHidden) return;
  }

  document.getElementById("vne-crit-overlay")?.remove();

  const safeType = type === "fumble" ? "fumble" : "crit";
  const isCrit   = safeType === "crit";
  const imgFile  = isCrit ? "critsucc" : "critfail";
  const overlay  = document.createElement("div");
  overlay.id = "vne-crit-overlay";
  overlay.className = `vne-crit-overlay vne-crit-${safeType}`;
  overlay.innerHTML = `
    <div class="vne-crit-rays"></div>
    <div class="vne-crit-content">
      <img class="vne-crit-img" src="modules/${ID}/assets/imgs/${imgFile}.png" />
    </div>
  `;
  // Append to body so it floats above character sheets and all Foundry windows
  document.body.appendChild(overlay);

  // Flash shake on target portrait (or source for fumble)
  if (actorId) _applyPortraitHitShake(actorId, isCrit);

  setTimeout(() => {
    overlay.classList.add("vne-crit-fadeout");
    setTimeout(() => overlay.remove(), 500);
  }, 1000);
}

// ── Chat Message Critical Parser ──────────────────────────────────────────────
// Supports PF2e, D&D5e (natural 20 / natural 1), and generic text patterns.

function _parseCritFromMessage(message) {
  // PF2e — uses structured outcome flags
  const pf2eCtx     = message.flags?.pf2e?.context;
  const pf2eOutcome = pf2eCtx?.outcome;
  if (pf2eOutcome) {
    // Skip flat checks — PF2e fires these automatically at turn start for
    // persistent damage, recovery checks, etc. They are not dramatic moments.
    const type = (pf2eCtx?.type ?? "").toLowerCase();
    if (type.includes("flat")) return null;
    if (pf2eOutcome === "criticalSuccess") return "crit";
    if (pf2eOutcome === "criticalFailure") return "fumble";
    return null;
  }

  // D&D 5e — check dice terms for nat 20 / nat 1 on a d20 attack roll
  try {
    const rolls = message.rolls ?? [];
    for (const roll of rolls) {
      for (const term of (roll?.terms ?? [])) {
        if ((term.faces ?? term.denomination) === 20) {
          for (const result of (term.results ?? [])) {
            if (!result.active) continue;
            if (result.result === 20) return "crit";
            if (result.result === 1)  return "fumble";
          }
        }
      }
    }
  } catch { /* ignore parse errors */ }

  // Generic: look for keywords in the rendered HTML
  const text = (message.content ?? "").toLowerCase();
  if (/cr[ií]tico|critical.{0,6}hit|golpe.{0,6}cr[ií]tico/.test(text))            return "crit";
  if (/pifia|fumble|fallo.{0,6}cr[ií]tico|critical.{0,6}fail|botch/.test(text))   return "fumble";

  return null;
}

function _escapeHTML(value) {
  const div = document.createElement("div");
  div.textContent = value ?? "";
  return div.innerHTML;
}
// Short alias used everywhere innerHTML touches user-controlled data
const _esc = _escapeHTML;

// ── Small sub-dialogs ────────────────────────────────────────────────────────

function openActorPicker(callback) {
  document.getElementById("vne-actor-picker")?.remove();

  const allActors = game.actors.contents.filter(a => a.img && !a.img.includes("mystery-man"));

  function buildCards(actors) {
    return actors.map(a =>
      `<div class="vne-qap-card" data-id="${_esc(a.id)}" title="${_esc(a.name)}">
        <img src="${_esc(a.img)}" loading="lazy"/>
        <span>${_esc(a.name)}</span>
      </div>`
    ).join("") || `<span style="color:rgba(200,185,160,0.5);font-size:0.8em;padding:8px;">Sin resultados</span>`;
  }

  function bindCards(container) {
    container.querySelectorAll(".vne-qap-card").forEach(card => {
      card.addEventListener("click", e => {
        e.stopPropagation();
        callback(card.dataset.id);
        picker.remove();
      });
    });
  }

  const picker = document.createElement("div");
  picker.id = "vne-actor-picker";
  picker.innerHTML = `
    <div class="vne-qap-label"><i class="fas fa-user-plus"></i> Personaje</div>
    <input class="vne-qap-search" placeholder="Buscar..." type="text" autocomplete="off"/>
    <div class="vne-qap-scroll">${buildCards(allActors)}</div>
    <div class="vne-qap-close" id="vne-qap-close-btn" title="Cerrar"><i class="fas fa-times"></i></div>
  `;

  document.getElementById("vne-main")?.appendChild(picker);

  const scrollEl  = picker.querySelector(".vne-qap-scroll");
  const searchEl  = picker.querySelector(".vne-qap-search");

  bindCards(scrollEl);

  let _searchDebounce = null;
  searchEl?.addEventListener("input", () => {
    clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(() => {
      const q = searchEl.value.toLowerCase().trim();
      scrollEl.innerHTML = buildCards(q ? allActors.filter(a => a.name.toLowerCase().includes(q)) : allActors);
      bindCards(scrollEl);
    }, 150);
  });
  // Focus search so user can type immediately
  requestAnimationFrame(() => searchEl?.focus());

  picker.querySelector("#vne-qap-close-btn")?.addEventListener("click", e => {
    e.stopPropagation(); picker.remove();
  });

  function onOutside(e) {
    if (!picker.contains(e.target)) {
      picker.remove();
      document.removeEventListener("mousedown", onOutside, true);
    }
  }
  setTimeout(() => document.addEventListener("mousedown", onOutside, true), 60);
}

function _isVideoBg(src) { return /\.(mp4|webm)$/i.test(src || ""); }

function _scenePreviewHtml(src) {
  if (!src) return `<img id="se-preview" style="display:none;max-width:100%;max-height:100px;margin-top:6px;border-radius:6px;"/>`;
  if (_isVideoBg(src)) {
    return `<video id="se-preview" src="${_esc(src)}" autoplay loop muted playsinline
      style="max-width:100%;max-height:100px;margin-top:6px;border-radius:6px;display:block;"></video>`;
  }
  return `<img id="se-preview" src="${_esc(src)}" style="max-width:100%;max-height:100px;margin-top:6px;border-radius:6px;display:block;"/>`;
}

function _updateScenePreview(html, src) {
  const prev = html.find("#se-preview");
  if (!src) { prev.hide(); return; }
  const isVid = _isVideoBg(src);
  const tag = isVid ? "video" : "img";
  if (prev.prop("tagName")?.toLowerCase() !== tag) {
    // Replace element type
    const newEl = isVid
      ? `<video id="se-preview" src="${_esc(src)}" autoplay loop muted playsinline style="max-width:100%;max-height:100px;margin-top:6px;border-radius:6px;display:block;"></video>`
      : `<img id="se-preview" src="${_esc(src)}" style="max-width:100%;max-height:100px;margin-top:6px;border-radius:6px;display:block;"/>`;
    prev.replaceWith(newEl);
  } else {
    prev.attr("src", src).show();
    if (isVid) prev[0].load?.();
  }
}

function openSceneEditor(existing, callback) {
  const loc = existing ?? {
    id: foundry.utils.randomID(),
    name: "", parent: "", backgroundImage: "", weather: "", time: ""
  };
  const content = `<div class="vne-scene-editor">
    <div class="vne-se-row"><label>Scene Name</label>
      <input id="se-name" type="text" value="${_esc(loc.name)}" placeholder="Tavern, Forest..."/></div>
    <div class="vne-se-row"><label>Region / Parent</label>
      <input id="se-parent" type="text" value="${_esc(loc.parent)}" placeholder="Neverwinter..."/></div>
    <div class="vne-se-row"><label>Background (image / GIF / WebP / MP4 / WebM)</label>
      <div style="display:flex;gap:6px;align-items:center;">
        <input id="se-bg" type="text" value="${_esc(loc.backgroundImage)}" placeholder="Path to file..."/>
        <button type="button" id="se-bg-pick"><i class="fas fa-folder-open"></i></button>
      </div>
      ${_scenePreviewHtml(loc.backgroundImage)}
    </div>
    <div class="vne-se-row"><label>Weather</label>
      <input id="se-weather" type="text" value="${_esc(loc.weather)}" placeholder="Sunny, Rainy..."/></div>
    <div class="vne-se-row"><label>Time</label>
      <input id="se-time" type="text" value="${_esc(loc.time)}" placeholder="12:00"/></div>
  </div>`;

  new Dialog({
    title: existing ? "Edit Scene" : "New Scene",
    content,
    buttons: {
      save: {
        label: "<i class='fas fa-save'></i> Save",
        callback: (html) => {
          callback({
            ...loc,
            name:            html.find("#se-name").val().trim(),
            parent:          html.find("#se-parent").val().trim(),
            backgroundImage: html.find("#se-bg").val().trim(),
            weather:         html.find("#se-weather").val().trim(),
            time:            html.find("#se-time").val().trim()
          });
        }
      },
      cancel: { label: "Cancel" }
    },
    render: (html) => {
      html.find("#se-bg-pick").on("click", () => {
        new FilePicker({
          type: "any",
          current: game.settings.get(ID, "bgFolderPath") || "",
          callback: (path) => {
            html.find("#se-bg").val(path);
            _updateScenePreview(html, path);
          }
        }).render(true);
      });
      html.find("#se-bg").on("input", function() {
        _updateScenePreview(html, this.value);
      });
    }
  }).render(true, { width: 500 });
}

function openPortraitEditor(portraitId, side = null) {
  const d = getData();
  // Search the specified side first, then all casts (supports rpCast / stagePlayers / stageNPCs actors)
  let p = null;
  if (side) p = (d[`${side}Cast`] || []).find(x => x.id === portraitId);
  if (!p) {
    for (const key of ["leftCast", "rightCast", "stagePlayers", "stageNPCs"]) {
      const arr = Array.isArray(d[key])
        ? (typeof d[key][0] === "string" ? null : d[key])  // stagePlayers is string[], skip
        : null;
      if (arr) { p = arr.find(x => x.id === portraitId); if (p) break; }
    }
  }
  // Fall back to the shared portraits store
  if (!p) p = d.portraits?.[portraitId];
  if (!p) return;

  new Dialog({
    title: `Edit: ${p.name}`,
    content: `<div class="vne-pe-form">
      <div class="vne-pe-preview">
        <img id="pe-img" src="${_esc(p.img || 'icons/svg/mystery-man.svg')}" style="max-height:180px;border-radius:8px;" onerror="this.src='icons/svg/mystery-man.svg'"/>
        <button type="button" id="pe-pick-img" class="vne-pe-pick-btn"><i class="fas fa-image"></i> Change Image</button>
      </div>
      <div class="vne-pe-fields">
        <label>Name</label>
        <input id="pe-name" type="text" value="${_esc(p.name)}"/>
        <label>Title / Role</label>
        <input id="pe-title" type="text" value="${_esc(p.title || "")}"/>
        <label>Scale: <span id="pe-scale-v">${p.scale ?? 100}</span>%</label>
        <input id="pe-scale" type="range" min="20" max="300" value="${p.scale ?? 100}"/>
        <label>Offset X: <span id="pe-ox-v">${p.offsetX ?? 0}</span>px</label>
        <input id="pe-ox" type="range" min="-500" max="500" value="${p.offsetX ?? 0}"/>
        <label>Offset Y: <span id="pe-oy-v">${p.offsetY ?? 0}</span>px</label>
        <input id="pe-oy" type="range" min="-500" max="500" value="${p.offsetY ?? 0}"/>
        <label style="display:flex;align-items:center;gap:6px;margin-top:4px;">
          <input id="pe-mirror" type="checkbox" ${p.mirrorX ? "checked" : ""}/>
          Mirror horizontally
        </label>
      </div>
    </div>
    <button type="button" id="pe-reactions-btn" style="width:100%;margin-top:10px;padding:6px 0;border-radius:6px;border:1px solid rgba(200,155,60,0.35);background:rgba(200,155,60,0.1);color:#c89b3c;cursor:pointer;">
      <i class="fas fa-theater-masks"></i> Manage Reactions / Expressions
    </button>`,
    buttons: {
      save: {
        label: "<i class='fas fa-check'></i> Save",
        callback: async (html) => {
          const d2 = getData();
          // Prefer data-picked so onerror fallback path is never saved as the portrait image
          const imgEl  = html.find("#pe-img");
          const newImg = imgEl.attr("data-picked") || imgEl.attr("src");
          const imgChanged = newImg !== p.img;
          const updates = {
            name:    html.find("#pe-name").val().trim() || p.name,
            title:   html.find("#pe-title").val().trim(),
            img:     newImg,
            scale:   Number.parseInt(html.find("#pe-scale").val(), 10),
            offsetX: Number.parseInt(html.find("#pe-ox").val(), 10),
            offsetY: Number.parseInt(html.find("#pe-oy").val(), 10),
            mirrorX: html.find("#pe-mirror").is(":checked"),
          };
          // Update portrait in every cast that contains this actor
          for (const key of ["leftCast", "rightCast"]) {
            const idx = (d2[key] || []).findIndex(x => x.id === portraitId);
            if (idx >= 0) {
              Object.assign(d2[key][idx], updates);
              // Keep reactions.default in sync when the portrait image changes
              if (imgChanged && d2[key][idx].reactions?.default === p.img)
                d2[key][idx].reactions.default = newImg;
            }
          }
          const stored = d2.portraits[portraitId] || p;
          d2.portraits[portraitId] = { ...stored, ...updates };
          if (imgChanged && d2.portraits[portraitId].reactions?.default === p.img)
            d2.portraits[portraitId].reactions = { ...d2.portraits[portraitId].reactions, default: newImg };
          await saveData(d2, { change: "castChange" });
        }
      },
      cancel: { label: "Cancel" }
    },
    render: (html) => {
      function livePreview() {
        const imgEl = html.find("#pe-img");
        _livePreviewPortrait(portraitId, side, {
          img:     imgEl.attr("data-picked") || imgEl.attr("src"),
          scale:   Number.parseInt(html.find("#pe-scale").val(), 10),
          offsetX: Number.parseInt(html.find("#pe-ox").val(), 10),
          offsetY: Number.parseInt(html.find("#pe-oy").val(), 10),
          mirrorX: html.find("#pe-mirror").is(":checked"),
        });
      }
      html.find("#pe-scale").on("input", function() { html.find("#pe-scale-v").text(this.value); livePreview(); });
      html.find("#pe-ox").on("input",    function() { html.find("#pe-ox-v").text(this.value);    livePreview(); });
      html.find("#pe-oy").on("input",    function() { html.find("#pe-oy-v").text(this.value);    livePreview(); });
      html.find("#pe-mirror").on("change", livePreview);
      html.find("#pe-pick-img").on("click", () => {
        new FilePicker({
          type: "image",
          current: game.settings.get(ID, "portraitFolderPath") || "",
          callback: (path) => {
            html.find("#pe-img").attr("src", path).attr("data-picked", path);
            livePreview();
          }
        }).render(true);
      });
      html.find("#pe-reactions-btn").on("click", () => openReactionManager(portraitId));
    }
  }).render(true, { width: 560 });
}

function openReactionManager(actorId) {
  const d = getData();
  const p = d.leftCast.find(x => x.id === actorId) || d.rightCast.find(x => x.id === actorId);
  if (!p) return;

  const reactions = p.reactions ? { ...p.reactions } : { default: p.img };

  function buildRow(name, img) {
    return `<div class="vne-rm-row" data-key="${_esc(name)}">
      <div class="vne-rm-preview">
        <img class="vne-rm-thumb" src="${_esc(img || "")}"${img ? "" : ' style="display:none"'}/>
      </div>
      <input class="vne-rm-name" type="text" value="${_esc(name)}" placeholder="reaction_name"/>
      <button type="button" class="vne-rm-pick vne-icon-btn" title="Pick image"><i class="fas fa-image"></i></button>
      <button type="button" class="vne-rm-remove vne-icon-btn" title="Remove"><i class="fas fa-trash"></i></button>
    </div>`;
  }

  function getTpls() { return game.settings.get(ID, "vnReactionTemplates") ?? {}; }

  function tplOptions(tpls) {
    const keys = Object.keys(tpls).sort();
    if (!keys.length) return `<option value="" disabled>No saved templates</option>`;
    return keys.map(k => `<option value="${_esc(k)}">${_esc(k)}</option>`).join("");
  }

  function collectRows(html) {
    const map = {};
    html.find(".vne-rm-row").each(function() {
      const name = $(this).find(".vne-rm-name").val().trim().toLowerCase().replace(/\s+/g,"_");
      const img  = $(this).find(".vne-rm-thumb").attr("src") || "";
      if (name && img) map[name] = img;
    });
    return map;
  }

  const initialRows = Object.entries(reactions).map(([n, i]) => buildRow(n, i)).join("");

  new Dialog({
    title: `Reactions: ${p.name}`,
    content: `<div class="vne-reaction-manager">

      <div class="vne-rm-section-label"><i class="fas fa-bookmark"></i> Templates</div>
      <div class="vne-rm-tpl-bar">
        <select id="vne-rm-tpl-select" class="vne-rm-tpl-select">
          <option value="">— Select template —</option>
          ${tplOptions(getTpls())}
        </select>
        <button type="button" id="vne-rm-tpl-apply" class="vne-rm-tpl-btn vne-rm-tpl-btn-apply" title="Apply template">
          <i class="fas fa-check"></i>
        </button>
        <button type="button" id="vne-rm-tpl-del" class="vne-rm-tpl-btn vne-rm-tpl-btn-del" title="Delete template">
          <i class="fas fa-trash"></i>
        </button>
      </div>

      <div class="vne-rm-divider"></div>

      <p class="vne-rm-hint">
        <i class="fas fa-theater-masks"></i> Each row = one expression. Actor owners can switch it during the session.<br>
        <span class="vne-rm-hint-autohp"><i class="fas fa-heart-broken"></i> Auto-HP:</span>
        name a reaction <code>hurt</code>/<code>wounded</code> (≤50%) or <code>critical</code>/<code>ko</code> (≤25%) for automatic activation.
      </p>
      <div id="vne-rm-rows">${initialRows}</div>
      <button type="button" id="vne-rm-add" class="vne-rm-add-btn"><i class="fas fa-plus"></i> Add Reaction</button>

      <div class="vne-rm-divider"></div>
      <div class="vne-rm-section-label"><i class="fas fa-tag"></i> Save as template</div>
      <div class="vne-rm-tpl-save-bar">
        <input id="vne-rm-tpl-name-input" class="vne-rm-tpl-name" type="text"
               placeholder="Name (e.g. Bandit, Guard, Elemental…)" autocomplete="off"/>
        <button type="button" id="vne-rm-tpl-save" class="vne-rm-tpl-btn vne-rm-tpl-btn-save"
                title="Save as template">
          <i class="fas fa-bookmark"></i>
        </button>
      </div>
    </div>`,
    buttons: {
      save: {
        label: "<i class='fas fa-save'></i> Save",
        callback: async (html) => {
          const newReactions = collectRows(html);
          if (!Object.keys(newReactions).length) return;
          const d2 = getData();
          for (const side of ["leftCast", "rightCast"]) {
            const portrait = d2[side].find(x => x.id === actorId);
            if (portrait) {
              portrait.reactions = newReactions;
              if (!newReactions[portrait.activeReaction])
                portrait.activeReaction = Object.keys(newReactions)[0];
            }
          }
          if (d2.portraits[actorId]) d2.portraits[actorId].reactions = newReactions;
          await saveData(d2, { change: "castChange" });
        }
      },
      cancel: { label: "Cancel" }
    },
    render: (html) => {
      // Image picker per row
      html.on("click", ".vne-rm-pick", (e) => {
        const row = $(e.currentTarget).closest(".vne-rm-row");
        new FilePicker({
          type: "image",
          current: game.settings.get(ID, "portraitFolderPath") || "",
          callback: (path) => row.find(".vne-rm-thumb").attr("src", path).show()
        }).render(true);
      });
      html.on("click", ".vne-rm-remove", (e) => $(e.currentTarget).closest(".vne-rm-row").remove());
      html.find("#vne-rm-add").on("click", () => html.find("#vne-rm-rows").append(buildRow("new_reaction", "")));

      // ── Apply template ──
      html.find("#vne-rm-tpl-apply").on("click", () => {
        const key = html.find("#vne-rm-tpl-select").val();
        if (!key) { ui.notifications?.warn("VNE: Select a template first."); return; }
        const tpl = getTpls()[key];
        if (!tpl || !Object.keys(tpl).length) return;
        html.find("#vne-rm-rows").html(Object.entries(tpl).map(([n,i]) => buildRow(n,i)).join(""));
        ui.notifications?.info(`VNE: Template "${key}" applied. Click Save to confirm.`);
      });

      // ── Delete template ──
      html.find("#vne-rm-tpl-del").on("click", async () => {
        const key = html.find("#vne-rm-tpl-select").val();
        if (!key) { ui.notifications?.warn("VNE: Select a template to delete."); return; }
        const tpls = getTpls();
        delete tpls[key];
        await game.settings.set(ID, "vnReactionTemplates", tpls);
        html.find("#vne-rm-tpl-select").html(`<option value="">— Select template —</option>${tplOptions(tpls)}`);
        ui.notifications?.info(`VNE: Template "${key}" deleted.`);
      });

      // ── Save as template ──
      html.find("#vne-rm-tpl-save").on("click", async () => {
        const name = html.find("#vne-rm-tpl-name-input").val().trim();
        if (!name) { ui.notifications?.warn("VNE: Enter a name for the template."); return; }
        const tplReactions = collectRows(html);
        if (!Object.keys(tplReactions).length) {
          ui.notifications?.warn("VNE: No reactions with images to save."); return;
        }
        const tpls = getTpls();
        const isOverwrite = !!tpls[name];
        tpls[name] = tplReactions;
        await game.settings.set(ID, "vnReactionTemplates", tpls);
        html.find("#vne-rm-tpl-select").html(`<option value="">— Select template —</option>${tplOptions(tpls)}`);
        html.find("#vne-rm-tpl-name-input").val("");
        ui.notifications?.info(`VNE: Template "${name}" ${isOverwrite ? "updated" : "saved"} (${Object.keys(tplReactions).length} reactions).`);
      });
    }
  }).render(true, { width: 520, height: "auto" });
}

// ── Spotlight Mode ────────────────────────────────────────────────────────────
// Double-click any RP-stage portrait to isolate it with a dramatic full-focus effect.
// Double-click again (or press Escape) to exit spotlight.

let _spotlightActorId = null;

function _enterSpotlight(actorId) {
  _spotlightActorId = actorId;
  const stage = document.getElementById("vne-rp-stage");
  if (!stage) return;
  stage.querySelectorAll(".vne-rp-slot").forEach(slot => {
    const isFocus = slot.dataset.id === actorId;
    slot.classList.toggle("vne-spotlight-focus", isFocus);
    slot.classList.toggle("vne-spotlight-dim",   !isFocus);
  });
  stage.classList.add("vne-spotlight-active");

  // Overlay with spotlight frame
  let overlay = document.getElementById("vne-spotlight-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "vne-spotlight-overlay";
    overlay.className = "vne-spotlight-overlay";
    overlay.innerHTML = `<div class="vne-spotlight-vignette"></div>
      <div class="vne-spotlight-exit-hint"><i class="fas fa-compress"></i> Doble clic para salir</div>`;
    stage.appendChild(overlay);
    overlay.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      _exitSpotlight();
    });
  }
}

function _exitSpotlight() {
  _spotlightActorId = null;
  const stage = document.getElementById("vne-rp-stage");
  if (!stage) return;
  stage.querySelectorAll(".vne-rp-slot").forEach(slot => {
    slot.classList.remove("vne-spotlight-focus", "vne-spotlight-dim");
  });
  stage.classList.remove("vne-spotlight-active");
  document.getElementById("vne-spotlight-overlay")?.remove();
}

// Keyboard Escape exits spotlight
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && _spotlightActorId) _exitSpotlight();
}, true);

// ── Cast Presets ─────────────────────────────────────────────────────────────
// Save and restore full cast configurations (leftCast + rightCast + portraits)

function _getCastPresets() {
  return game.settings.get(ID, "castPresets") ?? {};
}

async function _saveCastPresets(presets) {
  await game.settings.set(ID, "castPresets", presets);
}

function openCastPresetsDialog() {
  if (!game.user.isGM) return;

  function presetOptions(presets) {
    const keys = Object.keys(presets).sort();
    if (!keys.length) return `<option value="" disabled>No saved presets</option>`;
    return keys.map(k => `<option value="${_esc(k)}">${_esc(k)}</option>`).join("");
  }

  const presets = _getCastPresets();
  const content = `<div class="vne-presets-dialog">
    <p class="vne-presets-hint"><i class="fas fa-users"></i> Presets save the full cast (left + right + portraits + reactions) and let you restore it in one click.</p>

    <div class="vne-presets-section">
      <div class="vne-presets-label"><i class="fas fa-bookmark"></i> Load preset</div>
      <div class="vne-presets-row">
        <select id="vne-preset-select" class="vne-preset-select">
          <option value="">— Select —</option>
          ${presetOptions(presets)}
        </select>
        <button type="button" id="vne-preset-load" class="vne-preset-btn" title="Load"><i class="fas fa-check"></i></button>
        <button type="button" id="vne-preset-del"  class="vne-preset-btn vne-preset-btn-del" title="Delete"><i class="fas fa-trash"></i></button>
      </div>
    </div>

    <div class="vne-presets-divider"></div>

    <div class="vne-presets-section">
      <div class="vne-presets-label"><i class="fas fa-save"></i> Save current cast as preset</div>
      <div class="vne-presets-row">
        <input id="vne-preset-name" type="text" class="vne-preset-name-input" placeholder="Name (e.g. Main group, Tavern scene…)" autocomplete="off"/>
        <button type="button" id="vne-preset-save" class="vne-preset-btn vne-preset-btn-save" title="Save"><i class="fas fa-bookmark"></i></button>
      </div>
    </div>
  </div>`;

  const dialog = new Dialog({
    title: "Cast Presets",
    content,
    buttons: { close: { label: "Close" } },
    render: (html) => {

      // Load preset
      html.find("#vne-preset-load").on("click", async () => {
        const key = html.find("#vne-preset-select").val();
        if (!key) { ui.notifications?.warn("VNE: Select a preset first."); return; }
        const p = _getCastPresets()[key];
        if (!p) return;
        const d = getData();
        d.leftCast    = p.leftCast    ?? [];
        d.rightCast   = p.rightCast   ?? [];
        d.portraits   = { ...d.portraits, ...(p.portraits ?? {}) };
        d.stagePlayers = [];
        d.stageNPCs   = [];
        await saveData(d, { change: "castChange" });
        ui.notifications?.info(`VNE: Preset "${key}" loaded (${d.leftCast.length + d.rightCast.length} actors).`);
        dialog.close();
      });

      // Delete preset
      html.find("#vne-preset-del").on("click", async () => {
        const key = html.find("#vne-preset-select").val();
        if (!key) { ui.notifications?.warn("VNE: Select a preset to delete."); return; }
        const p2 = _getCastPresets();
        delete p2[key];
        await _saveCastPresets(p2);
        html.find("#vne-preset-select").html(`<option value="">— Select —</option>${presetOptions(p2)}`);
        ui.notifications?.info(`VNE: Preset "${key}" deleted.`);
      });

      // Save current cast as preset
      html.find("#vne-preset-save").on("click", async () => {
        const name = html.find("#vne-preset-name").val().trim();
        if (!name) { ui.notifications?.warn("VNE: Enter a name for the preset."); return; }
        const d = getData();
        if (!d.leftCast.length && !d.rightCast.length) {
          ui.notifications?.warn("VNE: The cast is empty, nothing to save."); return;
        }
        const p2 = _getCastPresets();
        const isOverwrite = !!p2[name];
        p2[name] = {
          leftCast:  foundry.utils.deepClone(d.leftCast),
          rightCast: foundry.utils.deepClone(d.rightCast),
          portraits: foundry.utils.deepClone(d.portraits),
          savedAt:   new Date().toISOString()
        };
        await _saveCastPresets(p2);
        html.find("#vne-preset-select").html(`<option value="">— Select —</option>${presetOptions(p2)}`);
        html.find("#vne-preset-name").val("");
        ui.notifications?.info(`VNE: Preset "${name}" ${isOverwrite ? "updated" : "saved"} (${d.leftCast.length + d.rightCast.length} actors).`);
      });
    }
  }, { width: 480 });
  dialog.render(true);
}

// ── Main application ─────────────────────────────────────────────────────────

export class VNE extends FormApplication {
  static instance = null;

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "vne-main",
      classes: ["vne-body"],
      popOut: false,
      width: "100%",
      height: "100%",
      resizable: false,
      template: `modules/${ID}/templates/vnMain.hbs`,
      title: "VN Enhanced",
      closeOnSubmit: false,
      submitOnChange: false,
      dragDrop: [{ dragSelector: ".vne-cast-portrait" }]
    });
  }

  static activate() {
    VNE.instance = new VNE();
    VNE.instance.render(true);
    VNE._injectToggleButton();
  }

  // Persistent floating button — always visible even when VN is closed or unlicensed
  static _injectToggleButton() {
    const existing = document.getElementById("vne-toggle-fab");
    if (existing) return;
    const fab = document.createElement("div");
    fab.id = "vne-toggle-fab";
    fab.title = "Open / Close VN (Alt+V)";
    fab.innerHTML = `<i class="fas fa-users-between-lines"></i>`;
    fab.addEventListener("click", () => {
      // If VNE is not active (unlicensed), show the license prompt for the GM
      if (!VNE.instance) {
        if (game.user?.isGM) VndLicenseUI.show();
        return;
      }
      if (game.user.isGM) {
        const d = getData();
        if (d.hideUI) {
          // FAB is the escape hatch — restore UI when it's collapsed
          d.hideUI = false;
          saveData(d, { change: "hideUI" });
        } else {
          VNE.toggle();
        }
      } else {
        _playerLocalHidden = !_playerLocalHidden;
        const main = document.getElementById("vne-main");
        if (_playerLocalHidden) {
          main?.style.setProperty("display", "none", "important");
        } else {
          main?.style.removeProperty("display");
          main?.classList.remove("vne-hidden");
        }
      }
    });
    document.body.appendChild(fab);
  }

  static async toggle(showForIds = null) {
    const d = getData();
    d.showVN    = !d.showVN;
    d.showForIds = showForIds;
    await saveData(d, { change: "showVN" });
  }

  async close(options) {
    _unmountSidebar();
    return super.close(options);
  }

  // ── Template data ──────────────────────────────────────────────────────────

  getData() {
    const d = getData();
    const zIndex      = game.settings.get(ID, "zIndex") || 90;
    const worldOffsetY = game.settings.get(ID, "worldOffsetY") || 0;
    const editMode    = d.editMode && game.user.isGM;

    // Treat showForIds=[] (empty) as null so an empty list never silently locks out all players
    const showForIds = (d.showForIds && d.showForIds.length > 0) ? d.showForIds : null;
    const visible = d.showVN &&
      (game.user.isGM || !showForIds || showForIds.includes(game.user.id)) &&
      (game.user.isGM || !_playerLocalHidden);

    const combatMode = d.combatMode ?? false;

    const players = game.users.contents.filter(u => u.active).map(u => ({
      id: u.id,
      name: u.name,
      color: u.color,
      visible: !showForIds || showForIds.includes(u.id)
    }));

    const stageActorIds = combatMode
      ? new Set([game.combat?.combatant?.actorId].filter(Boolean))
      : new Set([...(d.stagePlayers || []), ...(d.stageNPCs || [])]);
    const leftCast  = d.leftCast.map(p  => templatePortrait(p, "left",  stageActorIds, worldOffsetY, editMode, combatMode));
    const rightCast = d.rightCast.map(p => templatePortrait(p, "right", stageActorIds, worldOffsetY, editMode, combatMode));

    const combat        = game.combat;
    const combatRound   = combat?.round ?? 0;
    const combatTurnName = combat?.combatant?.name ?? "";

    return {
      zIndex,
      visible,
      showVN:          d.showVN,
      hideUI:          d.hideUI || (!game.user.isGM && _playerLocalUIHidden),
      hideBack:        d.hideBack,
      editMode,
      combatMode,
      isGM:            game.user.isGM,
      backgroundImage:   d.location?.backgroundImage || "",
      backgroundIsVideo: /\.(mp4|webm)$/i.test(d.location?.backgroundImage || ""),
      locationName:    d.location?.name || "",
      locationParent:  d.location?.parent || "",
      locationWeather: d.location?.weather || "",
      locationTime:    d.location?.time || "",
      leftCast,
      rightCast,
      locationList:    d.locationList,
      currentLocationId: d.location?.id || "",
      players,
      combatRound,
      combatTurnName,
      timerMinutes:    _timerMinutes,
      timerEnabled:    _timerEnabled,
      timerAuto:       _timerAutoReset,
      timerDisplay:    _timerDisplayStr(),
      timerLow:        _timerEnabled && _timerSecondsLeft <= 30
    };
  }

  // ── Listeners ──────────────────────────────────────────────────────────────

  activateListeners(html) {
    super.activateListeners(html);
    const root = html[0];

    // Close / toggle
    root.querySelector("#vne-close-btn")?.addEventListener("click", () => {
      if (game.user.isGM) {
        VNE.toggle();
      } else {
        _playerLocalHidden = true;
        document.getElementById("vne-main")?.style.setProperty("display", "none", "important");
      }
    });

    // Hide UI toggle
    root.querySelectorAll(".vne-hideUI-toggle").forEach(btn => {
      btn.addEventListener("click", toggleHideUI);
    });

    root.querySelectorAll(".vne-chat-toggle").forEach(btn => {
      btn.addEventListener("click", _toggleFoundrySidebar);
    });

    // Hide background toggle
    root.querySelector("#vne-hideback-btn")?.addEventListener("click", async () => {
      const d = getData(); d.hideBack = !d.hideBack;
      await saveData(d, { change: "hideBack" });
    });

    // Edit mode toggle (GM only) — pencil button in top-bar
    root.querySelector("#vne-editmode-btn")?.addEventListener("click", async () => {
      if (!game.user.isGM) return;
      const d = getData();
      d.editMode = !d.editMode;
      await saveData(d, { change: "editMode" });
    });

    // Add actor buttons
    root.querySelector("#vne-add-left-btn")?.addEventListener("click", () => this._addActor("left"));
    root.querySelector("#vne-add-right-btn")?.addEventListener("click", () => this._addActor("right"));

    // Combat stage toggle (GM only)
    root.querySelectorAll(".vne-combat-stage-toggle").forEach(btn => {
      btn.addEventListener("click", toggleCombatStage);
    });

    // Cast Presets (GM only)
    root.querySelector("#vne-presets-btn")?.addEventListener("click", () => {
      if (game.user.isGM) openCastPresetsDialog();
    });

    // AI Image Generator (GM only)
    root.querySelector("#vne-ai-btn")?.addEventListener("click", () => {
      if (game.user.isGM) VNDAIGenerator.open();
    });

    // Previous / Next turn (GM only)
    root.querySelector("#vne-prev-turn-btn")?.addEventListener("click", async () => {
      if (!game.user.isGM) return;
      await game.combat?.previousTurn().catch(() => {});
    });
    root.querySelector("#vne-next-turn-btn")?.addEventListener("click", async () => {
      if (!game.user.isGM) return;
      await game.combat?.nextTurn().catch(() => {});
    });

    // Roll all initiative (GM only)
    root.querySelector("#vne-roll-all-init-btn")?.addEventListener("click", async () => {
      if (!game.user.isGM) return;
      const combat = game.combat;
      if (!combat) { ui.notifications?.warn("No active combat."); return; }
      await combat.rollAll().catch(() => {});
    });

    // Turn timer: toggle on/off
    root.querySelector("#vne-timer-toggle-btn")?.addEventListener("click", () => {
      if (!game.user.isGM) return;
      if (_timerEnabled) {
        _stopTurnTimer();
      } else {
        const minutes = parseInt(root.querySelector("#vne-timer-input")?.value ?? "2") || 2;
        _startTurnTimer(minutes);
      }
    });

    // Turn timer: auto-reset toggle
    root.querySelector("#vne-timer-auto-btn")?.addEventListener("click", () => {
      if (!game.user.isGM) return;
      _timerAutoReset = !_timerAutoReset;
      localStorage.setItem("vne-timerAutoReset", _timerAutoReset ? "1" : "0");
      _patchTimerAutoBtn();
    });

    // Turn timer: change minutes (stops current timer)
    root.querySelector("#vne-timer-input")?.addEventListener("change", (e) => {
      if (!game.user.isGM) return;
      const minutes = parseInt(e.target.value) || 2;
      _timerMinutes = minutes;
      localStorage.setItem("vne-timerMinutes", String(minutes));
      if (_timerEnabled) _startTurnTimer(minutes);
    });

    // Portrait click → action menu in combat mode; in VN mode single-click adds to stage,
    // double-click opens the context menu for quick access to other options.
    root.querySelectorAll(".vne-cast-portrait[data-id]").forEach(el => {
      el.addEventListener("click", async (e) => {
        if (e.target.closest(".vne-remove-cast-btn, .vne-portrait-quick-ctrl")) return;
        const id   = e.currentTarget.dataset.id;
        const side = e.currentTarget.dataset.side;
        const d    = getData();
        if (d.combatMode) {
          e.stopPropagation();
          showPortraitActionMenu(e.currentTarget, id, side);
          return;
        }
        // VN mode: single click = toggle stage (block the second click that precedes a dblclick)
        if (e.detail === 2) { e.stopPropagation(); return; }
        e.stopPropagation();
        if (isOnStage(id, d)) await removeFromStage(id);
        else                  await addToStage(id);
      });

      // Double-click in VN mode → open context menu for full options
      el.addEventListener("dblclick", (e) => {
        if (e.target.closest(".vne-remove-cast-btn, .vne-portrait-quick-ctrl")) return;
        const id   = e.currentTarget.dataset.id;
        const side = e.currentTarget.dataset.side;
        e.stopPropagation();
        _openVNContextMenu(id, e.currentTarget, { mode: "vn", editMode: game.user.isGM && getData().editMode });
      });

      // Right-click → context menu (or portrait editor in edit mode)
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const id   = e.currentTarget.dataset.id;
        const side = e.currentTarget.dataset.side;
        const isEditMode = game.user.isGM && getData().editMode;
        if (isEditMode) {
          openPortraitEditor(id, side);
        } else {
          _openVNContextMenu(id, e.currentTarget, { mode: "vn", editMode: false });
        }
      });
    });

    // Remove portrait (edit mode × button)
    root.querySelectorAll(".vne-remove-cast-btn").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const { id, side } = e.currentTarget.dataset;
        const d = getData();
        d[`${side}Cast`] = d[`${side}Cast`].filter(p => p.id !== id);
        d.stagePlayers = d.stagePlayers.filter(sid => sid !== id);
        d.stageNPCs    = d.stageNPCs.filter(sid => sid !== id);
        await saveData(d, { change: "castChange" });
      });
    });

    // Scenes pill → opens the manager popup
    root.querySelector("#vne-scenes-pill")?.addEventListener("click", (e) => {
      if (document.getElementById("vne-scenes-panel")) {
        document.getElementById("vne-scenes-panel").remove();
      } else {
        openScenesPanel();
      }
    });

    // Player visibility toggles
    root.querySelectorAll(".vne-player-vis-btn").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        if (!game.user.isGM) return;
        const userId = e.currentTarget.dataset.userId;
        const d = getData();
        const allIds = game.users.contents.filter(u => u.active).map(u => u.id);
        if (!d.showForIds) d.showForIds = [...allIds];
        const idx = d.showForIds.indexOf(userId);
        if (idx >= 0) d.showForIds.splice(idx, 1);
        else d.showForIds.push(userId);
        // null means "all" — use null when all are included OR when none are (empty list is confusing)
        if (d.showForIds.length === 0 || d.showForIds.length >= allIds.length) d.showForIds = null;
        await saveData(d, { change: "visibility" });
      });
    });

    root.querySelector("#vne-show-all-btn")?.addEventListener("click", async () => {
      if (!game.user.isGM) return;
      const d = getData();
      d.showForIds = null;
      await saveData(d, { change: "visibility" });
    });

    // Reaction expression buttons (center speaker)
    root.querySelectorAll(".vne-reaction-btn[data-reaction]").forEach(btn => {
      btn.addEventListener("click", () => {
        setReaction(btn.dataset.actorId, btn.dataset.reaction);
      });
    });
    root.querySelector(".vne-reaction-manage-btn")?.addEventListener("click", (e) => {
      openReactionManager(e.currentTarget.dataset.actorId);
    });

    // Render carousel + VS display after the template is in the DOM
    renderVNECombatCarousel();
    _updateVSFromCombat();

    // Raise Foundry sidebar above VNE so it's always accessible at the right edge
    _mountSidebar();

    // Drag-over styling for drop zones
    root.querySelectorAll(".vne-drop-zone").forEach(zone => {
      zone.addEventListener("dragover", (e) => {
        e.preventDefault();
        zone.classList.add("vne-drag-over");
      });
      zone.addEventListener("dragleave", () => zone.classList.remove("vne-drag-over"));
      zone.addEventListener("drop", () => zone.classList.remove("vne-drag-over"));
    });

    // Sync AUTO button state in case of re-render without full template reload
    _patchTimerAutoBtn();

    // Initial render of VN stage
    _patchVNStage(getData(), game.settings.get(ID, "worldOffsetY") || 0);
  }

  _addActor(side) {
    openActorPicker(async (actorId) => {
      const actor = game.actors.get(actorId);
      if (!actor) return;
      const d = getData();
      const key = `${side}Cast`;
      if (d[key].some(p => p.id === actorId)) {
        ui.notifications?.info(`${actor.name} is already in the panel.`);
        if (d.combatMode && game.user.isGM) await ensureActiveEncounterForVNE();
        return;
      }
      const saved = d.portraits[actorId];
      const portrait = (saved?.img) ? { ...saved } : defaultPortrait(actor);
      if (d[key].length >= 10) d[key].shift();
      d[key].push(portrait);
      d.portraits[actorId] = portrait;
      await saveData(d, { change: "castChange" });
      if (d.combatMode && game.user.isGM) await ensureActiveEncounterForVNE();
    });
  }

  // ── Drag & Drop (actors from sidebar or internal reorder) ─────────────────

  _canDragDrop() { return true; }
  _canDragStart() { return true; }

  _onDragStart(event) {
    const el = event.currentTarget;
    event.dataTransfer.setData("text/plain", JSON.stringify({
      type: "vne-portrait",
      id: el.dataset.id,
      side: el.dataset.side
    }));
  }

  async _onDrop(event) {
    let raw;
    try { raw = JSON.parse(event.dataTransfer.getData("text/plain")); } catch { return; }

    const dropZone  = event.target.closest(".vne-drop-zone");
    const toSide    = dropZone?.dataset?.side;
    const isRPStage = dropZone?.id === "vne-rp-stage";
    const isCenter  = isRPStage || dropZone?.classList?.contains("vne-center-area");

    // ── Actor dropped from Foundry sidebar ──────────────────────────────────
    if (raw.type === "Actor" && raw.uuid) {
      const actor = await fromUuid(raw.uuid);
      if (!actor) return;
      const d = getData();

      if (isCenter) {
        // Actor dropped on stage: add to side cast if needed, then add to stage
        if (!d.leftCast.some(p => p.id === actor.id) && !d.rightCast.some(p => p.id === actor.id)) {
          const saved = d.portraits[actor.id];
          const portrait = saved ? { ...saved } : defaultPortrait(actor);
          const key = actor.hasPlayerOwner ? "leftCast" : "rightCast";
          if (d[key].length < 10) { d[key].push(portrait); d.portraits[actor.id] = portrait; }
          await saveData(d, { change: "castChange" });
        }
        await addToStage(actor.id);
        if (d.combatMode && game.user.isGM) await ensureActiveEncounterForVNE();
        return;
      } else {
        // Dropping on a side panel → leftCast / rightCast only, no speaker
        if (!toSide || !["left", "right"].includes(toSide)) return;
        const key = `${toSide}Cast`;
        if (!d[key].some(p => p.id === actor.id)) {
          if (d[key].length >= 10) d[key].shift();
          const saved = d.portraits[actor.id];
          const portrait = (saved?.img) ? { ...saved } : defaultPortrait(actor);
          d[key].push(portrait);
          d.portraits[actor.id] = portrait;
        }
      }

      await saveData(d, { change: "castChange" });
      if (d.combatMode && game.user.isGM) await ensureActiveEncounterForVNE();
      return;
    }

    // ── Internal portrait drag ──────────────────────────────────────────────
    if (raw.type === "vne-portrait") {
      if (!["left", "right"].includes(raw.side)) return;
      // Portrait dragged to center → add to stage
      if (isCenter) {
        await addToStage(raw.id);
        return;
      }
      // Portrait dragged to a different side panel → move between panels
      if (toSide && ["left", "right"].includes(toSide) && raw.side !== toSide) {
        const d = getData();
        const fromKey = `${raw.side}Cast`;
        const toKey   = `${toSide}Cast`;
        const idx = d[fromKey].findIndex(p => p.id === raw.id);
        if (idx < 0) return;
        const [portrait] = d[fromKey].splice(idx, 1);
        d[toKey].push(portrait);
        await saveData(d, { change: "castChange" });
      }
    }
  }
}

// ── Reactive DOM update hook ─────────────────────────────────────────────────

// Immediate activation on the GM client — fires synchronously from activateWithCode
// before the worldLicensed setting round-trips to the server and back.
Hooks.on("vnd-enhanced.activate", () => {
  if (!VNE.instance) {
    document.getElementById("vnd-license-prompt")?.remove();
    VNE.activate();
  }
});

Hooks.on("updateSetting", (setting, _value, options) => {
  // GM connected Patreon mid-session → activate for all clients now
  if (setting.key === `${ID}.worldLicensed`) {
    if (game.settings.get(ID, "worldLicensed") === true && !VNE.instance) {
      document.getElementById("vnd-license-prompt")?.remove();
      VNE.activate();
    }
    return;
  }

  if (setting.key !== `${ID}.vnData`) return;
  const change = options?.change;

  // Full re-render on show/hide, edit mode, combat mode, visibility change, or unknown change
  if (!change || ["showVN", "editMode", "visibility", "combatMode"].includes(change)) {
    if (change === "showVN") {
      const d2 = getData();
      if (d2.showVN) {
        // GM opened VN globally → reset any per-player local hide
        if (!game.user.isGM) {
          _playerLocalHidden   = false;
          _playerLocalUIHidden = false;
        }
        // Sidebar mount happens in activateListeners after render
      } else {
        _unmountSidebar();
        _stopTurnTimer();
      }
    }
    if (change === "combatMode") {
      _stopTurnTimer();
      _vsLeft = _vsRight = null;
      // Clear round-tier classes when leaving combat
      const main = document.getElementById("vne-main");
      main?.classList.remove("vne-round-tier-1", "vne-round-tier-2", "vne-round-tier-3");
    }
    VNE.instance?.render(true);
    return;
  }

  // Always fetch a fresh parsed copy — setting.value may be a raw JSON string in v13
  const d = getData();

  // Partial DOM updates for performance
  if (change === "location") {
    const bgSrc = d.location?.backgroundImage || "";
    const isVid = /\.(mp4|webm)$/i.test(bgSrc);
    const imgEl = document.getElementById("vne-background-img");
    const vidEl = document.getElementById("vne-background-vid");
    if (imgEl) { imgEl.src = isVid ? "" : bgSrc; imgEl.style.display = isVid ? "none" : ""; }
    if (vidEl) {
      if (isVid) { vidEl.innerHTML = `<source src="${_esc(bgSrc)}"/>`; vidEl.load(); vidEl.style.display = ""; }
      else { vidEl.style.display = "none"; vidEl.innerHTML = ""; }
    }
    const nameEl = document.getElementById("vne-loc-name");
    const parEl  = document.getElementById("vne-loc-parent");
    if (nameEl) nameEl.textContent = d.location?.name || "";
    if (parEl)  parEl.textContent  = d.location?.parent || "";
    _patchSceneBar(d);
  }

  if (change === "hideBack") {
    document.getElementById("vne-bg-wrap")?.classList.toggle("vne-hidden", d.hideBack);
  }

  if (change === "hideUI") {
    document.getElementById("vne-ui-layer")?.classList.toggle("vne-ui-collapsed", d.hideUI);
    document.querySelectorAll(".vne-hideUI-toggle").forEach(btn => {
      btn.classList.toggle("vne-active", d.hideUI);
      btn.title = d.hideUI ? "Show UI panels" : "Hide UI panels";
      const icon = btn.querySelector("i");
      if (icon) icon.className = `fas fa-${d.hideUI ? "eye" : "eye-slash"}`;
    });
  }

  if (change === "castChange") {
    // Clamp existing scroll offsets to new cast sizes so we never land on an invalid index
    const leftLen  = (d.leftCast  ?? []).length;
    const rightLen = (d.rightCast ?? []).length;
    const PAGE = 5;
    _sideScrollOffset.left  = Math.max(0, Math.min(_sideScrollOffset.left,  Math.max(0, leftLen  - PAGE)));
    _sideScrollOffset.right = Math.max(0, Math.min(_sideScrollOffset.right, Math.max(0, rightLen - PAGE)));
    _patchCast(d);
    renderVNECombatCarousel();
    _vsLeft = _vsRight = null;
    _updateVSFromCombat();
    if (game.user.isGM && d.combatMode) _syncGhostTokens(d);
    // Seed HP map for any newly added cast member so first HP delta shows correctly
    _seedCastHP(d);
    // Prune HP map for actors no longer in any cast to avoid unbounded growth
    const castIds = new Set([...(d.leftCast ?? []), ...(d.rightCast ?? [])].map(p => p.id));
    for (const id of _lastKnownHP.keys()) {
      if (!castIds.has(id)) _lastKnownHP.delete(id);
    }
  }

  if (change === "stageChange") {
    _patchCast(d);
    renderVNECombatCarousel();
  }

  if (change === "locationList") {
    _patchSceneBar(d);
  }
});

// ── DOM patch helpers ────────────────────────────────────────────────────────

function _patchSceneBar(d) {
  const nameEl  = document.getElementById("vne-scenes-current");
  const sepEl   = nameEl?.previousElementSibling;
  const countEl = document.querySelector(".vne-sp-pill-count");
  const name    = d.location?.name || "";
  if (nameEl)  { nameEl.textContent = name; nameEl.style.display = name ? "" : "none"; }
  if (sepEl)   { sepEl.style.display = name ? "" : "none"; }
  if (countEl) countEl.textContent = `(${d.locationList?.length ?? 0})`;
  // Sync active state in open panel
  document.querySelectorAll(".vne-sp-card").forEach(card => {
    card.classList.toggle("vne-sp-card-active", card.dataset.id === d.location?.id);
  });
}

function openScenesPanel() {
  document.getElementById("vne-scenes-panel")?.remove();
  const d = getData();

  // Unique categories (from .parent field)
  const categories = [...new Set(
    d.locationList.map(l => (l.parent || "").trim()).filter(Boolean)
  )].sort();

  let activeFilter = "";
  let searchQ      = "";

  function esc(s) { return String(s ?? "").replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;"); }

  function cardHtml(loc) {
    const isActive = loc.id === d.location?.id;
    const bgStyle  = loc.backgroundImage ? `background-image:url("${esc(loc.backgroundImage)}")` : "";
    const tag      = loc.parent ? `<span class="vne-sp-card-tag">${esc(loc.parent)}</span>` : "";
    const actions  = game.user.isGM ? `
      <div class="vne-sp-card-actions">
        <div class="vne-sp-card-edit" data-id="${esc(loc.id)}" title="Editar"><i class="fas fa-pencil"></i></div>
        <div class="vne-sp-card-del"  data-id="${esc(loc.id)}" title="Eliminar"><i class="fas fa-trash"></i></div>
      </div>` : "";
    return `<div class="vne-sp-card${isActive ? " vne-sp-card-active" : ""}" data-id="${esc(loc.id)}" title="${esc(loc.name)}">
      <div class="vne-sp-card-img" style="${bgStyle}">${actions}</div>
      <div class="vne-sp-card-info">
        <span class="vne-sp-card-name">${esc(loc.name || "?")}</span>${tag}
      </div>
    </div>`;
  }

  function getVisible() {
    let locs = d.locationList;
    if (activeFilter) locs = locs.filter(l => (l.parent || "").trim() === activeFilter);
    if (searchQ)      locs = locs.filter(l =>
      (l.name   || "").toLowerCase().includes(searchQ) ||
      (l.parent || "").toLowerCase().includes(searchQ));
    return locs;
  }

  function buildGrid() {
    const locs = getVisible();
    return locs.length
      ? locs.map(cardHtml).join("")
      : `<div class="vne-sp-empty"><i class="fas fa-map"></i><span>No scenes${activeFilter || searchQ ? " matching the filter" : ""}</span></div>`;
  }

  function refreshGrid() {
    const grid = document.getElementById("vne-sp-grid");
    if (!grid) return;
    grid.innerHTML = buildGrid();
    bindGrid(grid);
  }

  const tabsHtml = [
    `<div class="vne-sp-tab vne-sp-tab-active" data-filter="">All</div>`,
    ...categories.map(c => `<div class="vne-sp-tab" data-filter="${esc(c)}">${esc(c)}</div>`)
  ].join("");

  const panel = document.createElement("div");
  panel.id = "vne-scenes-panel";
  panel.innerHTML = `
    <div class="vne-sp-header">
      <span class="vne-sp-title"><i class="fas fa-map-marked-alt"></i> Scenes</span>
      <div class="vne-sp-header-btns">
        ${game.user.isGM ? `<div id="vne-sp-import-btn" class="vne-sp-hbtn" title="Import from JSON"><i class="fas fa-file-import"></i></div>` : ""}
        ${game.user.isGM ? `<div id="vne-sp-export-btn" class="vne-sp-hbtn" title="Export to JSON"><i class="fas fa-file-export"></i></div>` : ""}
        <div id="vne-sp-close" class="vne-sp-hbtn" title="Close"><i class="fas fa-times"></i></div>
      </div>
    </div>
    <div class="vne-sp-controls">
      <input id="vne-sp-search" class="vne-sp-search" type="text" placeholder="🔍 Search scene..." autocomplete="off"/>
      <div class="vne-sp-tabs">${tabsHtml}</div>
    </div>
    <div class="vne-sp-grid" id="vne-sp-grid">${buildGrid()}</div>
    ${game.user.isGM ? `<div class="vne-sp-footer">
      <div id="vne-sp-new-btn" class="vne-sp-new-btn"><i class="fas fa-plus"></i> New Scene</div>
    </div>` : ""}
    <input type="file" id="vne-sp-file" accept=".json" style="display:none"/>
  `;

  document.getElementById("vne-main")?.appendChild(panel);

  function bindGrid(grid) {
    // Click card → activate scene
    grid.querySelectorAll(".vne-sp-card").forEach(card => {
      card.addEventListener("click", async (e) => {
        if (e.target.closest(".vne-sp-card-edit, .vne-sp-card-del")) return;
        const d2  = getData();
        const loc = d2.locationList.find(l => l.id === card.dataset.id);
        if (!loc) return;
        d2.location = { ...loc };
        await saveData(d2, { change: "location" });
        d.location = { ...loc };   // keep closure in sync so refreshGrid() marks correct active card
        // Immediately reflect active state in grid without full rebuild
        grid.querySelectorAll(".vne-sp-card").forEach(c => c.classList.remove("vne-sp-card-active"));
        card.classList.add("vne-sp-card-active");
      });
    });

    // Edit button → open scene editor dialog
    grid.querySelectorAll(".vne-sp-card-edit").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const d2  = getData();
        const loc = d2.locationList.find(l => l.id === btn.dataset.id);
        if (!loc) return;
        openSceneEditor(loc, async (updated) => {
          const d3  = getData();
          const idx = d3.locationList.findIndex(l => l.id === updated.id);
          if (idx >= 0) d3.locationList[idx] = updated;
          if (d3.location?.id === updated.id) d3.location = { ...updated };
          await saveData(d3, { change: "location" });
          // Sync local copy and rebuild
          d.locationList = d3.locationList;
          refreshGrid();
        });
      });
    });

    // Delete button
    grid.querySelectorAll(".vne-sp-card-del").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const d2 = getData();
        d2.locationList = d2.locationList.filter(l => l.id !== btn.dataset.id);
        await saveData(d2, { change: "locationList" });
        d.locationList = d2.locationList;
        refreshGrid();
      });
    });
  }

  // Initial bind
  bindGrid(document.getElementById("vne-sp-grid"));

  // Filter tabs
  panel.querySelectorAll(".vne-sp-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      panel.querySelectorAll(".vne-sp-tab").forEach(t => t.classList.remove("vne-sp-tab-active"));
      tab.classList.add("vne-sp-tab-active");
      activeFilter = tab.dataset.filter;
      refreshGrid();
    });
  });

  // Search
  let _st = null;
  panel.querySelector("#vne-sp-search")?.addEventListener("input", (e) => {
    clearTimeout(_st);
    _st = setTimeout(() => { searchQ = e.target.value.toLowerCase().trim(); refreshGrid(); }, 150);
  });

  // New scene
  panel.querySelector("#vne-sp-new-btn")?.addEventListener("click", () => {
    openSceneEditor(null, async (newLoc) => {
      if (!newLoc.id) newLoc.id = foundry.utils.randomID();
      const d2 = getData();
      d2.locationList.push(newLoc);
      d2.location = { ...newLoc };
      await saveData(d2, { change: "location" });
      d.locationList = d2.locationList;
      refreshGrid();
    });
  });

  // Export → download JSON
  panel.querySelector("#vne-sp-export-btn")?.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({ scenes: getData().locationList }, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    Object.assign(document.createElement("a"), { href: url, download: "vne-scenes.json" }).click();
    URL.revokeObjectURL(url);
  });

  // Import → read JSON file
  panel.querySelector("#vne-sp-import-btn")?.addEventListener("click", () => {
    panel.querySelector("#vne-sp-file")?.click();
  });
  panel.querySelector("#vne-sp-file")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const parsed  = JSON.parse(await file.text());
      const incoming = parsed.scenes ?? parsed.locationList ?? [];
      if (!Array.isArray(incoming) || !incoming.length) {
        ui.notifications?.warn("VNE: No scenes found in the file."); return;
      }
      const d2 = getData();
      let added = 0;
      for (const loc of incoming) {
        if (!loc.name) continue;
        if (!loc.id) loc.id = foundry.utils.randomID();
        if (!d2.locationList.find(l => l.id === loc.id)) { d2.locationList.push(loc); added++; }
      }
      await saveData(d2, { change: "locationList" });
      d.locationList = d2.locationList;
      refreshGrid();
      ui.notifications?.info(`VNE: ${added} scene(s) imported.`);
    } catch { ui.notifications?.error("VNE: Error reading JSON file."); }
    e.target.value = "";
  });

  // Close button
  panel.querySelector("#vne-sp-close")?.addEventListener("click", () => panel.remove());

  // Click outside to close
  setTimeout(() => {
    function onOutside(ev) {
      const pill = document.getElementById("vne-scenes-pill");
      if (!panel.contains(ev.target) && !pill?.contains(ev.target)) {
        panel.remove();
        document.removeEventListener("mousedown", onOutside, true);
      }
    }
    document.addEventListener("mousedown", onOutside, true);
  }, 60);

  requestAnimationFrame(() => panel.querySelector("#vne-sp-search")?.focus());
}

function _buildCastPortraitEl(p, side, tp, editMode) {
  const div = document.createElement("div");
  div.className = `vne-cast-portrait${tp.isActive ? " vne-speaking" : ""}${tp.isOwned ? " vne-owned" : ""}${tp.isCombatTarget ? " vne-combat-target" : ""}${tp.isTargeted ? " vne-targeted" : ""}${tp.isYourTurn ? " vne-your-turn" : ""}`;
  div.dataset.id   = p.id;
  div.dataset.side = side;
  div.draggable    = true;
  div.title        = `${p.name}${p.title ? " – " + p.title : ""}`;

  const speakRing  = tp.isActive ? '<div class="vne-speaking-ring"></div>' : "";
  const removeBtn  = editMode
    ? `<div class="vne-remove-cast-btn" data-id="${p.id}" data-side="${side}" title="Remove"><i class="fas fa-times"></i></div>`
    : "";
  const quickCtrl  = editMode ? _portraitQuickCtrlHtml() : "";
  div.innerHTML = `<img src="${_esc(tp.img || 'icons/svg/mystery-man.svg')}" class="vne-cast-img" style="${tp.imgStyle}" onerror="this.src='icons/svg/mystery-man.svg'"/>${speakRing}${removeBtn}${quickCtrl}`;
  return div;
}

function _bindCastPortrait(div, p, side, editMode) {
  // Single click: toggle stage presence (same as template-rendered portrait behavior)
  div.addEventListener("click", async (e) => {
    if (e.target.closest(".vne-remove-cast-btn, .vne-portrait-quick-ctrl")) return;
    const d = getData();
    if (d.combatMode) {
      e.stopPropagation();
      showPortraitActionMenu(div, p.id, side);
      return;
    }
    // Don't toggle stage when user is double-clicking (block the second "click" of a dblclick)
    if (e.detail === 2) { e.stopPropagation(); return; }
    e.stopPropagation();
    if (isOnStage(p.id, d)) await removeFromStage(p.id);
    else                    await addToStage(p.id);
  });

  // Double-click: full context menu
  div.addEventListener("dblclick", (e) => {
    if (e.target.closest(".vne-remove-cast-btn, .vne-portrait-quick-ctrl")) return;
    e.stopPropagation();
    _openVNContextMenu(p.id, div, { mode: "vn", editMode: game.user.isGM && getData().editMode });
  });

  div.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const isEditMode = game.user.isGM && getData().editMode;
    if (isEditMode) {
      openPortraitEditor(p.id, side);
    } else {
      _openVNContextMenu(p.id, div, { mode: "vn", editMode: false });
    }
  });

  if (editMode) {
    div.querySelector(".vne-remove-cast-btn")?.addEventListener("click", async (e) => {
      e.stopPropagation();
      const d = getData();
      d[`${side}Cast`] = d[`${side}Cast`].filter(x => x.id !== p.id);
      d.stagePlayers = d.stagePlayers.filter(id => id !== p.id);
      d.stageNPCs    = d.stageNPCs.filter(id => id !== p.id);
      await saveData(d, { change: "castChange" });
    });
    _bindPortraitQuickCtrl(div, p.id);
  }

  div.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", JSON.stringify({ type: "vne-portrait", id: p.id, side }));
  });
}

function _patchSidePanel(side, d, worldOffsetY, editMode) {
  const panel = document.getElementById(`vne-${side}-portraits`);
  if (!panel) return;
  const cast = d[`${side}Cast`];
  panel.innerHTML = "";

  if (cast.length === 0) {
    panel.innerHTML = `<div class="vne-cast-empty"><i class="fas fa-user-plus"></i><span>Drag actors here<br>or click +</span></div>`;
    return;
  }

  const PAGE = 5;
  const total = cast.length;
  // Clamp offset so we never go out of range
  _sideScrollOffset[side] = Math.max(0, Math.min(_sideScrollOffset[side], Math.max(0, total - PAGE)));
  const offset = _sideScrollOffset[side];
  const visible = cast.slice(offset, offset + PAGE);
  const combatMode = d.combatMode ?? false;

  // Up button
  if (offset > 0) {
    const upBtn = document.createElement("div");
    upBtn.className = "vne-panel-nav vne-panel-nav-up";
    upBtn.title = "Anteriores";
    upBtn.innerHTML = `<i class="fas fa-chevron-up"></i>`;
    upBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      _sideScrollOffset[side] = Math.max(0, offset - 1);
      _patchSidePanel(side, getData(), worldOffsetY, editMode);
    });
    panel.appendChild(upBtn);
  }

  const stageActorIds = new Set([...(d.stagePlayers || []), ...(d.stageNPCs || [])]);
  for (const p of visible) {
    const tp  = templatePortrait(p, side, stageActorIds, worldOffsetY, editMode, combatMode);
    const div = _buildCastPortraitEl(p, side, tp, editMode);
    _bindCastPortrait(div, p, side, editMode);
    panel.appendChild(div);
  }

  // Down button
  if (offset + PAGE < total) {
    const downBtn = document.createElement("div");
    downBtn.className = "vne-panel-nav vne-panel-nav-down";
    downBtn.title = "Siguientes";
    downBtn.innerHTML = `<i class="fas fa-chevron-down"></i>`;
    downBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      _sideScrollOffset[side] = Math.min(total - PAGE, offset + 1);
      _patchSidePanel(side, getData(), worldOffsetY, editMode);
    });
    panel.appendChild(downBtn);
  }

  // Page indicator when scrolled
  if (total > PAGE) {
    const indicator = document.createElement("div");
    indicator.className = "vne-panel-page-indicator";
    indicator.textContent = `${offset + 1}–${Math.min(offset + PAGE, total)} / ${total}`;
    panel.appendChild(indicator);
  }
}

function _buildReactionsHTML(sp) {
  if (!sp.canControl && !game.user.isGM) return "";
  const btns = sp.reactions.map(r => `
    <div class="vne-reaction-btn${r.isActive ? " vne-active" : ""}"
         data-reaction="${_esc(r.name)}" data-actor-id="${_esc(sp.id)}" title="${_esc(r.label)}">
      <img src="${_esc(r.img)}" loading="lazy"/>
      <span>${_esc(r.label)}</span>
    </div>`).join("");
  const manage = game.user.isGM
    ? `<div class="vne-reaction-manage-btn" data-actor-id="${sp.id}" title="Manage Reactions"><i class="fas fa-cog"></i></div>`
    : "";
  return `<div class="vne-nameplate-reactions">${btns}${manage}</div>`;
}

function _patchCast(d) {
  const worldOffsetY = game.settings.get(ID, "worldOffsetY") || 0;
  const editMode = d.editMode && game.user.isGM;
  if (!d.combatMode) _patchVNStage(d, worldOffsetY);
  _patchSidePanel("left",  d, worldOffsetY, editMode);
  _patchSidePanel("right", d, worldOffsetY, editMode);
}

// Live portrait preview — patches only the affected DOM elements without writing to settings.
// Called on every slider input in openPortraitEditor for instant visual feedback.
function _livePreviewPortrait(actorId, side, { img, scale, offsetX, offsetY, mirrorX }) {
  const worldOffsetY = game.settings.get(ID, "worldOffsetY") || 0;
  const scaleVal = (scale || 100) / 100;
  const oy = (offsetY || 0) - worldOffsetY;
  const ox = offsetX || 0;

  // Side-panel portrait — only scale + mirror, NO offsetX/Y (offset applies to stage/VS only)
  const panelScaleX = (side === "left" ? !mirrorX : mirrorX) ? 1 : -1;
  const panelStyle  = `transform:scale(${scaleVal}) scaleX(${panelScaleX});`;
  const panelImgEl  = document.querySelector(`.vne-cast-portrait[data-id="${actorId}"] .vne-cast-img`);
  if (panelImgEl) { panelImgEl.setAttribute("style", panelStyle); if (img) panelImgEl.src = img; }

  // RP stage portrait — translateY/X before scale so offsets are in screen pixels
  const stageScaleX = mirrorX ? -1 : 1;
  const stageStyle  = `transform:translateY(${oy}px) translateX(${ox}px) scale(${scaleVal}) scaleX(${stageScaleX});`;
  const stageImgEl  = document.querySelector(`.vne-rp-slot[data-id="${actorId}"] .vne-rp-img`);
  if (stageImgEl) { stageImgEl.setAttribute("style", stageStyle); if (img) stageImgEl.src = img; }

  // VS combat display — same translateY/X approach
  const vsScaleX = (side === "left" ? !mirrorX : mirrorX) ? 1 : -1;
  const vsStyle  = `transform:translateY(${oy}px) translateX(${ox}px) scale(${scaleVal}) scaleX(${vsScaleX});`;
  if (side === "left" && _vsLeft) {
    if (img) _vsLeft.img = img;
    _vsLeft.imgStyle = vsStyle;
    const vsEl = document.querySelector(".vne-vs-left .vne-vs-img");
    if (vsEl) { if (img) vsEl.src = img; vsEl.setAttribute("style", vsStyle); }
  }
  if (side === "right" && _vsRight) {
    if (img) _vsRight.img = img;
    _vsRight.imgStyle = vsStyle;
    const vsEl = document.querySelector(".vne-vs-right .vne-vs-img");
    if (vsEl) { if (img) vsEl.src = img; vsEl.setAttribute("style", vsStyle); }
  }
}

function _patchVNStage(d, worldOffsetY) {
  const stage = document.getElementById("vne-rp-stage");
  if (!stage) return;

  const players = (d.stagePlayers || [])
    .map(id => d.leftCast.find(p => p.id === id) || d.portraits?.[id] || null)
    .filter(Boolean);
  const npcs = (d.stageNPCs || [])
    .map(id => d.rightCast.find(p => p.id === id) || d.portraits?.[id] || null)
    .filter(Boolean);

  const hasPlayers = players.length > 0;
  const hasNPCs    = npcs.length > 0;
  const twoRows    = hasPlayers && hasNPCs;

  function buildSlotHtml(p, rowCount) {
    const reactionMap    = p.reactions || { default: p.img };
    const activeReaction = p.activeReaction || "default";
    const scaleVal = (p.scale || 100) / 100;
    const scaleX   = p.mirrorX ? -1 : 1;
    const oy = (p.offsetY || 0) - worldOffsetY;
    const ox = p.offsetX || 0;
    const img      = getPortraitImg(p);
    // translateY/X come before scale so offsets are in screen pixels, not scaled px.
    // margin-top has no effect on flex-end aligned items (wrap uses align-items:flex-end).
    const imgStyle = `transform: translateY(${oy}px) translateX(${ox}px) scale(${scaleVal}) scaleX(${scaleX});`;
    const canCtrl  = canControlActor(p.id);

    let reactionsHtml = "";
    if (canCtrl) {
      const btns = Object.entries(reactionMap).map(([name, rImg]) => {
        const label  = name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, " ");
        const active = name === activeReaction ? " vne-active" : "";
        return `<div class="vne-reaction-btn${active}" data-reaction="${_esc(name)}" data-actor-id="${_esc(p.id)}" title="${_esc(label)}"><img src="${_esc(rImg)}" loading="lazy"/><span>${_esc(label)}</span></div>`;
      }).join("");
      const manageBtnHtml = game.user.isGM
        ? `<div class="vne-reaction-manage-btn" data-actor-id="${p.id}" title="Manage reactions"><i class="fas fa-cog"></i></div>` : "";
      reactionsHtml = `<div class="vne-rp-reactions">${btns}${manageBtnHtml}</div>`;
    }

    const removeBtn  = game.user.isGM
      ? `<div class="vne-rp-remove-btn" data-id="${p.id}" title="Remove from stage"><i class="fas fa-times"></i></div>` : "";
    const quickCtrl  = game.user.isGM ? _portraitQuickCtrlHtml() : "";
    const titleHtml  = p.title ? `<span class="vne-rp-title">${_esc(p.title)}</span>` : "";
    const safeSrc    = _esc(img || "icons/svg/mystery-man.svg");

    return `<div class="vne-rp-slot" data-id="${_esc(p.id)}" data-slot-count="${rowCount}">
      <div class="vne-rp-portrait-wrap">
        ${removeBtn}
        <img class="vne-rp-img" src="${safeSrc}" style="${imgStyle}" onerror="this.src='icons/svg/mystery-man.svg'"/>
        ${quickCtrl}
      </div>
      <div class="vne-rp-nameplate"><span class="vne-rp-name">${_esc(p.name)}</span>${titleHtml}</div>
      ${reactionsHtml}
    </div>`;
  }

  let html = "";
  if (!hasPlayers && !hasNPCs) {
    stage.classList.remove("vne-two-rows");
    html = `<div class="vne-rp-empty"><i class="fas fa-users fa-2x"></i><span>Drag actors from the side panels</span></div>`;
  } else if (twoRows) {
    stage.classList.add("vne-two-rows");
    const topSlots = players.map(p => buildSlotHtml(p, players.length)).join("");
    const botSlots = npcs.map(p => buildSlotHtml(p, npcs.length)).join("");
    html = `<div class="vne-rp-row vne-rp-row-top">${topSlots}</div><div class="vne-rp-row vne-rp-row-bottom">${botSlots}</div>`;
  } else {
    stage.classList.remove("vne-two-rows");
    const chars = hasPlayers ? players : npcs;
    html = chars.map(p => buildSlotHtml(p, chars.length)).join("");
  }

  stage.innerHTML = html;
  // The spotlight overlay is wiped by innerHTML — re-inject only if actor is still on stage
  if (_spotlightActorId && stage.querySelector(`.vne-rp-slot[data-id="${_spotlightActorId}"]`))
    _enterSpotlight(_spotlightActorId);
  else if (_spotlightActorId) _spotlightActorId = null;

  stage.querySelectorAll(".vne-rp-slot").forEach(slot => {
    // Double-click → enter/exit spotlight mode
    slot.addEventListener("dblclick", (e) => {
      if (e.target.closest(".vne-reaction-btn, .vne-rp-remove-btn, .vne-reaction-manage-btn, .vne-portrait-quick-ctrl")) return;
      e.stopPropagation();
      if (_spotlightActorId === slot.dataset.id) {
        _exitSpotlight();
      } else {
        _enterSpotlight(slot.dataset.id);
      }
    });

    slot.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.target.closest(".vne-reaction-btn, .vne-rp-remove-btn, .vne-reaction-manage-btn")) return;
      const isEditMode = game.user.isGM && getData().editMode;
      _openVNContextMenu(slot.dataset.id, slot, { mode: "vn", editMode: isEditMode });
    });

    slot.querySelectorAll(".vne-reaction-btn").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await setReaction(btn.dataset.actorId, btn.dataset.reaction);
      });
    });

    slot.querySelector(".vne-reaction-manage-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      openReactionManager(e.currentTarget.dataset.actorId);
    });

    slot.querySelector(".vne-rp-remove-btn")?.addEventListener("click", async (e) => {
      e.stopPropagation();
      await removeFromStage(e.currentTarget.dataset.id);
    });

    if (game.user.isGM) _bindPortraitQuickCtrl(slot, slot.dataset.id);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// VNE COMBAT CAROUSEL
// ═══════════════════════════════════════════════════════════════════════════════

function renderVNECombatCarousel() {
  const el = document.getElementById("vne-unified-carousel");
  if (!el) return;
  const d = getData();
  if (!d.showVN) { el.innerHTML = ""; _updateVSFromCombat(); return; }
  const combat = game.combat;
  if (combat?.turns?.length) {
    _renderVNECarouselUnified(el, combat);
  } else {
    _renderVNECarouselVNMode(el, d);
  }
  _updateVSFromCombat();
  // Apply round escalation tier immediately on any carousel render
  if (d.combatMode) _patchCombatDisplay();
}

function _getCarouselActorHP(actor) {
  if (!actor) return null;
  const hp = actor.system?.attributes?.hp ?? actor.system?.hp ?? null;
  if (!hp) return null;
  const value = hp.value ?? hp.current ?? 0;
  const max   = hp.max ?? 0;
  if (max <= 0) return null;
  return { value, max, pct: Math.max(0, Math.min(1, value / max)) };
}

function _carouselHpBarHtml(actor) {
  if (!game.user.isGM) return "";
  const hp = _getCarouselActorHP(actor);
  if (!hp) return "";
  const pct   = Math.round(hp.pct * 100);
  const color = hp.pct > 0.5 ? "#4caf50" : hp.pct > 0.25 ? "#f09800" : "#e53935";
  // At 0 HP show full-width dimmed red so the bar doesn't disappear visually
  const fillW  = pct === 0 ? "100%" : `${pct}%`;
  const fillOp = pct === 0 ? "0.28" : "1";
  return `<div class="vne-carousel-hp-bar"><div class="vne-carousel-hp-fill" style="width:${fillW};background:${color};opacity:${fillOp};"></div></div>`;
}

function _carouselEffectsHtml(actor) {
  const effects = actor?.temporaryEffects?.filter(e => !e.disabled) ?? [];
  if (!effects.length) return "";
  const icons = effects.slice(0, 6).map(e =>
    `<img class="vne-ce-icon" src="${_esc(e.img ?? e.icon)}" title="${_esc(e.name)}" onerror="this.style.display='none'">`
  ).join("");
  return `<div class="vne-carousel-effects">${icons}</div>`;
}

function _carouselCardHtml({ img, name, initLabel, isActive, isDefeated, isNext, isNextTwo, mode, combatantId, actorId, side, actor }) {
  const classes = ["vne-carousel-item",
    isActive   ? "vne-carousel-active"   : "",
    isNext     ? "vne-carousel-next"     : "",
    isNextTwo  ? "vne-carousel-next2"    : "",
    isDefeated ? "vne-carousel-defeated" : ""
  ].filter(Boolean).join(" ");

  const dataAttrs = mode === "combat"
    ? `data-mode="combat" data-combatant-id="${combatantId}"`
    : `data-mode="vn" data-actor-id="${actorId}" data-side="${side}"`;

  const initPart = initLabel !== null
    ? `<span class="vne-carousel-cinit">${initLabel}</span>` : "";

  const turnBadge = isActive  ? '<div class="vne-carousel-badge vne-badge-now">NOW</div>'
                  : isNext    ? '<div class="vne-carousel-badge vne-badge-next">NEXT</div>'
                  : isNextTwo ? '<div class="vne-carousel-badge vne-badge-next2">+2</div>'
                  : "";

  return `<div class="${classes}" ${dataAttrs}>
    ${turnBadge}
    <img src="${_esc(img)}" alt="${_esc(name)}" onerror="this.src='icons/svg/mystery-man.svg'">
    ${_carouselEffectsHtml(actor)}
    ${_carouselHpBarHtml(actor)}
    <div class="vne-carousel-footer">
      <span class="vne-carousel-cname">${_esc(name)}</span>
      ${initPart}
    </div>
    ${isActive ? '<div class="vne-carousel-turn-bar"></div>' : ""}
  </div>`;
}

function _renderVNECarouselUnified(el, combat) {
  const turns = combat.turns ?? [];
  const activeIdx = turns.findIndex(c => combat.combatant?.id === c.id);
  const total = turns.length;

  function nextIdx(offset) {
    if (total === 0 || activeIdx < 0) return -1;
    return (activeIdx + offset) % total;
  }
  const nextI  = nextIdx(1);
  const next2I = nextIdx(2);

  function toCard(c, idx) {
    const actor = c.actor ?? game.actors.get(c.actorId);
    const tokenSrc = c.token?.texture?.src;
    const actorSrc = actor?.img;
    const img = (tokenSrc && !tokenSrc.includes("mystery-man") ? tokenSrc : null)
             || (actorSrc  && !actorSrc.includes("mystery-man")  ? actorSrc  : null)
             || tokenSrc || actorSrc || "icons/svg/mystery-man.svg";
    const init  = c.initiative !== null && c.initiative !== undefined
      ? String(c.initiative) : "?";
    return _carouselCardHtml({
      img, name: c.name || actor?.name || "???",
      initLabel: init,
      isActive:   idx === activeIdx,
      isNext:     idx === nextI  && idx !== activeIdx,
      isNextTwo:  idx === next2I && idx !== activeIdx && idx !== nextI,
      isDefeated: c.defeated,
      mode: "combat",
      combatantId: c.id,
      actorId: c.actorId,
      actor
    });
  }
  el.innerHTML = turns.map(toCard).join("");
  _bindVNECarouselEvents(el);

  // Auto-scroll: bring the active card into view (centered)
  requestAnimationFrame(() => {
    const activeCard = el.querySelector(".vne-carousel-active");
    if (activeCard) {
      const elLeft   = el.getBoundingClientRect().left;
      const cardLeft = activeCard.getBoundingClientRect().left;
      const cardCenter = cardLeft - elLeft + activeCard.offsetWidth / 2;
      const targetScroll = cardCenter - el.clientWidth / 2;
      el.scrollTo({ left: el.scrollLeft + targetScroll, behavior: "smooth" });
    }
  });
}

function _renderVNECarouselVNMode(el, d) {
  const all = [...(d.leftCast ?? []).map(p => ({ p, side: "left" })),
               ...(d.rightCast ?? []).map(p => ({ p, side: "right" }))];
  function toCard({ p, side }) {
    const actor = game.actors.get(p.id);
    const img   = getPortraitImg(p) || actor?.img || "icons/svg/mystery-man.svg";
    return _carouselCardHtml({
      img, name: p.name || actor?.name || "???",
      initLabel: null,
      isActive:   isOnStage(p.id, d),
      isDefeated: false,
      mode: "vn",
      actorId: p.id,
      side,
      actor
    });
  }
  el.innerHTML = all.map(toCard).join("");
  _bindVNECarouselEvents(el);
}

function _bindVNECarouselEvents(carouselEl) {
  carouselEl.querySelectorAll(".vne-carousel-item").forEach(el => {
    el.addEventListener("click",       _onVNECarouselClick);
    el.addEventListener("contextmenu", _onVNECarouselContextMenu);
  });
}

function _onVNECarouselClick(event) {
  event.stopPropagation();
  const el   = event.currentTarget;
  const mode = el.dataset.mode;

  if (mode === "combat") {
    const combatant = game.combat?.combatants?.get(el.dataset.combatantId);
    if (!combatant) return;
    const token = canvas.tokens?.placeables?.find(
      t => t.document?.id === combatant.tokenId || t.id === combatant.tokenId
    );
    if (token) {
      token.control({ releaseOthers: true });
      canvas.animatePan({ x: token.x, y: token.y, duration: 250 });
    }
  } else {
    const actorId = el.dataset.actorId;
    const tokens  = canvas.tokens?.placeables?.filter(t => t.actor?.id === actorId) ?? [];
    if (tokens.length) {
      tokens[0].control({ releaseOthers: true });
      canvas.animatePan({ x: tokens[0].x, y: tokens[0].y, duration: 250 });
    }
  }
}

function _closeVNECarouselMenu() {
  document.getElementById("vne-carousel-menu")?.remove();
}

function _onVNECarouselContextMenu(event) {
  event.preventDefault();
  event.stopPropagation();
  const el   = event.currentTarget;
  const mode = el.dataset.mode;
  const actorId = mode === "combat"
    ? (game.combat?.combatants?.get(el.dataset.combatantId)?.actorId ?? null)
    : el.dataset.actorId;
  if (!actorId) return;
  _openVNContextMenu(actorId, el, { mode, combatantId: el.dataset.combatantId });
}

// ── Shared context menu for carousel, side panels, and RP stage slots ──────

function _openVNContextMenu(actorId, anchorEl, { mode = "vn", combatantId = null, editMode = false } = {}) {
  _closeVNECarouselMenu();

  const actor     = game.actors.get(actorId);
  const d         = getData();
  const inLeft    = d.leftCast.some(p => p.id === actorId);
  const inRight   = d.rightCast.some(p => p.id === actorId);
  const onStage   = isOnStage(actorId, d);
  const inVN      = inLeft || inRight;
  const inCombat  = (mode === "combat" || d.combatMode) && !!game.combat?.combatants.find(c => c.actorId === actorId);
  const canCtrl   = game.user.isGM || !!actor?.isOwner;

  const items = [];
  items.push({ label: "Open character sheet", icon: "fas fa-id-card",      action: "sheet" });
  items.push({ label: "Select as target",     icon: "fas fa-hand-pointer", action: "select" });

  // Stage controls (available to owner and GM)
  if (inVN && canCtrl) {
    items.push({ separator: true });
    if (onStage) {
      items.push({ label: "Remove from stage", icon: "fas fa-users-slash", action: "removeFromStage" });
    } else {
      items.push({ label: "Add to stage",      icon: "fas fa-users",       action: "addToStage" });
    }
  }

  if (game.user.isGM) {
    items.push({ separator: true });
    if (inCombat) {
      items.push({ label: "Roll Initiative", icon: "fas fa-dice-d20", action: "rollInit" });
    }
    if (!inVN) {
      items.push({ label: "Add to VN (left)",  icon: "fas fa-user-plus",  action: "addVNLeft" });
      items.push({ label: "Add to VN (right)", icon: "fas fa-user-plus",  action: "addVNRight" });
    } else {
      items.push({ label: "Remove from VN",    icon: "fas fa-user-minus", action: "removeVN" });
    }
    if (inCombat) {
      items.push({ label: "Remove from combat", icon: "fas fa-skull",     action: "removeCombat" });
    }
    if (inVN) {
      items.push({ separator: true });
      items.push({ label: "Edit portrait",      icon: "fas fa-sliders-h", action: "editPortrait" });
    }
  }

  const menu = document.createElement("div");
  menu.id = "vne-carousel-menu";
  menu.innerHTML = items.map(item =>
    item.separator
      ? `<div class="vne-carousel-separator"></div>`
      : `<div class="vne-carousel-menu-item" data-action="${item.action}"><i class="${item.icon}"></i> ${item.label}</div>`
  ).join("");

  menu.addEventListener("click", async (e) => {
    const action = e.target.closest(".vne-carousel-menu-item")?.dataset.action;
    if (!action) return;
    _closeVNECarouselMenu();

    if (action === "sheet") {
      actor?.sheet?.render(true);
    } else if (action === "select") {
      targetActorToken(actorId);
    } else if (action === "addToStage") {
      await addToStage(actorId);
    } else if (action === "removeFromStage") {
      await removeFromStage(actorId);
    } else if (action === "rollInit") {
      const combatant = game.combat?.combatants?.find(c => c.actorId === actorId);
      if (combatant) await game.combat.rollInitiative([combatant.id]);
    } else if (action === "addVNLeft") {
      const d2 = getData();
      if (!d2.leftCast.some(p => p.id === actorId)) {
        const saved = d2.portraits[actorId];
        const portrait = (saved?.img) ? { ...saved } : defaultPortrait(actor);
        if (!portrait) { ui.notifications?.warn("VNE: Actor not found."); return; }
        if (d2.leftCast.length >= 10) d2.leftCast.shift();
        d2.leftCast.push(portrait);
        d2.portraits[actorId] = portrait;
        await saveData(d2, { change: "castChange" });
      }
      if (d2.combatMode && game.user.isGM) await ensureActiveEncounterForVNE();
    } else if (action === "addVNRight") {
      const d2 = getData();
      if (!d2.rightCast.some(p => p.id === actorId)) {
        const saved = d2.portraits[actorId];
        const portrait = (saved?.img) ? { ...saved } : defaultPortrait(actor);
        if (!portrait) { ui.notifications?.warn("VNE: Actor not found."); return; }
        if (d2.rightCast.length >= 10) d2.rightCast.shift();
        d2.rightCast.push(portrait);
        d2.portraits[actorId] = portrait;
        await saveData(d2, { change: "castChange" });
      }
      if (d2.combatMode && game.user.isGM) await ensureActiveEncounterForVNE();
    } else if (action === "removeVN") {
      const d2 = getData();
      d2.leftCast    = d2.leftCast.filter(p => p.id !== actorId);
      d2.rightCast   = d2.rightCast.filter(p => p.id !== actorId);
      d2.stagePlayers = d2.stagePlayers.filter(id => id !== actorId);
      d2.stageNPCs    = d2.stageNPCs.filter(id => id !== actorId);
      await saveData(d2, { change: "castChange" });
    } else if (action === "removeCombat") {
      const combatant = game.combat?.combatants?.find(c => c.actorId === actorId);
      if (combatant) {
        await game.combat.deleteEmbeddedDocuments("Combatant", [combatant.id]);
      }
    } else if (action === "editPortrait") {
      const side = inLeft ? "left" : inRight ? "right" : null;
      openPortraitEditor(actorId, side);
    }
  });

  document.body.appendChild(menu);
  const rect = anchorEl.getBoundingClientRect();
  menu.style.left = `${Math.min(rect.left, window.innerWidth  - 230)}px`;
  menu.style.top  = `${Math.min(rect.bottom + 4, window.innerHeight - 260)}px`;
  setTimeout(() => document.addEventListener("click", _closeVNECarouselMenu, { once: true }), 0);
}

// Carousel combat hooks
Hooks.on("createCombatant",  renderVNECombatCarousel);
Hooks.on("deleteCombatant",  renderVNECombatCarousel);
Hooks.on("updateCombatant",  (combatant, changes) => {
  // Save snapshot before potential deleteCombat wipes turns — only trust active scene's combat
  if (combatant.combat?.turns && combatant.combat === game.combat) {
    _lastCombatTurns = combatant.combat.turns.map(c => ({ actorId: c.actorId, defeated: c.defeated }));
  }
  renderVNECombatCarousel();
  if (changes.defeated === true) _checkVictoryCondition(_lastCombatTurns);
});
Hooks.on("deleteCombat",     () => {
  _stopTurnTimer();
  renderVNECombatCarousel();
  _checkVictoryCondition(_lastCombatTurns); // use pre-delete snapshot
  _lastCombatTurns = [];                    // clear after use
});
Hooks.on("createCombat",     () => {
  _lastCombatTurns = [];
  renderVNECombatCarousel();
});

// Live HP / status effect updates (debounced 80 ms)
let _vneCarouselTimer = null;
function _scheduleCarousel() {
  clearTimeout(_vneCarouselTimer);
  _vneCarouselTimer = setTimeout(renderVNECombatCarousel, 80);
}
Hooks.on("updateActor", (actor, changes) => {
  _scheduleCarousel();

  const hpChanged = changes?.system?.attributes?.hp !== undefined;
  if (hpChanged) {
    const hp    = actor.system?.attributes?.hp?.value ?? null;
    const hpMax = actor.system?.attributes?.hp?.max   ?? null;
    const d = getData();
    let vsChanged = false;
    if (_vsLeft  && d.leftCast.some(p => p.id === actor.id))  { _vsLeft  = { ..._vsLeft,  hp, hpMax }; vsChanged = true; }
    if (_vsRight && d.rightCast.some(p => p.id === actor.id)) { _vsRight = { ..._vsRight, hp, hpMax }; vsChanged = true; }
    if (vsChanged) _renderVSDisplay();
    clearTimeout(_autoReactionTimers.get(actor.id));
    _autoReactionTimers.set(actor.id, setTimeout(() => {
      _autoReactionTimers.delete(actor.id);
      _applyAutoReaction(actor.id);
    }, 150));
  }

  // ── Damage Floaters + Hit Shake ─────────────────────────────────────────────
  const newHpValue = changes?.system?.attributes?.hp?.value
                  ?? changes?.system?.hp?.value;          // fallback for simpler systems
  if (newHpValue !== undefined) {
    const d = getData();
    const inCast = d.showVN && d.combatMode
      && ([...d.leftCast, ...d.rightCast].some(p => p.id === actor.id));

    if (inCast) {
      const oldHp = _lastKnownHP.get(actor.id);
      _lastKnownHP.set(actor.id, newHpValue);
      if (oldHp !== undefined && oldHp !== newHpValue) {
        const delta  = newHpValue - oldHp;
        const isCrit = _nextHpChangeCrit.has(actor.id);
        if (isCrit) _nextHpChangeCrit.delete(actor.id);
        if (delta < 0) _applyPortraitHitShake(actor.id, isCrit);
        // Defer floater 300ms — PF2e posts an appliedDamage chat message shortly after
        // the actor update; the createChatMessage hook will override with the raw amount.
        const existing = _pendingFloaters.get(actor.id);
        if (existing) clearTimeout(existing.timerId);
        const timerId = setTimeout(() => {
          _pendingFloaters.delete(actor.id);
          _showDamageFloater(actor.id, delta, isCrit);
        }, 300);
        _pendingFloaters.set(actor.id, { delta, isCrit, timerId });
      }
    } else {
      // Keep map up-to-date even when not in cast (actor might be added later)
      _lastKnownHP.set(actor.id, newHpValue);
    }

    // Token state swap (merged from duplicate hook)
    const states = actor.getFlag(ID, "tokenStates");
    if (states) {
      const max = actor.system?.attributes?.hp?.max ?? 1;
      const pct = (newHpValue / max) * 100;
      const key = pct > 75 ? "normal" : pct > 50 ? "hurt" : pct > 25 ? "wounded" : "crit";
      const img = states[key];
      if (img) {
        const tokens = canvas.tokens?.placeables?.filter(t => t.actor?.id === actor.id) ?? [];
        tokens.forEach(t => t.document.update({ "texture.src": img }));
      }
    }
  }
});
Hooks.on("updateToken",       _scheduleCarousel);
Hooks.on("createActiveEffect",_scheduleCarousel);
Hooks.on("deleteActiveEffect",_scheduleCarousel);
Hooks.on("updateActiveEffect",_scheduleCarousel);

// ── Boot ─────────────────────────────────────────────────────────────────────

Hooks.once("init", () => {
  registerSettings();

  // Register keybinding (Alt+V)
  try {
    game.keybindings.register(ID, "toggleVN", {
      name: "Toggle VN window",
      editable: [{ key: "KeyV", modifiers: ["Alt"] }],
      onUp: () => {
        if (game.user.isGM) {
          VNE.toggle();
        } else {
          _playerLocalHidden = !_playerLocalHidden;
          const main = document.getElementById("vne-main");
          if (_playerLocalHidden) {
            main?.style.setProperty("display", "none", "important");
          } else {
            main?.style.removeProperty("display");
            main?.classList.remove("vne-hidden");
          }
        }
      }
    });
  } catch(e) {
    console.warn("vnd-enhanced | keybinding registration failed:", e);
  }
});

// ── Setup: license gate + socket + activation ─────────────────────────────────
// Single async hook so the license check completes BEFORE VNE.activate() runs.
// Non-GM players never call initialize() — they read the world-level flag the GM wrote.
Hooks.once("setup", async () => {
  // Restore per-client timer preferences from localStorage
  const savedMinutes = parseInt(localStorage.getItem("vne-timerMinutes") ?? "") || 2;
  const savedAuto    = localStorage.getItem("vne-timerAutoReset") === "1";
  _timerMinutes   = savedMinutes;
  _timerAutoReset = savedAuto;

  // Socket handler (lets players trigger GM-side saves)
  game.socket.on(`module.${ID}`, async (msg) => {
    // SECURITY NOTE: msg.senderId is client-supplied and cannot be authenticated
    // without socketlib. All handlers validate server-side game state instead of
    // trusting the senderId field.

    // vnVictory — broadcast to all clients when VN is active
    if (msg.type === "vnVictory") {
      // Guard with server-side state: module must be licensed and VN visible
      if (!game.settings.get(ID, "worldLicensed")) return;
      if (!getData().showVN) return;
      _showVictoryOverlay();
      return;
    }

    // vnProjectile — CSS projectile animation broadcast to all clients
    if (msg.type === "vnProjectile") {
      if (!game.settings.get(ID, "worldLicensed")) return;
      if (!getData().showVN) return;
      // Validate file has a safe media extension (prevents arbitrary URL injection)
      const safeFile = (typeof msg.file === "string" &&
        /\.(webm|gif|mp4|png|jpg|jpeg|webp)$/i.test(msg.file)) ? msg.file : null;
      if (!safeFile) return;
      const durationMs = (typeof msg.durationMs === "number" && isFinite(msg.durationMs))
        ? Math.min(Math.max(msg.durationMs, 100), 5000) : 800;
      const srcPos = _getPortraitScreenCenter(msg.sourceActorId);
      const tgtPos = _getPortraitScreenCenter(msg.targetActorId);
      if (srcPos && tgtPos) {
        _renderProjectileCSS(srcPos, tgtPos, safeFile, { durationMs });
      }
      return;
    }

    // All other message types are GM-side operations
    if (!game.user.isGM) return;

    if (msg.type === "vnReaction") {
      const actor = game.actors.get(msg.actorId);
      if (!actor) return;
      // senderId cannot be trusted — verify the actor is in the GM-controlled cast
      // and _applyReaction whitelists reactionName against GM-defined reactions
      const d = getData();
      const inCast = [...d.leftCast, ...d.rightCast].some(p => p.id === msg.actorId);
      if (!inCast) return;
      _applyReaction(d, msg.actorId, msg.reactionName);
      await game.settings.set(ID, "vnData", d, { change: "castChange" });
      return;
    }

    if (msg.type === "vnAddToStage" || msg.type === "vnRemoveFromStage") {
      const actor = game.actors.get(msg.actorId);
      if (!actor) return;
      // senderId cannot be trusted — verify the actor has at least one non-GM owner
      // (ensures only player-owned actors can be stage-toggled via socket)
      const hasPlayerOwner = Object.entries(actor.ownership)
        .some(([userId, lvl]) => lvl >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER &&
          !game.users.get(userId)?.isGM);
      if (!hasPlayerOwner) return;
      if (msg.type === "vnAddToStage")    await addToStage(msg.actorId);
      else                                await removeFromStage(msg.actorId);
      return;
    }
    // vnDataSet removed — direct data injection is no longer permitted
  });

  // ── License gate ────────────────────────────────────────────────────────────
  if (game.user?.isGM) {
    const licensed = await VndLicenseClient.instance.initialize();
    if (licensed) {
      // Confirmed active — write true so players can read it
      try { await game.settings.set(ID, "worldLicensed", true); } catch { /* ignore */ }
    } else {
      // Tokens missing or expired — show re-auth prompt.
      // Do NOT write false here: the persisted flag stays true if set in a prior session
      // (heartbeat and releaseInstallation are the only valid ways to revoke it).
      Hooks.once("ready", () => VndLicenseUI.show());
    }
  }

  // All clients: activate only if the world flag is true
  const worldLicensed = game.settings.get(ID, "worldLicensed") ?? false;
  if (!worldLicensed) return;

  VNE.activate();
});

Hooks.on("ready", () => {
  // FAB always injected — when unlicensed, clicking it opens the license prompt
  VNE._injectToggleButton();
  _initSequencerHook();
  _initAAHook();
  // Seed HP baselines so the first damage event in a session shows floaters correctly
  _seedCastHP();

  // Safety net: activate VNE for clients that missed the setup hook activation.
  // This covers the race condition where worldLicensed=true was already persisted and
  // the setup hook completed before the setting was readable by non-GM clients.
  if (!VNE.instance && game.settings.get(ID, "worldLicensed")) {
    VNE.activate();
  }

  // Rich API for macros and Active Tile Triggers
  globalThis.VNEnhanced = {
    // License
    license: VndLicenseClient.instance,
    hasFeature: (f) => VndLicenseClient.instance.hasFeature(f),
    // Open/close
    toggle:       (showForIds = null) => VNE.toggle(showForIds),
    show:         async (userIds = null) => {
      const d = getData(); d.showVN = true; d.showForIds = userIds ?? null;
      await saveData(d, { change: "showVN" });
    },
    hide:         async () => {
      const d = getData(); d.showVN = false;
      await saveData(d, { change: "showVN" });
    },
    // Scene switching — by scene id or name
    setScene:     async (idOrName) => {
      const d = getData();
      const loc = d.locationList.find(l => l.id === idOrName || l.name === idOrName);
      if (!loc) { console.warn(`VNEnhanced | scene not found: "${idOrName}"`); return; }
      d.location = { ...loc };
      await saveData(d, { change: "location" });
    },
    setBackground: async (path) => {
      const d = getData(); d.location.backgroundImage = path;
      await saveData(d, { change: "location" });
    },
    // Speaker control
    setSpeaker:   async (actorId) => {
      if (actorId) await addToStage(actorId);
    },
    clearSpeaker: async () => {
      const d = getData(); d.stagePlayers = []; d.stageNPCs = [];
      await saveData(d, { change: "stageChange" });
    },
    // Reaction / expression
    setReaction:  (actorId, reactionName) => setReaction(actorId, reactionName),
    // Cast management
    addActor:     async (actorId, side = "left") => {
      if (!["left", "right"].includes(side)) { console.warn(`VNEnhanced | addActor: invalid side "${side}"`); return; }
      const actor = game.actors.get(actorId);
      if (!actor) return;
      const d = getData();
      const key = `${side}Cast`;
      if (!d[key].some(p => p.id === actorId)) {
        const portrait = d.portraits[actorId]
          ? { ...d.portraits[actorId] }
          : defaultPortrait(actor);
        if (d[key].length >= 5) d[key].shift();
        d[key].push(portrait);
        d.portraits[actorId] = portrait;
      }
      await saveData(d, { change: "castChange" });
      if (d.combatMode && game.user.isGM) await ensureActiveEncounterForVNE();
    },
    removeActor:  async (actorId) => {
      const d = getData();
      d.leftCast    = d.leftCast.filter(p => p.id !== actorId);
      d.rightCast   = d.rightCast.filter(p => p.id !== actorId);
      d.stagePlayers = d.stagePlayers.filter(id => id !== actorId);
      d.stageNPCs    = d.stageNPCs.filter(id => id !== actorId);
      await saveData(d, { change: "castChange" });
    },
    clearCast:    async () => {
      const d = getData();
      d.leftCast = []; d.rightCast = []; d.stagePlayers = []; d.stageNPCs = [];
      await saveData(d, { change: "castChange" });
    },
    // Read state
    getState:     () => getData(),
    // Combat stage
    setCombatMode: async (on) => {
      const d = getData(); d.combatMode = !!on;
      if (d.combatMode) {
        const combat = await ensureActiveEncounterForVNE();
        if (!combat) {
          d.combatMode = false;
          ui.notifications?.warn("VNEnhanced | setCombatMode: could not create encounter.");
          return;
        }
      }
      await saveData(d, { change: "combatMode" });
    },
    targetActor:  (actorId) => targetActorToken(actorId),
    showActionImage: (data) => _showActionImageOverlay(data),
    // Ghost Token Bridge — VFX on VN portraits
    playEffect:    (actorId, file, opts = {}) =>
      _playVNEScreenEffect(actorId, file, opts),
    playProjectile: (sourceActorId, targetActorId, file, opts = {}) => {
      const srcPos = _getPortraitScreenCenter(sourceActorId);
      const tgtPos = _getPortraitScreenCenter(targetActorId);
      if (!srcPos || !tgtPos) return;
      _renderProjectileCSS(srcPos, tgtPos, file, opts);
      game.socket.emit(`module.${ID}`, {
        type:          "vnProjectile",
        senderId:      game.user.id,
        sourceActorId,
        targetActorId,
        file,
        durationMs:    opts.durationMs ?? 800,
      });
    },
    playExplosion: (actorId, file, opts = {}) =>
      _playVNEScreenEffect(actorId, file, { scale: 2.0, ...opts }),
    playBuff:      (actorId, file, opts = {}) =>
      _playVNEScreenEffect(actorId, file, { scale: 1.2, ...opts }),
    playDebuff:    (actorId, file, opts = {}) =>
      _playVNEScreenEffect(actorId, file, { scale: 1.2, ...opts }),
    getGhostToken: (actorId) => getGhostTokenDoc(actorId),
    isGhostToken:  (tokenDocOrId) => {
      const id = typeof tokenDocOrId === "string" ? tokenDocOrId : tokenDocOrId?.id;
      return id ? [..._ghostTokens.values()].some(doc => doc.id === id) : false;
    },
    // Edit mode
    setEditMode: async (on) => {
      if (!game.user.isGM) return;
      const d = getData(); d.editMode = !!on;
      await saveData(d, { change: "editMode" });
    },
    // Spotlight mode
    spotlight:      (actorId) => _enterSpotlight(actorId),
    exitSpotlight:  () => _exitSpotlight(),
    // Cast Presets
    openCastPresets: () => openCastPresetsDialog(),
    saveCastPreset: async (name) => {
      if (!game.user.isGM || !name) return;
      const d = getData();
      const presets = _getCastPresets();
      presets[name] = {
        leftCast:  foundry.utils.deepClone(d.leftCast),
        rightCast: foundry.utils.deepClone(d.rightCast),
        portraits: foundry.utils.deepClone(d.portraits),
        savedAt:   new Date().toISOString()
      };
      await _saveCastPresets(presets);
    },
    loadCastPreset: async (name) => {
      if (!game.user.isGM || !name) return;
      const presets = _getCastPresets();
      const p = presets[name];
      if (!p) { console.warn(`VNEnhanced | preset not found: "${name}"`); return; }
      const d = getData();
      d.leftCast  = p.leftCast  ?? [];
      d.rightCast = p.rightCast ?? [];
      d.portraits = { ...d.portraits, ...(p.portraits ?? {}) };
      d.stagePlayers = []; d.stageNPCs = [];
      await saveData(d, { change: "castChange" });
    },
    getCastPresets: () => _getCastPresets(),
  };
});

// Helper: get base actor ID from a token (works for linked AND unlinked tokens, v11-v13)
function _tokenActorId(token) {
  return token?.document?.actorId  // PlaceableObject in v11/v12/v13
      ?? token?.actorId            // TokenDocument in v13
      ?? token?.data?.actorId      // v11 fallback
      ?? token?.actor?.id          // last resort (may be synthetic for unlinked tokens)
      ?? null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEQUENCER VFX INTEGRATION
// Plays JB2A/Sequencer animations on VN portraits when effects fire in canvas.
// ═══════════════════════════════════════════════════════════════════════════════

function _initSequencerHook() {
  if (!game.modules.get("sequencer")?.active) return;

  Hooks.on("createSequencerEffect", (effect) => {
    try {
      const d = getData();
      if (!d.showVN) return;

      // Skip screen-space effects that VNE itself generated — prevents double-play
      if (effect?.data?.screenSpaceAboveUI) return;

      // ── File resolution ──────────────────────────────────────────────────
      let file = effect?.data?.file ?? effect?.file;
      if (!file) return;

      // Sequencer may store a database path (no extension) — resolve it
      if (!/\.(webm|gif|mp4)$/i.test(file)) {
        try {
          const db = window.Sequencer?.Database ?? globalThis.Sequencer?.Database;
          const entry = db?.getEntry?.(file);
          if (!entry) return;
          const f = Array.isArray(entry)
            ? (entry[0]?.file ?? entry[0])
            : (entry?.file ?? entry?.files?.[0] ?? null);
          if (!f || !/\.(webm|gif|mp4)$/i.test(f)) return;
          file = f;
        } catch { return; }
      }

      const _rawDur = effect?.data?.duration ?? effect?.duration;
      const durationMs = (typeof _rawDur === "number" && isFinite(_rawDur) && _rawDur > 0) ? _rawDur : 2000;
      const allCast    = [...(d.leftCast ?? []), ...(d.rightCast ?? [])];

      // ── Detect projectile (stretchTo present) vs overlay (attachTo/source only) ─
      const stretchRef    = effect?.data?.stretchTo;
      const sourceRef     = effect?.data?.source ?? effect?.data?.attachTo ?? effect?.source;
      const sourceActorId = _actorIdFromSeqRef(sourceRef);
      const stretchActorId = stretchRef ? _actorIdFromSeqRef(stretchRef) : null;

      const isSourceInCast  = sourceActorId  && allCast.some(p => p.id === sourceActorId);
      const isStretchInCast = stretchActorId && allCast.some(p => p.id === stretchActorId);

      if (stretchRef && (isSourceInCast || isStretchInCast)) {
        // ── PROJECTILE PATH ─────────────────────────────────────────────────
        const srcPos = isSourceInCast  ? _getPortraitScreenCenter(sourceActorId)  : null;
        const tgtPos = isStretchInCast ? _getPortraitScreenCenter(stretchActorId) : null;

        if (srcPos && tgtPos) {
          _renderProjectileCSS(srcPos, tgtPos, file, { durationMs: Math.min(durationMs, 1200) });
        } else if (srcPos) {
          _playVNEScreenEffect(sourceActorId,  file, { durationMs, scale: 1.2 });
        } else if (tgtPos) {
          _playVNEScreenEffect(stretchActorId, file, { durationMs, scale: 1.2 });
        }
        return;
      }

      // ── OVERLAY PATH — collect all actor refs in this effect ─────────────
      const actorIds   = new Set();
      const candidates = [
        effect?.data?.source,
        effect?.data?.target,
        effect?.data?.attachTo,
        effect?.data?.stretchTo,
        effect?.source,
        effect?.target,
      ];
      if (Array.isArray(effect?.data?.targets)) candidates.push(...effect.data.targets);

      for (const ref of candidates) {
        const id = _actorIdFromSeqRef(ref);
        if (id) actorIds.add(id);
      }
      if (!actorIds.size) return;

      for (const actorId of actorIds) {
        if (allCast.some(p => p.id === actorId)) {
          _playVNEScreenEffect(actorId, file, { durationMs, scale: 1.5 });
        }
      }
    } catch (e) {
      console.warn("VNE | Sequencer VFX error:", e);
    }
  });
}

// Extracts an Actor ID from any Sequencer reference format:
// UUID string, TokenDocument, CanvasEffect, or { id, uuid } objects.
function _actorIdFromSeqRef(ref) {
  if (!ref) return null;
  if (typeof ref === "string") return _actorIdFromSeqUuid(ref);
  // Already a resolved document or placeable
  if (ref.actor?.id) return ref.actor.id;
  if (ref.actorId)   return ref.actorId;
  // { id: string } — Sequencer attachTo/stretchTo format
  if (typeof ref.id === "string") {
    return ref.id.includes(".")
      ? _actorIdFromSeqUuid(ref.id)
      : _actorIdFromTokenDocId(ref.id);
  }
  if (ref.uuid)           return _actorIdFromSeqUuid(ref.uuid);
  if (ref.document?.uuid) return _actorIdFromSeqUuid(ref.document.uuid);
  return null;
}

// Resolves a full Foundry UUID (e.g. "Scene.X.Token.Y") to an Actor ID.
function _actorIdFromSeqUuid(uuid) {
  if (!uuid) return null;
  try {
    const doc = (typeof fromUuidSync === "function") ? fromUuidSync(uuid) : null;
    if (doc) return doc.actor?.id ?? doc.actorId ?? null;
    // Fallback for "Scene.X.Token.Y" format
    const parts = uuid.split(".");
    if (parts.includes("Token")) {
      const tokenId = parts[parts.indexOf("Token") + 1];
      const sceneId = parts[parts.indexOf("Scene") + 1];
      const token   = game.scenes.get(sceneId)?.tokens.get(tokenId);
      return token?.actor?.id ?? token?.actorId ?? null;
    }
    return null;
  } catch { return null; }
}

// Resolves a plain TokenDocument ID to an Actor ID via the active canvas.
function _actorIdFromTokenDocId(tokenDocId) {
  if (!tokenDocId) return null;
  const tok = canvas?.tokens?.get?.(tokenDocId)
           ?? game.scenes?.current?.tokens?.get?.(tokenDocId);
  return tok?.actor?.id ?? tok?.actorId ?? null;
}

function _playVNFx(actorId, file, durationMs, d) {
  const isLeft  = (d.leftCast ?? []).some(p => p.id === actorId);
  const isRight = (d.rightCast ?? []).some(p => p.id === actorId);

  // VS display sides (most prominent in combat)
  if (isLeft)  _attachVNFxOverlay(document.querySelector(".vne-vs-left"),  file, durationMs);
  if (isRight) _attachVNFxOverlay(document.querySelector(".vne-vs-right"), file, durationMs);

  // Side panel portrait card
  _attachVNFxOverlay(
    document.querySelector(`.vne-cast-portrait[data-id="${actorId}"]`),
    file, durationMs
  );

  // RP stage slot
  _attachVNFxOverlay(
    document.querySelector(`.vne-rp-slot[data-id="${actorId}"]`),
    file, durationMs
  );
}

function _attachVNFxOverlay(container, file, durationMs) {
  if (!container) return;

  // Avoid stacking duplicate overlays for the same file
  if (container.querySelector(`.vne-fx-overlay[data-file="${CSS.escape(file)}"]`)) return;

  const overlay = document.createElement("div");
  overlay.className = "vne-fx-overlay";
  overlay.dataset.file = file;

  const video = document.createElement("video");
  video.src         = file;
  video.autoplay    = true;
  video.muted       = true;
  video.loop        = false;
  video.playsInline = true;
  video.className   = "vne-fx-video";

  overlay.appendChild(video);
  container.appendChild(overlay);

  const cleanup = () => overlay.remove();
  video.addEventListener("ended", cleanup);
  // Fallback: remove after duration + 600ms buffer
  setTimeout(cleanup, (durationMs ?? 2000) + 600);
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTOMATED ANIMATIONS HOOK — CAPA 1 bridge
// Swaps source/target tokens with ghost tokens so AA's getSize() and attachTo()
// have real TokenDocuments when VN combat stage is active.
// ═══════════════════════════════════════════════════════════════════════════════

function _initAAHook() {
  if (!game.modules.get("autoanimations")?.active) return;

  // Pre-create a ghost token when any actor sheet opens and the actor has no real
  // canvas token. This prevents "Could not determine where to play the effect!" errors
  // from Automated Animations/Sequencer when rolling from custom sheets.
  Hooks.on("renderActorSheet", async (sheet) => {
    if (!game.user.isGM || !canvas.scene) return;
    const actor = sheet.actor;
    if (!actor?.id) return;
    const hasRealToken = canvas.tokens?.placeables?.some(
      t => (t.document?.actorId ?? t.actor?.id) === actor.id
        && !t.document?.flags?.[ID]?.isGhost
    );
    if (!hasRealToken && !_ghostTokens.has(actor.id)) {
      await _createGhostToken(actor.id);
    }
  });

  // Clean up ghost tokens created for sheet support when the sheet closes,
  // but only if the actor is NOT in the active VN cast (those are managed separately).
  Hooks.on("closeActorSheet", async (sheet) => {
    if (!game.user.isGM) return;
    const actor = sheet.actor;
    if (!actor?.id) return;
    const d = getData();
    const inVNCast = [...(d.leftCast ?? []), ...(d.rightCast ?? [])].some(p => p.id === actor.id);
    if (inVNCast) return;
    const doc = _ghostTokens.get(actor.id);
    if (!doc) return;
    _ghostTokens.delete(actor.id);
    if (doc.id && canvas.scene) {
      try { await canvas.scene.deleteEmbeddedDocuments("Token", [doc.id]); } catch { /* ignore */ }
    }
  });

  Hooks.on("aa.getRequiredData", (data) => {
    try {
      // For any actor with no real canvas token, redirect AA to its ghost token.
      // Works regardless of VN/combat mode — ghost tokens may exist from sheet-open
      // pre-creation (above) or from the VN combat sync system.
      const _hasRealToken = (actorId) => !!canvas.tokens?.placeables?.some(
        t => (t.document?.actorId ?? t.actor?.id) === actorId
          && !t.document?.flags?.[ID]?.isGhost
      );

      if (data.sourceToken) {
        const srcActorId = _tokenActorId(data.sourceToken);
        if (srcActorId && !_hasRealToken(srcActorId)) {
          const ghostObj = getGhostTokenObject(srcActorId);
          if (ghostObj) data.sourceToken = ghostObj;
          else _createGhostToken(srcActorId); // fire-and-forget: ready for the next roll
        }
      }

      if (Array.isArray(data.allTargets)) {
        data.allTargets = data.allTargets.map(t => {
          const actorId = _tokenActorId(t);
          if (!actorId || _hasRealToken(actorId)) return t;
          const ghostObj = getGhostTokenObject(actorId);
          if (!ghostObj) _createGhostToken(actorId); // fire-and-forget
          return ghostObj ?? t;
        });
      }
    } catch (e) {
      console.warn("VNE | AA hook error:", e);
    }
  });
}

// Refresh targeted portrait ring when user targeting changes
Hooks.on("targetToken", (user, token, targeted) => {
  if (user.id !== game.user.id) return;
  const d = getData();
  if (!d.showVN || !d.combatMode) return;
  // Refresh right-panel portrait target classes without full re-render
  const targetedIds = new Set(
    [...(game.user.targets ?? [])].map(t => _tokenActorId(t)).filter(Boolean)
  );
  document.querySelectorAll(".vne-cast-portrait[data-side='right']").forEach(el => {
    el.classList.toggle("vne-targeted", targetedIds.has(el.dataset.id));
  });
  // Targeted actor goes "al frente" on their own side — persists until next turn or new target
  if (targeted) {
    const actorId = _tokenActorId(token);
    if (actorId) {
      if (d.rightCast.some(p => p.id === actorId))      _updateVSOnTarget(actorId, "right");
      else if (d.leftCast.some(p => p.id === actorId))  _updateVSOnTarget(actorId, "left");
    }
  }
});

// PF2e applied-damage intercept — override the pending floater with raw damage amount.
// PF2e posts a chat message with flags.pf2e.appliedDamage shortly after the actor HP
// update, so we can correct the overkill-clamped HP delta with the actual damage dealt.
Hooks.on("createChatMessage", (message) => {
  const pf2eApplied = message.flags?.pf2e?.appliedDamage;
  if (pf2eApplied) {
    const targetId = pf2eApplied.actorId
                  ?? pf2eApplied.updates?.[0]?.actorId
                  ?? null;
    // total is always a positive number in PF2e; isHealing flips the sign
    const rawAmt   = pf2eApplied.total
                  ?? pf2eApplied.updates?.[0]?.finalDamage
                  ?? null;
    if (targetId && rawAmt != null) {
      const pending = _pendingFloaters.get(targetId);
      if (pending) {
        clearTimeout(pending.timerId);
        _pendingFloaters.delete(targetId);
        const rawDelta = pf2eApplied.isHealing ? Math.abs(rawAmt) : -Math.abs(rawAmt);
        _showDamageFloater(targetId, rawDelta, pending.isCrit);
      }
    }
  }
});

// Crit / Fumble detection — fires before updateActor so the flag is ready
Hooks.on("createChatMessage", (message) => {
  const d = getData();
  if (!d.showVN || !d.combatMode) return;

  const critType = _parseCritFromMessage(message);
  if (!critType) return;

  const speakerActorId = message.speaker?.actor ?? null;

  // Suppress rolls that fire automatically at turn start (PF2e processes conditions,
  // persistent damage, aura saves, etc. within ~500ms of a turn change).
  // Manual attack/save rolls always happen after the player has had time to act.
  if (Date.now() - _lastTurnChangeMs < 2500) return;

  // Mark the next HP change for this actor as crit-sourced
  if (speakerActorId) _nextHpChangeCrit.add(speakerActorId);

  // Show the epic overlay immediately for all clients
  _showCriticalAnimation(critType, speakerActorId);
});

// Consolidated updateCombat hook — carousel + display + timer + speaker + whisper + Turn Card
Hooks.on("updateCombat", async (combat, changed) => {
  // Always update snapshot and carousel — only trust the active scene's combat
  if (combat?.turns && combat === game.combat) {
    _lastCombatTurns = combat.turns.map(c => ({ actorId: c.actorId, defeated: c.defeated }));
  }
  renderVNECombatCarousel();

  const d = getData();
  if (!d.showVN || !d.combatMode) return;
  _patchCombatDisplay();

  const turnChanged = changed.turn !== undefined || changed.round !== undefined;

  // Auto-restart timer on new turn
  if (turnChanged) {
    if (_timerAutoReset || _timerEnabled) _startTurnTimer(_timerMinutes);
  }

  if (turnChanged) {
    _lastTurnChangeMs = Date.now();
    _updateVSFromCombat();
    // Persona-style turn card — shown on ALL clients (no socket needed, all have combat state)
    _showTurnCard(combat.combatant);
  }

  // Spotlight whisper — notify player it's their turn
  if (game.user.isGM && turnChanged) {
    const combatant = combat.combatant;
    if (combatant?.actorId) {
      const actor = game.actors.get(combatant.actorId);
      const owner = game.users.find(u => !u.isGM && actor?.testUserPermission(u, "OWNER"));
      if (owner && actor) {
        const portrait = actor.img
          ? `<img src="${_esc(actor.img)}" style="width:48px;height:48px;border-radius:4px;vertical-align:middle;margin-right:8px;" />`
          : "";
        ChatMessage.create({
          content: `${portrait}<strong>${_esc(actor.name)}</strong>, it's your turn!`,
          whisper: [owner.id],
          speaker: { alias: "VND Enhanced" },
          flags: { "vnd-enhanced": { type: "turn-notification" } }
        });
      }
    }
  }

  const controls = document.getElementById("vne-combat-controls");
  if (controls) controls.classList.remove("vne-hidden");
});


Hooks.on("vnd-enhanced.actionImage", (data) => {
  try {
    const d = getData();
    if (!d.showVN) return;
    _showActionImageOverlay(data);
  } catch (e) { /* ignore */ }
});

// Scene toolbar button — compatible with v11/v12/v13
Hooks.on("getSceneControlButtons", (controls) => {
  try {
    if (!game.user.isGM) return;
    // v13: controls is a Map-like object; v11/v12: it is an Array
    const button = {
      name: "openVN",
      title: "Toggle VN (Alt+V)",
      icon: "fas fa-window-maximize",
      visible: true,
      button: true,
      onClick: () => VNE.toggle()
    };
    if (Array.isArray(controls)) {
      // v11/v12 style
      controls.push({
        name: "vndEnhanced",
        title: "VN Dialogues Enhanced",
        icon: "fas fa-users-between-lines",
        layer: "controls",
        tools: [button]
      });
    } else if (controls instanceof Map) {
      // v13+ style
      controls.set("vndEnhanced", {
        name: "vndEnhanced",
        title: "VN Dialogues Enhanced",
        icon: "fas fa-users-between-lines",
        tools: new Map([["openVN", button]])
      });
    }
  } catch(e) {
    // Toolbar registration failed — Alt+V keybinding still works
    console.warn(`vnd-enhanced | toolbar registration failed:`, e);
  }
});

// Remove deleted actors from VN cast so they don't leave zombie entries
Hooks.on("deleteActor", (actor) => {
  if (!game.user.isGM) return;
  const d = getData();
  const id = actor.id;
  let changed = false;
  for (const key of ["leftCast", "rightCast"]) {
    const before = d[key].length;
    d[key] = d[key].filter(p => p.id !== id);
    if (d[key].length !== before) changed = true;
  }
  d.stagePlayers = d.stagePlayers.filter(i => i !== id);
  d.stageNPCs    = d.stageNPCs.filter(i => i !== id);
  if (d.portraits) delete d.portraits[id];
  if (changed) saveData(d, { change: "castChange" });
});

// Refresh ghost tokens when the canvas scene changes (scene navigation or page reload).
// _ghostTokens Map starts empty on every page load, so _destroyGhostTokens() (which
// checks Map.size) would be a no-op, leaving orphaned tokens from the previous session.
// We must scan the scene by flag instead.
Hooks.on("canvasReady", async () => {
  if (!game.user.isGM) return;
  const d = getData();
  if (!d.showVN || !d.combatMode) return;

  // Delete ALL ghost tokens in the scene by flag (covers stale tokens after page reload)
  const scene = canvas.scene;
  if (scene) {
    const staleIds = scene.tokens
      .filter(t => t.flags?.[ID]?.isGhost)
      .map(t => t.id);
    if (staleIds.length) {
      try { await scene.deleteEmbeddedDocuments("Token", staleIds); } catch { /* ignore */ }
    }
  }
  _ghostTokens.clear();
  await _syncGhostTokens(d);
});

// Token state swap logic is now merged into the consolidated updateActor hook above.
