import { VndLicenseMenu } from "./license-client.js";

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

Hooks.once("ready", applyVisualTheme);

export function registerSettings() {
  // License manager — tier, installation slots, self-service slot release
  game.settings.registerMenu(ID, "licenseManager", {
    name:       "vnd-enhanced.settings.licenseMenu.name",
    label:      "vnd-enhanced.settings.licenseMenu.label",
    hint:       "vnd-enhanced.settings.licenseMenu.hint",
    icon:       "fas fa-key",
    type:       VndLicenseMenu,
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
}
