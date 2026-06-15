/**
 * AI Studio — OpenAI client (server-side only)
 *
 * Character mode: gpt-image-1 (reference image + action → variation)
 * Scene mode:     gpt-image-1 text-to-image + optional multi-reference compositing
 * Scene expand:   gpt-4o-mini chat → structured JSON brief (free, no credits)
 */

const OPENAI_API = 'https://api.openai.com/v1';

// ── Character base prompt ─────────────────────────────────────────────────────
const BASE_PROMPT = `Use the attached image as the exact character reference.

Preserve 100% of the character's visual identity, including facial structure, body proportions, skin color, hairstyle, clothing, accessories, armor, weapons, markings, species traits, colors, art style, age, and overall design.

Do not redesign, reinterpret, replace, or alter any part of the character.

Generate the same character in a new pose:

{{ACTION}}

Keep the same outfit, same colors, same equipment, same artistic style, same lighting quality, and same level of detail as the reference image.

Character consistency is the highest priority.

Only change the pose and facial expression.

No alternate costume, no different hairstyle, no different facial features, no different body type, no redesign.

Full character illustration, professional fantasy artwork.`;

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

// ── Cost calculation ──────────────────────────────────────────────────────────

export function calculateCost(env, { quality, n }) {
  const cfg = env.AI_TOKEN_COSTS ? JSON.parse(env.AI_TOKEN_COSTS) : null;
  if (n >= 4)                          return cfg?.character_variations4 ?? 30;
  if (quality === 'hd' || quality === 'high') return cfg?.character_hd ?? 20;
  return cfg?.character_standard ?? 15;
}

export function calculateSceneCost(env, { sceneTier, refCount, quality, n }) {
  const cfg = env.AI_TOKEN_COSTS ? JSON.parse(env.AI_TOKEN_COSTS) : null;

  const base = {
    standard: cfg?.scene_standard ?? 5,
    detailed: cfg?.scene_detailed ?? 10,
    epic:     cfg?.scene_epic     ?? 15
  }[sceneTier] ?? 5;

  let refExtra = 0;
  if (refCount === 1)      refExtra = cfg?.scene_ref_single ?? 5;
  else if (refCount >= 2)  refExtra = cfg?.scene_refs_multi ?? 10;

  const hdExtra = quality === 'hd' ? (cfg?.scene_quality_hd ?? 5) : 0;

  return (base + refExtra + hdExtra) * Math.max(1, n);
}

// ── OpenAI client ─────────────────────────────────────────────────────────────

export class OpenAIClient {
  #apiKey;

  constructor(env) {
    this.#apiKey = env.OPENAI_API_KEY;
    if (!this.#apiKey) throw new Error('OPENAI_API_KEY secret is not configured');
  }

  // ── Scene idea expansion (gpt-4o-mini, FREE — no credits) ────────────────

  async expandSceneIdea(idea) {
    const resp = await fetch(`${OPENAI_API}/chat/completions`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${this.#apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:           'gpt-4o-mini',
        response_format: { type: 'json_object' },
        temperature:     0.75,
        max_tokens:      900,
        messages: [
          {
            role:    'system',
            content: 'Eres un director artístico especializado en juegos de rol de mesa. Expandes ideas simples en briefs visuales estructurados para generación de imágenes. Responde ÚNICAMENTE con JSON válido, sin texto adicional fuera del JSON.'
          },
          {
            role:    'user',
            content: `Expande esta idea de escena para TTRPG: "${idea}"\n\nDevuelve exactamente este JSON:\n{\n  "title": "Título en español (3-5 palabras evocadoras)",\n  "description": "Descripción visual de 2-3 frases de lo que SE VE en la escena",\n  "elements": ["elemento visual específico 1", "elemento visual específico 2"],\n  "atmosphere": ["palabra de atmósfera 1", "palabra de atmósfera 2"],\n  "palette": ["descripción de color 1", "descripción de color 2"]\n}\n\nReglas:\n- elements: 8-12 elementos visuales concretos presentes en la escena\n- atmosphere: 4-6 palabras que describen el ambiente y emoción\n- palette: 3-4 descripciones de colores dominantes\n- Todo en español`
          }
        ]
      })
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error?.message ?? `OpenAI chat error ${resp.status}`);
    }

    const data = await resp.json();
    try {
      return JSON.parse(data.choices[0].message.content);
    } catch {
      throw new Error('La IA devolvió una respuesta inválida. Intenta de nuevo.');
    }
  }

  // ── Scene image generation ────────────────────────────────────────────────

  async generateScene({ finalPrompt, sceneType, style, references = [], quality = 'standard', n = 1 }) {
    const typeDesc  = SCENE_TYPE_PROMPT[sceneType]  ?? SCENE_TYPE_PROMPT.narrative;
    const styleDesc = SCENE_STYLE_PROMPT[style]      ?? SCENE_STYLE_PROMPT['fantasy-painting'];
    const size      = sceneType === 'battlemap' ? '1024x1024' : '1536x1024';
    const gptQuality = quality === 'hd' ? 'high' : 'medium';

    const fullPrompt = [
      typeDesc,
      styleDesc,
      finalPrompt,
      'High quality digital art for tabletop RPG, rich detail, immersive atmosphere.'
    ].join('. ');

    if (references.length > 0) {
      try {
        return await this.#gptImage1WithRefs({ prompt: fullPrompt, references, size, quality: gptQuality, n });
      } catch (err) {
        const isModelError = err.message.includes('model_not_found')
          || err.message.includes('invalid_model')
          || err.message.includes('404');
        if (!isModelError) throw err;
        console.warn('[VND AI] gpt-image-1 with refs failed, falling back to text-only');
      }
    }

    return this.#textOnlyGenerate({ prompt: fullPrompt, size, quality: gptQuality, n });
  }

  // ── Character variation (existing) ────────────────────────────────────────

  async generateCharacterVariation({ action, imageB64, quality = 'standard', n = 1 }) {
    const prompt     = buildCharacterPrompt(action);
    const gptQuality = quality === 'hd' ? 'high' : 'medium';

    return await this.#gptImage1({ prompt, imageB64, quality: gptQuality, n });
  }

  // ── Private: text-to-image (no reference) ────────────────────────────────

  async #textOnlyGenerate({ prompt, size, quality, n }) {
    const resp = await fetch(`${OPENAI_API}/images/generations`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${this.#apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:         'gpt-image-1',
        prompt,
        size,
        quality,
        n,
        output_format: 'b64_json'
      })
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error?.message ?? `OpenAI generation error ${resp.status}`);
    }

    const result = await resp.json();
    return result.data ?? [];
  }

  // ── Private: gpt-image-1 with reference images (scene) ───────────────────

  async #gptImage1WithRefs({ prompt, references, size, quality, n }) {
    const form = new FormData();
    form.append('model',   'gpt-image-1');
    form.append('prompt',  prompt);
    form.append('size',    size);
    form.append('quality', quality);
    form.append('n',       String(Math.min(n, 10)));

    for (const ref of references) {
      const bytes = Uint8Array.from(atob(ref.b64), c => c.codePointAt(0));
      const blob  = new Blob([bytes], { type: 'image/png' });
      form.append('image[]', blob, 'reference.png');
    }

    const resp = await fetch(`${OPENAI_API}/images/edits`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${this.#apiKey}` },
      body:    form
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error?.message ?? `OpenAI gpt-image-1 error ${resp.status}`);
    }

    const result = await resp.json();
    return result.data ?? [];
  }

  // ── Private: gpt-5.5 via Responses API (vision + image generation) ───────

  async #gptImage1({ prompt, imageB64, quality, n }) {
    const resp = await fetch(`${OPENAI_API}/responses`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${this.#apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.5',
        input: [
          {
            role: 'user',
            content: [
              {
                type:      'input_image',
                image_url: `data:image/png;base64,${imageB64}`
              },
              {
                type: 'input_text',
                text: prompt
              }
            ]
          }
        ],
        tools: [{ type: 'image_generation', quality, size: '1024x1536' }]
      })
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error?.message ?? `gpt-5.5 Responses API error ${resp.status}`);
    }

    const result = await resp.json();
    const images = (result.output ?? [])
      .filter(o => o.type === 'image_generation_call' && o.result)
      .map(o => ({ b64_json: o.result }));

    if (images.length === 0) {
      throw new Error('gpt-5.5 no devolvió imagen. Output: ' + JSON.stringify(result.output ?? []).slice(0, 300));
    }
    return images;
  }

}
