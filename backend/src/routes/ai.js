/**
 * AI Studio — routes
 *   POST /ai/expand    — expand a simple idea into a scene brief (FREE, no credits)
 *   GET  /ai/tokens    — current credit balance
 *   POST /ai/generate  — generate image (character or scene mode)
 *   GET  /ai/history   — recent generations
 */

import { Hono }                                            from 'hono';
import { Supabase }                                        from '../supabase.js';
import { OpenAIClient }  from '../openai.js';
import { FluxClient }    from '../flux.js';
import { requireAuth, rateLimiter, signedJson }            from '../middleware.js';

const router = new Hono();

const DEFAULT_TIER_TOKENS = { none: 0, basic: 20, premium: 50 };

function isOwner(env, user) {
  return env.OWNER_EMAILS?.split(',').map(e => e.trim()).includes(user.email) ?? false;
}

function tierAllocation(env, tier) {
  const cfg = env.AI_TIER_TOKENS ? JSON.parse(env.AI_TIER_TOKENS) : DEFAULT_TIER_TOKENS;
  return cfg[tier] ?? 0;
}

// First day of the month after `from`, UTC — the renewal anchor for generation allowances
function nextMonthStartISO(from = new Date()) {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1)).toISOString();
}

async function checkRenewal(db, aiTokens, user, env) {
  const now = new Date();

  // Legacy rows were created with renewal_date=null and were never renewed.
  // Treat them as due when their last reset happened in an earlier UTC month.
  const lastReset = aiTokens.last_reset_at ? new Date(aiTokens.last_reset_at) : null;
  const legacyDue = !aiTokens.renewal_date && (
    lastReset?.getUTCFullYear() !== now.getUTCFullYear() ||
    lastReset?.getUTCMonth()    !== now.getUTCMonth()
  );

  const needsReset = legacyDue ||
    (aiTokens.renewal_date && new Date(aiTokens.renewal_date) <= now);

  if (needsReset) {
    const updated = await db.update('vnd_ai_tokens', { user_id: user.id }, {
      tokens_total:  tierAllocation(env, user.tier),
      tokens_used:   0,
      renewal_date:  nextMonthStartISO(now),
      last_reset_at: now.toISOString()
    });
    await db.insert('vnd_audit', {
      event_type: 'ai_token_reset',
      user_id:    user.id,
      details:    JSON.stringify({ tier: user.tier, new_total: tierAllocation(env, user.tier) })
    });
    return updated;
  }

  // Not due yet, but legacy rows still need a renewal schedule going forward
  if (!aiTokens.renewal_date) {
    return db.update('vnd_ai_tokens', { user_id: user.id }, {
      renewal_date: nextMonthStartISO(now)
    });
  }

  return aiTokens;
}

async function getOrCreateTokens(db, user, env) {
  const existing = await db.findOne('vnd_ai_tokens', { user_id: user.id });
  if (existing) {
    return checkRenewal(db, existing, user, env);
  }
  return db.insert('vnd_ai_tokens', {
    user_id:       user.id,
    tokens_total:  tierAllocation(env, user.tier),
    tokens_used:   0,
    renewal_date:  nextMonthStartISO(),
    last_reset_at: new Date().toISOString()
  });
}

// ── Scene generation helper ───────────────────────────────────────────────────

async function handleSceneGenerate(c, body, db, user, quality, n) {
  const finalPrompt = body?.finalPrompt?.trim();
  const validTypes  = ['battlemap', 'isometric', 'narrative', 'concept'];
  const sceneType   = validTypes.includes(body?.sceneType) ? body.sceneType : 'narrative';
  const style       = typeof body?.style === 'string' ? body.style.slice(0, 64) : 'fantasy-painting';
  const validTiers  = ['standard', 'detailed', 'epic'];
  const sceneTier   = validTiers.includes(body?.sceneTier) ? body.sceneTier : 'standard';

  const rawRefs    = Array.isArray(body?.references) ? body.references.slice(0, 4) : [];
  const references = rawRefs
    .filter(r => typeof r?.b64 === 'string' && r.b64.length > 100)
    .map(r => ({ b64: r.b64, role: typeof r.role === 'string' ? r.role.slice(0, 32) : '' }));

  if (!finalPrompt) {
    return c.json({ error: 'Se requiere el prompt final de la escena.', code: 'BAD_REQUEST' }, 400);
  }

  const ownerBypass = isOwner(c.env, user);
  const tokens      = ownerBypass ? null : await getOrCreateTokens(db, user, c.env);

  if (!ownerBypass) {
    const available = Math.max(0, tokens.tokens_total - tokens.tokens_used);
    if (available < 1) {
      return c.json({
        error: 'Has alcanzado tu límite de generaciones para este ciclo de facturación.',
        code: 'GENERATION_LIMIT_REACHED'
      }, 402);
    }
    await db.update('vnd_ai_tokens', { user_id: user.id }, { tokens_used: tokens.tokens_used + 1 });
  }

  let images;
  try {
    const flux = new FluxClient(c.env);
    images = await flux.generateScene({ finalPrompt, sceneType, style, references, sceneTier, quality, n });
  } catch (err) {
    if (!ownerBypass) await db.update('vnd_ai_tokens', { user_id: user.id }, { tokens_used: tokens.tokens_used });
    console.error('[VND AI] Scene generation error:', err.message);
    return c.json({ error: err.message, code: 'GENERATION_FAILED' }, 502);
  }

  const historySize = sceneType === 'battlemap' ? '1024x1024' : '1536x1024';
  await db.insert('vnd_ai_history', {
    user_id: user.id, prompt: finalPrompt.slice(0, 4000), preset_id: sceneType,
    model: 'scene-studio', size: historySize, quality, image_count: images.length, token_cost: 1
  });
  await db.insert('vnd_audit', {
    event_type: 'ai_generate_scene',
    user_id:    user.id,
    details:    JSON.stringify({ sceneType, style, sceneTier, refCount: references.length, quality, n: images.length })
  });

  const newUsed      = ownerBypass ? null : tokens.tokens_used + 1;
  const newRemaining = ownerBypass ? null : Math.max(0, tokens.tokens_total - newUsed);

  return c.json({
    images:               images.map(i => ({ b64_json: i.b64_json })),
    generationsUsed:      newUsed,
    generationsRemaining: newRemaining
  });
}

// ── Character generation helper ───────────────────────────────────────────────

async function handleCharacterGenerate(c, body, db, user, quality, n) {
  const action = body?.action?.trim();
  const hasRef = typeof body?.referenceImageB64 === 'string' && body.referenceImageB64.length > 100;
  const charN  = n >= 4 ? 4 : 1;

  if (!action) {
    return c.json({ error: 'Se requiere una acción/pose.', code: 'BAD_REQUEST' }, 400);
  }
  if (!hasRef) {
    return c.json({ error: 'Se requiere una imagen de referencia del personaje.', code: 'NO_REFERENCE' }, 400);
  }

  const ownerBypass = isOwner(c.env, user);
  const tokens      = ownerBypass ? null : await getOrCreateTokens(db, user, c.env);

  if (!ownerBypass) {
    const available = Math.max(0, tokens.tokens_total - tokens.tokens_used);
    if (available < 1) {
      return c.json({
        error: 'Has alcanzado tu límite de generaciones para este ciclo de facturación.',
        code: 'GENERATION_LIMIT_REACHED'
      }, 402);
    }
    await db.update('vnd_ai_tokens', { user_id: user.id }, { tokens_used: tokens.tokens_used + 1 });
  }

  let images;
  try {
    const flux = new FluxClient(c.env);
    images = await flux.generateCharacterVariation({
      action, imageB64: body.referenceImageB64, quality, n: charN
    });
  } catch (err) {
    if (!ownerBypass) await db.update('vnd_ai_tokens', { user_id: user.id }, { tokens_used: tokens.tokens_used });
    console.error('[VND AI] Character generation error:', err.message);
    return c.json({ error: err.message, code: 'GENERATION_FAILED' }, 502);
  }

  const presetId = typeof body?.presetId === 'string' ? body.presetId.slice(0, 64) : null;
  await db.insert('vnd_ai_history', {
    user_id: user.id, prompt: action.slice(0, 4000), preset_id: presetId,
    model: 'character-studio', size: '1024x1536', quality, image_count: images.length, token_cost: 1
  });
  await db.insert('vnd_audit', {
    event_type: 'ai_generate_character',
    user_id:    user.id,
    details:    JSON.stringify({ quality, n: images.length, preset_id: presetId })
  });

  const newUsed      = ownerBypass ? null : tokens.tokens_used + 1;
  const newRemaining = ownerBypass ? null : Math.max(0, tokens.tokens_total - newUsed);

  return c.json({
    images:               images.map(i => ({ b64_json: i.b64_json })),
    generationsUsed:      newUsed,
    generationsRemaining: newRemaining
  });
}

// ── POST /ai/expand ───────────────────────────────────────────────────────────

router.post('/expand',
  requireAuth,
  rateLimiter({ max: 15, windowSec: 60,   keyFn: (c) => `expand-min:${c.get('jwtPayload')?.sub ?? 'anon'}` }),
  rateLimiter({ max: 60, windowSec: 3600, keyFn: (c) => `expand-hr:${c.get('jwtPayload')?.sub ?? 'anon'}` }),
  async (c) => {
    const payload = c.get('jwtPayload');
    const body    = await c.req.json().catch(() => null);
    const idea    = body?.idea?.trim();

    if (!idea || idea.length < 2) {
      return c.json({ error: 'Introduce una idea para la escena (mín. 2 caracteres).', code: 'BAD_REQUEST' }, 400);
    }
    if (idea.length > 500) {
      return c.json({ error: 'La idea es demasiado larga (máx. 500 caracteres).', code: 'BAD_REQUEST' }, 400);
    }

    const db   = new Supabase(c.env);
    const user = await db.findOne('vnd_users', { id: payload.sub });
    if (user?.status !== 'active') {
      return c.json({ error: 'Account inactive', code: 'ACCOUNT_INACTIVE' }, 403);
    }

    const openai    = new OpenAIClient(c.env);
    const expansion = await openai.expandSceneIdea(idea);
    return c.json({ expansion });
  }
);

// ── GET /ai/tokens ─────────────────────────────────────────────────────────────

router.get('/tokens', requireAuth, async (c) => {
  const payload = c.get('jwtPayload');
  const db      = new Supabase(c.env);

  const user = await db.findOne('vnd_users', { id: payload.sub });
  if (user?.status !== 'active') {
    return c.json({ error: 'Account inactive', code: 'ACCOUNT_INACTIVE' }, 403);
  }

  const ownerBypass = isOwner(c.env, user);
  const tokens      = ownerBypass ? null : await getOrCreateTokens(db, user, c.env);
  const remaining   = ownerBypass ? null : Math.max(0, tokens.tokens_total - tokens.tokens_used);

  return signedJson(c, {
    generationsTotal:     ownerBypass ? null : tokens.tokens_total,
    generationsUsed:      ownerBypass ? null : tokens.tokens_used,
    generationsRemaining: remaining,
    renewalDate:          ownerBypass ? null : tokens.renewal_date,
    lastReset:            ownerBypass ? null : tokens.last_reset_at,
    tier:                 user.tier,
    tierLimit:            ownerBypass ? null : tierAllocation(c.env, user.tier)
  });
});

// ── POST /ai/generate ─────────────────────────────────────────────────────────

router.post('/generate',
  requireAuth,
  rateLimiter({ max: 3,  windowSec: 60,   keyFn: (c) => `gen-min:${c.get('jwtPayload')?.sub ?? 'anon'}` }),
  rateLimiter({ max: 20, windowSec: 3600, keyFn: (c) => `gen-hr:${c.get('jwtPayload')?.sub ?? 'anon'}` }),
  async (c) => {
    const payload = c.get('jwtPayload');
    const body    = await c.req.json().catch(() => null);

    const db   = new Supabase(c.env);
    const user = await db.findOne('vnd_users', { id: payload.sub });

    if (user?.status !== 'active') {
      return c.json({ error: 'Account inactive', code: 'ACCOUNT_INACTIVE' }, 403);
    }
    if (user.tier === 'none') {
      return c.json({ error: 'Se requiere suscripción Patreon activa.', code: 'NO_SUBSCRIPTION' }, 403);
    }

    const quality = body?.quality === 'hd' ? 'hd' : 'standard';
    const n       = 1;
    const mode    = body?.mode === 'scene' ? 'scene' : 'character';

    if (mode === 'scene') {
      return handleSceneGenerate(c, body, db, user, quality, n);
    }
    return handleCharacterGenerate(c, body, db, user, quality, n);
  }
);

// ── GET /ai/history ───────────────────────────────────────────────────────────

router.get('/history', requireAuth, async (c) => {
  const payload = c.get('jwtPayload');
  const limit   = Math.min(Number.parseInt(c.req.query('limit') ?? '20', 10), 50);
  const db      = new Supabase(c.env);

  const history = await db.findMany(
    'vnd_ai_history',
    { user_id: payload.sub },
    { order: 'created_at.desc', limit }
  );

  return signedJson(c, { history });
});

export default router;
