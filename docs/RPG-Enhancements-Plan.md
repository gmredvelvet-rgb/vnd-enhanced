# Plan de mejoras — Experiencia más RPG

Fecha: 2026-08-13
Repositorio: vnd-enhanced

## Resumen
Este documento reúne las mejoras propuestas para reforzar el "feeling" RPG del módulo VND Enhanced: visuales, audio, UX, integración con sistemas y herramientas narrativas. Está priorizado por impacto y dificultad.

---

## Prioridad alta

- Claridad visual
  - Indicadores nítidos de turno/activo: borde luminoso animado, ligero "pop" (scale) al activarse.
  - Mostrar opción para que jugadores vean/oculten números de PV (respecto a privacidad del GM).

- Feedback de estado y reacciones automáticas
  - Triggers automáticos: ≤50% -> `hurt`, ≤25% -> `critical` (activar reacciones/expresiones).
  - Plantillas de reacciones reutilizables (guardar/aplicar).

- Sonido y ambientación
  - Reproducir SFX por evento: inicio de turno, golpe, muerte, victoria.
  - Loop ambiental por escena; carpeta configurable para assets.

## Prioridad media

- Cinemáticas y transiciones
  - Zoom/pulse en VS duel, crossfade de fondo y cambio de soundtrack por escena.

- Accesibilidad / UX
  - Mejorar ARIA y focus styles; atajos configurables; navegación por teclado completa.

- Polish de UI
  - Tooltips enriquecidos con atajos y lecturas rápidas (AC, immunities), mini-previews de habilidades en hover.

- Rendimiento
  - Lazy-load de imágenes/videos, uso de `srcset`/`picture`, caching y evitar re-renders innecesarios.

## Prioridad baja

- Integraciones con sistemas de reglas
  - Adaptadores por sistema (D&D5e, PF2e…) para lectura estándar de HP/AC/effects.

- Herramientas narrativas
  - Timeline de escenas, condiciones de branching, export/import de encuentros narrativos.

---

## Cambios concretos y parcheables (rápidos)

1) Subir `z-index` de side-panels para que las cartas no se atenúen durante VS (ya aplicado):
   - Archivo: [styles/module.css](styles/module.css)
   - Cambio: `z-index: 12` → `z-index: 30` en `#vne-main.vne-combat-mode .vne-left-panel, .vne-right-panel, .vne-side-panel`.

2) Control de opacidad del overlay VS (setting):
   - Añadir `game.settings` boolean/float `combatOverlayAlpha` y alternar entre clases CSS (`vne-vs-overlay-strong` / `vne-vs-overlay-soft`).

3) Mostrar PV a jugadores (opcional):
   - Añadir setting `showHpToPlayers` y condicionar render de `vne-cp-hp-text` en `scripts/main.js`.

4) SFX básicos (primer parche):
   - Añadir settings `sfxFolder`, `sfxTurnStart`, `sfxHit`, `sfxDeath`, `sfxVictory`.
   - Reproducir con `AudioHelper.play()` en los hooks: turno iniciado, daño, combat end.

5) Reacciones automáticas:
   - Reutilizar la UI de `reactions` ya presente; añadir un pequeño engine que observe HP y active la reacción correspondiente.

## Hooks / Events recomendados (para extensibilidad)

- `Hooks.call("vne.turnStart", { combatant, side, round })`
- `Hooks.call("vne.turnEnd", { combatant, side, round })`
- `Hooks.call("vne.actorDamaged", { actor, delta, hp })`
- `Hooks.call("vne.actorDefeated", { actor })`

Estos facilitan que otros módulos o macros reaccionen a eventos sin hackear internals.

## Siguientes pasos sugeridos (orden corto plazo)

1. Implementar SFX y ambient (alto impacto, bajo esfuerzo).  
2. Exponer setting `showHpToPlayers` y permitir mostrar números de HP.  
3. Añadir triggers de reacciones automáticas basadas en HP.  
4. Ajustes visuales menores (mejor contraste/outline/animación).  
5. Opcional: exponer `combatOverlayAlpha` para personalizar cuánto oscurece el VS.

---

## Notas técnicas y archivos relevantes
- Plantilla principal UI: [templates/vnMain.hbs](templates/vnMain.hbs)
- Lógica UI/combat: [scripts/main.js](scripts/main.js)
- Formación/placement: [scripts/combat-formation.js](scripts/combat-formation.js)
- Estilos: [styles/module.css](styles/module.css)
- Localización: [language/en.json](language/en.json), [language/es.json](language/es.json)

---

## Pregunta
Si quieres, aplico el primer parche ahora: 1) añadir SFX básico y settings, o 2) exponer `showHpToPlayers` y renderizar los números de HP. ¿Cuál prefieres que implemente primero?
