-- ============================================================
-- WINERIX — Irrigation + Row Level Security
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 001_profiles.sql (auth.users, public.update_updated_at())
--             002_vineyards.sql (vineyards, blocks)
-- ============================================================

-- ------------------------------------------------------------
-- IRRIGATION
-- Watering activities recorded against a vineyard (and optionally a block).
-- Mirrors the structure of public.operations.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.irrigation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vineyard_id UUID NOT NULL REFERENCES public.vineyards(id) ON DELETE CASCADE,
  block_id UUID REFERENCES public.blocks(id) ON DELETE SET NULL,
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_irrigation_vineyard_id ON public.irrigation(vineyard_id);
CREATE INDEX IF NOT EXISTS idx_irrigation_block_id ON public.irrigation(block_id);
CREATE INDEX IF NOT EXISTS idx_irrigation_owner_id ON public.irrigation(owner_id);
CREATE INDEX IF NOT EXISTS idx_irrigation_status ON public.irrigation(status);

-- ============================================================
-- ROW LEVEL SECURITY
-- Every row is scoped to its owner (auth.uid() = owner_id).
-- ============================================================
ALTER TABLE public.irrigation ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own irrigation"
  ON public.irrigation FOR SELECT
  USING (auth.uid() = owner_id);

CREATE POLICY "Users can insert own irrigation"
  ON public.irrigation FOR INSERT
  WITH CHECK (auth.uid() = owner_id);

CREATE POLICY "Users can update own irrigation"
  ON public.irrigation FOR UPDATE
  USING (auth.uid() = owner_id)
  WITH CHECK (auth.uid() = owner_id);

CREATE POLICY "Users can delete own irrigation"
  ON public.irrigation FOR DELETE
  USING (auth.uid() = owner_id);

-- ============================================================
-- updated_at trigger (reuses public.update_updated_at from 001)
-- ============================================================
DROP TRIGGER IF EXISTS irrigation_updated_at ON public.irrigation;
CREATE TRIGGER irrigation_updated_at
  BEFORE UPDATE ON public.irrigation
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
