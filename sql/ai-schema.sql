-- VND Enhanced — AI Image Generator schema
-- Run AFTER the base schema (sql/schema.sql)

-- Ensure the shared trigger helper exists (idempotent)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Monthly generation allocation per user (tokens_total = generation limit, tokens_used = generations consumed)
CREATE TABLE IF NOT EXISTS vnd_ai_tokens (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES vnd_users(id) ON DELETE CASCADE,
  tokens_total  INTEGER NOT NULL DEFAULT 0,  -- generation limit (basic=20, premium=50)
  tokens_used   INTEGER NOT NULL DEFAULT 0,  -- generations consumed this cycle
  renewal_date  TIMESTAMPTZ,
  last_reset_at TIMESTAMPTZ DEFAULT now(),
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id)
);

-- Generation history (metadata only — no image blobs)
CREATE TABLE IF NOT EXISTS vnd_ai_history (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES vnd_users(id) ON DELETE CASCADE,
  prompt      TEXT NOT NULL,
  preset_id   TEXT,
  model       TEXT NOT NULL DEFAULT 'dall-e-3',
  size        TEXT NOT NULL DEFAULT '1024x1024',
  quality     TEXT NOT NULL DEFAULT 'standard',
  image_count INTEGER NOT NULL DEFAULT 1,
  token_cost  INTEGER NOT NULL DEFAULT 1,  -- always 1 generation per call
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vnd_ai_history_user_date
  ON vnd_ai_history(user_id, created_at DESC);

-- updated_at trigger for ai_tokens
CREATE TRIGGER vnd_ai_tokens_updated_at
  BEFORE UPDATE ON vnd_ai_tokens
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS: service role only (same pattern as base tables)
ALTER TABLE vnd_ai_tokens  ENABLE ROW LEVEL SECURITY;
ALTER TABLE vnd_ai_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_ai_tokens"
  ON vnd_ai_tokens USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_ai_history"
  ON vnd_ai_history USING (true) WITH CHECK (true);
