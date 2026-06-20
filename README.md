# VN Dialogues Enhanced

**Visual Novel-style dialogue display for Foundry Virtual Tabletop — with cinematic combat, AI image generation, and full session immersion.**

> Made by **GM RedVelvet** · **The GM Studio**
> 🔐 Requires an active [Patreon subscription](https://www.patreon.com/TheGMStudio)

---

## Overview

VN Dialogues Enhanced transforms your Foundry VTT sessions into a cinematic experience. Inspired by visual novel storytelling and Persona-style combat presentation, it gives every character a stage and every moment a frame.

---

## Features

### Dialogue Stage
- **Active speaker always center and large** — the speaking character is highlighted; all others are dimmed in the side panels.
- **Left panel (Players) / Right panel (NPCs)** — up to 10 actors per side, paginated with smooth navigation.
- **Click to speak** — single-click any portrait to toggle stage presence; double-click for the full context menu.
- **Drag actors** from the Foundry sidebar or between panels to rearrange the cast instantly.

### Portrait System
- **Per-actor portrait editor** — set image, title, scale, X/Y offset, and horizontal mirror per character.
- **Reaction / Expression system** — define named expressions (happy, hurt, critical, etc.) and switch them during the session. Players can control their own character's expression.
- **Auto-HP reactions** — name a reaction `hurt` (≤50% HP) or `critical`/`ko` (≤25% HP) and it activates automatically when the actor takes damage.
- **Quick adjust toolbar** (Edit Mode) — scale up/down and mirror directly from the portrait card without opening the editor.
- **Live preview** — sliders update the portrait in real time before saving.
- **Cast Presets** — save and restore entire cast configurations (actors + reactions + settings) in one click.
- **Spotlight Mode** — double-click any stage portrait to isolate it with a dramatic focus effect. Press Escape or double-click again to exit.

### Scene Management
- **Scene library** — create, edit, and delete named scenes with background image/video, region, weather, and time metadata.
- **Background support** — images (PNG, JPG, GIF, WebP), animated GIFs, and videos (MP4, WebM).
- **Export / Import** — save your scene library as a JSON file and import it into any other world.
- **Quick-switch bar** — one-click scene switching from the bottom bar.

### Combat Stage
- **Combat Mode** activates a Persona-style presentation over the standard Foundry combat tracker.
- **Turn Card** — full-screen cinematic portrait announcement on every turn change.
- **Damage Floaters** — animated HP delta numbers over the affected portrait.
- **Critical Hit / Fumble Overlay** — epic screen flash with custom art on nat-20 / nat-1 (D&D 5e) or critical success/failure (PF2e).
- **Portrait Hit Shake** — portrait trembles on damage received.
- **VS Combat Display** — persistent left-vs-right HP bars for the current combatants.
- **Initiative Carousel** — scrollable turn order with NOW / NEXT / +2 badges and HP bars.
- **Round Escalation** — visual intensity increases at rounds 3, 5, and 7.
- **Turn Timer** — per-turn countdown with auto-reset option; auto-advances to next turn at 0.
- **Turn Whisper** — automatically whispers the active player when it is their turn.
- **Ghost Token Bridge** — invisible off-screen tokens provide full Sequencer/Automated Animations/PF2e compatibility without placing characters on the map.

### VFX Integration
- **Sequencer** — canvas effects automatically mirror to the VN portrait layer.
- **Automated Animations** — source/target tokens are automatically substituted with ghost tokens so animations play on portraits.
- **Screen-space VFX** — effects render above all Foundry UI at the portrait's exact screen position.
- **CSS Projectile System** — animated projectiles travel from source portrait to target portrait.

### AI Image Generator *(premium tier)*
- **Scene Studio** — describe a scene idea → AI expands it into a structured brief → generates a background image.
- **Character Studio** — upload a reference image and generate pose/expression variations for your portraits.
- Credit-based system managed per Patreon tier.

### General
- **Player visibility control** — show or hide the VN window per connected player.
- **Hide UI mode** — collapse all panels to show only the background and portraits.
- **Alt+V keybinding** — toggle the VN window from anywhere.
- **Scene Toolbar button** — dedicated button in the Foundry scene controls.
- **Macro API** — full `VNEnhanced.*` API for macros and Active Tile Triggers.
- **No map required** — works on any scene or even without an active scene.

---

## Compatibility

| Foundry VTT | Status |
|---|---|
| v14 | ✅ Verified |
| v13 | ✅ Supported |
| v12 | ✅ Supported |
| v11 | ✅ Supported |

**Game systems:** System-agnostic. HP tracking and crit detection include native support for **PF2e** and **D&D 5e**. Other systems work with the generic text-pattern fallback.

**Optional integrations:** [Sequencer](https://foundryvtt.com/packages/sequencer), [Automated Animations](https://foundryvtt.com/packages/autoanimations)

---

## Installation

> **This module requires an active Patreon subscription.** The module activates via a Patreon OAuth flow directly inside Foundry.

### From the Foundry Module Manager (recommended)
1. In Foundry, go to **Add-on Modules → Install Module**.
2. Paste the manifest URL:
   ```
   https://github.com/gmredvelvet-rgb/vnd-enhanced/releases/latest/download/module.json
   ```
3. Click **Install**, then enable the module in your world.
4. On first launch, click the **VNE button** (top-right FAB) and connect your Patreon account.

### Manual installation
1. Download `module.zip` from the [latest release](https://github.com/gmredvelvet-rgb/vnd-enhanced/releases/latest).
2. Extract it into your Foundry `Data/modules/vnd-enhanced/` folder.
3. Enable the module in your world settings.

---

## Quick Start

1. Open the VN window with **Alt+V** or the toolbar button.
2. Drag actors from the **Actors sidebar** onto the left or right panel.
3. Click a portrait to make that character the **active speaker**.
4. Use the **Scenes bar** (bottom) to switch backgrounds.
5. In **Edit Mode** (pencil icon), right-click any portrait to open the full portrait editor.

---

## Macro API

```js
// Open / close
VNEnhanced.toggle();
VNEnhanced.show(["userId1", "userId2"]); // show for specific players only
VNEnhanced.hide();

// Cast management
VNEnhanced.addActor("actorId", "left");  // or "right"
VNEnhanced.removeActor("actorId");
VNEnhanced.clearCast();

// Speaker
VNEnhanced.setSpeaker("actorId");
VNEnhanced.clearSpeaker();

// Scenes
VNEnhanced.setScene("Tavern");           // by name or id
VNEnhanced.setBackground("path/to/bg.jpg");

// Reactions
VNEnhanced.setReaction("actorId", "happy");

// VFX
VNEnhanced.playEffect("actorId", "path/to/effect.webm");
VNEnhanced.playProjectile("sourceId", "targetId", "path/to/projectile.webm");

// Combat
VNEnhanced.setCombatMode(true);

// Presets
VNEnhanced.saveCastPreset("Main Party");
VNEnhanced.loadCastPreset("Main Party");
```

---

## Support & Bugs

- **Bug reports:** [GitHub Issues](https://github.com/gmredvelvet-rgb/vnd-enhanced/issues)
- **Discord / Support:** Contact `gmredvelvet` on Discord
- **Patreon:** [patreon.com/TheGMStudio](https://www.patreon.com/TheGMStudio)

---

## Credits

| Role | Name |
|---|---|
| Design & Development | **GM RedVelvet** |
| Production & Studio | **The GM Studio** |

Critical success / fumble artwork included in `assets/imgs/` is original work by The GM Studio.

---

## License

This module is **proprietary software**. Use requires an active Patreon subscription to The GM Studio.
Redistribution, resale, and public re-upload are strictly prohibited.
See [LICENSE](LICENSE) for full terms.
