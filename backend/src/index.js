/**
 * VND Enhanced — License Server
 * Cloudflare Worker entry point
 *
 * Deploy: wrangler deploy
 * Local:  wrangler dev
 */

import { Hono }        from 'hono';
import { cors }        from 'hono/cors';
import authRouter      from './routes/auth.js';
import licenseRouter   from './routes/license.js';
import aiRouter        from './routes/ai.js';
import shopsRouter     from './routes/shops.js';

const app = new Hono();

// ── CORS preflight ────────────────────────────────────────────────────────────
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Installation-ID'],
  maxAge: 86400
}));

app.options('*', (c) => c.text('', 204));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (c) => c.json({ status: 'ok', service: 'vnd-license', v: '1.0' }));

// ── Routes ────────────────────────────────────────────────────────────────────
app.route('/oauth',     authRouter);
app.route('/token',     licenseRouter);
app.route('/heartbeat', licenseRouter);
app.route('/ai',        aiRouter);
app.route('/shops',     shopsRouter);
app.route('/',          licenseRouter);

// ── Error handler ─────────────────────────────────────────────────────────────
app.onError((err, c) => {
  console.error('Worker error:', err.message, err.stack);
  // Never expose internal error details to the client
  return c.json({ error: 'Internal error', code: 'INTERNAL_ERROR' }, 500);
});

app.notFound((c) => c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404));

export default app;
