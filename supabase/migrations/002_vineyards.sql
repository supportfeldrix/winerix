-- ============================================================
-- WINERIX — Vineyards, Blocks & Operations + Row Level Security
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 001_profiles.sql (auth.users, public.update_updated_at())
-- ============================================================

-- ------------------------------------------------------------
-- VINEYARDS
-- Top-level estate/property owned by an authenticated user.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.vineyards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  location TEXT,
  area_hectares NUMERIC(10, 2),
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vineyards_owner_id ON public.vineyards(owner_id);

-- ------------------------------------------------------------
-- BLOCKS
-- Sub-divisions of a vineyard (planting blocks / parcels).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vineyard_id UUID NOT NULL REFERENCES public.vineyards(id) ON DELETE CASCADE,
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  area_hectares NUMERIC(10, 2),
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_blocks_vineyard_id ON public.blocks(vineyard_id);
CREATE INDEX IF NOT EXISTS idx_blocks_owner_id ON public.blocks(owner_id);

-- ------------------------------------------------------------
-- OPERATIONS
-- Field tasks/work carried out on a vineyard (and optionally a block).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vineyard_id UUID NOT NULL REFERENCES public.vineyards(id) ON DELETE CASCADE,
  block_id UUID REFERENCES public.blocks(id) ON DELETE SET NULL,
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_operations_vineyard_id ON public.operations(vineyard_id);
CREATE INDEX IF NOT EXISTS idx_operations_owner_id ON public.operations(owner_id);
CREATE INDEX IF NOT EXISTS idx_operations_status ON public.operations(status);

-- ============================================================
-- ROW LEVEL SECURITY
-- Every row is scoped to its owner (auth.uid() = owner_id).
-- ============================================================

-- ---- Vineyards ---------------------------------------------
ALTER TABLE public.vineyards ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own vineyards"
  ON public.vineyards FOR SELECT
  USING (auth.uid() = owner_id);

CREATE POLICY "Users can insert own vineyards"
  ON public.vineyards FOR INSERT
  WITH CHECK (auth.uid() = owner_id);

CREATE POLICY "Users can update own vineyards"
  ON public.vineyards FOR UPDATE
  USING (auth.uid() = owner_id)
  WITH CHECK (auth.uid() = owner_id);

CREATE POLICY "Users can delete own vineyards"
  ON public.vineyards FOR DELETE
  USING (auth.uid() = owner_id);

-- ---- Blocks ------------------------------------------------
ALTER TABLE public.blocks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own blocks"
  ON public.blocks FOR SELECT
  USING (auth.uid() = owner_id);

CREATE POLICY "Users can insert own blocks"
  ON public.blocks FOR INSERT
  WITH CHECK (auth.uid() = owner_id);

CREATE POLICY "Users can update own blocks"
  ON public.blocks FOR UPDATE
  USING (auth.uid() = owner_id)
  WITH CHECK (auth.uid() = owner_id);

CREATE POLICY "Users can delete own blocks"
  ON public.blocks FOR DELETE
  USING (auth.uid() = owner_id);

-- ---- Operations --------------------------------------------
ALTER TABLE public.operations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own operations"
  ON public.operations FOR SELECT
  USING (auth.uid() = owner_id);

CREATE POLICY "Users can insert own operations"
  ON public.operations FOR INSERT
  WITH CHECK (auth.uid() = owner_id);

CREATE POLICY "Users can update own operations"
  ON public.operations FOR UPDATE
  USING (auth.uid() = owner_id)
  WITH CHECK (auth.uid() = owner_id);

CREATE POLICY "Users can delete own operations"
  ON public.operations FOR DELETE
  USING (auth.uid() = owner_id);

-- ============================================================
-- updated_at triggers (reuses public.update_updated_at from 001)
-- ============================================================
DROP TRIGGER IF EXISTS vineyards_updated_at ON public.vineyards;
CREATE TRIGGER vineyards_updated_at
  BEFORE UPDATE ON public.vineyards
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS blocks_updated_at ON public.blocks;
CREATE TRIGGER blocks_updated_at
  BEFORE UPDATE ON public.blocks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS operations_updated_at ON public.operations;
CREATE TRIGGER operations_updated_at
  BEFORE UPDATE ON public.operations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
