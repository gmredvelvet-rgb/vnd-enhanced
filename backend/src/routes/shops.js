/**
 * D&D Shops data endpoint
 * GET /shops/data — requires valid JWT; returns shop catalog signed with RS256.
 *
 * The shops.json data lives here (server-only).
 * Without a valid Patreon token, the client gets nothing.
 */

import { Hono }       from 'hono';
import { requireAuth, rateLimiter, signedJson } from '../middleware.js';

const router = new Hono();

// ── Shop catalog (moved from module's shops.json) ─────────────────────────────

const SHOPS_DATA = {
  shop: {
    id:             'frenzy',
    name:           'Frenzy Shop',
    subtitle:       'Black Market Outfitters',
    district:       'Neon Row / Ward 13',
    reputation:     8,
    keeper:         'Boss Dokka',
    keeperLine:     "What're ya buyin'? Make it quick. The heat's on tonight.",
    keeperHint:     'No refunds. No names. Roll high.',
    keeperAvatar:   'icons/svg/mystery-man.svg',
    sellMultiplier: 0.5
  },
  categories: [
    {
      id:        'weapon',
      code:      'WPN',
      label:     'Weapons',
      kana:      '武器',
      icon:      'fa-solid fa-khanda',
      tag:       'NEW',
      color:     '#ff176e',
      itemTypes: ['weapon']
    },
    {
      id:        'equipment',
      code:      'ARM',
      label:     'Armor',
      kana:      '鎧',
      icon:      'fa-solid fa-shield-halved',
      tag:       'HOT',
      color:     '#20e5d8',
      itemTypes: ['equipment']
    },
    {
      id:        'consumable',
      code:      'CON',
      label:     'Consumables',
      kana:      '消耗品',
      icon:      'fa-solid fa-flask-round-potion',
      tag:       'BUY',
      color:     '#22c55e',
      itemTypes: ['consumable']
    },
    {
      id:        'ammunition',
      code:      'AMO',
      label:     'Ammunition',
      kana:      '弾薬',
      icon:      'fa-solid fa-bow-arrow',
      tag:       'STOCK',
      color:     '#f97316',
      itemTypes: ['consumable']
    },
    {
      id:        'tool',
      code:      'TLK',
      label:     'Tools',
      kana:      '道具',
      icon:      'fa-solid fa-screwdriver-wrench',
      tag:       'UTIL',
      color:     '#a855f7',
      itemTypes: ['tool']
    },
    {
      id:        'loot',
      code:      'TRD',
      label:     'Trade Goods',
      kana:      '商品',
      icon:      'fa-solid fa-sack',
      tag:       'LOOT',
      color:     '#ffe500',
      itemTypes: ['loot', 'container', 'backpack']
    },
    {
      id:        'magic',
      code:      'MAG',
      label:     'Magic Items',
      kana:      '魔法品',
      icon:      'fa-solid fa-wand-sparkles',
      tag:       'RARE',
      color:     '#e879f9',
      itemTypes: ['weapon', 'equipment', 'consumable', 'loot']
    }
  ]
};

// ── GET /shops/data ───────────────────────────────────────────────────────────

router.get('/data',
  rateLimiter({ max: 30, windowSec: 3600, keyFn: (c) => c.req.header('X-Installation-ID') ?? 'unknown' }),
  requireAuth,
  async (c) => {
    const payload = c.get('jwtPayload');

    if (!payload.features?.includes('dnd-shops')) {
      return c.json({ error: 'Feature not included in your tier', code: 'FEATURE_UNAVAILABLE' }, 403);
    }

    return signedJson(c, SHOPS_DATA);
  }
);

export default router;
