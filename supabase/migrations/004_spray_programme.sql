-- ============================================================
-- WINERIX — Spray Programme + Row Level Security
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 001_profiles.sql (auth.users, public.update_updated_at())
--             002_vineyards.sql (vineyards, blocks)
-- ============================================================

-- ------------------------------------------------------------
-- SPRAY_PROGRAMME
-- Spray programme activities recorded against a vineyard (and optionally a
-- block). Mirrors the structure of public.operations / public.irrigation.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.spray_programme (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vineyard_id UUID NOT NULL REFERENCES public.vineyards(id) ON DELETE CASCADE,
  block_id UUID REFERENCES public.blocks(id) ON DELETE SET NULL,
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_spray_programme_vineyard_id ON public.spray_programme(vineyard_id);
CREATE INDEX IF NOT EXISTS idx_spray_programme_block_id ON public.spray_programme(block_id);
CREATE INDEX IF NOT EXISTS idx_spray_programme_owner_id ON public.spray_programme(owner_id);
CREATE INDEX IF NOT EXISTS idx_spray_programme_status ON public.spray_programme(status);

-- ============================================================
-- ROW LEVEL SECURITY
-- Every row is scoped to its owner (auth.uid() = owner_id).
-- ============================================================
ALTER TABLE public.spray_programme ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own spray programme"
  ON public.spray_programme FOR SELECT
  USING (auth.uid() = owner_id);

CREATE POLICY "Users can insert own spray programme"
  ON public.spray_programme FOR INSERT
  WITH CHECK (auth.uid() = owner_id);

CREATE POLICY "Users can update own spray programme"
  ON public.spray_programme FOR UPDATE
  USING (auth.uid() = owner_id)
  WITH CHECK (auth.uid() = owner_id);

CREATE POLICY "Users can delete own spray programme"
  ON public.spray_programme FOR DELETE
  USING (auth.uid() = owner_id);

-- ============================================================
-- updated_at trigger (reuses public.update_updated_at from 001)
-- ============================================================
DROP TRIGGER IF EXISTS spray_programme_updated_at ON public.spray_programme;
CREATE TRIGGER spray_programme_updated_at
  BEFORE UPDATE ON public.spray_programme
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
