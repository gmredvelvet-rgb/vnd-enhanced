# VND Enhanced — Full Engineering Audit (2026-07-02)

Scope: every file in the module (4 frontend scripts, 2 templates, 2 stylesheets, en.json, module.json) and the complete Cloudflare Worker backend (11 files). Nothing was reviewed in isolation; every finding below was verified against its callers and consumers.

**Overall assessment:** the module is in far better shape than a typical hobby module — the security architecture (RS256-signed responses, token rotation, replay protection, XSS escaping discipline) is genuinely strong, and the DOM-patching strategy for partial updates is the right instinct. The gaps that keep it from "commercial AAA" are: (1) paid features that silently don't do what the UI promises, (2) a license-resilience hole that can suspend a live session, (3) a large amount of dead code/CSS from an abandoned "center speaker" design, (4) unlocalized, mixed Spanish/English UI, and (5) accessibility that is effectively zero (div-buttons, no keyboard path).

---

## CRITICAL

### C1. AI Studio "Complejidad" tier does nothing
- **Category:** Bug / Gameplay · **Severity:** Critical
- **Description:** The Scene Studio offers Estándar / Detallado / Épico complexity. The selection is validated and written to the audit log, but never affects generation.
- **Root Cause:** `handleSceneGenerate` (backend/src/routes/ai.js:100) calls `flux.generateScene({ finalPrompt, sceneType, style, references, quality, n })` — `sceneTier` is omitted, and `FluxClient.generateScene` has no parameter for it.
- **Proposed Solution:** Either pass `sceneTier` into the prompt assembly in flux.js (e.g. append detail-level fragments like the style/type fragments) or remove the selector from the UI. Do not ship a paid control that is a no-op.
- **Expected Benefit:** Paying users get what the UI sells; removes a refund/trust liability.

### C2. Scene Studio advertises 4 role-based reference slots; only 1 is used
- **Category:** Bug / Gameplay · **Severity:** Critical
- **Description:** The UI presents four labeled slots (Composición, Estilo, Arquitectura, Paleta). The backend accepts all four, then `flux.js:108` uses only `references[0]` as `image_prompt` (strength 0.15). Roles are ignored entirely.
- **Root Cause:** Flux `flux-2-pro` accepts a single `image_prompt`; the UI was designed for a multi-reference API that was never wired.
- **Proposed Solution:** Short term: collapse the UI to one "Reference image" slot. Long term: if BFL multi-ref or a compositing pass is added, restore the roles. At minimum tell the user only the first filled slot counts.
- **Expected Benefit:** Honest UI; users stop wasting effort curating 4 references.

### C3. Subscription feature tiers are not enforced anywhere in the module
- **Category:** Security / Architecture · **Severity:** Critical (business logic)
- **Description:** The backend computes per-tier feature lists (`basic` lacks `vs-display`, `victory-overlay`, `action-overlay`, `rp-stage`, `timer-auto`). The client stores them and exposes `VNEnhanced.hasFeature()`, but **no code path in main.js ever checks a feature**. A basic ($6) subscriber gets every premium ($10) feature except AI generation volume.
- **Root Cause:** `hasFeature` was built (license-client.js:90) but gating was never wired into `toggleCombatStage`, `_renderVSDisplay`, `_showVictoryOverlay`, `_patchVNStage`, timer auto-reset, etc.
- **Proposed Solution:** Decide the actual business model. If tiers should differ: gate each premium entry point with `VndLicenseClient.instance.hasFeature(...)` and show an upsell tooltip on locked buttons. If not: collapse the backend feature lists so the data matches reality.
- **Expected Benefit:** Pricing integrity; premium tier becomes meaningful.

### C4. Heartbeat can never recover after >1 h offline → module suspends mid-session until reload
- **Category:** Bug / Architecture · **Severity:** Critical
- **Description:** If the GM's machine sleeps or loses network for over an hour, the access token (1 h TTL) expires. `#doHeartbeat` (license-client.js:299) calls `/heartbeat`, which requires a **valid** access token (`requireAuth`). Every subsequent heartbeat 401s, the grace period elapses, `#handleHeartbeatFailure` sets `worldLicensed=false` — killing the module for the whole table — and nothing ever attempts the refresh-token flow again until a full page reload.
- **Root Cause:** `#doHeartbeat`'s catch path never falls back to `#doRefresh()`; recovery only exists in `initialize()`.
- **Proposed Solution:** In the heartbeat failure handler, if `!#isAccessTokenValid()` and a refresh token exists, run `#doRefresh()` and retry the heartbeat before counting it as a failure. Also clear `#degraded` and re-set `worldLicensed=true` on the first successful recovery.
- **Expected Benefit:** Laptop-sleep or ISP blips no longer nuke a live game session.

### C5. Token-texture swap hook runs on every client without a GM guard
- **Category:** Bug / Foundry Integration · **Severity:** Critical
- **Description:** In the consolidated `updateActor` hook (main.js:3827-3838), the `tokenStates` HP-threshold texture swap calls `t.document.update({"texture.src": img})` with **no `game.user.isGM` check**. Every connected client fires it: players without token-update permission throw permission errors on every HP change of a flagged actor, and multiple GMs double-write.
- **Root Cause:** Logic merged from an older hook lost its guard; contrast with `_applyAutoReaction`, which checks `isGM`.
- **Proposed Solution:** Wrap the block in `if (game.user.isGM)`. Also fix the max-HP fallback: `actor.system?.attributes?.hp?.max ?? 1` produces absurd percentages on systems using `system.hp.max` — reuse `_getCarouselActorHP`.
- **Expected Benefit:** No console error spam on player clients; no duplicate document writes.

### C6. AI generation allowance appears never to renew
- **Category:** Bug / Backend · **Severity:** Critical (verify against production data)
- **Description:** `vnd_ai_tokens` rows are created with `renewal_date: null` (ai.js:55-61), `checkRenewal` only resets **when `renewal_date <= now`**, and after a reset it writes `renewal_date: null` again. No code in the worker ever sets a future `renewal_date`. Unless a Supabase trigger/cron does it, users who exhaust their generations are locked out forever, and the UI's "Renovación: —" is telling the truth.
- **Root Cause:** The renewal writer (presumably tied to Patreon billing cycle) was never implemented.
- **Proposed Solution:** On token-row creation and on each reset, set `renewal_date` to the next Patreon billing anchor (or first of next month). Alternatively reset lazily in `getOrCreateTokens` when `last_reset_at` is in a previous month.
- **Expected Benefit:** Subscribers' monthly allowance actually renews; fewer support tickets.

---

## HIGH

### H1. Players get lying UI on GM-only controls
- **Category:** UX / Bug · **Severity:** High
- **Description:** `saveData()` silently no-ops for non-GMs, but several player-visible controls call it. Worst case: in the Scenes panel, a player clicking a scene card gets the **active-card highlight applied locally** (main.js:2952-2954) even though nothing was saved — the UI confirms an action that never happened. The background toggle (`#vne-hideback-btn`) is likewise shown to players and does nothing.
- **Root Cause:** Templates/panels don't distinguish "visible to players" from "operable by players"; optimistic DOM updates run before/regardless of permission.
- **Proposed Solution:** In `openScenesPanel` and the top bar, either hide GM-only affordances for players (`game.user.isGM` guards at render time) or make them explicitly read-only (cursor/disabled state). Never apply optimistic highlights when `!game.user.isGM`.
- **Expected Benefit:** Players stop reporting "the module is broken"; interface honesty.

### H2. Turn-timer AUTO toggle is meaningless while the timer runs
- **Category:** Bug / UX · **Severity:** High
- **Description:** `updateCombat` restarts the timer when `_timerAutoReset || _timerEnabled` (main.js:4511). A *running* timer therefore always resets on every turn change even with AUTO off — directly contradicting the AUTO tooltip ("el timer no se reinicia solo").
- **Root Cause:** The `|| _timerEnabled` condition makes the AUTO flag redundant whenever the timer is active; AUTO only matters when the timer is stopped.
- **Proposed Solution:** Decide the semantic: if AUTO means "restart each turn," the condition should be `_timerAutoReset` alone (a running non-auto timer keeps counting across turns), or keep current behavior and rewrite the AUTO tooltip to "also start automatically on turn change." Also clamp the minutes input (`parseInt("-5")` currently yields a "-5:00" display and instant turn-skip).
- **Expected Benefit:** Timer behaves as labeled; no accidental instant `nextTurn()`.

### H3. Localization is dead; UI is a Spanish/English patchwork
- **Category:** Code Quality / UX · **Severity:** High
- **Description:** `language/en.json` (53 lines) is ~100 % unused — no `game.i18n.localize` call references it except status-effect names. Meanwhile the UI hardcodes mixed languages: "¡VICTORIA!", "TU TURNO", "TURNO", "Voltear izq/der", "Anteriores/Siguientes", "Buscar…", "Sin resultados", "Doble clic para salir", the entire AI Studio, and one settings hint in Spanish — while the help overlay, tooltips, and combat labels are English. An English-only table sees Spanish combat banners; a Spanish table sees English help.
- **Root Cause:** Features were added with literal strings; the localization file predates them and was never maintained.
- **Proposed Solution:** Sweep every user-facing literal into `en.json` under structured keys, use `game.i18n.localize`/`format` everywhere (including strings built in JS template literals), then add `es.json` — you clearly want both languages, and the infrastructure is already declared in module.json.
- **Expected Benefit:** Single-language consistency per client, community translations become possible, and the "AI-generated feel" of mixed-language UI disappears.

### H4. Abandoned "center speaker" feature: dead template node, dead CSS, dead JS
- **Category:** Architecture / Code Quality · **Severity:** High
- **Description:** `#vne-center-speaker` (vnMain.hbs:166) is never populated by any code. Dead with it: ~170 lines of CSS (`.vne-center-portrait-wrap`, `.vne-center-img`, `.vne-nameplate*`, `.vne-no-speaker`, `.vne-speaker-clear-btn`, `vne-speaker-in`), the `.vne-center-img` query in `_showActionImageOverlay`, plus dead functions `setSpeaker()` (main.js:393) and `_buildReactionsHTML()` (main.js:3211). Additional dead CSS: `.vne-rp-speaking` (never applied), `.vne-header-participants`, `.vne-combat-indicator`, `.vne-rp-add-slot`, scrollbar rules for `.vne-scene-bar`/`.vne-actor-picker-grid`. Backend dead weight: `openai.js` `calculateCost`/`calculateSceneCost` + duplicated prompt tables (flux.js is the live copy), and the `/shops` route serves data for a different module.
- **Root Cause:** The RP-stage redesign replaced the single-center-speaker layout, but the old implementation was only half-removed.
- **Proposed Solution:** Delete the node, the CSS blocks, both dead functions, and the duplicated backend prompt code. Move `/shops` to the module that consumes it (or a shared worker route file clearly marked as external).
- **Expected Benefit:** ~300 lines removed, template/CSS truthfully reflect the product, future contributors stop reasoning about phantom features.

### H5. AppV1 everywhere while claiming Foundry v14 compatibility
- **Category:** Foundry Integration · **Severity:** High
- **Description:** module.json claims `verified: 14`, but the module is built on `FormApplication`, `Dialog`, and jQuery `html.find(...)` — all AppV1 APIs deprecated since v12/v13 and scheduled for removal. Additionally, `getSceneControlButtons` handles `Array` (v11/12) and `Map`, but v13 actually passes a **plain object record** — `controls instanceof Map` is false, so the toolbar button silently never appears on v13+ (the Alt+V fallback masks it).
- **Root Cause:** Compatibility ceiling raised without migrating APIs; the v13 controls shape was misremembered as a Map.
- **Proposed Solution:** (1) Fix `getSceneControlButtons` now: add an `else { controls.vndEnhanced = {...} }` branch for the record shape and verify on v13. (2) Plan the ApplicationV2/DialogV2 migration (VNE shell, portrait editor, reaction manager, scene editor, presets dialog, AI Studio). (3) Until migrated, lower `verified` to the version actually tested.
- **Expected Benefit:** Toolbar button returns on v13/14; no breakage when AppV1 is removed; manifest honesty.

### H6. Ghost-token system leaves real documents on scenes and churns documents on sheet-open
- **Category:** Foundry Integration / Architecture · **Severity:** High
- **Description:** Combat ghosts are real, **non-hidden** (`alpha: 0.001`) linked tokens stacked in the scene corner. Consequences: (a) players can box-select/target them; (b) they persist in the scene document if the GM closes the browser mid-combat — cleanup only runs on `canvasReady` *when VN+combat mode are still on*, so ghosts orphan if the GM disabled combat mode after a crash; (c) with Automated Animations active, **every** `renderActorSheet` for a token-less actor creates a ghost token (a document write on sheet open) and deletes it on close.
- **Root Cause:** Sequencer needs resolvable token positions on all clients, which forced visible tokens; cleanup paths were added reactively per-scenario rather than as one reconciler.
- **Proposed Solution:** Run the stale-ghost sweep on `canvasReady` **unconditionally** (flag-scan is cheap) and on `ready`. Consider `displayName: 0`, zero-size texture, and `locked: true` on ghosts to reduce player interaction surface. For sheet ghosts, debounce creation (only on first roll attempt, not sheet render) or cache per-session.
- **Expected Benefit:** No orphaned tokens accumulating in worlds; drastically fewer document writes; fewer "what is this invisible token" reports.

### H7. Sidebar DOM hijack is fragile
- **Category:** Foundry Integration · **Severity:** High
- **Description:** `_mountSidebar` reparents Foundry's `#sidebar` into `document.body` with inline `!important` styles. Any module or core code that assumes `#sidebar`'s parent (v13 AppV2 sidebar re-render, UI layout modules, popout modules) can break, and if VNE errors before `close()`, the sidebar stays detached and fixed.
- **Root Cause:** Escaping `#interface`'s stacking context to keep the sidebar clickable above the full-screen VN layer.
- **Proposed Solution:** Prefer lowering VNE below the sidebar instead of raising the sidebar: the VN shell already manages its own z-index; setting `#vne-main` z-index below `var(--z-index-app)` sidebar band plus a right-side inset (grid column reserved for the sidebar width when expanded) avoids touching Foundry DOM at all. If reparenting must stay, wrap in try/finally and restore on `Hooks.on("error")`/module disable.
- **Expected Benefit:** Compatibility with other UI modules and future Foundry versions; no stuck-sidebar states.

---

## MEDIUM

### M1. `getData()` deep-clones the entire world state on every hook
- **Category:** Performance · **Root Cause:** `foundry.utils.deepClone(game.settings.get(ID,"vnData"))` runs in every hook (`updateActor` per HP tick, `targetToken`, every render, every context menu). With 20 cast portraits + reactions + locationList this is kilobytes of garbage per event.
- **Solution:** Cache the parsed object; invalidate in the `updateSetting` hook; only clone when the caller intends to mutate (`getData({mutable:true})`).
- **Benefit:** Less GC pressure during combat, where hooks fire most.

### M2. Carousel renders into a hidden element
- **Category:** Performance · **Root Cause:** `#vne-unified-carousel` is `vne-hidden` outside combat mode, but `renderVNECombatCarousel` still rebuilds its innerHTML and rebinds listeners on every actor/token/effect update (debounced 80 ms), including the VN-mode card set that is never visible.
- **Solution:** Early-return when the element is hidden (`!d.combatMode && !game.combat`), or drop `_renderVNECarouselVNMode` entirely (it's invisible dead output).
- **Benefit:** Zero wasted DOM churn during roleplay scenes.

### M3. Divergent portrait renderers (template vs JS) drift
- **Category:** Bug / Code Quality · **Root Cause:** Side-panel portraits are rendered twice: Handlebars (`vnMain.hbs:141-151`) and `_buildCastPortraitEl` (main.js:3078). The hbs version shows the owned-star badge but lacks `vne-your-turn` and quick-controls; the JS version is the inverse. After the first `castChange` patch, the badge silently disappears.
- **Solution:** Single renderer: make the template render an empty `#vne-left-portraits` and always populate via `_patchSidePanel` on first render (it already runs in `activateListeners`). Delete the hbs `{{#each}}` blocks.
- **Benefit:** One source of truth; no visual pop after the first update.

### M4. `VNE.toggle()` wipes per-player visibility every open/close
- **Category:** UX / Bug · **Root Cause:** `toggle(showForIds = null)` overwrites `d.showForIds` with `null` on every toggle, so a GM who hid the VN from one player loses that setting whenever they close and reopen.
- **Solution:** Preserve existing `showForIds` unless explicitly passed: `d.showForIds = showForIds === undefined ? d.showForIds : showForIds`.
- **Benefit:** Visibility choices persist across toggles.

### M5. Outside-click listeners leak until next click
- **Category:** Code Quality · **Root Cause:** `openActorPicker`, `openScenesPanel`, and the status picker attach capturing `document` listeners removed only inside the outside-click branch; closing via the ✕ button or selecting an item leaves the listener attached (it self-removes on the *next* unrelated click).
- **Solution:** Use `AbortController` per popup: pass `{ signal }` to all its listeners and `abort()` in a single `close()` helper.
- **Benefit:** No stray capturing listeners; pattern becomes reusable for all six popups.

### M6. Inconsistent cast-size caps (5 vs 10)
- **Category:** Bug / API · **Root Cause:** UI paths cap casts at 10 (`_addActor`, `_onDrop`, context menu) but the public API `VNEnhanced.addActor` caps at 5 (main.js:4039), silently evicting the oldest portrait earlier than the UI would.
- **Solution:** One `MAX_CAST = 10` constant used everywhere; extract the duplicated "add portrait to side" logic (it exists 4×) into one helper.
- **Benefit:** Macros and UI behave identically; removes 3 copies of the same block.

### M7. Generic crit regex can false-positive on chat text
- **Category:** Bug · **Root Cause:** `_parseCritFromMessage`'s fallback greps rendered HTML for `crítico|critical hit|fumble|pifia` — any chat card or journal quote containing those words triggers the full-screen crit overlay (outside the 2.5 s turn-change suppression window).
- **Solution:** Only run the text fallback when `message.rolls?.length > 0`, and require `message.isRoll`.
- **Benefit:** No surprise "¡CRÍTICO!" banners from narration text.

### M8. Backend: rate limiter window resets on every request; token spend races
- **Category:** Backend / Code Quality · **Root Cause:** `rateLimiter` re-puts the KV key with a fresh TTL each request (window extends indefinitely under sustained traffic — stricter than documented) and read-increment-write races. AI token deduction (`tokens_used + 1` then refund with the stale value on failure) can double-spend or clobber a concurrent increment.
- **Solution:** Acceptable for current scale, but document it; for correctness use a Durable Object counter or Supabase RPC (`increment_tokens_used`) with a `WHERE tokens_used = $expected` guard.
- **Benefit:** Accurate quotas under concurrency.

### M9. Backend route-mounting duplication and dead statements
- **Category:** Backend / Code Quality · **Root Cause:** `index.js` mounts `licenseRouter` at `/token`, `/heartbeat`, **and** `/`, creating junk endpoints (`/heartbeat/refresh`, `/heartbeat/heartbeat`, `/refresh`). `license.js:98` performs an empty `db.update(..., {})`. `/license/status` returns `world_id`, which is never written anywhere.
- **Solution:** Mount once at `/` (all paths are already unique), delete the empty update and the phantom field.
- **Benefit:** Smaller attack/testing surface, clearer routing.

### M10. `releaseInstallation` has no UI
- **Category:** UX / Gameplay · **Root Cause:** The 2-slot install limit exists, and the release endpoint + client method exist, but no button anywhere calls `releaseInstallation()`. A GM who switches browsers (localStorage-keyed install ID) burns a slot with no self-service way to free it — the eviction fallback in `/oauth/exchange` saves them, but by silently killing their other install.
- **Solution:** Add a "Manage license" section (module settings menu): show tier, slots (via `/license/status`), and a Release button per slot.
- **Benefit:** Self-service slot management; fewer confused "my other world stopped working" reports.

### M11. Constant infinite animations while idle
- **Category:** Performance / Visual · **Root Cause:** Round tiers 2–3 add multiple infinite pulse/throb animations on full-viewport pseudo-elements, plus `backdrop-filter: blur` on three full-width bars; the VS "VS" text and speaking rings pulse forever. On low-end machines this is a constant compositor load during the entire combat.
- **Solution:** Honor `prefers-reduced-motion`; pause tier animations via `animation-play-state` when the tab reports low FPS or when `hideUI` is on; limit full-viewport `box-shadow` pulses to `opacity` keyframes on a pre-rendered layer (already mostly done — verify tier-2/3 `::after`).
- **Benefit:** Cooler laptops, accessibility compliance.

---

## LOW

- **L1. Accessibility baseline (Category: Accessibility · would be High for a storefront release):** nearly all interactive elements are `<div>`s (`.vne-ctrl-btn`, cards, menu items) — no keyboard focus, no Enter/Space activation, no ARIA roles, no visible focus ring; carousel names render at 8 px; HP state is color-only. Fix pattern: swap to `<button type="button">`, add `:focus-visible` styles, `aria-label` from the existing `title`s, and an HP text alternative. The help overlay and dialogs are also not focus-trapped.
- **L2. `onerror="this.src='icons/svg/mystery-man.svg'"` inline handlers:** loop forever if the fallback itself 404s and violate strict CSP setups. Use `addEventListener('error', ..., { once: true })` in the renderers.
- **L3. Settings text:** `aiImageFolder` hint is Spanish in an otherwise English settings sheet; `worldOffsetY`/`zIndex` names are unlocalized. Fold into H3.
- **L4. `vnProjectile` socket spam:** any client can broadcast unlimited projectile animations to everyone (file path is validated, volume is not). Add a per-sender client-side rate cap (e.g. 5/s drop).
- **L5. `aiImageFolder` setting is unused:** images save to `modules/vnd-enhanced/generated/...` (`_saveToFoundry`), which is destroyed on module update. Honor the setting and default it to a `Data`-relative folder outside the module directory. *(This is arguably High for users who lose purchased generations on update — recommend fixing in Phase 1.)*
- **L6. `_showTurnCard`/crit overlays append to `document.body` with z-index 99990+:** they cover dialogs and the sidebar by design, but also cover Foundry's escape menu; consider capping below `#notifications`.
- **L7. Duplicated crypto/escape utilities:** `_esc`/`_escapeHTML`, RSA import + response-verify exist in both license-client.js and ai-generator.js; `API_BASE` and the public key are declared twice. Extract a shared `scripts/lib/crypto.js` + `scripts/lib/dom.js`.
- **L8. README/manifest polish:** `compatibility.verified: 14` (see H5), no `media` array for the package listing, `flags` absent. For a commercial listing add screenshots and a changelog URL.
- **L9. Status picker `setTimeout(rebuildGrid, 500)`:** fixed delay races slow PF2e condition writes; prefer awaiting the toggle promise then rebuilding immediately (the awaits already exist — the timeout is redundant pessimism).
- **L10. `timingSafeEqual` HMAC trick (license.js:258):** correct but exotic; note that fingerprint mismatch is deliberately soft-fail — the "after 5 occurrences triggers manual review" comment describes logic that doesn't exist. Either implement the counter or fix the comment.

---

## What was checked and found healthy (no action)

- **XSS discipline:** all user-controlled interpolations audited (`_esc` coverage in menus, cards, floaters, chat whisper, scene cards, AI results). Found none unescaped that carry user data.
- **Socket security model:** GM-authoritative writes, actor-ownership validation on stage toggles, media-extension whitelist + duration clamp on projectiles, licensed-world gate on all broadcast handlers. `senderId` is correctly treated as untrusted.
- **Backend auth chain:** state-parameter CSRF on OAuth, opaque single-use auth codes, refresh-token rotation with family revocation on reuse, KV revocation lists checked in `requireAuth`, signed responses with payload-hash binding and 60 s TTL, secrets kept out of wrangler.toml.
- **Timer drift handling** (Date.now-based ticking), **HP floater PF2e override** (raw damage vs clamped delta), **showForIds=[] lockout fix**, **ghost-token exclusion from targeting/tracker**, and **turn-card timer cancellation** are all correctly implemented.

---

## Prioritized Roadmap

### Phase 1 — Critical fixes (ship as 1.1.6 hotfix) — ✅ IMPLEMENTED 2026-07-02
1. ✅ C5: `isGM` guard + HP-max fallback in the tokenStates block.
2. ✅ C4: heartbeat → refresh-token fallback and recovery path (restores `worldLicensed` on reconnect).
3. ✅ C1/C2: `sceneTier` now shapes the Flux prompt; reference slots collapsed to the single one Flux uses.
4. ✅ C6: `renewal_date` set on creation/reset (UTC month boundary) + lazy backfill for legacy null rows.
5. ✅ H2: AUTO alone restarts the timer on turn change (GM only); minutes clamped 1–60.
6. ✅ H5 (part): `getSceneControlButtons` handles the v13 plain-record shape (`onChange` + `onClick` both provided). **Needs verification on a live v13 world.**
7. ✅ L5: AI images save to the `aiImageFolder` setting (Data-relative, default `vnd-enhanced/ai-generated`), with recursive directory creation — no longer wiped by module updates.

> Backend changes (flux.js, ai.js) require `wrangler deploy` to take effect.

### Phase 2 — UX improvements — ✅ IMPLEMENTED 2026-07-09 (except C3, deliberate)
1. ✅ H1: `#vne-hideback-btn` now GM-only; scene cards are a read-only gallery for players (no fake activation highlight); scenes panel gets `vne-sp-readonly` cursor.
2. ⏸️ C3: **deliberately deferred** — wiring `hasFeature` gates would remove features basic subscribers currently enjoy; that's a business/pricing decision for the author, not an autonomous code change. `hasFeature()` remains available for when the call is made.
3. ✅ M4: `VNE.toggle()` preserves `showForIds` unless a value is explicitly passed.
4. ✅ M10: License manager in module settings (tier, slot list with last-heartbeat, per-slot Release with confirm; releasing another device's slot refreshes the list).
5. ✅ H3: full localization — en.json rewritten (all ~230 keys actually used), es.json added, module.json registers Spanish, every user-facing literal in main.js / vnMain.hbs / settings.js / license-client.js goes through `game.i18n`. **Known gap: the AI Studio (ai-generator.js/.hbs) remains Spanish-only** — it's a self-consistent surface; localize in a follow-up.
6. ✅ M6: single `MAX_CAST = 10` + `_addPortraitToCastData()` helper replaces the 4 duplicated add-portrait blocks (API `addActor` no longer evicts at 5).

### Phase 3 — Performance — ✅ IMPLEMENTED 2026-07-09
1. ✅ M1: `getDataRO()` cached snapshot (invalidated in `updateSetting` + after `saveData`); all hot hooks (updateActor, targetToken, createChatMessage, carousel, sockets, Sequencer/AA, VS display) read it clone-free. `getData()` still returns a mutable deep copy for writers.
2. ✅ M2: `renderVNECombatCarousel` early-returns when the carousel row is hidden (`!combatMode`); VN-mode card set only builds when combat mode is on with an empty tracker.
3. ✅ M11: `prefers-reduced-motion` stops every infinite decorative loop (iteration-count 1) while letting entrance animations play once.
4. ✅ H6 (partial): ghost sweep on `canvasReady` is now unconditional (orphans are purged even if VN/combat mode is off); ghosts are created `locked` with nameplate/bars display NONE. Sheet-ghost debounce not changed.

### Phase 4 — Visual polish & accessibility — ✅ IMPLEMENTED 2026-07-09 (except dialog re-theme)
1. ✅ L1 (baseline): `role="button"` + `tabindex=0` + `aria-label` on all div controls (template chrome upgraded programmatically; popups/cards/nav in their builders); delegated Enter/Space activation on `#vne-main`; FAB keyboard-operable; `:focus-visible` outline. Focus traps not implemented.
2. ✅ M3: single portrait renderer — template side panels are empty shells; `_patchSidePanel` renders everything (owned-star badge, your-turn, quick controls all in one place). Side panels also refresh on every turn change so the active-combatant ring and "your turn" badge track the combat live.
3. ⏸️ Dialog re-theme: **deliberately skipped** — commit ac58a88 ("dialog text contrast") intentionally made these dialogs dark-text-on-light; re-theming risks regressing that fix. Revisit only with the author's direction.
4. ✅ L2 (inline `onerror` → `_bindImgFallback`, once-only, CSP-safe), ✅ L9 (status picker rebuilds right after the awaited toggle — no 500 ms race), ⏸️ L6 (z-index cap unchanged — current 99990 already sits below core notifications).

Additional fixes in this pass (not in the original roadmap):
- M5: outside-click listener leaks fixed with one AbortController per popup (actor picker, scenes panel, status picker).
- M7: generic crit-keyword fallback now requires `message.rolls.length` — narration text can no longer trigger the crit overlay.
- Dead code removed: `setSpeaker()` wrapper, `_buildReactionsHTML()`, the never-populated `#vne-center-speaker` node, the fully inert `.vne-center-area` drop zone, and ~260 lines of dead CSS (center-speaker/nameplate block, `vne-rp-speaking`, `vne-header-participants`, `vne-combat-indicator`, `vne-rp-add-slot`, orphan scrollbar selectors).
- Version bumped to 1.2.0.

### Phase 5 — Long-term architecture
1. H5: ApplicationV2/DialogV2 + no-jQuery migration (VNE shell first, dialogs second).
2. H4: dead-code excision (center-speaker system, dead CSS blocks, openai.js duplicates, `/shops` relocation).
3. H7: replace sidebar reparenting with z-index/inset layout.
4. M5/L7: shared popup lifecycle (AbortController) and shared crypto/DOM utility modules.
5. Split main.js (4,650 lines) into modules: `state.js` (getData/saveData/cache), `stage.js`, `combat.js` (carousel/VS/turn-cards/floaters), `ghosts.js`, `vfx.js`, `menus.js`, `api.js`. The section banners already in the file are the natural seams.
6. M8/M9: backend counter correctness + route cleanup.
