# Tema "Darkest Dungeon"

Desde **Configuración → VN Dialogues Enhanced → Tema visual** puedes cambiar entre:

- **Clásico** — el diseño actual del módulo, sin cambios.
- **Darkest Dungeon** — piel gótica de fantasía oscura inspirada en el juego: paneles de
  hierro con bisel, esquinas duras, acentos rojo sangre, texto pergamino grabado, viñeta
  pesada sobre el fondo, parpadeo de antorcha en el hablante activo y números de daño
  con contorno negro.

El tema es **solo CSS**: no cambia ninguna funcionalidad y se puede alternar en caliente
sin recargar. Todo vive en `styles/theme-dd.css` bajo el scope `body.vne-theme-dd`, así
que el diseño clásico queda intacto.

---

## Carpeta de assets opcional

El tema funciona completo sin assets externos. Si quieres afinarlo más, apunta el ajuste
**"Tema Darkest Dungeon — carpeta de assets"** a una carpeta dentro de tu Data de Foundry
con cualquiera de estos archivos (los que falten se ignoran en silencio):

| Archivo | Uso |
|---|---|
| `title-font.ttf` | Tipografía de títulos (nombres, VICTORIA/DERROTA, rondas) |
| `body-font.ttf` | Tipografía de cuerpo |
| `panel-texture.png` | Textura de grano para los paneles |

> Darkest Dungeon usa fuentes bitmap (`.fnt` + `.tga`) que un navegador no puede cargar.
> La fuente del juego es **Dwarven Axe BB** (comercial, de Blambot). Cualquier TTF gótica
> similar que poseas o descargues con licencia libre sirve: renómbrala a `title-font.ttf`.

## Reutilizar arte de TU copia del juego (uso personal)

Si posees el juego (`I:\SteamLibrary\steamapps\common\DarkestDungeon`), hay mucho arte
estático directamente utilizable con los ajustes que el módulo ya tiene:

- **Retratos de héroes** → `heroes/<héroe>/<héroe>_portrait_roster.png` (y variantes en
  `heroes/<héroe>/A/`). Cópialos a tu carpeta de retratos (`portraitFolderPath`) y
  asígnalos como retrato VN de cada personaje.
- **Fondos** → `loading_screen/` (ilustraciones grandes), `dungeons/<zona>/` y
  `campaign/town/` tienen fondos excelentes. Cópialos a tu carpeta de fondos
  (`bgFolderPath`) y úsalos como fondo de escena.
- **Monstruos** → en `monsters/<nombre>/` los `.png` son hojas de atlas de Spine
  (piezas sueltas del esqueleto); no sirven como imagen directamente, pero muchos
  monstruos tienen art de preview/roster utilizable como retrato estático.

### Lo que NO es viable (todavía)

- **Animaciones de combate**: DD anima con **Spine 2.1** (`.skel` binario + `.atlas`).
  Los runtimes web modernos (pixi-spine) no leen ese formato antiguo; haría falta
  convertir cada esqueleto con herramientas externas y un visor Spine integrado en el
  módulo. Es una posible fase futura, no parte de este tema.
- **Sonidos y música**: el audio del juego está en bancos **FMOD** (`.bank`), que el
  navegador no reproduce. Existen herramientas externas de extracción a `.ogg`/`.wav`;
  una vez extraídos puedes usarlos en Foundry como playlists o sonidos ambientales.

## Nota legal (importante)

Todos los assets de Darkest Dungeon son propiedad de **Red Hook Studios**. Extraerlos de
tu propia copia para tu mesa privada es una cosa; **redistribuirlos es infracción de
copyright**. Por eso:

- El módulo **nunca** incluye ni incluirá assets del juego.
- No subas assets extraídos a repositorios, releases del módulo ni a Patreon.
- La carpeta de assets es siempre local de cada mundo/usuario.
