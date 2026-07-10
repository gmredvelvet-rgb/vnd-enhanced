/**
 * AI Studio — Flux (BFL) client (server-side only)
 *
 * Scene mode:     flux-pro-1.1 text-to-image + optional image conditioning
 * Character mode: flux-2-flex image-conditioned generation
 *
 * Async pattern: POST → receive job id → poll /v1/get_result → download URL → base64
 *
 * NOTE: Flux generation takes 10-30s. If requests time out, add to wrangler.toml:
 *   [limits]
 *   cpu_ms = 30000
 * or switch to usage_model = "unbound" for longer wall-clock limits.
 */

const BFL_API          = 'https://api.bfl.ai/v1';
const POLL_INTERVAL_MS = 2500;
const POLL_MAX_ATTEMPTS = 20; // 50s max wait

// ── Character base prompt ─────────────────────────────────────────────────────

const BASE_PROMPT = `Use the attached image as the exact character reference.

Preserve 100% of the character's visual identity, including facial structure, body proportions, species traits, clothing, equipment, colors, hairstyle, accessories, and artistic style.

Character consistency is the highest priority.

Do not redesign, reinterpret, stylize, modernize, age up, age down, or alter the character in any way.

{{ACTION}}

Maintain identical appearance, outfit, colors, proportions, species traits, facial features, hairstyle, equipment, and art style from the reference image.

Only the pose, body language, facial expression, and battle damage may change.

No character redesign.
No alternate costume.
No different hairstyle.
No different facial features.
No different body type.
No style drift.
No extra accessories.
No missing accessories.

The character must remain instantly recognizable as the exact same individual from the reference image.

High-quality fantasy character illustration.
Professional RPG character art.
Highly detailed.
Dynamic action pose.

Pure white background. No environment, no scenery, no shadows on the background. Sharp defined character edges. Character fully isolated on white.`;

export function buildCharacterPrompt(action) {
  return BASE_PROMPT.replace('{{ACTION}}', action.trim());
}

// ── Scene type / style prompt fragments ──────────────────────────────────────

const SCENE_TYPE_PROMPT = {
  battlemap:  'Top-down tactical battlemap, pure overhead orthographic view, grid-ready for VTT combat, precise bird-eye perspective',
  isometric:  'Isometric 2.5D projection, equal-axis perspective, RPG exploration scene, environmental detail',
  narrative:  'Wide cinematic background, theatrical panoramic composition, third-person view, suitable for dialogue scenes',
  concept:    'Environmental concept art, professional world-building illustration, detailed painterly exploration piece'
};

const SCENE_STYLE_PROMPT = {
  'fantasy-painting':  'traditional fantasy oil painting style, rich detailed illustration, warm dramatic lighting',
  'dark-fantasy':      'dark fantasy style, grim moody atmosphere, desaturated palette with warm torch accent lights',
  'realistic':         'photorealistic digital render, natural lighting, highly detailed textures and materials',
  'semi-realistic':    'semi-realistic digital painting, stylized proportions with detailed rendering',
  'anime':             'anime/manga illustration style, vibrant cel-shaded colors, clean linework',
  'visual-novel':      'visual novel background art, clean polished digital illustration, anime-adjacent style',
  'concept-art':       'professional concept art, expressive brushwork, environmental storytelling',
  'battlemap-drawn':   'hand-drawn RPG map style, ink on aged parchment, cartographic conventions, old-school dungeon map aesthetic',
  'battlemap-inked':   'clean inked battlemap, precise architectural linework, cross-hatching for depth and shadow',
  'battlemap-colored': 'colored battlemap, flat watercolor fills over clean ink linework, vivid map colors'
};

// Complexity tier fragments — selected as "Complejidad" in the Scene Studio UI
const SCENE_TIER_PROMPT = {
  standard: '',
  detailed: 'Highly detailed environment, layered composition with distinct foreground, midground and background elements, fine surface textures and props',
  epic:     'Epic monumental scale, dramatic cinematic lighting, sweeping vista composition, breathtaking sense of depth and grandeur, masterpiece-level environmental detail'
};

// ── Flux client ───────────────────────────────────────────────────────────────

const REPLICATE_API = 'https://api.replicate.com/v1';

export class FluxClient {
  #apiKey;
  #replicateKey;

  constructor(env) {
    this.#apiKey      = env.BFL_API_KEY;
    this.#replicateKey = env.REPLICATE_API_TOKEN ?? null;
    if (!this.#apiKey) throw new Error('BFL_API_KEY secret is not configured');
  }

  // ── Scene image generation ────────────────────────────────────────────────

  async generateScene({ finalPrompt, sceneType, style, references = [], sceneTier = 'standard', quality = 'standard', n = 1 }) {
    const typeDesc  = SCENE_TYPE_PROMPT[sceneType]  ?? SCENE_TYPE_PROMPT.narrative;
    const styleDesc = SCENE_STYLE_PROMPT[style]      ?? SCENE_STYLE_PROMPT['fantasy-painting'];
    const tierDesc  = SCENE_TIER_PROMPT[sceneTier]   ?? '';

    const [width, height] = sceneType === 'battlemap' ? [1024, 1024] : [1440, 1024];

    const fullPrompt = [
      typeDesc,
      styleDesc,
      tierDesc,
      finalPrompt,
      'High quality digital art for tabletop RPG, rich detail, immersive atmosphere.'
    ].filter(Boolean).join('. ');

    const firstRef = references[0];

    const body = {
      prompt:            fullPrompt,
      width,
      height,
      output_format:     'png',
      safety_tolerance:  5,
      prompt_upsampling: quality === 'hd',
      ...(firstRef ? { image_prompt: firstRef.b64, image_prompt_strength: 0.15 } : {})
    };

    const requests = Array.from({ length: Math.max(1, n) }, () =>
      this.#submitAndPoll('flux-2-pro', body)
    );

    const b64s = await Promise.all(requests);
    return b64s.map(b64_json => ({ b64_json }));
  }

  // ── Character variation ───────────────────────────────────────────────────

  async generateCharacterVariation({ action, imageB64, quality = 'standard', n = 1 }) {
    const prompt = buildCharacterPrompt(action);

    // flux-2-flex + input_image = true img2img: transforms the reference into the new pose
    // while keeping the same character identity, style, and appearance.
    const body = {
      prompt,
      input_image:           imageB64,
      image_prompt_strength: 0.45,
      width:                 1024,
      height:                1440,
      output_format:         'png',
      safety_tolerance:      5,
      prompt_upsampling:     quality === 'hd'
    };

    const requests = Array.from({ length: Math.max(1, n) }, async () => {
      const b64 = await this.#submitAndPoll('flux-2-flex', body);
      return this.#removeBg(b64);
    });

    const b64s = await Promise.all(requests);
    return b64s.map(b64_json => ({ b64_json }));
  }

  // ── Background removal via Replicate rembg ────────────────────────────────

  async #removeBg(imageB64) {
    if (!this.#replicateKey) return imageB64;

    try {
      const submit = await fetch(`${REPLICATE_API}/models/851-labs/background-remover/predictions`, {
        method:  'POST',
        headers: { 'Authorization': `Token ${this.#replicateKey}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ input: { image: `data:image/png;base64,${imageB64}` } })
      });
      if (!submit.ok) throw new Error(`Replicate submit ${submit.status}`);
      const { id, urls } = await submit.json();

      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const poll   = await fetch(urls?.get ?? `${REPLICATE_API}/predictions/${id}`, {
          headers: { 'Authorization': `Token ${this.#replicateKey}` }
        });
        const result = await poll.json();
        if (result.status === 'succeeded') return this.#urlToBase64(result.output);
        if (result.status === 'failed')    throw new Error(`Replicate rembg: ${result.error}`);
      }
      throw new Error('Replicate rembg timeout');
    } catch (err) {
      console.warn('[VND Flux] bg removal failed, returning original:', err.message);
      return imageB64;
    }
  }

  // ── Private: submit job and poll until Ready ──────────────────────────────

  async #submitAndPoll(endpoint, body) {
    const { id, pollingUrl } = await this.#submitJob(endpoint, body);

    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      const result = await this.#pollResult(id, pollingUrl);
      if (result.status === 'Pending' || result.status === 'Queued') continue;
      return this.#resolveResult(result);
    }

    throw new Error(`Flux: tiempo de espera agotado (${POLL_INTERVAL_MS * POLL_MAX_ATTEMPTS / 1000}s). Intenta de nuevo.`);
  }

  async #submitJob(endpoint, body) {
    const resp = await fetch(`${BFL_API}/${endpoint}`, {
      method:  'POST',
      headers: { 'x-key': this.#apiKey, 'Content-Type': 'application/json' },
      body:    JSON.stringify(body)
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      const detail = Array.isArray(err.detail)
        ? err.detail.map(d => d.msg ?? JSON.stringify(d)).join('; ')
        : (err.detail ?? err.message ?? `Flux error ${resp.status}`);
      console.error('[VND Flux] submit error:', resp.status, JSON.stringify(err));
      throw new Error(detail);
    }
    const data = await resp.json();
    console.log('[VND Flux] submit ok:', JSON.stringify(data));
    const id = data.id;
    if (!id) throw new Error('Flux no devolvió un ID de trabajo');
    return { id, pollingUrl: data.polling_url ?? null };
  }

  async #pollResult(id, pollingUrl) {
    const url = pollingUrl ?? `${BFL_API}/get_result?id=${encodeURIComponent(id)}`;
    const resp = await fetch(url, { headers: { 'x-key': this.#apiKey } });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      const detail = Array.isArray(err.detail)
        ? err.detail.map(d => d.msg ?? JSON.stringify(d)).join('; ')
        : (err.detail ?? `Flux poll error ${resp.status}`);
      throw new Error(detail);
    }
    return resp.json();
  }

  async #resolveResult(result) {
    const FATAL = {
      'Error':             'Flux falló al generar la imagen. Intenta de nuevo.',
      'Content Moderated': `La imagen fue bloqueada por el filtro de contenido de Flux (Content Moderated).`,
      'Request Moderated': `La imagen fue bloqueada por el filtro de contenido de Flux (Request Moderated).`,
      'Task not found':    'Tarea Flux no encontrada. Intenta de nuevo.'
    };
    if (FATAL[result.status]) throw new Error(FATAL[result.status]);

    const imageUrl = result.result?.sample;
    if (!imageUrl) throw new Error('Flux devolvió Ready pero sin URL de imagen');
    return this.#urlToBase64(imageUrl);
  }

  // ── Private: download image URL and return base64 string ─────────────────

  async #urlToBase64(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`No se pudo descargar la imagen generada: HTTP ${resp.status}`);

    const buffer = await resp.arrayBuffer();
    // Buffer is available via nodejs_compat flag in wrangler.toml
    return Buffer.from(buffer).toString('base64');
  }
}
