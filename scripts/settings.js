import { VndLicenseMenu } from "./license-client.js";

const ID = "vnd-enhanced";

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
