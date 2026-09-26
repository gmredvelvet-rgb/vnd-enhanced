import { VndLicenseMenu } from "./license-client.js";
import { hubActive } from "./license-hub.js";
import { SfxSettingsApp } from "./sfx-ui.js";
import { ReactionTemplatesApp } from "./reaction-templates.js";
import { applyVoiceMode } from "./voice-activity.js";

const ID = "vnd-enhanced";

/**
 * Visual theme switcher — toggles the body-level theme class and injects
 * optional user-supplied assets (fonts/textures) for the Darkest Dungeon skin.
 * Pure CSS theming: no re-render needed, the classic design stays untouched.
 */
export function applyVisualTheme() {
  const theme = game.settings.get(ID, "visualTheme") ?? "classic";
  const dd = theme === "darkest";
  document.body.classList.toggle("vne-theme-dd", dd);

  // Optional user-asset layer (fonts / panel texture extracted from the
  // user's OWN copy of the game — never bundled, never distributed).
  const STYLE_ID = "vne-dd-user-assets";
  document.getElementById(STYLE_ID)?.remove();
  if (!dd) return;

  let folder = (game.settings.get(ID, "ddAssetsPath") || "").trim();
  while (folder.endsWith("/")) folder = folder.slice(0, -1);
  if (!folder) return;
  const base = encodeURI(folder);
  const style = document.createElement("style");
  style.id = STYLE_ID;
  // Missing files fail silently — the pure-CSS look below remains intact.
  style.textContent = `
    @font-face { font-family: "VNE DD Title"; src: url("${base}/title-font.ttf"); font-display: swap; }
    @font-face { font-family: "VNE DD Body";  src: url("${base}/body-font.ttf");  font-display: swap; }
    body.vne-theme-dd #vne-main,
    body.vne-theme-dd { --vne-dd-panel-tex: url("${base}/panel-texture.png"); }
  `;
  document.head.appendChild(style);
}

/**
 * True inside a TaleSpire Symbiote. Any one of three signals is enough:
 * the Symbiote API global (`TS`), the flag the TaleSpire compatibility layer
 * sets only inside that WebView, and the dice-return bridge the Symbiote
 * injects. None of them exists in a normal browser.
 */
export function isTaleSpireSymbiote() {
  return typeof globalThis.TS === "object"
      || globalThis.TALESPIRE_COMPAT === true
      || typeof globalThis.FRB_TALESPIRE_BRIDGE === "object";
}

/**
 * Mobile mode — when the companion module "Velvet Mobile" is active in this
 * world, tag <body> so styles/mobile.css activates its responsive layer.
 * Desktop clients are unaffected: every rule in that sheet also requires a
 * small-viewport or coarse-pointer media query to match.
 */
export function applyMobileMode() {
  // A TaleSpire Symbiote is a narrow desktop side panel, not a phone. Its
  // Chromium viewport can be under 640px wide, which otherwise triggers the
  // phone layout and stacks both cast panels vertically over the scene.
  // The Symbiote gets its own layout instead (applySymbioteLayout), and the two
  // never stack: forcing the Symbiote layout on a phone switches this one off.
  const on = (game.modules.get("velvet-mobile")?.active ?? false)
          && !isTaleSpireSymbiote()
          && !document.body.classList.contains("vne-symbiote");
  document.body.classList.toggle("vne-mobile-ready", on);
}

/**
 * Symbiote layout — a portrait arrangement for the tall, narrow panel TaleSpire
 * gives a Symbiote (about 600 × 1200 CSS px). Tags <body> for styles/symbiote.css,
 * which also drives the JS paths that change structure rather than style: cast
 * strips in roleplay and a page size sized to the panel in combat.
 *
 * Client scope: the layout follows the screen, so the GM on a desktop and a
 * player inside TaleSpire each get the one that fits their own display.
 */
export function applySymbioteLayout() {
  const mode = game.settings.get(ID, "symbioteLayout") ?? "auto";
  const on = mode === "on" || (mode === "auto" && isTaleSpireSymbiote());
  document.body.classList.toggle("vne-symbiote", on);
  return on;
}

/**
 * RPG Classic Style — opt-in Combat Mode layout where the combatants stand on
 * the battlefield in automatic formations with a bottom combat HUD, instead of
 * the side panels + VS duel arrangement.
 *
 * Tagging <body> (same pattern as the theme and mobile switches) rather than
 * #vne-main lets the stylesheet reach elements that live outside the VN window,
 * notably the floating toggle button. Everything the option changes is gated on
 * this class, so turning it off restores the released behaviour exactly.
 */
export function applyRpgStyle() {
  const on = game.settings.get(ID, "combatRpgStyle") === true;
  document.body.classList.toggle("vne-rpg-style", on);
}

/**
 * HUD-only mode — strips the VN down to a combat overlay laid over the live map:
 * side panels with HP, turn cards, initiative carousel and the bottom bar, with
 * no background, no stage and no ghost tokens. Same <body> tagging as the styles
 * above, so everything it changes is gated on one class and turning it off
 * restores the full VN exactly.
 */
export function applyHudOnly() {
  const on = game.settings.get(ID, "hudOnlyMode") === true;
  document.body.classList.toggle("vne-hud-only", on);
}

Hooks.once("ready", () => {
  applyVisualTheme();
  applySymbioteLayout();   // before mobile mode, which defers to it
  applyMobileMode();
  applyRpgStyle();
  applyHudOnly();
});

// The Symbiote API can finish initialising after Foundry's "ready". When it does,
// re-run the detection so "auto" still lands on the Symbiote layout.
globalThis.addEventListener?.("frb:talespire-ready", () => {
  if (!game.ready) return;
  const was = document.body.classList.contains("vne-symbiote");
  const now = applySymbioteLayout();
  applyMobileMode();
  if (now !== was) Hooks.callAll("vnd-enhanced.relayout");
});

export function registerSettings() {
  // License manager — tier, installation slots, self-service slot release
  // With Velvet License Hub active, its menu is the one place to manage the licence.
  if (!hubActive()) game.settings.registerMenu(ID, "licenseManager", {
    name:       "vnd-enhanced.settings.licenseMenu.name",
    label:      "vnd-enhanced.settings.licenseMenu.label",
    hint:       "vnd-enhanced.settings.licenseMenu.hint",
    icon:       "fas fa-key",
    type:       VndLicenseMenu,
    restricted: true
  });

  // SFX manager — browse and preview per-event audio files
  game.settings.registerMenu(ID, "sfxManager", {
    name:       "vnd-enhanced.settings.sfxMenu.name",
    label:      "vnd-enhanced.settings.sfxMenu.label",
    hint:       "vnd-enhanced.settings.sfxMenu.hint",
    icon:       "fas fa-volume-up",
    type:       SfxSettingsApp,
    restricted: true
  });

  // Reaction templates manager — save/load reusable reaction sets
  game.settings.registerMenu(ID, "reactionTemplatesManager", {
    name:       "vnd-enhanced.settings.reactionMenu.name",
    label:      "vnd-enhanced.settings.reactionMenu.label",
    hint:       "vnd-enhanced.settings.reactionMenu.hint",
    icon:       "fas fa-theater-masks",
    type:       ReactionTemplatesApp,
    restricted: true
  });

  game.settings.register(ID, "vnData", {
    scope: "world",
    type: Object,
    config: false,
    default: {
      showVN: false,
      hideUI: false,
      hideBack: false,
      showForIds: null,
      editMode: false,
      combatMode: false,
      vsRevealed: false,
      stagePlayers: [],
      stageNPCs: [],
      leftCast: [],
      rightCast: [],
      portraits: {},
      location: {
        id: "",
        name: "???",
        parent: "",
        backgroundImage: "",
        weather: "",
        time: ""
      },
      locationList: []
    }
  });

  // Visual theme — "classic" keeps the current design untouched;
  // "darkest" applies the Darkest Dungeon-inspired skin (CSS-only overlay).
  game.settings.register(ID, "visualTheme", {
    name: "vnd-enhanced.settings.visualTheme.name",
    hint: "vnd-enhanced.settings.visualTheme.hint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      classic: "vnd-enhanced.settings.visualTheme.classic",
      darkest: "vnd-enhanced.settings.visualTheme.darkest"
    },
    default: "classic",
    onChange: applyVisualTheme
  });

  // Optional folder with user-extracted assets for the Darkest Dungeon theme
  // (title-font.ttf, body-font.ttf, panel-texture.png). Personal use only.
  game.settings.register(ID, "ddAssetsPath", {
    name: "vnd-enhanced.settings.ddAssetsPath.name",
    hint: "vnd-enhanced.settings.ddAssetsPath.hint",
    scope: "world",
    config: true,
    type: String,
    default: "",
    filePicker: "folder",
    onChange: applyVisualTheme
  });

  // Auto-cast: mirror combat tracker into the VN cast (players/companions left,
  // enemies right) when the combat stage opens or combatants join mid-fight.
  game.settings.register(ID, "autoCastFromCombat", {
    name: "vnd-enhanced.settings.autoCastFromCombat.name",
    hint: "vnd-enhanced.settings.autoCastFromCombat.hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  // Death tombstone — drop a gravestone tile where a combatant's token stood
  // when it is marked defeated; removed on revive or when combat ends.
  game.settings.register(ID, "deathTombstone", {
    name: "vnd-enhanced.settings.deathTombstone.name",
    hint: "vnd-enhanced.settings.deathTombstone.hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  // Select-on-target — when you target from the VN, also SELECT that token so
  // the system's damage buttons (which apply to selected tokens) hit it. Client
  // setting: each user decides whether VN targeting drives their selection.
  game.settings.register(ID, "selectOnTarget", {
    name: "vnd-enhanced.settings.selectOnTarget.name",
    hint: "vnd-enhanced.settings.selectOnTarget.hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });

  // ── Voice activity ──────────────────────────────────────────────────────────
  // Animates the portrait of whoever is talking. Platform-agnostic: it reads the
  // local microphone (or a held key), never Discord, so it works alongside any
  // voice chat. Off by default — the microphone path needs deliberate consent.

  game.settings.register(ID, "voiceActivityEnabled", {
    name: "vnd-enhanced.settings.voiceActivityEnabled.name",
    hint: "vnd-enhanced.settings.voiceActivityEnabled.hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: applyVoiceMode
  });

  game.settings.register(ID, "voiceAutoSpotlight", {
    name: "vnd-enhanced.settings.voiceAutoSpotlight.name",
    hint: "vnd-enhanced.settings.voiceAutoSpotlight.hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  // Per-client, because it is that user's own microphone and their own consent.
  game.settings.register(ID, "voiceInputMode", {
    name: "vnd-enhanced.settings.voiceInputMode.name",
    hint: "vnd-enhanced.settings.voiceInputMode.hint",
    scope: "client",
    config: true,
    type: String,
    choices: {
      off: "vnd-enhanced.settings.voiceInputMode.off",
      mic: "vnd-enhanced.settings.voiceInputMode.mic",
      ptt: "vnd-enhanced.settings.voiceInputMode.ptt"
    },
    default: "off",
    onChange: applyVoiceMode
  });

  game.settings.register(ID, "voiceThreshold", {
    name: "vnd-enhanced.settings.voiceThreshold.name",
    hint: "vnd-enhanced.settings.voiceThreshold.hint",
    scope: "client",
    config: true,
    type: Number,
    range: { min: -70, max: -20, step: 1 },
    default: -45
  });

  // Optional override for users who voice someone other than their assigned
  // character. Empty falls back to the assigned character, then to the selected
  // token — which is the natural gesture for a GM voicing an NPC.
  game.settings.register(ID, "voiceActorId", {
    name: "vnd-enhanced.settings.voiceActorId.name",
    hint: "vnd-enhanced.settings.voiceActorId.hint",
    scope: "client",
    config: true,
    type: String,
    default: ""
  });

  // RPG Classic Style — opt-in battlefield layout for Combat Mode. Default off:
  // an existing world keeps the side-panel + VS arrangement it already knows.
  game.settings.register(ID, "combatRpgStyle", {
    name: "vnd-enhanced.settings.combatRpgStyle.name",
    hint: "vnd-enhanced.settings.combatRpgStyle.hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => {
      applyRpgStyle();
      // Both layouts are built at render time, so the open window has to be
      // rebuilt for the switch to take effect without a reload.
      Hooks.callAll("vnd-enhanced.rerender");
    }
  });

  // HUD-only mode — world scope, like RPG Classic Style: the GM decides how the
  // table sees combat and everyone gets the same presentation. It also keeps the
  // ghost-token trade-off honest — ghosts are GM-created, so a per-client switch
  // would have let the GM silently strip portrait VFX from players still on the
  // full VN. Off by default so nothing changes for an existing world.
  game.settings.register(ID, "hudOnlyMode", {
    name: "vnd-enhanced.settings.hudOnlyMode.name",
    hint: "vnd-enhanced.settings.hudOnlyMode.hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => {
      applyHudOnly();
      // Visibility and the background are decided at render time, so the open
      // window has to be rebuilt for the switch to take effect without a reload.
      Hooks.callAll("vnd-enhanced.rerender");
    }
  });

  // TaleSpire Symbiote layout — "auto" switches it on only inside a Symbiote,
  // so desktop browsers keep the landscape layout untouched.
  game.settings.register(ID, "symbioteLayout", {
    name: "vnd-enhanced.settings.symbioteLayout.name",
    hint: "vnd-enhanced.settings.symbioteLayout.hint",
    scope: "client",
    config: true,
    type: String,
    choices: {
      auto: "vnd-enhanced.settings.symbioteLayout.auto",
      on:   "vnd-enhanced.settings.symbioteLayout.on",
      off:  "vnd-enhanced.settings.symbioteLayout.off"
    },
    default: "auto",
    onChange: () => {
      applySymbioteLayout();
      applyMobileMode();
      // Strips vs paged columns and the page size are built in JS, not CSS.
      Hooks.callAll("vnd-enhanced.relayout");
    }
  });

  // Manual combat reveal — when true the VS "duel" display (both fighters shown
  // large, front and center) stays hidden until the GM toggles it, and auto-hides
  // when the turn ends. When false it behaves as before (always shown in combat).
  // Under RPG Classic Style the duel is always opt-in (it overlays the field).
  game.settings.register(ID, "combatManualReveal", {
    name: "vnd-enhanced.settings.combatManualReveal.name",
    hint: "vnd-enhanced.settings.combatManualReveal.hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(ID, "bgFolderPath", {
    name: "vnd-enhanced.settings.bgFolderPath.name",
    hint: "vnd-enhanced.settings.bgFolderPath.hint",
    scope: "world",
    config: true,
    type: String,
    default: "",
    filePicker: "folder"
  });

  game.settings.register(ID, "portraitFolderPath", {
    name: "vnd-enhanced.settings.portraitFolderPath.name",
    hint: "vnd-enhanced.settings.portraitFolderPath.hint",
    scope: "world",
    config: true,
    type: String,
    default: "",
    filePicker: "folder"
  });

  game.settings.register(ID, "worldOffsetY", {
    name: "vnd-enhanced.settings.worldOffsetY.name",
    hint: "vnd-enhanced.settings.worldOffsetY.hint",
    scope: "world",
    config: true,
    type: Number,
    default: 0
  });

  game.settings.register(ID, "zIndex", {
    name: "vnd-enhanced.settings.zIndex.name",
    hint: "vnd-enhanced.settings.zIndex.hint",
    scope: "world",
    config: true,
    type: Number,
    default: 90
  });

  game.settings.register(ID, "vnReactionTemplates", {
    scope: "world",
    type: Object,
    config: false,
    default: {}
  });

  // World-level license flag — written by GM client after Patreon auth,
  // read by all clients to decide whether to activate the module.
  game.settings.register(ID, "worldLicensed", {
    scope: "world",
    type: Boolean,
    config: false,
    default: false
  });

  // AI Image Generator — folder where generated images are saved
  game.settings.register(ID, "aiImageFolder", {
    name:    "vnd-enhanced.settings.aiImageFolder.name",
    hint:    "vnd-enhanced.settings.aiImageFolder.hint",
    scope:   "world",
    type:    String,
    config:  true,
    default: "vnd-enhanced/ai-generated"
  });

  // Sound effects folder and per-event file names
  game.settings.register(ID, "sfxFolder", {
    name: "vnd-enhanced.settings.sfxFolder.name",
    hint: "vnd-enhanced.settings.sfxFolder.hint",
    scope: "world",
    config: true,
    type: String,
    default: "vnd-enhanced/sfx",
    filePicker: "folder"
  });

  game.settings.register(ID, "enableSfx", {
    name: "vnd-enhanced.settings.enableSfx.name",
    hint: "vnd-enhanced.settings.enableSfx.hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(ID, "sfxTurnStart", {
    scope: "world",
    config: true,
    type: String,
    default: "turn-start.ogg"
  });

  game.settings.register(ID, "sfxVictory", {
    scope: "world",
    config: true,
    type: String,
    default: "victory.ogg"
  });

  game.settings.register(ID, "sfxDefeat", {
    scope: "world",
    config: true,
    type: String,
    default: "defeat.ogg"
  });

  // Toggle automatic reactions based on HP thresholds (GM-configurable)
  game.settings.register(ID, "enableAutoReactions", {
    name: "vnd-enhanced.settings.enableAutoReactions.name",
    hint: "vnd-enhanced.settings.enableAutoReactions.hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  // Auto-apply reaction templates when thresholds are hit
  game.settings.register(ID, "enableAutoApplyTemplates", {
    name: "vnd-enhanced.settings.enableAutoApplyTemplates.name",
    hint: "vnd-enhanced.settings.enableAutoApplyTemplates.hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(ID, "autoTemplateCritical", {
    name: "vnd-enhanced.settings.autoTemplateCritical.name",
    hint: "vnd-enhanced.settings.autoTemplateCritical.hint",
    scope: "world",
    config: true,
    type: String,
    default: ""
  });

  game.settings.register(ID, "autoTemplateHurt", {
    name: "vnd-enhanced.settings.autoTemplateHurt.name",
    hint: "vnd-enhanced.settings.autoTemplateHurt.hint",
    scope: "world",
    config: true,
    type: String,
    default: ""
  });

  // Cast Presets — saved cast configurations (leftCast + rightCast + portraits)
  game.settings.register(ID, "castPresets", {
    scope:   "world",
    type:    Object,
    config:  false,
    default: {}
  });

  // Per-client turn timer preferences
  game.settings.register(ID, "timerMinutes", {
    scope:   "client",
    type:    Number,
    config:  false,
    default: 2
  });

  game.settings.register(ID, "timerAutoReset", {
    scope:   "client",
    type:    Boolean,
    config:  false,
    default: false
  });

  // Whether players should see exact HP numbers (GM-configurable world setting)
  game.settings.register(ID, "showHpToPlayers", {
    name: "vnd-enhanced.settings.showHpToPlayers.name",
    hint: "vnd-enhanced.settings.showHpToPlayers.hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
}
