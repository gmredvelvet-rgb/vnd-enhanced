/**
 * VND Enhanced — AI Studio
 *   Scene Studio:     idea → AI expansion → editable brief → image generation
 *   Character Studio: reference image → pose/expression → variations
 */

const MODULE_ID      = 'vnd-enhanced';
const API_BASE       = 'https://vnd-license.gmredvelvet.workers.dev';
const MAX_FILE_BYTES = 4 * 1024 * 1024;

// RSA public key — safe to embed; only the server's private key can produce valid signatures.
const RSA_PUBLIC_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3-hTzuHo9lgENNQiA4-Fm7VIdalqisZ5NhqrBioXmIXSMbEhYpy1TnPkCBAdAzXAsyX1YdTYLcMADETPnERvceLsDoAWHFZzHGxoXBkOGw0ukAyHJyrwBZxCf_bY_FSbip_-XQuTS4YuyhLPVNjbGMZdVarkegh7BKwW4CR9MDb1DMtf_NxtfNqJ3MxhfAiTxIod4AWer8esisr0IekQlPLmMPA2KggzQw9rFj61B4DAVk2F_TAXPMOKyEcX_zVGpp00JTurTsfwK2023UHKO9t98R0rG17oX0rK_x2EOBiW2Nla3NChZyR4yi8zHe0vjYhprqcwozv9wN0wbANnzwIDAQAB';
let _rsaKey = null;

const SLOT_ROLES = ['Composición', 'Estilo', 'Arquitectura', 'Paleta'];

// ── Character preset library ──────────────────────────────────────────────────

const PRESETS = {
  poses: {
    label: 'Poses',
    icon:  'fa-person',
    items: [
      { id: 'idle',     label: 'Idle',       action: 'Standing naturally. Neutral posture. Relaxed expression. Looking forward.' },
      { id: 'heroic',   label: 'Heroico',    action: 'Standing proudly. Chest forward. Confident expression. Heroic stance.' },
      { id: 'running',  label: 'Corriendo',  action: 'Running forward. Dynamic motion. Determined expression.' },
      { id: 'walking',  label: 'Caminando',  action: 'Walking calmly. Natural movement. Relaxed expression.' },
      { id: 'sitting',  label: 'Sentado',    action: 'Seated naturally. Relaxed posture. Comfortable expression.' },
      { id: 'pointing', label: 'Señalando',  action: 'Pointing forward. Arm fully extended. Serious expression.' },
      { id: 'kneeling', label: 'Arrodillado',action: 'Kneeling on one knee. Respectful posture. Focused expression.' },
      { id: 'victory',  label: 'Victoria',   action: 'Celebratory posture. Raised weapon or fist. Confident wide smile.' }
    ]
  },
  expressions: {
    label: 'Expresiones',
    icon:  'fa-face-smile',
    items: [
      { id: 'happy',       label: 'Feliz',       action: 'Idle pose. Genuine smile. Relaxed face. Friendly expression.' },
      { id: 'angry',       label: 'Enojado',     action: 'Idle pose. Frowning heavily. Intense piercing gaze. Aggressive expression.' },
      { id: 'sad',         label: 'Triste',      action: 'Idle pose. Lowered gaze. Melancholic expression. Subtle visible sadness.' },
      { id: 'shocked',     label: 'Impactado',   action: 'Idle pose. Wide open eyes. Surprised open mouth. Shocked reaction.' },
      { id: 'confident',   label: 'Confiado',    action: 'Heroic stance. Slight smirk. Direct eye contact. Self-assured posture.' },
      { id: 'embarrassed', label: 'Avergonzado', action: 'Idle pose. Subtle blush on cheeks. Avoiding eye contact. Nervous small smile.' },
      { id: 'fearful',     label: 'Asustado',    action: 'Defensive idle pose. Tense posture. Concerned wide eyes. Visible anxiety.' },
      { id: 'crying',      label: 'Llorando',    action: 'Idle pose. Tears visibly streaming. Sad trembling expression. Emotional posture.' }
    ]
  },
  combat: {
    label: 'Combate',
    icon:  'fa-swords',
    items: [
      { id: 'stance',  label: 'Guardia',       action: 'Combat ready stance. Balanced posture. Focused expression. Weapons raised and prepared.' },
      { id: 'slash',   label: 'Espadazo',      action: 'Performing a powerful sword slash. Body twisted into the attack. Front leg planted, rear leg pushing forward. Aggressive expression.' },
      { id: 'block',   label: 'Bloqueo',       action: 'Shield raised defensively. Stable wide footing. Focused protective expression.' },
      { id: 'casting', label: 'Conjuro',       action: 'Casting a magical spell. One hand extended forward with magical energy gathering. Concentrated expression.' },
      { id: 'bow',     label: 'Arco',          action: 'Drawing a bow fully. Aiming carefully with focused eye. Dynamic archer stance.' },
      { id: 'spear',   label: 'Lanzada',       action: 'Performing a forward spear thrust. Balanced posture. Aggressive expression.' },
      { id: 'jump',    label: 'Ataque aéreo',  action: 'Mid-air jump attack. Weapon raised above head. Dynamic aerial movement. Battle-focused expression.' },
      { id: 'charge',  label: 'Carga',         action: 'Charging aggressively forward at full speed. Combat posture. Determined intense expression.' }
    ]
  },
  vn: {
    label: 'Visual Novel',
    icon:  'fa-comment',
    items: [
      { id: 'talking',      label: 'Hablando',     action: 'Speaking naturally. Mouth slightly open mid-sentence. Friendly engaged expression.' },
      { id: 'thinking',     label: 'Pensando',     action: 'One hand near chin in thinking gesture. Thoughtful expression. Eyes looking slightly upward and away.' },
      { id: 'laughing',     label: 'Riendo',       action: 'Laughing openly. Bright wide smile. Relaxed joyful posture. Eyes slightly closed.' },
      { id: 'surprised_vn', label: 'Sorprendido',  action: 'Wide open eyes. Open mouth. Arms slightly raised. Unexpected surprised reaction.' },
      { id: 'serious',      label: 'Serio',        action: 'Idle pose. Focused direct stare. Neutral firm mouth. Professional composed posture.' },
      { id: 'annoyed',      label: 'Irritado',     action: 'Arms crossed. Slight visible frown. Irritated expression. Looking away with mild annoyance.' },
      { id: 'looking_away', label: 'Mirando lejos',action: 'Head turned slightly sideways. Avoiding direct eye contact. Reserved distant expression.' },
      { id: 'blushing',     label: 'Sonrojado',    action: 'Idle pose. Visible blush on cheeks. Embarrassed shy expression. Slightly hunched shy posture.' }
    ]
  },
  injury: {
    label: 'Daño',
    icon:  'fa-heart-crack',
    items: [
      {
        id:     'hurt',
        label:  'Golpeado',
        action: `Generate the same character immediately after receiving a minor hit.

The character flinches briefly from the impact.

Facial expression shows brief surprise and mild pain.

Eyes momentarily narrowed. A slight wince on the face.

Body barely recoils, maintaining full combat balance.

Clothing may show minor scuffs or dust from the glancing blow.

The character is fully combat-ready and shakes off the hit immediately.

No significant injuries — this is a minor impact, not a serious wound.`
      },
      {
        id:     'wounded',
        label:  'Herido',
        action: `Generate the same character immediately after being struck by a powerful attack.

The character is visibly wounded and reacting to pain.

Facial expression shows shock, pain, strain, and determination.

Eyes narrowed or partially closed from the impact.

Jaw clenched, teeth gritted, brows furrowed.

Body recoiling slightly from the hit.

One hand may instinctively move toward the injured area.

Clothing may show realistic damage, tears, dirt, dust, blood stains, scratches, or battle wear consistent with the attack.

Visible bruises, cuts, abrasions, and injuries are allowed.

The character remains standing and fighting despite the pain.

The scene should clearly communicate that the character has just been injured but is not defeated.`
      },
      {
        id:     'crit',
        label:  'Crítico',
        action: `Generate the same character after suffering a devastating critical hit.

The character has taken severe, life-threatening damage and is barely standing.

Facial expression shows extreme pain, agony, and desperate raw determination.

Eyes barely open, struggling to focus through the pain.

Jaw clenched through extreme agony, teeth gritted hard.

Body heavily staggered, barely maintaining balance, one knee may be slightly bent.

Both hands clutching the most severe wound.

Severe battle damage: clothing badly torn, deep gashes, heavy blood, major bruising across the body.

Equipment visibly cracked, bent, or partially broken from the impact.

The character is at their absolute limit and refusing to collapse — severely wounded, struggling, but unbroken and still dangerous.`
      }
    ]
  }
};

// ── API helpers ───────────────────────────────────────────────────────────────

function _getToken() {
  return localStorage.getItem(`${MODULE_ID}:at`);
}

async function _importRsaKey() {
  if (_rsaKey) return _rsaKey;
  const bytes = Uint8Array.from(
    atob(RSA_PUBLIC_KEY.replaceAll('-', '+').replaceAll('_', '/')),
    c => c.codePointAt(0)
  );
  _rsaKey = await crypto.subtle.importKey(
    'spki', bytes,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['verify']
  );
  return _rsaKey;
}

async function _verifyResponseSig(payload, jwt) {
  const parts = jwt.split('.');
  if (parts.length !== 3) return false;
  const [hdr, body, sig] = parts;
  try {
    const key      = await _importRsaKey();
    const data     = new TextEncoder().encode(`${hdr}.${body}`);
    const sigBytes = Uint8Array.from(atob(sig.replaceAll('-', '+').replaceAll('_', '/')), c => c.codePointAt(0));
    const valid    = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sigBytes, data);
    if (!valid) return false;

    const claims = JSON.parse(atob(body.replaceAll('-', '+').replaceAll('_', '/')));
    if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) return false;

    // Verify the JWT covers the exact payload received
    const hashBuf    = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload)));
    const payloadPh  = btoa(String.fromCodePoint(...new Uint8Array(hashBuf)))
      .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    return claims.ph === payloadPh;
  } catch { return false; }
}

async function _apiGetSigned(path) {
  const token = _getToken();
  if (!token) throw new Error('No autenticado. Conecta tu cuenta Patreon primero.');

  const resp = await fetch(`${API_BASE}${path}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  if (resp.status === 401) throw new Error('Sesión expirada. Reconecta tu cuenta Patreon.');
  if (!resp.ok) {
    const d = await resp.json().catch(() => ({}));
    throw new Error(d.error ?? `Error HTTP ${resp.status}`);
  }

  const data  = await resp.json();
  const valid = data.sig && data.payload && await _verifyResponseSig(data.payload, data.sig);
  if (!valid) throw new Error('Respuesta del servidor inválida (firma RSA incorrecta).');
  return data.payload;
}

async function _apiPost(path, body) {
  const token = _getToken();
  if (!token) throw new Error('No autenticado. Conecta tu cuenta Patreon primero.');

  const resp = await fetch(`${API_BASE}${path}`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body)
  });

  if (resp.status === 401) throw new Error('Sesión expirada. Reconecta tu cuenta Patreon.');
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error ?? `Error HTTP ${resp.status}`);
  return data;
}

async function _saveToFoundry(b64, index, subfolder = 'character-studio') {
  const folder   = `modules/${MODULE_ID}/generated/${subfolder}`;
  const stamp    = Date.now();
  const filename = `${subfolder === 'scene-studio' ? 'scene' : 'char'}-${stamp}-${index}.png`;
  try {
    const blob   = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const file   = new File([blob], filename, { type: 'image/png' });
    const result = await FilePicker.upload('data', folder, file, {}, { notify: false });
    return result?.path ?? null;
  } catch (err) {
    console.warn('VND AI: Could not save image to Foundry:', err);
    return null;
  }
}

// ── Tag cloud helpers ─────────────────────────────────────────────────────────

function _buildTag(text, onRemove) {
  const tag = document.createElement('span');
  tag.className = 'vnd-ai-tag';
  tag.innerHTML = `<span class="vnd-ai-tag-text">${text}</span><button type="button" class="vnd-ai-tag-rm" title="Eliminar"><i class="fas fa-xmark"></i></button>`;
  tag.querySelector('.vnd-ai-tag-rm').addEventListener('click', () => {
    tag.remove();
    onRemove?.();
  });
  return tag;
}

function _renderTagCloud(container, tags, onChange) {
  container.innerHTML = '';
  for (const text of tags) {
    container.appendChild(_buildTag(text, onChange));
  }
}

function _getTagCloudValues(container) {
  return [...container.querySelectorAll('.vnd-ai-tag-text')].map(el => el.textContent.trim()).filter(Boolean);
}

// ── VND AI Studio ─────────────────────────────────────────────────────────────

export class VNDAIGenerator extends Application {
  static instance = null;

  // Character state
  #referenceB64   = null;
  #selectedAction = null;
  #customAction   = '';
  #activeCategory = 'poses';
  #generating     = false;

  // Scene state
  #sceneExpansion  = null;
  #sceneRefs       = [null, null, null, null];
  #sceneGenerating = false;

  // Generation limit (null = not yet loaded)
  #generationsRemaining = null;

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id:        'vnd-ai-generator',
      title:     'VND Enhanced — AI Studio',
      template:  `modules/${MODULE_ID}/templates/ai-generator.hbs`,
      width:     900,
      height:    700,
      resizable: true,
      classes:   ['vnd-ai-window']
    });
  }

  static open() {
    if (!game.user.isGM) {
      ui.notifications?.warn('AI Studio es exclusivo para el GM.');
      return null;
    }
    if (!VNDAIGenerator.instance?.rendered) {
      VNDAIGenerator.instance = new VNDAIGenerator();
    }
    VNDAIGenerator.instance.render(true);
    return VNDAIGenerator.instance;
  }

  getData() { return { isGM: game.user.isGM }; }

  activateListeners(html) {
    super.activateListeners(html);
    const root = html[0];

    if (!game.user.isGM) {
      root.innerHTML = '<p style="padding:1rem;color:var(--color-level-error)">Acceso restringido al GM.</p>';
      return;
    }

    // Tabs
    root.querySelectorAll('.vnd-ai-tab').forEach(tab => {
      tab.addEventListener('click', () => this._switchTab(root, tab.dataset.tab));
    });

    this._initSceneListeners(root);
    this._initCharacterListeners(root);
    this._renderPresetGrid(root);
    this._updateGenerateBar(root);
    this._updateSceneGenBtn(root);
    this._loadTokens(root);
  }

  _switchTab(root, name) {
    root.querySelectorAll('.vnd-ai-tab').forEach(t   => t.classList.remove('active'));
    root.querySelectorAll('.vnd-ai-panel').forEach(p => p.classList.remove('active'));
    root.querySelector(`.vnd-ai-tab[data-tab="${name}"]`)?.classList.add('active');
    root.querySelector(`#vnd-ai-panel-${name}`)?.classList.add('active');
    if (name === 'history') this._loadHistory(root);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SCENE STUDIO
  // ══════════════════════════════════════════════════════════════════════════

  _initSceneListeners(root) {
    root.querySelector('#vnd-ai-expand-btn')?.addEventListener('click', () => this._expandScene(root));

    root.querySelectorAll('.vnd-ai-scene-type-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        root.querySelectorAll('.vnd-ai-scene-type-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._updateSceneGenBtn(root);
      });
    });

    root.querySelectorAll('.vnd-ai-scene-tier-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        root.querySelectorAll('.vnd-ai-scene-tier-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._updateSceneGenBtn(root);
      });
    });

    root.querySelectorAll('.vnd-ai-style-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        root.querySelectorAll('.vnd-ai-style-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
      });
    });

    root.querySelectorAll('.vnd-ai-mini-slot').forEach(slot => {
      this._initSlotListeners(root, Number.parseInt(slot.dataset.slot, 10));
    });

    root.querySelectorAll('.vnd-ai-scene-quality-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        root.querySelectorAll('.vnd-ai-scene-quality-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._updateSceneGenBtn(root);
      });
    });


    root.querySelector('#vnd-ai-rebuild-prompt')?.addEventListener('click', () => {
      const prompt = this._buildScenePrompt(root);
      const ta = root.querySelector('#vnd-ai-scene-prompt');
      if (ta) ta.value = prompt;
    });

    root.querySelectorAll('.vnd-ai-tag-add-trigger').forEach(btn => {
      btn.addEventListener('click', () => this._addTagPrompt(root, btn.dataset.target));
    });

    root.querySelector('#vnd-ai-scene-gen-btn')?.addEventListener('click', () => this._generateScene(root));
  }

  _initSlotListeners(root, idx) {
    const slot      = root.querySelector(`.vnd-ai-mini-slot[data-slot="${idx}"]`);
    const fileInput = slot?.querySelector('.vnd-ai-slot-input');
    const emptyDiv  = slot?.querySelector('.vnd-ai-slot-empty');

    emptyDiv?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', () => {
      if (fileInput.files[0]) this._handleSlotFile(root, idx, fileInput.files[0]);
    });
    slot?.querySelector('.vnd-ai-slot-remove')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._clearSlot(root, idx);
    });
  }

  // ── Slot image management ─────────────────────────────────────────────────

  _handleSlotFile(root, idx, file) {
    const ALLOWED = ['image/png', 'image/jpeg', 'image/webp'];
    if (!ALLOWED.includes(file.type)) {
      ui.notifications?.warn('VND AI: Solo se aceptan PNG, JPG o WEBP.');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      ui.notifications?.warn('VND AI: La imagen debe pesar menos de 4 MB.');
      return;
    }
    this._resizeImageFile(file).then(({ dataUrl, b64 }) => {
      this.#sceneRefs[idx] = { b64, role: SLOT_ROLES[idx] };
      this._updateSlotUI(root, idx, dataUrl);
      this._updateSceneGenBtn(root);
    }).catch(err => {
      ui.notifications?.warn(`VND AI: No se pudo procesar la imagen — ${err.message}`);
    });
  }

  _updateSlotUI(root, idx, dataUrl) {
    const slot   = root.querySelector(`.vnd-ai-mini-slot[data-slot="${idx}"]`);
    const empty  = slot?.querySelector('.vnd-ai-slot-empty');
    const filled = slot?.querySelector('.vnd-ai-slot-filled');
    const img    = slot?.querySelector('.vnd-ai-slot-img');
    if (img)    img.src              = dataUrl;
    if (empty)  empty.style.display  = 'none';
    if (filled) filled.style.display = '';
  }

  _clearSlot(root, idx) {
    this.#sceneRefs[idx] = null;
    const slot   = root.querySelector(`.vnd-ai-mini-slot[data-slot="${idx}"]`);
    const empty  = slot?.querySelector('.vnd-ai-slot-empty');
    const filled = slot?.querySelector('.vnd-ai-slot-filled');
    const img    = slot?.querySelector('.vnd-ai-slot-img');
    const fi     = slot?.querySelector('.vnd-ai-slot-input');
    if (img)    img.src              = '';
    if (empty)  empty.style.display  = '';
    if (filled) filled.style.display = 'none';
    if (fi)     fi.value             = '';
    this._updateSceneGenBtn(root);
  }

  // ── Tag management ────────────────────────────────────────────────────────

  _addTagPrompt(root, targetId) {
    const text = globalThis.prompt('Añadir etiqueta:')?.trim();
    if (!text) return;
    const container = root.querySelector(`#${targetId}`);
    if (container) {
      container.appendChild(_buildTag(text));
      this._autoRebuildPrompt(root);
    }
  }

  _autoRebuildPrompt(root) {
    const prompt = this._buildScenePrompt(root);
    const ta = root.querySelector('#vnd-ai-scene-prompt');
    if (ta) ta.value = prompt;
  }

  // ── Scene expansion ───────────────────────────────────────────────────────

  async _expandScene(root) {
    const idea = root.querySelector('#vnd-ai-scene-idea')?.value?.trim();
    if (!idea) {
      ui.notifications?.warn('VND AI: Escribe una idea de escena primero.');
      return;
    }

    const btn = root.querySelector('#vnd-ai-expand-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Expandiendo…'; }

    try {
      const data = await _apiPost('/ai/expand', { idea });
      this.#sceneExpansion = data.expansion;
      this._renderSceneEditor(root, data.expansion);
      this._updateSceneGenBtn(root);
    } catch (err) {
      ui.notifications?.error(`VND AI: ${err.message}`);
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-wand-sparkles"></i> <span>Expandir con IA</span> <span class="vnd-ai-free-badge">GRATIS</span>'; }
    }
  }

  _renderSceneEditor(root, expansion) {
    const empty  = root.querySelector('#vnd-ai-scene-empty');
    const editor = root.querySelector('#vnd-ai-scene-editor');
    if (empty)  empty.style.display  = 'none';
    if (editor) editor.style.display = '';

    const titleEl = root.querySelector('#vnd-ai-scene-title');
    if (titleEl) titleEl.textContent = expansion.title ?? '';

    const descEl = root.querySelector('#vnd-ai-scene-desc');
    if (descEl) descEl.value = expansion.description ?? '';

    const elemContainer = root.querySelector('#vnd-ai-scene-elements');
    const atmoContainer = root.querySelector('#vnd-ai-scene-atmosphere');
    const palContainer  = root.querySelector('#vnd-ai-scene-palette');

    const onChange = () => this._autoRebuildPrompt(root);
    if (elemContainer) _renderTagCloud(elemContainer, expansion.elements   ?? [], onChange);
    if (atmoContainer) _renderTagCloud(atmoContainer, expansion.atmosphere ?? [], onChange);
    if (palContainer)  _renderTagCloud(palContainer,  expansion.palette    ?? [], onChange);

    const prompt = this._buildScenePrompt(root);
    const ta = root.querySelector('#vnd-ai-scene-prompt');
    if (ta) ta.value = prompt;
  }

  _buildScenePrompt(root) {
    const title = root.querySelector('#vnd-ai-scene-title')?.textContent?.trim() ?? '';
    const desc  = root.querySelector('#vnd-ai-scene-desc')?.value?.trim()       ?? '';
    const elems = _getTagCloudValues(root.querySelector('#vnd-ai-scene-elements')   ?? document.createElement('div'));
    const atmo  = _getTagCloudValues(root.querySelector('#vnd-ai-scene-atmosphere') ?? document.createElement('div'));
    const pal   = _getTagCloudValues(root.querySelector('#vnd-ai-scene-palette')    ?? document.createElement('div'));

    const parts = [];
    if (title) parts.push(title);
    if (desc)  parts.push(desc);
    if (elems.length > 0)  parts.push(`Visual elements: ${elems.join(', ')}.`);
    if (atmo.length > 0)   parts.push(`Atmosphere: ${atmo.join(', ')}.`);
    if (pal.length > 0)    parts.push(`Color palette: ${pal.join(', ')}.`);
    return parts.join(' ');
  }

  // ── Scene cost ────────────────────────────────────────────────────────────

  _getSceneTier(root) {
    return root.querySelector('.vnd-ai-scene-tier-btn.active')?.dataset.tier ?? 'standard';
  }

  _getSceneQuality(root) {
    return root.querySelector('.vnd-ai-scene-quality-btn.active')?.dataset.quality ?? 'standard';
  }

_updateSceneGenBtn(root) {
    const hasPrompt    = !!(root.querySelector('#vnd-ai-scene-prompt')?.value?.trim() || this.#sceneExpansion);
    const limitReached = this.#generationsRemaining !== null && this.#generationsRemaining <= 0;
    const btn          = root.querySelector('#vnd-ai-scene-gen-btn');
    const hint         = root.querySelector('#vnd-ai-scene-gen-hint');
    const limitMsg     = root.querySelector('#vnd-ai-scene-limit-msg');
    if (btn)      btn.disabled           = !hasPrompt || this.#sceneGenerating || limitReached;
    if (hint)     hint.style.display     = hasPrompt ? 'none' : '';
    if (limitMsg) limitMsg.style.display = limitReached ? '' : 'none';
  }

  // ── Scene generation ──────────────────────────────────────────────────────

  async _generateScene(root) {
    if (this.#sceneGenerating) return;

    const finalPrompt = root.querySelector('#vnd-ai-scene-prompt')?.value?.trim();
    if (!finalPrompt) {
      ui.notifications?.warn('VND AI: Expande una idea primero para obtener el prompt.');
      return;
    }

    const sceneType  = root.querySelector('.vnd-ai-scene-type-btn.active')?.dataset.type ?? 'narrative';
    const style      = root.querySelector('.vnd-ai-style-chip.active')?.dataset.style    ?? 'fantasy-painting';
    const sceneTier  = this._getSceneTier(root);
    const quality    = this._getSceneQuality(root);
    const n          = 1;
    const references = this.#sceneRefs.filter(Boolean).map(r => ({ b64: r.b64, role: r.role }));

    this.#sceneGenerating = true;
    const btn     = root.querySelector('#vnd-ai-scene-gen-btn');
    const results = root.querySelector('#vnd-ai-scene-results');

    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generando…'; }
    if (results) {
      const nLabel = n > 1 ? `${n} imágenes` : 'imagen';
      results.innerHTML = `
        <div class="vnd-ai-progress">
          <i class="fas fa-spinner fa-spin fa-2x"></i>
          <p>Generando ${nLabel}…</p>
          <p class="vnd-ai-progress-sub">Esto puede tomar 30-60 segundos</p>
        </div>`;
    }

    try {
      const data = await _apiPost('/ai/generate', {
        mode: 'scene', finalPrompt, sceneType, style, sceneTier, quality, n, references
      });

      this._refreshGenBar(root, data);
      await this._renderSceneResults(root, results, data);
      ui.notifications?.info(`VND AI: ${data.images.length} escena(s) generada(s). Generaciones restantes: ${data.generationsRemaining}`);
    } catch (err) {
      if (results) results.innerHTML = `<div class="vnd-ai-error"><i class="fas fa-exclamation-triangle"></i> ${err.message}</div>`;
      ui.notifications?.error(`VND AI: ${err.message}`);
    } finally {
      this.#sceneGenerating = false;
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-wand-sparkles"></i> <span>Generar escena</span>'; }
      this._updateSceneGenBtn(root);
    }
  }

  async _renderSceneResults(root, container, data) {
    if (!container || !data.images?.length) return;
    container.innerHTML = '';

    for (let i = 0; i < data.images.length; i++) {
      const b64   = data.images[i].b64_json;
      const saved = await _saveToFoundry(b64, i, 'scene-studio');
      container.appendChild(this._buildResultCard(b64, 'Escena', i, data.images.length, saved));
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CHARACTER STUDIO
  // ══════════════════════════════════════════════════════════════════════════

  _initCharacterListeners(root) {
    const dropzone  = root.querySelector('#vnd-ai-dropzone');
    const fileInput = root.querySelector('#vnd-ai-file-input');

    dropzone?.addEventListener('click', (e) => {
      if (e.target.closest('#vnd-ai-remove-ref'))   return;
      if (e.target.closest('#vnd-ai-foundry-btn'))  return;
      fileInput?.click();
    });
    dropzone?.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag-over'); });
    dropzone?.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
    dropzone?.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag-over');
      if (e.dataTransfer.files[0]) this._handleFile(root, e.dataTransfer.files[0]);
    });

    fileInput?.addEventListener('change', () => {
      if (fileInput.files[0]) this._handleFile(root, fileInput.files[0]);
    });
    root.querySelector('#vnd-ai-upload-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      fileInput?.click();
    });
    root.querySelector('#vnd-ai-remove-ref')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._clearReference(root);
    });
    root.querySelector('#vnd-ai-foundry-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      new FilePicker({ type: 'image', callback: (path) => this._handleFoundryPath(root, path) }).browse();
    });

    root.querySelectorAll('.vnd-ai-cat-btn').forEach(btn => {
      btn.addEventListener('click', () => this._switchCharCategory(root, btn));
    });

    root.querySelector('#vnd-ai-custom-textarea')?.addEventListener('input', (e) => {
      this.#customAction = e.target.value;
      this.#selectedAction = this.#customAction.trim()
        ? { id: 'custom', label: 'Personalizado', action: this.#customAction }
        : null;
      if (this.#selectedAction) {
        this._showSelectedAction(root, this.#selectedAction);
      } else {
        this._clearSelectedAction(root);
      }
      this._updateGenerateBar(root);
    });

    root.querySelectorAll('.vnd-ai-quality-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        root.querySelectorAll('.vnd-ai-quality-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._updateGenerateBar(root);
      });
    });


    root.querySelector('#vnd-ai-generate-btn')?.addEventListener('click', () => this._generate(root));
  }

  _switchCharCategory(root, btn) {
    this.#activeCategory = btn.dataset.cat;
    root.querySelectorAll('.vnd-ai-cat-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const isCustom = btn.dataset.cat === 'custom';
    root.querySelector('#vnd-ai-preset-grid')?.classList.toggle('hidden', isCustom);
    root.querySelector('#vnd-ai-custom-action')?.classList.toggle('hidden', !isCustom);
    if (!isCustom) this._renderPresetGrid(root);
  }

  // ── Reference image ───────────────────────────────────────────────────────

  // Resize preserving aspect ratio.
  // Landscape (w > h): max 2400×1600 — costs double credits (large reference).
  // Portrait  (h ≥ w): max 800×1200  — normal cost.
  _resizeImageFile(file) {
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(objectUrl);
        const isLandscape = img.naturalWidth > img.naturalHeight;
        const [maxW, maxH] = isLandscape ? [2400, 1600] : [800, 1200];

        let w = img.naturalWidth;
        let h = img.naturalHeight;
        if (w > maxW || h > maxH) {
          const scale = Math.min(maxW / w, maxH / h);
          w = Math.round(w * scale);
          h = Math.round(h * scale);
        }

        const canvas = document.createElement('canvas');
        canvas.width  = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/png');
        resolve({ dataUrl, b64: dataUrl.split(',')[1] });
      };
      img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('No se pudo cargar la imagen')); };
      img.src = objectUrl;
    });
  }

  _handleFile(root, file) {
    const ALLOWED = ['image/png', 'image/jpeg', 'image/webp'];
    if (!ALLOWED.includes(file.type)) {
      ui.notifications?.warn('VND AI: Solo se aceptan PNG, JPG o WEBP.');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      ui.notifications?.warn('VND AI: La imagen debe pesar menos de 4 MB.');
      return;
    }
    this._resizeImageFile(file).then(({ dataUrl, b64 }) => {
      this.#referenceB64 = b64;

      const preview = root.querySelector('#vnd-ai-ref-preview');
      const img     = root.querySelector('#vnd-ai-ref-img');
      const holder  = root.querySelector('#vnd-ai-drop-placeholder');

      if (img)     img.src               = dataUrl;
      if (preview) preview.style.display = '';
      if (holder)  holder.style.display  = 'none';

      this._updateGenerateBar(root);
    }).catch(err => {
      ui.notifications?.warn(`VND AI: No se pudo procesar la imagen — ${err.message}`);
    });
  }

  _clearReference(root) {
    this.#referenceB64 = null;
    const preview = root.querySelector('#vnd-ai-ref-preview');
    const holder  = root.querySelector('#vnd-ai-drop-placeholder');
    const fi      = root.querySelector('#vnd-ai-file-input');
    if (preview) preview.style.display = 'none';
    if (holder)  holder.style.display  = '';
    if (fi)      fi.value              = '';
    this._updateGenerateBar(root);
  }

  async _handleFoundryPath(root, path) {
    try {
      const resp = await fetch(path);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      if (!blob.type.startsWith('image/')) throw new Error('El archivo no es una imagen.');
      if (blob.size > MAX_FILE_BYTES) throw new Error('La imagen supera 4 MB.');
      const file = new File([blob], path.split('/').pop(), { type: blob.type });
      this._handleFile(root, file);
    } catch (err) {
      ui.notifications?.warn(`VND AI: No se pudo cargar la imagen — ${err.message}`);
    }
  }

  // ── Preset grid ───────────────────────────────────────────────────────────

  _renderPresetGrid(root) {
    const grid = root.querySelector('#vnd-ai-preset-grid');
    if (!grid || this.#activeCategory === 'custom') return;

    grid.classList.remove('hidden');
    root.querySelector('#vnd-ai-custom-action')?.classList.add('hidden');
    grid.innerHTML = '';

    const cat = PRESETS[this.#activeCategory];
    if (!cat) return;

    for (const item of cat.items) {
      const btn = document.createElement('button');
      btn.type      = 'button';
      btn.className = 'vnd-ai-preset-chip';
      btn.dataset.id  = item.id;
      btn.textContent = item.label;
      btn.title       = item.action;
      if (this.#selectedAction?.id === item.id) btn.classList.add('selected');
      btn.addEventListener('click', () => {
        grid.querySelectorAll('.vnd-ai-preset-chip').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        this.#selectedAction = item;
        this._showSelectedAction(root, item);
        this._updateGenerateBar(root);
      });
      grid.appendChild(btn);
    }
  }

  // ── Selected action display ───────────────────────────────────────────────

  _showSelectedAction(root, item) {
    const card = root.querySelector('#vnd-ai-selected-display');
    if (!card) return;
    const nameEl = card.querySelector('#vnd-ai-selected-name');
    const descEl = card.querySelector('#vnd-ai-selected-desc');
    if (nameEl) nameEl.textContent = item.label;
    if (descEl) descEl.textContent = item.action;
    card.style.display = '';
  }

  _clearSelectedAction(root) {
    const card = root.querySelector('#vnd-ai-selected-display');
    if (!card) return;
    card.style.display = 'none';
  }

  // ── Character generate bar ────────────────────────────────────────────────

  _getQuality(root) {
    return root.querySelector('.vnd-ai-quality-btn.active')?.dataset.quality ?? 'standard';
  }

_updateGenerateBar(root) {
    const hasRef       = !!this.#referenceB64;
    const hasAction    = !!(this.#selectedAction?.action?.trim());
    const limitReached = this.#generationsRemaining !== null && this.#generationsRemaining <= 0;
    const ready        = hasRef && hasAction && !limitReached;

    const btn      = root.querySelector('#vnd-ai-generate-btn');
    const refHint  = root.querySelector('#vnd-ai-ref-hint');
    const actHint  = root.querySelector('#vnd-ai-action-hint');
    const limitMsg = root.querySelector('#vnd-ai-char-limit-msg');
    if (btn)      btn.disabled           = !ready || this.#generating;
    if (refHint)  refHint.style.display  = hasRef    ? 'none' : '';
    if (actHint)  actHint.style.display  = hasAction ? 'none' : '';
    if (limitMsg) limitMsg.style.display = limitReached ? '' : 'none';
  }

  // ── Character generation ──────────────────────────────────────────────────

  async _generate(root) {
    if (this.#generating) return;

    const action   = this.#selectedAction?.action?.trim();
    const quality  = this._getQuality(root);
    const n        = 1;
    const presetId = this.#selectedAction?.id === 'custom' ? null : this.#selectedAction?.id;

    if (!this.#referenceB64) {
      ui.notifications?.warn('VND AI: Sube una imagen de referencia del personaje.');
      return;
    }
    if (!action) {
      ui.notifications?.warn('VND AI: Selecciona una pose/expresión o escribe una acción personalizada.');
      return;
    }

    this.#generating = true;
    const btn     = root.querySelector('#vnd-ai-generate-btn');
    const results = root.querySelector('#vnd-ai-results');
    const genLabel = n > 1 ? `${n} variaciones` : 'imagen';

    if (btn)     { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generando…'; }
    if (results) {
      results.innerHTML = `
        <div class="vnd-ai-progress">
          <i class="fas fa-spinner fa-spin fa-2x"></i>
          <p>Generando ${genLabel}…</p>
          <p class="vnd-ai-progress-sub">Manteniendo identidad visual del personaje</p>
        </div>`;
    }

    try {
      const data = await _apiPost('/ai/generate', {
        mode: 'character', action, quality, n, presetId, referenceImageB64: this.#referenceB64
      });
      this._refreshGenBar(root, data);
      await this._renderCharResults(root, data);
      ui.notifications?.info(`VND AI: ${data.images.length} imagen(es) generada(s). Generaciones restantes: ${data.generationsRemaining}`);
    } catch (err) {
      if (results) results.innerHTML = `<div class="vnd-ai-error"><i class="fas fa-exclamation-triangle"></i> ${err.message}</div>`;
      ui.notifications?.error(`VND AI: ${err.message}`);
    } finally {
      this.#generating = false;
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-wand-sparkles"></i> <span>Generar</span>'; }
      this._updateGenerateBar(root);
    }
  }

  async _renderCharResults(root, data) {
    const results = root.querySelector('#vnd-ai-results');
    const right   = root.querySelector('.vnd-ai-char-right');
    if (!results || !data.images?.length) return;

    // Header row with back button
    results.innerHTML = `
      <div class="vnd-ai-results-header" style="width:100%;display:flex;align-items:center;justify-content:space-between;padding-bottom:6px;border-bottom:1px solid rgba(200,155,60,0.25);margin-bottom:2px;flex-shrink:0">
        <span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:rgba(200,155,60,0.8)"><i class="fas fa-images"></i> Resultados</span>
        <button type="button" class="vnd-ai-back-btn" style="display:flex;align-items:center;gap:5px;padding:4px 10px;background:rgba(200,155,60,0.1);border:1px solid rgba(200,155,60,0.3);border-radius:6px;color:rgba(232,220,200,0.8);font-size:11px;font-weight:600;cursor:pointer">
          <i class="fas fa-arrow-left"></i> Volver
        </button>
      </div>
    `;

    const baseLabel    = this.#selectedAction?.label ?? 'Custom';
    const actionId     = this.#selectedAction?.id ?? '';
    const defaultState = ['hurt', 'wounded', 'crit'].includes(actionId) ? actionId : 'normal';
    for (let i = 0; i < data.images.length; i++) {
      const b64   = data.images[i].b64_json;
      const saved = await _saveToFoundry(b64, i, 'character-studio');
      results.appendChild(this._buildResultCard(b64, baseLabel, i, data.images.length, saved, { showAssign: true, defaultState }));
    }

    right?.classList.add('has-results');
    results.querySelector('.vnd-ai-back-btn')?.addEventListener('click', () => {
      right?.classList.remove('has-results');
    });
  }

  // ── Shared result card ────────────────────────────────────────────────────

  _buildResultCard(b64, baseLabel, index, total, saved, opts = {}) {
    const { showAssign = false, defaultState = 'normal' } = opts;
    const label = total > 1 ? `${baseLabel} #${index + 1}` : baseLabel;
    const card  = document.createElement('div');
    card.className = 'vnd-ai-result-card';

    const copyBtn = saved
      ? `<button type="button" class="vnd-ai-result-btn vnd-ai-copy-btn" title="${saved}">
           <i class="fas fa-clipboard"></i> Copiar ruta
         </button>`
      : '';
    const assignBtn = (saved && showAssign)
      ? `<button type="button" class="vnd-ai-result-btn vnd-ai-assign-btn">
           <i class="fas fa-user-shield"></i> Asignar al token
         </button>`
      : '';
    const pathEl = saved ? `<div class="vnd-ai-result-path" title="${saved}">${saved}</div>` : '';

    card.innerHTML = `
      <div class="vnd-ai-result-label">${label}</div>
      <img class="vnd-ai-result-img" src="data:image/png;base64,${b64}" />
      <div class="vnd-ai-result-actions">
        <button type="button" class="vnd-ai-result-btn vnd-ai-dl-btn" title="Descargar PNG">
          <i class="fas fa-download"></i> Descargar
        </button>
        ${copyBtn}
        ${assignBtn}
      </div>
      ${pathEl}
    `;

    card.querySelector('.vnd-ai-dl-btn')?.addEventListener('click', () => {
      const a = Object.assign(document.createElement('a'), {
        href:     `data:image/png;base64,${b64}`,
        download: `${baseLabel.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}-${index}.png`
      });
      a.click();
    });

    if (saved) {
      card.querySelector('.vnd-ai-copy-btn')?.addEventListener('click', () => {
        navigator.clipboard.writeText(saved).catch(() => {});
        ui.notifications?.info(`VND AI: Ruta copiada — ${saved}`);
      });
      card.querySelector('.vnd-ai-assign-btn')?.addEventListener('click', () => {
        this._assignToToken(saved, defaultState);
      });
    }

    return card;
  }

  // ── Assign generated image to actor token state ───────────────────────────

  async _assignToToken(saved, defaultState = 'normal') {
    const actors = (game.actors?.contents ?? [])
      .map(a => `<option value="${a.id}">${a.name}</option>`)
      .join('');
    if (!actors) return ui.notifications?.warn('No hay actores en este mundo.');

    const stateOpts = [
      { v: 'normal',  l: 'Normal  (HP 76–100%)' },
      { v: 'hurt',    l: 'Golpeado (HP 51–75%)' },
      { v: 'wounded', l: 'Herido   (HP 26–50%)' },
      { v: 'crit',    l: 'Crítico  (HP ≤ 25%)'  }
    ].map(s => `<option value="${s.v}" ${s.v === defaultState ? 'selected' : ''}>${s.l}</option>`)
     .join('');

    const result = await Dialog.prompt({
      title:   'Asignar imagen al token',
      content: `<div style="display:grid;gap:8px;padding:4px 0">
                  <label style="font-size:12px;font-weight:600">Personaje</label>
                  <select id="vnd-t-actor">${actors}</select>
                  <label style="font-size:12px;font-weight:600">Estado de HP</label>
                  <select id="vnd-t-state">${stateOpts}</select>
                </div>`,
      label:    'Asignar',
      callback: (html) => ({
        actorId: html.find('#vnd-t-actor').val(),
        state:   html.find('#vnd-t-state').val()
      }),
      rejectClose: false
    }).catch(() => null);

    if (!result?.actorId) return;
    const actor = game.actors.get(result.actorId);
    if (!actor) return;

    const existing = actor.getFlag(MODULE_ID, 'tokenStates') ?? {};
    await actor.setFlag(MODULE_ID, 'tokenStates', { ...existing, [result.state]: saved });
    ui.notifications?.info(`VND AI: Estado "${result.state}" asignado a ${actor.name}`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TOKEN BAR
  // ══════════════════════════════════════════════════════════════════════════

  async _loadTokens(root) {
    try {
      const data = await _apiGetSigned('/ai/tokens');
      this._updateTokenBar(root, data);
    } catch (err) {
      const bar = root.querySelector('.vnd-ai-token-bar');
      if (bar) bar.innerHTML = `<span class="vnd-ai-bar-error"><i class="fas fa-exclamation-triangle"></i> ${err.message}</span>`;
    }
  }

  _updateTokenBar(root, data) {
    const isUnlimited = data.generationsRemaining === null;
    this.#generationsRemaining = isUnlimited ? null : (data.generationsRemaining ?? 0);

    const rem   = this.#generationsRemaining ?? 0;
    const tot   = data.generationsTotal ?? 0;
    const pct   = isUnlimited ? 100 : (tot > 0 ? Math.min(100, (rem / tot) * 100) : 0);
    const renew = data.renewalDate
      ? new Date(data.renewalDate).toLocaleDateString('es-ES')
      : '—';

    const set = (id, v) => { const el = root.querySelector(id); if (el) el.textContent = v; };
    set('#vnd-ai-tier-badge',     (data.tier ?? '?').toUpperCase());
    set('#vnd-ai-gens-remaining', isUnlimited ? '∞' : rem);
    set('#vnd-ai-gens-total',     isUnlimited ? '∞' : tot);
    set('#vnd-ai-renewal',        isUnlimited ? '' : `Renovación: ${renew}`);

    const fill = root.querySelector('#vnd-ai-bar-fill');
    if (fill) {
      fill.style.width = `${pct}%`;
      fill.className   = `vnd-ai-bar-fill${pct < 20 && !isUnlimited ? ' critical' : pct < 50 && !isUnlimited ? ' low' : ''}`;
    }

this._updateSceneGenBtn(root);
    this._updateGenerateBar(root);
  }

  _refreshGenBar(root, data) {
    const tot = Number.parseInt(root.querySelector('#vnd-ai-gens-total')?.textContent ?? '0', 10);
    this._updateTokenBar(root, {
      generationsRemaining: data.generationsRemaining,
      generationsUsed:      data.generationsUsed,
      generationsTotal:     tot,
      tier:                 root.querySelector('#vnd-ai-tier-badge')?.textContent?.toLowerCase(),
      renewalDate:          null
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // HISTORY
  // ══════════════════════════════════════════════════════════════════════════

  async _loadHistory(root) {
    const list = root.querySelector('#vnd-ai-history-list');
    if (!list) return;
    list.innerHTML = '<div class="vnd-ai-progress"><i class="fas fa-spinner fa-spin"></i> Cargando…</div>';

    try {
      const data = await _apiGetSigned('/ai/history?limit=20');
      if (!data.history?.length) {
        list.innerHTML = '<p class="vnd-ai-empty">No hay generaciones todavía.</p>';
        return;
      }

      list.innerHTML = '';
      for (const entry of data.history) {
        list.appendChild(this._buildHistoryRow(root, entry));
      }
    } catch (err) {
      list.innerHTML = `<div class="vnd-ai-error"><i class="fas fa-exclamation-triangle"></i> ${err.message}</div>`;
    }
  }

  _buildHistoryRow(root, entry) {
    const dateStr = new Date(entry.created_at).toLocaleString('es-ES', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
    const isScene      = entry.model === 'scene-studio';
    const modeLabel    = isScene ? '🏔 Escena' : '👤 Personaje';
    const qualityLabel = entry.quality === 'hd' ? 'HD' : 'Estándar';

    const row = document.createElement('div');
    row.className = 'vnd-ai-history-row';
    row.innerHTML = `
      <div class="vnd-ai-hist-header">
        <span class="vnd-ai-hist-mode">${modeLabel}</span>
        <span class="vnd-ai-hist-date">${dateStr}</span>
        <span class="vnd-ai-hist-cost">−1 gen</span>
        <span class="vnd-ai-hist-quality">${qualityLabel} · ${entry.image_count} img</span>
      </div>
      <div class="vnd-ai-hist-action">${entry.prompt.slice(0, 120)}${entry.prompt.length > 120 ? '…' : ''}</div>
      ${entry.preset_id ? `<span class="vnd-ai-hist-preset">${entry.preset_id}</span>` : ''}
    `;

    row.addEventListener('click', () => {
      if (isScene) this._restoreSceneFromHistory(root, entry);
      else         this._restoreCharFromHistory(root, entry);
    });

    return row;
  }

  _restoreSceneFromHistory(root, entry) {
    this._switchTab(root, 'scene');
    const editor = root.querySelector('#vnd-ai-scene-editor');
    const empty  = root.querySelector('#vnd-ai-scene-empty');
    const ta     = root.querySelector('#vnd-ai-scene-prompt');
    if (editor) editor.style.display = '';
    if (empty)  empty.style.display  = 'none';
    if (ta)     ta.value             = entry.prompt;
    this._updateSceneGenBtn(root);
  }

  _restoreCharFromHistory(root, entry) {
    this._switchTab(root, 'character');
    this.#selectedAction = { id: 'custom', label: 'Restaurado', action: entry.prompt };
    this.#activeCategory = 'custom';

    root.querySelectorAll('.vnd-ai-cat-btn').forEach(b => b.classList.remove('active'));
    root.querySelector('.vnd-ai-cat-btn[data-cat="custom"]')?.classList.add('active');

    const textarea = root.querySelector('#vnd-ai-custom-textarea');
    if (textarea) { textarea.value = entry.prompt; this.#customAction = entry.prompt; }
    root.querySelector('#vnd-ai-preset-grid')?.classList.add('hidden');
    root.querySelector('#vnd-ai-custom-action')?.classList.remove('hidden');

    this._updateGenerateBar(root);
  }
}
