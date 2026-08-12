/**
 * VND Enhanced — Combat Formation
 *
 * Formation positioning for Combat Mode. Role Mode keeps its free/scene
 * positioning (`_patchVNStage` in main.js); this module is the second consumer
 * of the same portrait data, laying combatants out in automatic battle rows.
 *
 * Deliberately free of Foundry globals (`game`, `canvas`, `Hooks`, `document`)
 * at module scope AND inside every exported function — everything here is a pure
 * value→string transform. That keeps the layout maths verifiable from Node
 * (see tools/verify-combat-formation.mjs) instead of only inside a live world.
 *
 * Layout produced:
 *
 *     ENEMY AREA     [E1] [E2] [E3]
 *                       [E4] [E5]
 *                         — VS —
 *     PLAYER AREA    [P1] [P2] [P3]
 *                       [P4] [P5]
 *
 * Rows are logical only: no borders, no cells, no grid lines (§5/§6). Centering
 * is done in CSS (`justify-content: center` per row), so no row needs padding
 * maths here.
 */

export const DEFAULT_MAX_PER_ROW = 3;

/** Bar colours — enemies read red, players read green→amber→red as they drop (§8). */
const ENEMY_HP_COLOR = "#c0392b";
const PLAYER_HP_COLORS = [
  { min: 0.5,  color: "#4caf50" },
  { min: 0.25, color: "#f09800" },
  { min: 0,    color: "#e53935" }
];

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * HTML-escape. Local copy so this module stays importable on its own; mirrors
 * `_escapeHTML` in main.js.
 */
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Sanitise a CSS declaration string before it goes into a style="" attribute.
 * Portrait transforms are built from numbers we control, but portrait data is
 * world-editable, so quotes/brackets and url() are stripped rather than trusted.
 */
export function sanitizeStyle(style) {
  return String(style ?? "")
    .replace(/url\s*\(/gi, "")
    .replace(/[<>"'`]/g, "")
    .slice(0, 400);
}

// ── Formation maths ──────────────────────────────────────────────────────────

/**
 * How many combatants fit on one row at this viewport width (§11).
 * Narrow phones get 2, standard desktop 3, ultrawide 4.
 */
export function resolveMaxPerRow(viewportWidth) {
  const w = Number(viewportWidth);
  if (!Number.isFinite(w) || w <= 0) return DEFAULT_MAX_PER_ROW;
  if (w < 900)  return 2;   // phones / very narrow windows
  if (w < 2200) return 3;   // 1366×768 through 1920×1080 — the common case
  return 4;                 // 2560×1440 and wider
}

/**
 * Split `count` combatants into rows of at most `maxPerRow`, filling each row
 * before starting the next. Matches the spec examples (§4):
 *   3 → [3]      4 → [3,1]     6 → [3,3]     9 → [3,3,3]
 * Returns an array of rows, each row an array of indices into the source list.
 * Never overflows horizontally: extra combatants always start a new row.
 */
export function computeFormation(count, { maxPerRow = DEFAULT_MAX_PER_ROW } = {}) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  // A row of 1 is legitimate; 0, negative and NaN are caller bugs and fall back
  // to the default rather than degenerating into a column of single units.
  const raw = Math.floor(Number(maxPerRow));
  const per = Number.isFinite(raw) && raw >= 1 ? raw : DEFAULT_MAX_PER_ROW;
  const rows = [];
  for (let i = 0; i < n; i += per) {
    const row = [];
    for (let j = i; j < Math.min(i + per, n); j++) row.push(j);
    rows.push(row);
  }
  return rows;
}

// ── HP presentation ──────────────────────────────────────────────────────────

/** Bar colour for a 0–1 HP ratio on a given side. */
export function hpColor(pct, side) {
  if (side === "enemy") return ENEMY_HP_COLOR;
  const p = Math.max(0, Math.min(1, Number(pct) || 0));
  return (PLAYER_HP_COLORS.find(t => p > t.min) ?? PLAYER_HP_COLORS.at(-1)).color;
}

/**
 * Turn a raw { value, max } into everything the bar needs.
 * `showNumbers` false → the bar still renders, the digits do not (§ HP privacy:
 * players read enemy pressure from the bar, exact stats stay with the GM).
 */
export function hpPresentation(hp, { side = "player", showNumbers = true } = {}) {
  if (!hp || !Number.isFinite(hp.max) || hp.max <= 0) return null;
  const value = Number.isFinite(hp.value) ? hp.value : 0;
  const pct = Math.max(0, Math.min(1, value / hp.max));
  return {
    pct,
    percent: Math.round(pct * 100),
    color: hpColor(pct, side),
    text: showNumbers ? `${value} / ${hp.max}` : ""
  };
}

// ── Manual placement ─────────────────────────────────────────────────────────
// The formation is the default, not a cage: the GM can drag any combatant to a
// spot on the field. Overrides are stored as FRACTIONS of the battlefield box
// (0–1), never pixels, so a placement survives a window resize, a different
// monitor and every responsive breakpoint.

export const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

/** True when this unit carries a manual position and leaves the formation flow. */
export function isPlaced(unit) {
  return Number.isFinite(unit?.x) && Number.isFinite(unit?.y);
}

/** Partition a cast into the ones that still auto-arrange and the ones pinned. */
export function splitPlaced(units) {
  const list = Array.isArray(units) ? units : [];
  return {
    flow:   list.filter(u => !isPlaced(u)),
    placed: list.filter(u =>  isPlaced(u))
  };
}

// ── Unit rendering ───────────────────────────────────────────────────────────

/**
 * One combatant on the battlefield: the artwork stays the protagonist and the
 * name/HP ride underneath as a small informational layer (§7/§9) — no card,
 * no frame around the character.
 *
 * `unit` = { id, name, img, imgStyle, hp:{value,max}|null, showHpNumbers,
 *            side:"enemy"|"player", isActive, isTargeted, isDefeated, isOwned }
 */
export function buildUnitHtml(unit = {}) {
  const {
    id = "", name = "???", img = "", imgStyle = "", hp = null,
    showHpNumbers = true, side = "player",
    ac = null, speed = null, init = null, effects = [],
    isActive = false, isTargeted = false, isDefeated = false, isOwned = false,
    rowCount = DEFAULT_MAX_PER_ROW, canPlace = false, resetLabel = ""
  } = unit;

  const placed = isPlaced(unit);
  const classes = ["vne-bf-unit", `vne-bf-${side === "enemy" ? "enemy" : "player"}`,
    isActive   ? "vne-bf-active"   : "",
    isTargeted ? "vne-bf-targeted" : "",
    isDefeated ? "vne-bf-defeated" : "",
    isOwned    ? "vne-bf-owned"    : "",
    placed     ? "vne-bf-placed"   : "",
    canPlace   ? "vne-bf-draggable": ""
  ].filter(Boolean).join(" ");

  // The anchor is the character's feet, so dropping a unit puts it exactly
  // where the pointer released (see .vne-bf-placed in module.css).
  const posStyle = placed
    ? `left:${(clamp01(unit.x) * 100).toFixed(3)}%;top:${(clamp01(unit.y) * 100).toFixed(3)}%;`
    : "";

  // "Back to formation" — only meaningful once a unit has been pinned.
  const resetBtn = (placed && canPlace)
    ? `<div class="vne-bf-reset" title="${escapeHtml(resetLabel)}" role="button" tabindex="0">` +
      `<i class="fas fa-rotate-left"></i></div>`
    : "";

  const bars = hpPresentation(hp, { side, showNumbers: showHpNumbers });
  const hpHtml = bars
    ? `<div class="vne-bf-hp" role="img" aria-label="${escapeHtml(bars.percent)}%">` +
      `<div class="vne-bf-hp-fill" style="width:${bars.percent}%;background:${bars.color};"></div>` +
      `</div>${bars.text ? `<div class="vne-bf-hp-text">${escapeHtml(bars.text)}</div>` : ""}`
    : "";

  // Active-turn marker sits above the artwork so it never covers the face.
  const turnMark = isActive ? `<div class="vne-bf-turn-mark" aria-hidden="true">✦</div>` : "";

  // Combat readouts under the name: AC, movement and initiative — the same info
  // the classic side-panel plates carry, so the battlefield HUD is complete.
  const statBits = [];
  if (init  !== null && init  !== undefined) statBits.push(`<span class="vne-bf-stat vne-bf-init" title="Initiative"><i class="fas fa-dice-d20"></i>${escapeHtml(init)}</span>`);
  if (ac    !== null && ac    !== undefined) statBits.push(`<span class="vne-bf-stat vne-bf-ac" title="AC"><i class="fas fa-shield-halved"></i>${escapeHtml(ac)}</span>`);
  if (speed !== null && speed !== undefined) statBits.push(`<span class="vne-bf-stat vne-bf-spd" title="Speed"><i class="fas fa-shoe-prints"></i>${escapeHtml(speed)}</span>`);
  const statsHtml = statBits.length ? `<div class="vne-bf-stats">${statBits.join("")}</div>` : "";

  // Status-effect icons — small strip, mirrors the classic plate / carousel.
  const fxHtml = (Array.isArray(effects) && effects.length)
    ? `<div class="vne-bf-effects">` +
      effects.map(fx => `<img class="vne-bf-fx" src="${escapeHtml(fx.img)}" title="${escapeHtml(fx.name)}" alt=""/>`).join("") +
      `</div>`
    : "";

  return `<div class="${classes}" data-id="${escapeHtml(id)}" data-side="${escapeHtml(side)}" ` +
    `data-row-count="${escapeHtml(rowCount)}" role="button" tabindex="0" ` +
    `style="${posStyle}" ` +
    `aria-label="${escapeHtml(name)}"${isActive ? ' aria-current="true"' : ""}>` +
    `${turnMark}${resetBtn}` +
    `<div class="vne-bf-art">${fxHtml}` +
      `<img class="vne-bf-img" src="${escapeHtml(img)}" alt="" ` +
      `style="${escapeHtml(sanitizeStyle(imgStyle))}"/>` +
    `</div>` +
    `<div class="vne-bf-info">` +
      `<div class="vne-bf-name">${escapeHtml(name)}</div>` +
      `${hpHtml}` +
      `${statsHtml}` +
    `</div>` +
  `</div>`;
}

/** Wrap units into centered, border-free formation rows. */
export function buildFormationHtml(units, { maxPerRow = DEFAULT_MAX_PER_ROW } = {}) {
  const list = Array.isArray(units) ? units : [];
  const rows = computeFormation(list.length, { maxPerRow });
  return rows.map(row =>
    `<div class="vne-bf-row">` +
    row.map(i => buildUnitHtml({ ...list[i], rowCount: row.length })).join("") +
    `</div>`
  ).join("");
}

/** Free layer holding every manually-placed combatant, both sides together. */
export function buildPlacedHtml(units) {
  const list = Array.isArray(units) ? units : [];
  if (!list.length) return "";
  return `<div class="vne-bf-free">${list.map(u => buildUnitHtml(u)).join("")}</div>`;
}

/**
 * The whole battlefield: enemy area on top, player area below, VS between them.
 * Areas carry no visible chrome — they exist purely as positioning zones (§5).
 */
export function buildBattlefieldHtml({
  enemies = [], players = [], maxPerRow = DEFAULT_MAX_PER_ROW,
  vsLabel = "VS", emptyLabel = ""
} = {}) {
  if (!enemies.length && !players.length) {
    return `<div class="vne-bf-empty">${escapeHtml(emptyLabel)}</div>`;
  }
  // Manually-placed combatants leave the formation flow entirely, so the ones
  // left behind close ranks instead of holding an empty slot.
  const e = splitPlaced(enemies);
  const p = splitPlaced(players);
  const showVs = e.flow.length > 0 && p.flow.length > 0;
  return (
    `<div class="vne-bf-area vne-bf-area-enemy" data-area="enemy">` +
      buildFormationHtml(e.flow, { maxPerRow }) +
    `</div>` +
    (showVs ? `<div class="vne-bf-vs"><span>${escapeHtml(vsLabel)}</span></div>` : `<div class="vne-bf-vs"></div>`) +
    `<div class="vne-bf-area vne-bf-area-player" data-area="player">` +
      buildFormationHtml(p.flow, { maxPerRow }) +
    `</div>` +
    buildPlacedHtml([...e.placed, ...p.placed])
  );
}
