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

const ID = "vnd-enhanced";

// Per-client local hide — non-GM players close/open without affecting others
let _playerLocalHidden    = false;
let _playerLocalUIHidden  = false;

// ── VS Combat Display state ───────────────────────────────────────────────────
// Each side is updated permanently on two events: (a) their turn starts, (b) they are targeted.
// No timers — the most recent event always wins and persists until a new event overwrites it.
let _vsLeft  = null;  // { img, name } — PC shown on left (leftCast)
let _vsRight = null;  // { img, name } — NPC shown on right (rightCast)

// ── Turn timer state ─────────────────────────────────────────────────────────
let _timerInterval  = null;
let _timerSecondsLeft = 0;
let _timerEnabled   = false;
let _timerMinutes   = 2;

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
  if (btn) { btn.classList.remove("vne-active"); btn.title = "Start turn timer"; btn.querySelector("i").className = "fas fa-hourglass-start"; }
}

function _startTurnTimer(minutes) {
  _stopTurnTimer();
  _timerMinutes     = minutes;
  _timerSecondsLeft = minutes * 60;
  _timerEnabled     = true;
  _patchTimerDisplay();
  const btn = document.getElementById("vne-timer-toggle-btn");
  if (btn) { btn.classList.add("vne-active"); btn.title = "Stop timer"; btn.querySelector("i").className = "fas fa-hourglass-half"; }
  _timerInterval = setInterval(() => {
    _timerSecondsLeft = Math.max(0, _timerSecondsLeft - 1);
    _patchTimerDisplay();
    if (_timerSecondsLeft === 0) {
      _stopTurnTimer();
      game.combat?.nextTurn().catch(() => {});
    }
  }, 1000);
}

function _patchCombatDisplay() {
  const combat = game.combat;
  const round   = combat?.round ?? 0;
  const name    = combat?.combatant?.name ?? "";
  const roundEl = document.getElementById("vne-round-num");
  const nameEl  = document.getElementById("vne-turn-name");
  if (roundEl) roundEl.textContent = round || "–";
  if (nameEl)  nameEl.textContent  = name;
}

// ── Data helpers ─────────────────────────────────────────────────────────────

function getData() { return foundry.utils.deepClone(game.settings.get(ID, "vnData")); }

async function saveData(data, opts = {}) {
  if (game.user.isGM) {
    await game.settings.set(ID, "vnData", data, opts);
  } else {
    game.socket.emit(`module.${ID}`, { type: "vnDataSet", data, options: opts });
  }
}

function defaultPortrait(actor) {
  const img =
    actor.img && !actor.img.includes("mystery-man")
      ? actor.img
      : actor.prototypeToken?.texture?.src ?? "";
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
function templatePortrait(p, side, activeSpeakerId, worldOffsetY, editMode, combatMode = false) {
  const scaleX = (side === "left" ? !p.mirrorX : p.mirrorX) ? 1 : -1;
  const scaleVal = (p.scale || 100) / 100;
  const oy = (p.offsetY || 0) - worldOffsetY;
  const ox = p.offsetX || 0;
  const isCombatTarget = side === "right" && combatMode;
  // Use actorId from the token document to support unlinked tokens
  const isTargeted = isCombatTarget
    ? [...(game.user.targets ?? [])].some(t => (t.document?.actorId ?? t.actorId ?? t.actor?.id) === p.id)
    : false;
  return {
    ...p,
    img: getPortraitImg(p),
    isActive: p.id === activeSpeakerId,
    isOwned: canControlActor(p.id),
    isCombatTarget,
    isTargeted,
    imgStyle: `transform: scale(${scaleVal}) scaleX(${scaleX}); margin-top: ${oy}px; margin-left: ${ox}px;`,
    editMode
  };
}

function templateCenterSpeaker(d, worldOffsetY) {
  if (!d.activeSpeakerId) return null;
  const sp =
    d.leftCast.find(p => p.id === d.activeSpeakerId) ||
    d.rightCast.find(p => p.id === d.activeSpeakerId);
  if (!sp) return null;
  const scaleVal = (sp.scale || 100) / 100;
  const scaleX   = sp.mirrorX ? -1 : 1;
  const oy       = (sp.offsetY || 0) - worldOffsetY;
  const ox       = sp.offsetX || 0;

  const reactionMap    = sp.reactions || { default: sp.img };
  const activeReaction = sp.activeReaction || "default";
  const reactions = Object.entries(reactionMap).map(([name, img]) => ({
    name, img, isActive: name === activeReaction,
    label: name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, " ")
  }));

  return {
    ...sp,
    img: getPortraitImg(sp),
    imgStyle: `transform: scale(${scaleVal}) scaleX(${scaleX}); margin-top: ${oy}px; margin-left: ${ox}px;`,
    reactions,
    activeReaction,
    canControl: canControlActor(sp.id)
  };
}

// ── Reaction helpers ──────────────────────────────────────────────────────────

function _applyReaction(d, actorId, reactionName) {
  for (const side of ["leftCast", "rightCast"]) {
    const p = d[side].find(x => x.id === actorId);
    if (p) p.activeReaction = reactionName;
  }
  if (d.portraits[actorId]) d.portraits[actorId].activeReaction = reactionName;
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

// ── Combat Stage helpers ──────────────────────────────────────────────────────

function targetActorToken(actorId) {
  // Match by document.actorId to support unlinked tokens (t.actor?.id may be synthetic)
  const tokens = canvas.tokens?.placeables?.filter(t =>
    (t.document?.actorId ?? t.actorId ?? t.actor?.id) === actorId
  ) ?? [];
  if (!tokens.length) { ui.notifications?.warn("No token on the active scene for this actor."); return; }
  const token = tokens[0];
  const ids = [...(game.user.targets ?? [])].map(t => t.id);
  const idx = ids.indexOf(token.id);
  if (idx >= 0) ids.splice(idx, 1); else ids.push(token.id);
  game.user.updateTokenTargets(ids);
}

function getVNECastTokens(d = getData()) {
  const actorIds = new Set([...(d.leftCast ?? []), ...(d.rightCast ?? [])].map(p => p.id));
  return (canvas.tokens?.placeables ?? []).filter(t => actorIds.has(t.actor?.id));
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
    combat = await Combat.create({ scene: scene.id, active: true });
  } else if (!combat.active) {
    await combat.update({ active: true });
  }

  const castTokens = getVNECastTokens();
  if (!castTokens.length) {
    ui.notifications?.warn("Combat Stage is active, but no VN cast tokens were found on this scene.");
    return combat;
  }

  const existingTokenIds = new Set(getCollectionArray(combat.combatants).map(c => c.tokenId));
  const combatants = castTokens.filter(t => !existingTokenIds.has(t.document?.id ?? t.id)).map(t => ({
    tokenId: t.document?.id ?? t.id,
    sceneId: scene.id,
    actorId: t.actor?.id,
    hidden: t.document?.hidden ?? false
  }));
  if (combatants.length) await combat.createEmbeddedDocuments("Combatant", combatants);
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

// In Foundry v13, sidebar state is ui.sidebar.expanded (boolean), not a CSS class.
function _toggleFoundrySidebar() {
  if (!ui.sidebar) return;
  if (ui.sidebar.expanded) {
    ui.sidebar.collapse();
  } else {
    ui.sidebar.expand();
  }
}

async function toggleCombatStage() {
  if (!game.user.isGM) return;
  const d = getData();
  d.combatMode = !d.combatMode;
  if (d.combatMode) {
    await ensureActiveEncounterForVNE();
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
  const removeVNBtn    = game.user.isGM ? `<button type="button" data-action="removeVN"><i class="fas fa-user-minus"></i><span>Remover del VN</span></button>` : "";
  const removeCombatBtn = (game.user.isGM && inCombat) ? `<button type="button" data-action="removeCombat"><i class="fas fa-skull"></i><span>Remover del combate</span></button>` : "";

  const menu = document.createElement("div");
  menu.id = "vne-portrait-action-menu";
  menu.className = "vne-portrait-action-menu";
  menu.innerHTML = `
    <button type="button" data-action="sheet"><i class="fas fa-id-card"></i><span>Abrir hoja de personaje</span></button>
    <button type="button" data-action="target"><i class="fas fa-crosshairs"></i><span>Seleccionar objetivo</span></button>
    ${inCombat ? initiativeBtn : ""}
    <button type="button" data-action="speaker"><i class="fas fa-comment-dots"></i><span>Hacer hablante</span></button>
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
      const d = getData();
      d.activeSpeakerId = d.activeSpeakerId === actorId ? null : actorId;
      await saveData(d, { change: "activeSpeaker" });
      return;
    }
    if (action === "removeVN") {
      if (!game.user.isGM) return;
      const d = getData();
      d.leftCast  = d.leftCast.filter(p => p.id !== actorId);
      d.rightCast = d.rightCast.filter(p => p.id !== actorId);
      if (d.activeSpeakerId === actorId) d.activeSpeakerId = null;
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
    <img class="vne-ao-img" src="${imagePath}" />
    <div class="vne-ao-label">
      ${actorName ? `<span class="vne-ao-actor">${actorName}</span>` : ""}
      ${actionName ? `<span class="vne-ao-action">${actionName}</span>` : ""}
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
  const mkSide = (p) => p
    ? `<img class="vne-vs-img" src="${p.img}" /><div class="vne-vs-name">${p.name}</div>`
    : "";
  const showVS = !!(_vsLeft || _vsRight);
  vsEl.innerHTML = `
    <div class="vne-vs-side vne-vs-left">${mkSide(_vsLeft)}</div>
    <div class="vne-vs-sep">${showVS ? "<span>VS</span>" : ""}</div>
    <div class="vne-vs-side vne-vs-right">${mkSide(_vsRight)}</div>`;
}

// Called on turn change — updates the side that corresponds to the active combatant.
// Also seeds whichever side is still empty by scanning all combat.turns.
function _updateVSFromCombat() {
  const d = getData();
  if (!d.showVN || !d.combatMode) return;
  const combat = game.combat;
  if (!combat) return;
  // Update the active combatant's side
  const currentId = combat.combatant?.actorId;
  if (currentId) {
    const leftP  = d.leftCast.find(p => p.id === currentId);
    const rightP = d.rightCast.find(p => p.id === currentId);
    if (leftP)  _vsLeft  = { img: getPortraitImg(leftP),  name: leftP.name  };
    if (rightP) _vsRight = { img: getPortraitImg(rightP), name: rightP.name };
  }
  // Seed any side that is still empty from the full turn order
  if (!_vsLeft || !_vsRight) {
    for (const turn of (combat.turns ?? [])) {
      if (!_vsLeft) {
        const p = d.leftCast.find(q => q.id === turn.actorId);
        if (p) _vsLeft  = { img: getPortraitImg(p), name: p.name };
      }
      if (!_vsRight) {
        const p = d.rightCast.find(q => q.id === turn.actorId);
        if (p) _vsRight = { img: getPortraitImg(p), name: p.name };
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
  const portrait = { img: getPortraitImg(castP), name: castP.name };
  if (side === "right") _vsRight = portrait;
  else                  _vsLeft  = portrait;
  _renderVSDisplay();
}

function _escapeHTML(value) {
  const div = document.createElement("div");
  div.textContent = value ?? "";
  return div.innerHTML;
}

// ── Small sub-dialogs ────────────────────────────────────────────────────────

function openActorPicker(callback) {
  document.getElementById("vne-actor-picker")?.remove();

  const allActors = game.actors.contents.filter(a => a.img && !a.img.includes("mystery-man"));

  function buildCards(actors) {
    return actors.map(a =>
      `<div class="vne-qap-card" data-id="${a.id}" title="${a.name}">
        <img src="${a.img}" loading="lazy"/>
        <span>${a.name}</span>
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

  searchEl?.addEventListener("input", () => {
    const q = searchEl.value.toLowerCase().trim();
    scrollEl.innerHTML = buildCards(q ? allActors.filter(a => a.name.toLowerCase().includes(q)) : allActors);
    bindCards(scrollEl);
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
    return `<video id="se-preview" src="${src}" autoplay loop muted playsinline
      style="max-width:100%;max-height:100px;margin-top:6px;border-radius:6px;display:block;"></video>`;
  }
  return `<img id="se-preview" src="${src}" style="max-width:100%;max-height:100px;margin-top:6px;border-radius:6px;display:block;"/>`;
}

function _updateScenePreview(html, src) {
  const prev = html.find("#se-preview");
  if (!src) { prev.hide(); return; }
  const isVid = _isVideoBg(src);
  const tag = isVid ? "video" : "img";
  if (prev.prop("tagName")?.toLowerCase() !== tag) {
    // Replace element type
    const newEl = isVid
      ? `<video id="se-preview" src="${src}" autoplay loop muted playsinline style="max-width:100%;max-height:100px;margin-top:6px;border-radius:6px;display:block;"></video>`
      : `<img id="se-preview" src="${src}" style="max-width:100%;max-height:100px;margin-top:6px;border-radius:6px;display:block;"/>`;
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
      <input id="se-name" type="text" value="${loc.name}" placeholder="Tavern, Forest..."/></div>
    <div class="vne-se-row"><label>Region / Parent</label>
      <input id="se-parent" type="text" value="${loc.parent}" placeholder="Neverwinter..."/></div>
    <div class="vne-se-row"><label>Background (image / GIF / WebP / MP4 / WebM)</label>
      <div style="display:flex;gap:6px;align-items:center;">
        <input id="se-bg" type="text" value="${loc.backgroundImage}" placeholder="Path to file..."/>
        <button type="button" id="se-bg-pick"><i class="fas fa-folder-open"></i></button>
      </div>
      ${_scenePreviewHtml(loc.backgroundImage)}
    </div>
    <div class="vne-se-row"><label>Weather</label>
      <input id="se-weather" type="text" value="${loc.weather}" placeholder="Sunny, Rainy..."/></div>
    <div class="vne-se-row"><label>Time</label>
      <input id="se-time" type="text" value="${loc.time}" placeholder="12:00"/></div>
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

function openPortraitEditor(portraitId, side) {
  const d = getData();
  const p = d[`${side}Cast`].find(x => x.id === portraitId);
  if (!p) return;

  new Dialog({
    title: `Edit: ${p.name}`,
    content: `<div class="vne-pe-form">
      <div class="vne-pe-preview">
        <img id="pe-img" src="${p.img}" style="max-height:180px;border-radius:8px;"/>
        <button type="button" id="pe-pick-img" class="vne-pe-pick-btn"><i class="fas fa-image"></i> Change Image</button>
      </div>
      <div class="vne-pe-fields">
        <label>Name</label>
        <input id="pe-name" type="text" value="${p.name}"/>
        <label>Title / Role</label>
        <input id="pe-title" type="text" value="${p.title || ""}"/>
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
          const portrait = d2[`${side}Cast`].find(x => x.id === portraitId);
          if (!portrait) return;
          portrait.name    = html.find("#pe-name").val().trim() || portrait.name;
          portrait.title   = html.find("#pe-title").val().trim();
          portrait.img     = html.find("#pe-img").attr("src");
          portrait.scale   = Number.parseInt(html.find("#pe-scale").val(), 10);
          portrait.offsetX = Number.parseInt(html.find("#pe-ox").val(), 10);
          portrait.offsetY = Number.parseInt(html.find("#pe-oy").val(), 10);
          portrait.mirrorX = html.find("#pe-mirror").is(":checked");
          d2.portraits[portraitId] = { ...portrait };
          await saveData(d2, { change: "castChange" });
        }
      },
      cancel: { label: "Cancel" }
    },
    render: (html) => {
      html.find("#pe-scale").on("input", function() { html.find("#pe-scale-v").text(this.value); });
      html.find("#pe-ox").on("input", function()    { html.find("#pe-ox-v").text(this.value); });
      html.find("#pe-oy").on("input", function()    { html.find("#pe-oy-v").text(this.value); });
      html.find("#pe-pick-img").on("click", () => {
        new FilePicker({
          type: "image",
          current: game.settings.get(ID, "portraitFolderPath") || "",
          callback: (path) => html.find("#pe-img").attr("src", path)
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
    return `<div class="vne-rm-row" data-key="${name}">
      <div class="vne-rm-preview">
        <img class="vne-rm-thumb" src="${img || ""}"${img ? "" : ' style="display:none"'}/>
      </div>
      <input class="vne-rm-name" type="text" value="${name}" placeholder="reaction_name"/>
      <button type="button" class="vne-rm-pick vne-icon-btn" title="Pick image"><i class="fas fa-image"></i></button>
      <button type="button" class="vne-rm-remove vne-icon-btn" title="Remove"><i class="fas fa-trash"></i></button>
    </div>`;
  }

  const initialRows = Object.entries(reactions).map(([n, i]) => buildRow(n, i)).join("");

  new Dialog({
    title: `Reactions: ${p.name}`,
    content: `<div class="vne-reaction-manager">
      <p class="vne-rm-hint">Each row = one expression. Players who own this actor can switch between them during play.</p>
      <div id="vne-rm-rows">${initialRows}</div>
      <button type="button" id="vne-rm-add" class="vne-rm-add-btn"><i class="fas fa-plus"></i> Add Reaction</button>
    </div>`,
    buttons: {
      save: {
        label: "<i class='fas fa-save'></i> Save",
        callback: async (html) => {
          const newReactions = {};
          html.find(".vne-rm-row").each(function() {
            const name = $(this).find(".vne-rm-name").val().trim()
              .toLowerCase().replace(/\s+/g, "_");
            const img  = $(this).find(".vne-rm-thumb").attr("src") || "";
            if (name && img) newReactions[name] = img;
          });
          if (!Object.keys(newReactions).length) return;
          const d2 = getData();
          for (const side of ["leftCast", "rightCast"]) {
            const portrait = d2[side].find(x => x.id === actorId);
            if (portrait) {
              portrait.reactions = newReactions;
              if (!newReactions[portrait.activeReaction]) {
                portrait.activeReaction = Object.keys(newReactions)[0];
              }
            }
          }
          if (d2.portraits[actorId]) {
            d2.portraits[actorId].reactions = newReactions;
          }
          await saveData(d2, { change: "castChange" });
        }
      },
      cancel: { label: "Cancel" }
    },
    render: (html) => {
      html.on("click", ".vne-rm-pick", (e) => {
        const row = $(e.currentTarget).closest(".vne-rm-row");
        new FilePicker({
          type: "image",
          current: game.settings.get(ID, "portraitFolderPath") || "",
          callback: (path) => row.find(".vne-rm-thumb").attr("src", path).show()
        }).render(true);
      });
      html.on("click", ".vne-rm-remove", (e) => {
        $(e.currentTarget).closest(".vne-rm-row").remove();
      });
      html.find("#vne-rm-add").on("click", () => {
        html.find("#vne-rm-rows").append(buildRow("new_reaction", ""));
      });
    }
  }).render(true, { width: 530, height: 560 });
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

  // Persistent floating button — always visible even when VN is closed
  static _injectToggleButton() {
    const existing = document.getElementById("vne-toggle-fab");
    if (existing) return;
    const fab = document.createElement("div");
    fab.id = "vne-toggle-fab";
    fab.title = "Open / Close VN (Alt+V)";
    fab.innerHTML = `<i class="fas fa-users-between-lines"></i>`;
    fab.addEventListener("click", () => {
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

    const visible = d.showVN &&
      (game.user.isGM || !d.showForIds || d.showForIds.includes(game.user.id)) &&
      (game.user.isGM || !_playerLocalHidden);

    const combatMode = d.combatMode ?? false;

    const players = game.users.contents.filter(u => u.active).map(u => ({
      id: u.id,
      name: u.name,
      color: u.color,
      visible: !d.showForIds || d.showForIds.includes(u.id)
    }));

    const leftCast  = d.leftCast.map(p  => templatePortrait(p, "left",  d.activeSpeakerId, worldOffsetY, editMode, combatMode));
    const rightCast = d.rightCast.map(p => templatePortrait(p, "right", d.activeSpeakerId, worldOffsetY, editMode, combatMode));
    const activeSpeaker = templateCenterSpeaker(d, worldOffsetY);

    // Roleplay cast: merged left+right, max 4, each with reactions for their owner
    const rpRaw = [...d.leftCast, ...d.rightCast].slice(0, 4);
    const roleplayCastCount = Math.max(1, rpRaw.length);
    const roleplayCast = rpRaw.map(p => {
      const reactionMap    = p.reactions || { default: p.img };
      const activeReaction = p.activeReaction || "default";
      const scaleVal = (p.scale || 100) / 100;
      const scaleX   = p.mirrorX ? -1 : 1;
      const oy = (p.offsetY || 0) - worldOffsetY;
      const ox = p.offsetX || 0;
      return {
        id: p.id, name: p.name, title: p.title || "",
        img:      getPortraitImg(p),
        imgStyle: `transform: scale(${scaleVal}) scaleX(${scaleX}); margin-top: ${oy}px; margin-left: ${ox}px;`,
        isActive:   p.id === d.activeSpeakerId,
        canControl: canControlActor(p.id),
        editMode,
        reactions: Object.entries(reactionMap).map(([name, img]) => ({
          name, img, isActive: name === activeReaction,
          label: name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, " ")
        }))
      };
    });

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
      activeSpeaker,
      leftCast,
      rightCast,
      roleplayCast,
      roleplayCastCount,
      locationList:    d.locationList,
      currentLocationId: d.location?.id || "",
      players,
      combatRound,
      combatTurnName,
      timerMinutes:    _timerMinutes,
      timerEnabled:    _timerEnabled,
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

    // Edit mode (GM only)
    root.querySelector("#vne-edit-btn")?.addEventListener("click", async () => {
      if (!game.user.isGM) return;
      const d = getData(); d.editMode = !d.editMode;
      await saveData(d, { change: "editMode" });
    });

    // Quick background pick
    root.querySelector("#vne-bg-btn")?.addEventListener("click", () => {
      new FilePicker({
        type: "any",
        current: game.settings.get(ID, "bgFolderPath") || "",
        callback: async (img) => {
          const d = getData();
          d.location.backgroundImage = img;
          const idx = d.locationList.findIndex(l => l.id === d.location.id);
          if (idx >= 0) d.locationList[idx].backgroundImage = img;
          await saveData(d, { change: "location" });
        }
      }).render(true);
    });

    // Edit current scene
    root.querySelector("#vne-edit-scene-btn")?.addEventListener("click", () => {
      const d = getData();
      openSceneEditor(d.location, async (updated) => {
        const d2 = getData();
        d2.location = updated;
        const idx = d2.locationList.findIndex(l => l.id === updated.id);
        if (idx >= 0) d2.locationList[idx] = updated;
        await saveData(d2, { change: "location" });
      });
    });

    // Add actor buttons
    root.querySelector("#vne-add-left-btn")?.addEventListener("click", () => this._addActor("left"));
    root.querySelector("#vne-add-right-btn")?.addEventListener("click", () => this._addActor("right"));

    // Combat stage toggle (GM only)
    root.querySelectorAll(".vne-combat-stage-toggle").forEach(btn => {
      btn.addEventListener("click", toggleCombatStage);
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

    // Turn timer: change minutes (stops current timer)
    root.querySelector("#vne-timer-input")?.addEventListener("change", (e) => {
      if (!game.user.isGM) return;
      const minutes = parseInt(e.target.value) || 2;
      _timerMinutes = minutes;
      if (_timerEnabled) _startTurnTimer(minutes);
    });

    // Portrait click → set speaker OR target token in combat mode
    root.querySelectorAll(".vne-cast-portrait[data-id]").forEach(el => {
      el.addEventListener("click", async (e) => {
        if (e.target.closest(".vne-remove-cast-btn")) return;
        const id   = e.currentTarget.dataset.id;
        const side = e.currentTarget.dataset.side;
        const d    = getData();
        if (d.combatMode) {
          e.stopPropagation();
          showPortraitActionMenu(e.currentTarget, id, side);
          return;
        }
        d.activeSpeakerId = d.activeSpeakerId === id ? null : id;
        await saveData(d, { change: "activeSpeaker" });
      });
      // Right-click → edit portrait (edit mode)
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (!game.user.isGM) return;
        const d = getData();
        if (!d.editMode) return;
        const id   = e.currentTarget.dataset.id;
        const side = e.currentTarget.dataset.side;
        openPortraitEditor(id, side);
      });
    });

    // Remove portrait (edit mode × button)
    root.querySelectorAll(".vne-remove-cast-btn").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const { id, side } = e.currentTarget.dataset;
        const d = getData();
        d[`${side}Cast`] = d[`${side}Cast`].filter(p => p.id !== id);
        if (d.activeSpeakerId === id) d.activeSpeakerId = null;
        await saveData(d, { change: "castChange" });
      });
    });

    // Scene thumbnails
    root.querySelectorAll(".vne-scene-thumb").forEach(thumb => {
      thumb.addEventListener("click", async (e) => {
        if (e.target.closest(".vne-scene-delete-btn")) return;
        const locId = e.currentTarget.dataset.id;
        const d = getData();
        const loc = d.locationList.find(l => l.id === locId);
        if (loc) { d.location = { ...loc }; await saveData(d, { change: "location" }); }
      });
      thumb.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (!game.user.isGM) return;
        const locId = e.currentTarget.dataset.id;
        const d = getData();
        const loc = d.locationList.find(l => l.id === locId);
        openSceneEditor(loc, async (updated) => {
          const d2 = getData();
          const idx = d2.locationList.findIndex(l => l.id === updated.id);
          if (idx >= 0) d2.locationList[idx] = updated;
          if (d2.location?.id === updated.id) d2.location = { ...updated };
          await saveData(d2, { change: "location" });
        });
      });
    });

    // Delete scene buttons
    root.querySelectorAll(".vne-scene-delete-btn").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const locId = e.currentTarget.dataset.id;
        const d = getData();
        d.locationList = d.locationList.filter(l => l.id !== locId);
        await saveData(d, { change: "locationList" });
      });
    });

    // Add new scene
    root.querySelector("#vne-add-scene-btn")?.addEventListener("click", () => {
      openSceneEditor(null, async (newLoc) => {
        if (!newLoc.id) newLoc.id = foundry.utils.randomID();
        const d = getData();
        d.locationList.push(newLoc);
        d.location = { ...newLoc };
        await saveData(d, { change: "location" });
      });
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
        if (d.showForIds.length >= allIds.length) d.showForIds = null;
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

    // Initial bind for roleplay stage
    _bindRPStage(getData(), game.settings.get(ID, "worldOffsetY") || 0);
  }

  _addActor(side) {
    openActorPicker(async (actorId) => {
      const actor = game.actors.get(actorId);
      if (!actor) return;
      const d = getData();
      const key = `${side}Cast`;
      if (d[key].some(p => p.id === actorId)) {
        // Already present — just make them the speaker
        d.activeSpeakerId = actorId;
        await saveData(d, { change: "activeSpeaker" });
        return;
      }
      const saved = d.portraits[actorId];
      const portrait = saved ? { ...saved } : defaultPortrait(actor);
      if (d[key].length >= 5) d[key].shift();
      d[key].push(portrait);
      d.portraits[actorId] = portrait;
      d.activeSpeakerId = actorId;
      await saveData(d, { change: "castChange" });
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

    // Actor dropped from Foundry sidebar
    if (raw.type === "Actor" && raw.uuid) {
      const actor = await fromUuid(raw.uuid);
      if (!actor || !toSide) return;
      const d = getData();
      const key = `${toSide}Cast`;
      if (!d[key].some(p => p.id === actor.id)) {
        if (isRPStage && d.leftCast.length + d.rightCast.length >= 4) {
          ui.notifications?.warn("Máximo 4 personajes en modo roleplay.");
          return;
        }
        const saved = d.portraits[actor.id];
        const portrait = saved ? { ...saved } : defaultPortrait(actor);
        if (!isRPStage && d[key].length >= 5) d[key].shift();
        d[key].push(portrait);
        d.portraits[actor.id] = portrait;
      }
      d.activeSpeakerId = actor.id;
      await saveData(d, { change: "castChange" });
      return;
    }

    // Internal move between sides
    if (raw.type === "vne-portrait" && toSide && raw.side !== toSide) {
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

// ── Reactive DOM update hook ─────────────────────────────────────────────────

Hooks.on("updateSetting", (setting, _value, options) => {
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
      }
    }
    if (change === "combatMode") {
      _stopTurnTimer();
      // Reset VS portraits so they re-initialize from current combat state
      _vsLeft = _vsRight = null;
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
      if (isVid) { vidEl.innerHTML = `<source src="${bgSrc}"/>`; vidEl.load(); vidEl.style.display = ""; }
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
    _patchCast(d);
    renderVNECombatCarousel();
    _vsLeft = _vsRight = null;
    _updateVSFromCombat();
  }

  if (change === "activeSpeaker") {
    _patchCast(d);
    renderVNECombatCarousel();
    if (d.activeSpeakerId) {
      // Speaker set → bring them "al frente" on their side in VS
      const leftP  = d.leftCast.find(p => p.id === d.activeSpeakerId);
      const rightP = d.rightCast.find(p => p.id === d.activeSpeakerId);
      if (leftP)  { _vsLeft  = { img: getPortraitImg(leftP),  name: leftP.name  }; _renderVSDisplay(); }
      if (rightP) { _vsRight = { img: getPortraitImg(rightP), name: rightP.name }; _renderVSDisplay(); }
    } else {
      // Speaker cleared → revert VS to current combatant
      _updateVSFromCombat();
    }
  }

  if (change === "locationList") {
    _patchSceneBar(d);
  }
});

// ── DOM patch helpers ────────────────────────────────────────────────────────

function _sceneThumbHTML(loc, editMode) {
  const bgStyle = loc.backgroundImage ? `background-image:url("${loc.backgroundImage}")` : "";
  const deleteBtn = editMode
    ? `<div class="vne-scene-delete-btn" data-id="${loc.id}" title="Delete"><i class="fas fa-trash"></i></div>`
    : "";
  return `
    <div class="vne-scene-thumb-img" style="${bgStyle}"></div>
    <span class="vne-scene-thumb-name">${loc.name || "?"}</span>
    ${deleteBtn}`;
}

async function _onSceneThumbClick(e, loc) {
  if (e.target.closest(".vne-scene-delete-btn")) return;
  const d = getData();
  const found = d.locationList.find(l => l.id === loc.id);
  if (!found) return;
  d.location = { ...found };
  await saveData(d, { change: "location" });
}

async function _onSceneThumbDelete(locId) {
  const d = getData();
  d.locationList = d.locationList.filter(l => l.id !== locId);
  await saveData(d, { change: "locationList" });
}

function _bindSceneThumb(div, loc, editMode) {
  div.addEventListener("click", (e) => _onSceneThumbClick(e, loc));
  div.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (!game.user.isGM) return;
    openSceneEditor(loc, async (updated) => {
      const d = getData();
      const idx = d.locationList.findIndex(l => l.id === updated.id);
      if (idx >= 0) d.locationList[idx] = updated;
      if (d.location?.id === updated.id) d.location = { ...updated };
      await saveData(d, { change: "location" });
    });
  });
  if (editMode) {
    div.querySelector(".vne-scene-delete-btn")?.addEventListener("click", async (e) => {
      e.stopPropagation();
      await _onSceneThumbDelete(loc.id);
    });
  }
}

function _patchSceneBar(d) {
  const bar = document.getElementById("vne-scene-bar-inner");
  if (!bar) return;
  const editMode = getData().editMode && game.user.isGM;
  bar.innerHTML = "";
  for (const loc of d.locationList) {
    const active = loc.id === d.location?.id;
    const div = document.createElement("div");
    div.className = `vne-scene-thumb${active ? " vne-scene-active" : ""}`;
    div.dataset.id = loc.id;
    div.title = `${loc.name}${loc.parent ? " – " + loc.parent : ""}`;
    div.innerHTML = _sceneThumbHTML(loc, editMode);
    _bindSceneThumb(div, loc, editMode);
    bar.appendChild(div);
  }
}

function _buildCastPortraitEl(p, side, tp, editMode) {
  const div = document.createElement("div");
  div.className = `vne-cast-portrait${tp.isActive ? " vne-speaking" : ""}${tp.isOwned ? " vne-owned" : ""}${tp.isCombatTarget ? " vne-combat-target" : ""}${tp.isTargeted ? " vne-targeted" : ""}`;
  div.dataset.id   = p.id;
  div.dataset.side = side;
  div.draggable    = true;
  div.title        = `${p.name}${p.title ? " – " + p.title : ""}`;

  const speakRing  = tp.isActive ? '<div class="vne-speaking-ring"></div>' : "";
  const removeBtn  = editMode
    ? `<div class="vne-remove-cast-btn" data-id="${p.id}" data-side="${side}" title="Remove"><i class="fas fa-times"></i></div>`
    : "";
  div.innerHTML = `<img src="${tp.img}" class="vne-cast-img" style="${tp.imgStyle}"/>${speakRing}${removeBtn}`;
  return div;
}

function _bindCastPortrait(div, p, side, editMode) {
  div.addEventListener("click", async (e) => {
    if (e.target.closest(".vne-remove-cast-btn")) return;
    const d = getData();
    if (d.combatMode) {
      e.stopPropagation();
      showPortraitActionMenu(e.currentTarget, p.id, side);
      return;
    }
    d.activeSpeakerId = d.activeSpeakerId === p.id ? null : p.id;
    await saveData(d, { change: "activeSpeaker" });
  });

  div.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (!game.user.isGM) return;
    if (!getData().editMode) return;
    openPortraitEditor(p.id, side);
  });

  if (editMode) {
    div.querySelector(".vne-remove-cast-btn")?.addEventListener("click", async (e) => {
      e.stopPropagation();
      const d = getData();
      d[`${side}Cast`] = d[`${side}Cast`].filter(x => x.id !== p.id);
      if (d.activeSpeakerId === p.id) d.activeSpeakerId = null;
      await saveData(d, { change: "castChange" });
    });
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
  const combatMode = d.combatMode ?? false;
  for (const p of cast) {
    const tp  = templatePortrait(p, side, d.activeSpeakerId, worldOffsetY, editMode, combatMode);
    const div = _buildCastPortraitEl(p, side, tp, editMode);
    _bindCastPortrait(div, p, side, editMode);
    panel.appendChild(div);
  }
}

function _buildReactionsHTML(sp) {
  if (!sp.canControl && !game.user.isGM) return "";
  const btns = sp.reactions.map(r => `
    <div class="vne-reaction-btn${r.isActive ? " vne-active" : ""}"
         data-reaction="${r.name}" data-actor-id="${sp.id}" title="${r.label}">
      <img src="${r.img}" loading="lazy"/>
      <span>${r.label}</span>
    </div>`).join("");
  const manage = game.user.isGM
    ? `<div class="vne-reaction-manage-btn" data-actor-id="${sp.id}" title="Manage Reactions"><i class="fas fa-cog"></i></div>`
    : "";
  return `<div class="vne-nameplate-reactions">${btns}${manage}</div>`;
}

function _patchCenterSpeaker(d, worldOffsetY) {
  const centerEl = document.getElementById("vne-center-speaker");
  if (!centerEl) return;
  const sp = templateCenterSpeaker(d, worldOffsetY);
  if (sp) {
    const titleHtml    = sp.title ? `<span class="vne-nameplate-title">${sp.title}</span>` : "";
    const reactionsHtml = _buildReactionsHTML(sp);
    centerEl.innerHTML = `
      <div class="vne-center-portrait-wrap">
        <img class="vne-center-img" src="${sp.img}" style="${sp.imgStyle}"/>
      </div>
      <div class="vne-nameplate">
        <span class="vne-nameplate-name">${sp.name || ""}</span>${titleHtml}
        ${reactionsHtml}
      </div>`;
    centerEl.classList.add("vne-has-speaker");

    // Bind reaction buttons
    centerEl.querySelectorAll(".vne-reaction-btn[data-reaction]").forEach(btn => {
      btn.addEventListener("click", () => setReaction(btn.dataset.actorId, btn.dataset.reaction));
    });
    centerEl.querySelector(".vne-reaction-manage-btn")?.addEventListener("click", (e) => {
      openReactionManager(e.currentTarget.dataset.actorId);
    });
  } else {
    centerEl.innerHTML = `<div class="vne-no-speaker"><i class="fas fa-user-circle"></i><span>Click a portrait to set active speaker</span></div>`;
    centerEl.classList.remove("vne-has-speaker");
  }
}

function _patchCast(d) {
  const worldOffsetY = game.settings.get(ID, "worldOffsetY") || 0;
  const editMode = d.editMode && game.user.isGM;
  _patchCenterSpeaker(d, worldOffsetY);
  _patchSidePanel("left",  d, worldOffsetY, editMode);
  _patchSidePanel("right", d, worldOffsetY, editMode);
  _patchRPStage(d, worldOffsetY, editMode);
}

function _bindRPStage(d, worldOffsetY, editMode) {
  _patchRPStage(d, worldOffsetY ?? game.settings.get(ID, "worldOffsetY") ?? 0, editMode ?? (d.editMode && game.user.isGM));
}

function _patchRPStage(d, worldOffsetY, editMode) {
  const stage = document.getElementById("vne-rp-stage");
  if (!stage) return;

  const rpRaw = [...(d.leftCast || []), ...(d.rightCast || [])].slice(0, 4);
  const count  = rpRaw.length;

  let html = "";

  for (const p of rpRaw) {
    const reactionMap    = p.reactions || { default: p.img };
    const activeReaction = p.activeReaction || "default";
    const scaleVal = (p.scale || 100) / 100;
    const scaleX   = p.mirrorX ? -1 : 1;
    const oy = (p.offsetY || 0) - worldOffsetY;
    const ox = p.offsetX || 0;
    const img      = getPortraitImg(p);
    const imgStyle = `transform: scale(${scaleVal}) scaleX(${scaleX}); margin-top: ${oy}px; margin-left: ${ox}px;`;
    const isActive  = p.id === d.activeSpeakerId;
    const canCtrl   = canControlActor(p.id);

    let reactionsHtml = "";
    if (canCtrl) {
      const btns = Object.entries(reactionMap).map(([name, rImg]) => {
        const label  = name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, " ");
        const active = name === activeReaction ? " vne-active" : "";
        return `<div class="vne-reaction-btn${active}" data-reaction="${name}" data-actor-id="${p.id}" title="${label}"><img src="${rImg}" loading="lazy"/><span>${label}</span></div>`;
      }).join("");
      const manageBtnHtml = game.user.isGM
        ? `<div class="vne-reaction-manage-btn" data-actor-id="${p.id}" title="Gestionar reacciones"><i class="fas fa-cog"></i></div>` : "";
      reactionsHtml = `<div class="vne-rp-reactions">${btns}${manageBtnHtml}</div>`;
    }

    const removeBtn  = editMode ? `<div class="vne-rp-remove-btn" data-id="${p.id}" title="Quitar"><i class="fas fa-times"></i></div>` : "";
    const titleHtml  = p.title ? `<span class="vne-rp-title">${p.title}</span>` : "";

    html += `<div class="vne-rp-slot${isActive ? " vne-rp-speaking" : ""}" data-id="${p.id}" data-slot-count="${count}">
      <div class="vne-rp-portrait-wrap">
        ${removeBtn}
        <img class="vne-rp-img" src="${img}" style="${imgStyle}"/>
      </div>
      <div class="vne-rp-nameplate"><span class="vne-rp-name">${p.name}</span>${titleHtml}</div>
      ${reactionsHtml}
    </div>`;
  }

  if (count === 0) {
    html += `<div class="vne-rp-empty"><i class="fas fa-users fa-2x"></i><span>${game.user.isGM ? "Arrastra actores aquí o usa +" : "No hay personajes en escena"}</span></div>`;
  }

  if (game.user.isGM && count < 4) {
    html += `<div id="vne-rp-add-btn" class="vne-rp-add-slot" title="Añadir personaje"><i class="fas fa-user-plus"></i><span>Añadir</span></div>`;
  }

  stage.innerHTML = html;

  // Bind slot interactions
  stage.querySelectorAll(".vne-rp-slot").forEach(slot => {
    slot.addEventListener("click", async (e) => {
      if (e.target.closest(".vne-reaction-btn, .vne-rp-remove-btn, .vne-reaction-manage-btn")) return;
      const id = slot.dataset.id;
      const d2 = getData();
      d2.activeSpeakerId = d2.activeSpeakerId === id ? null : id;
      await saveData(d2, { change: "activeSpeaker" });
    });

    slot.querySelectorAll(".vne-reaction-btn").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const d2 = getData();
        const actorId  = btn.dataset.actorId;
        const reaction = btn.dataset.reaction;
        const allCast  = [...d2.leftCast, ...d2.rightCast];
        const p2 = allCast.find(p => p.id === actorId);
        if (p2) { p2.activeReaction = reaction; if (d2.portraits[actorId]) d2.portraits[actorId].activeReaction = reaction; }
        await saveData(d2, { change: "castChange" });
      });
    });

    slot.querySelector(".vne-reaction-manage-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      openReactionManager(e.currentTarget.dataset.actorId);
    });

    slot.querySelector(".vne-rp-remove-btn")?.addEventListener("click", async (e) => {
      e.stopPropagation();
      const actorId = e.currentTarget.dataset.id;
      const d2 = getData();
      d2.leftCast  = d2.leftCast.filter(p => p.id !== actorId);
      d2.rightCast = d2.rightCast.filter(p => p.id !== actorId);
      if (d2.activeSpeakerId === actorId) d2.activeSpeakerId = null;
      await saveData(d2, { change: "castChange" });
    });
  });

  stage.querySelector("#vne-rp-add-btn")?.addEventListener("click", () => {
    if (!game.user.isGM) return;
    openActorPicker(async (actorId) => {
      const d2 = getData();
      if (d2.leftCast.length + d2.rightCast.length >= 4) {
        ui.notifications?.warn("Máximo 4 personajes en modo roleplay.");
        return;
      }
      if (!d2.leftCast.some(p => p.id === actorId) && !d2.rightCast.some(p => p.id === actorId)) {
        const actor = game.actors.get(actorId);
        if (!actor) return;
        const saved    = d2.portraits[actorId];
        const portrait = saved ? { ...saved } : defaultPortrait(actor);
        d2.leftCast.push(portrait);
        d2.portraits[actorId] = portrait;
      }
      d2.activeSpeakerId = actorId;
      await saveData(d2, { change: "castChange" });
    });
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
  const hp = _getCarouselActorHP(actor);
  if (!hp) return "";
  const color = hp.pct > 0.5 ? "#4caf50" : hp.pct > 0.25 ? "#f09800" : "#e53935";
  return `<div class="vne-carousel-hp-bar"><div class="vne-carousel-hp-fill" style="width:${Math.round(hp.pct * 100)}%;background:${color};"></div></div>`;
}

function _carouselEffectsHtml(actor) {
  const effects = actor?.temporaryEffects?.filter(e => !e.disabled) ?? [];
  if (!effects.length) return "";
  const icons = effects.slice(0, 6).map(e =>
    `<img class="vne-ce-icon" src="${e.icon}" title="${e.name}" onerror="this.style.display='none'">`
  ).join("");
  return `<div class="vne-carousel-effects">${icons}</div>`;
}

function _carouselCardHtml({ img, name, initLabel, isActive, isDefeated, mode, combatantId, actorId, side, actor }) {
  const classes = ["vne-carousel-item",
    isActive   ? "vne-carousel-active"   : "",
    isDefeated ? "vne-carousel-defeated" : ""
  ].filter(Boolean).join(" ");

  const dataAttrs = mode === "combat"
    ? `data-mode="combat" data-combatant-id="${combatantId}"`
    : `data-mode="vn" data-actor-id="${actorId}" data-side="${side}"`;

  const initPart = initLabel !== null
    ? `<span class="vne-carousel-cinit">${initLabel}</span>` : "";

  return `<div class="${classes}" ${dataAttrs}>
    <img src="${img}" alt="${name}" onerror="this.src='icons/svg/mystery-man.svg'">
    ${_carouselEffectsHtml(actor)}
    ${_carouselHpBarHtml(actor)}
    <div class="vne-carousel-footer">
      <span class="vne-carousel-cname">${name}</span>
      ${initPart}
    </div>
    ${isActive ? '<div class="vne-carousel-turn-bar"></div>' : ""}
  </div>`;
}

function _renderVNECarouselUnified(el, combat) {
  const turns = combat.turns ?? [];
  function toCard(c) {
    const actor = c.actor ?? game.actors.get(c.actorId);
    const img   = c.token?.texture?.src ?? actor?.img ?? "icons/svg/mystery-man.svg";
    const init  = c.initiative !== null && c.initiative !== undefined
      ? String(c.initiative) : "?";
    return _carouselCardHtml({
      img, name: c.name || actor?.name || "???",
      initLabel: init,
      isActive:   combat.combatant?.id === c.id,
      isDefeated: c.defeated,
      mode: "combat",
      combatantId: c.id,
      actorId: c.actorId,
      actor
    });
  }
  el.innerHTML = turns.map(toCard).join("");
  _bindVNECarouselEvents(el);
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
      isActive:   p.id === d.activeSpeakerId,
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
  _closeVNECarouselMenu();

  const el   = event.currentTarget;
  const mode = el.dataset.mode;

  const actorId = mode === "combat"
    ? (game.combat?.combatants?.get(el.dataset.combatantId)?.actorId ?? null)
    : el.dataset.actorId;
  if (!actorId) return;

  const actor    = game.actors.get(actorId);
  const d        = getData();
  const inLeft   = d.leftCast.some(p => p.id === actorId);
  const inRight  = d.rightCast.some(p => p.id === actorId);
  const inVN     = inLeft || inRight;
  const inCombat = mode === "combat" || !!game.combat?.combatants.find(c => c.actorId === actorId);

  const items = [];
  items.push({ label: "Abrir Hoja",        icon: "fas fa-id-card",     action: "sheet" });
  items.push({ label: "Seleccionar token",  icon: "fas fa-hand-pointer",action: "select" });

  if (game.user.isGM) {
    if (inCombat) {
      items.push({ label: "Tirar Iniciativa", icon: "fas fa-dice-d20",   action: "rollInit" });
      items.push({ separator: true });
    }
    if (!inVN) {
      items.push({ label: "Añadir al VN (izquierda)", icon: "fas fa-user-plus",  action: "addVNLeft" });
      items.push({ label: "Añadir al VN (derecha)",   icon: "fas fa-user-plus",  action: "addVNRight" });
    } else {
      items.push({ label: "Remover del VN",  icon: "fas fa-user-minus", action: "removeVN" });
    }
    if (mode === "combat") {
      items.push({ label: "Remover del combate", icon: "fas fa-skull",   action: "removeCombat" });
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
      const tokens = canvas.tokens?.placeables?.filter(t => t.actor?.id === actorId) ?? [];
      if (tokens.length) {
        tokens[0].control({ releaseOthers: true });
        canvas.animatePan({ x: tokens[0].x, y: tokens[0].y, duration: 250 });
      }
    } else if (action === "rollInit") {
      const combat    = game.combat;
      const combatant = combat?.combatants?.find(c => c.actorId === actorId);
      if (combatant) await combat.rollInitiative([combatant.id]);
    } else if (action === "addVNLeft") {
      const d2 = getData();
      if (!d2.leftCast.some(p => p.id === actorId)) {
        const portrait = d2.portraits[actorId]
          ? { ...d2.portraits[actorId] } : defaultPortrait(actor);
        if (d2.leftCast.length >= 5) d2.leftCast.shift();
        d2.leftCast.push(portrait);
        d2.portraits[actorId] = portrait;
        await saveData(d2, { change: "castChange" });
      }
    } else if (action === "addVNRight") {
      const d2 = getData();
      if (!d2.rightCast.some(p => p.id === actorId)) {
        const portrait = d2.portraits[actorId]
          ? { ...d2.portraits[actorId] } : defaultPortrait(actor);
        if (d2.rightCast.length >= 5) d2.rightCast.shift();
        d2.rightCast.push(portrait);
        d2.portraits[actorId] = portrait;
        await saveData(d2, { change: "castChange" });
      }
    } else if (action === "removeVN") {
      const d2 = getData();
      d2.leftCast  = d2.leftCast.filter(p => p.id !== actorId);
      d2.rightCast = d2.rightCast.filter(p => p.id !== actorId);
      if (d2.activeSpeakerId === actorId) d2.activeSpeakerId = null;
      await saveData(d2, { change: "castChange" });
    } else if (action === "removeCombat") {
      const combatant = game.combat?.combatants?.find(c => c.actorId === actorId);
      if (combatant) await game.combat.deleteEmbeddedDocuments("Combatant", [combatant.id]);
    }
  });

  document.body.appendChild(menu);
  const rect = el.getBoundingClientRect();
  menu.style.left = `${Math.min(rect.left, window.innerWidth  - 220)}px`;
  menu.style.top  = `${Math.min(rect.bottom + 4, window.innerHeight - 220)}px`;
  setTimeout(() => document.addEventListener("click", _closeVNECarouselMenu, { once: true }), 0);
}

// Carousel combat hooks
Hooks.on("updateCombat",     renderVNECombatCarousel);
Hooks.on("createCombatant",  renderVNECombatCarousel);
Hooks.on("deleteCombatant",  renderVNECombatCarousel);
Hooks.on("updateCombatant",  renderVNECombatCarousel);
Hooks.on("deleteCombat",     renderVNECombatCarousel);
Hooks.on("createCombat",     renderVNECombatCarousel);

// Live HP / status effect updates (debounced 80 ms)
let _vneCarouselTimer = null;
function _scheduleCarousel() {
  clearTimeout(_vneCarouselTimer);
  _vneCarouselTimer = setTimeout(renderVNECombatCarousel, 80);
}
Hooks.on("updateActor",       _scheduleCarousel);
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
          }
        }
      }
    });
  } catch(e) {
    console.warn("vnd-enhanced | keybinding registration failed:", e);
  }
});

Hooks.on("setup", () => {
  // Socket handler (lets players trigger GM-side saves)
  game.socket.on(`module.${ID}`, async (msg) => {
    if (!game.user.isGM) return;
    if (msg.type === "vnDataSet") {
      await game.settings.set(ID, "vnData", msg.data, msg.options ?? {});
      return;
    }
    if (msg.type === "vnReaction") {
      // Validate: the user who sent this must own the actor
      const actor  = game.actors.get(msg.actorId);
      const sender = game.users.get(msg.senderId);
      if (!actor || !sender) return;
      const ownerLevel = actor.ownership[msg.senderId] ?? actor.ownership.default ?? 0;
      if (ownerLevel < CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) return;
      const d = getData();
      _applyReaction(d, msg.actorId, msg.reactionName);
      await game.settings.set(ID, "vnData", d, { change: "castChange" });
    }
  });

  VNE.activate();
});

Hooks.on("ready", () => {
  // Rich API for macros and Active Tile Triggers
  globalThis.VNEnhanced = {
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
      const d = getData(); d.activeSpeakerId = actorId ?? null;
      await saveData(d, { change: "activeSpeaker" });
    },
    clearSpeaker: async () => {
      const d = getData(); d.activeSpeakerId = null;
      await saveData(d, { change: "activeSpeaker" });
    },
    // Reaction / expression
    setReaction:  (actorId, reactionName) => setReaction(actorId, reactionName),
    // Cast management
    addActor:     async (actorId, side = "left") => {
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
      d.activeSpeakerId = actorId;
      await saveData(d, { change: "castChange" });
    },
    removeActor:  async (actorId) => {
      const d = getData();
      d.leftCast  = d.leftCast.filter(p => p.id !== actorId);
      d.rightCast = d.rightCast.filter(p => p.id !== actorId);
      if (d.activeSpeakerId === actorId) d.activeSpeakerId = null;
      await saveData(d, { change: "castChange" });
    },
    clearCast:    async () => {
      const d = getData();
      d.leftCast = []; d.rightCast = []; d.activeSpeakerId = null;
      await saveData(d, { change: "castChange" });
    },
    // Read state
    getState:     () => getData(),
    // Combat stage
    setCombatMode: async (on) => {
      const d = getData(); d.combatMode = !!on;
      if (d.combatMode) {
        await ensureActiveEncounterForVNE();
      }
      await saveData(d, { change: "combatMode" });
    },
    targetActor:  (actorId) => targetActorToken(actorId),
    showActionImage: (data) => _showActionImageOverlay(data),
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

// Update round/turn display and restart timer when Foundry combat advances
Hooks.on("updateCombat", (combat, changed) => {
  const d = getData();
  if (!d.showVN || !d.combatMode) return;
  _patchCombatDisplay();
  // Auto-restart timer on new turn (if timer was running)
  if (_timerEnabled && (changed.turn !== undefined || changed.round !== undefined)) {
    _startTurnTimer(_timerMinutes);
  }
  // Auto-set active speaker + refresh VS display when turn advances
  if (changed.turn !== undefined || changed.round !== undefined) {
    _updateVSFromCombat();
    if (game.user.isGM) {
      const currentActorId = combat.combatant?.actorId;
      if (currentActorId) {
        const d2 = getData();
        const inCast = d2.leftCast.some(p => p.id === currentActorId) ||
                       d2.rightCast.some(p => p.id === currentActorId);
        if (inCast && d2.activeSpeakerId !== currentActorId) {
          d2.activeSpeakerId = currentActorId;
          saveData(d2, { change: "activeSpeaker" });
        }
      }
    }
  }
  // Patch combat controls visibility after render
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
