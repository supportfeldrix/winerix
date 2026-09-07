-- ============================================================
-- WINERIX — Phase 1 remaining modules: harvest, machinery, finance, planner
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 001_profiles.sql (auth.users, public.update_updated_at())
--             002_vineyards.sql (vineyards, blocks)
-- ============================================================

-- ------------------------------------------------------------
-- HARVEST
-- Harvest records against a vineyard (and optionally a block).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.harvest (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vineyard_id UUID NOT NULL REFERENCES public.vineyards(id) ON DELETE CASCADE,
  block_id UUID REFERENCES public.blocks(id) ON DELETE SET NULL,
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',
  harvest_date DATE,
  yield_tons NUMERIC(12, 2),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_harvest_vineyard_id ON public.harvest(vineyard_id);
CREATE INDEX IF NOT EXISTS idx_harvest_block_id ON public.harvest(block_id);
CREATE INDEX IF NOT EXISTS idx_harvest_owner_id ON public.harvest(owner_id);
CREATE INDEX IF NOT EXISTS idx_harvest_status ON public.harvest(status);

ALTER TABLE public.harvest ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own harvest"
  ON public.harvest FOR SELECT USING (auth.uid() = owner_id);
CREATE POLICY "Users can insert own harvest"
  ON public.harvest FOR INSERT WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "Users can update own harvest"
  ON public.harvest FOR UPDATE USING (auth.uid() = owner_id) WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "Users can delete own harvest"
  ON public.harvest FOR DELETE USING (auth.uid() = owner_id);

DROP TRIGGER IF EXISTS harvest_updated_at ON public.harvest;
CREATE TRIGGER harvest_updated_at
  BEFORE UPDATE ON public.harvest
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ------------------------------------------------------------
-- MACHINERY
-- Equipment owned by the user. Optionally linked to a vineyard.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.machinery (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vineyard_id UUID REFERENCES public.vineyards(id) ON DELETE SET NULL,
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT,
  registration TEXT,
  status TEXT NOT NULL DEFAULT 'operational',
  last_service_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_machinery_vineyard_id ON public.machinery(vineyard_id);
CREATE INDEX IF NOT EXISTS idx_machinery_owner_id ON public.machinery(owner_id);
CREATE INDEX IF NOT EXISTS idx_machinery_status ON public.machinery(status);

ALTER TABLE public.machinery ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own machinery"
  ON public.machinery FOR SELECT USING (auth.uid() = owner_id);
CREATE POLICY "Users can insert own machinery"
  ON public.machinery FOR INSERT WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "Users can update own machinery"
  ON public.machinery FOR UPDATE USING (auth.uid() = owner_id) WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "Users can delete own machinery"
  ON public.machinery FOR DELETE USING (auth.uid() = owner_id);

DROP TRIGGER IF EXISTS machinery_updated_at ON public.machinery;
CREATE TRIGGER machinery_updated_at
  BEFORE UPDATE ON public.machinery
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ------------------------------------------------------------
-- FINANCE
-- Income / expense records. Optionally linked to a vineyard/block.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.finance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vineyard_id UUID REFERENCES public.vineyards(id) ON DELETE SET NULL,
  block_id UUID REFERENCES public.blocks(id) ON DELETE SET NULL,
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'expense',    -- 'income' | 'expense'
  category TEXT,
  amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  entry_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_finance_vineyard_id ON public.finance(vineyard_id);
CREATE INDEX IF NOT EXISTS idx_finance_owner_id ON public.finance(owner_id);
CREATE INDEX IF NOT EXISTS idx_finance_type ON public.finance(type);
CREATE INDEX IF NOT EXISTS idx_finance_entry_date ON public.finance(entry_date);

ALTER TABLE public.finance ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own finance"
  ON public.finance FOR SELECT USING (auth.uid() = owner_id);
CREATE POLICY "Users can insert own finance"
  ON public.finance FOR INSERT WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "Users can update own finance"
  ON public.finance FOR UPDATE USING (auth.uid() = owner_id) WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "Users can delete own finance"
  ON public.finance FOR DELETE USING (auth.uid() = owner_id);

DROP TRIGGER IF EXISTS finance_updated_at ON public.finance;
CREATE TRIGGER finance_updated_at
  BEFORE UPDATE ON public.finance
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ------------------------------------------------------------
-- PLANNER
-- Planned tasks/activities. Optionally linked to a vineyard/block.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.planner (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vineyard_id UUID REFERENCES public.vineyards(id) ON DELETE SET NULL,
  block_id UUID REFERENCES public.blocks(id) ON DELETE SET NULL,
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  due_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_planner_vineyard_id ON public.planner(vineyard_id);
CREATE INDEX IF NOT EXISTS idx_planner_owner_id ON public.planner(owner_id);
CREATE INDEX IF NOT EXISTS idx_planner_status ON public.planner(status);
CREATE INDEX IF NOT EXISTS idx_planner_due_date ON public.planner(due_date);

ALTER TABLE public.planner ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own planner"
  ON public.planner FOR SELECT USING (auth.uid() = owner_id);
CREATE POLICY "Users can insert own planner"
  ON public.planner FOR INSERT WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "Users can update own planner"
  ON public.planner FOR UPDATE USING (auth.uid() = owner_id) WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "Users can delete own planner"
  ON public.planner FOR DELETE USING (auth.uid() = owner_id);

DROP TRIGGER IF EXISTS planner_updated_at ON public.planner;
CREATE TRIGGER planner_updated_at
  BEFORE UPDATE ON public.planner
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
