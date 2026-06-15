const ID = "vnd-enhanced";

export function registerSettings() {
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
      activeSpeakerId: null,
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
    name: "Background images folder",
    hint: "Default folder opened when picking a background image.",
    scope: "world",
    config: true,
    type: String,
    default: "",
    filePicker: "folder"
  });

  game.settings.register(ID, "portraitFolderPath", {
    name: "Portrait images folder",
    hint: "Default folder opened when picking portrait images.",
    scope: "world",
    config: true,
    type: String,
    default: "",
    filePicker: "folder"
  });

  game.settings.register(ID, "worldOffsetY", {
    name: "Global portrait Y offset (px)",
    hint: "Shifts every portrait up or down globally.",
    scope: "world",
    config: true,
    type: Number,
    default: 0
  });

  game.settings.register(ID, "zIndex", {
    name: "UI z-index",
    hint: "Raise if other UI elements overlap the VN window.",
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

  // AI Image Generator — folder where generated images are saved
  game.settings.register(ID, "aiImageFolder", {
    name:    "AI Images Folder",
    hint:    "Carpeta donde se guardan las imágenes generadas con IA. Relativa al almacenamiento de Foundry.",
    scope:   "world",
    type:    String,
    config:  true,
    default: "vnd-enhanced/ai-generated"
  });
}
