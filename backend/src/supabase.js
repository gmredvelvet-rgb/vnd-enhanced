/**
 * Thin Supabase REST API client — no npm dependency, pure fetch.
 * Uses the service role key (bypasses RLS) — keep this secret.
 */

export class Supabase {
  #url;
  #key;

  constructor(env) {
    this.#url = env.SUPABASE_URL;
    this.#key = env.SUPABASE_SERVICE_KEY;
  }

  #headers(extra = {}) {
    return {
      'apikey':        this.#key,
      'Authorization': `Bearer ${this.#key}`,
      'Content-Type':  'application/json',
      ...extra
    };
  }

  // ── SELECT ────────────────────────────────────────────────────────────────

  async findOne(table, filters) {
    const url  = this.#buildUrl(table, filters);
    const resp = await fetch(url, { headers: this.#headers({ 'Accept': 'application/json' }) });
    if (!resp.ok) throw new DbError(await resp.text(), resp.status);
    const rows = await resp.json();
    return rows[0] ?? null;
  }

  async findMany(table, filters) {
    const url  = this.#buildUrl(table, filters);
    const resp = await fetch(url, { headers: this.#headers() });
    if (!resp.ok) throw new DbError(await resp.text(), resp.status);
    return resp.json();
  }

  async count(table, filters) {
    const url  = this.#buildUrl(table, filters);
    const resp = await fetch(url, {
      headers: this.#headers({ 'Prefer': 'count=exact', 'Accept': 'application/json' })
    });
    if (!resp.ok) throw new DbError(await resp.text(), resp.status);
    const countHeader = resp.headers.get('content-range');
    // content-range: 0-N/TOTAL  or  */TOTAL
    return countHeader ? parseInt(countHeader.split('/')[1] ?? '0', 10) : 0;
  }

  // ── INSERT ────────────────────────────────────────────────────────────────

  async insert(table, data) {
    const resp = await fetch(`${this.#url}/rest/v1/${table}`, {
      method:  'POST',
      headers: this.#headers({ 'Prefer': 'return=representation' }),
      body:    JSON.stringify(data)
    });
    if (!resp.ok) throw new DbError(await resp.text(), resp.status);
    const rows = await resp.json();
    return rows[0] ?? null;
  }

  // Upsert (INSERT … ON CONFLICT UPDATE)
  async upsert(table, data, conflictKey) {
    const resp = await fetch(`${this.#url}/rest/v1/${table}?on_conflict=${conflictKey}`, {
      method:  'POST',
      headers: this.#headers({
        'Prefer': 'return=representation,resolution=merge-duplicates'
      }),
      body: JSON.stringify(data)
    });
    if (!resp.ok) throw new DbError(await resp.text(), resp.status);
    const rows = await resp.json();
    return rows[0] ?? null;
  }

  // ── UPDATE ────────────────────────────────────────────────────────────────

  async update(table, filters, data) {
    const url  = this.#buildUrl(table, filters);
    const resp = await fetch(url, {
      method:  'PATCH',
      headers: this.#headers({ 'Prefer': 'return=representation' }),
      body:    JSON.stringify(data)
    });
    if (!resp.ok) throw new DbError(await resp.text(), resp.status);
    const rows = await resp.json();
    return rows[0] ?? null;
  }

  // ── RPC (stored function) ─────────────────────────────────────────────────

  async rpc(fn, args = {}) {
    const resp = await fetch(`${this.#url}/rest/v1/rpc/${fn}`, {
      method:  'POST',
      headers: this.#headers(),
      body:    JSON.stringify(args)
    });
    if (!resp.ok) throw new DbError(await resp.text(), resp.status);
    return resp.json();
  }

  // ── URL builder ───────────────────────────────────────────────────────────

  #buildUrl(table, filters = {}) {
    const url = new URL(`${this.#url}/rest/v1/${table}`);
    for (const [col, val] of Object.entries(filters)) {
      // Support operators: col=gte.value, col=eq.value, col=in.(a,b)
      if (typeof val === 'object' && val !== null) {
        const [op, v] = Object.entries(val)[0];
        url.searchParams.set(col, `${op}.${v}`);
      } else {
        url.searchParams.set(col, `eq.${val}`);
      }
    }
    return url.toString();
  }
}

export class DbError extends Error {
  constructor(message, status) {
    super(message);
    this.name   = 'DbError';
    this.status = status;
  }
}
