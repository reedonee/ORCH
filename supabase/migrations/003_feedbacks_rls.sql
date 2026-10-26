-- ═══════════════════════════════════════════════════════════════════
-- ORCH — Lock down the feedbacks table
-- ═══════════════════════════════════════════════════════════════════
--
-- WHY THIS EXISTS
--
-- 002_grants.sql ran:
--     GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO anon;
--     ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon;
--
-- The tables in 001 all enable RLS, so those grants were survivable there.
-- But `feedbacks` was created afterwards by scripts/create-feedbacks-table.mjs,
-- which never enabled RLS — and the ALTER DEFAULT PRIVILEGES above meant it
-- inherited full anon access automatically.
--
-- The anon key ships inside every ORCH binary and is committed in
-- .env.production, so in practice anyone could read every user's bug
-- reports (titles, descriptions, workspace names in `system`), rewrite
-- them, or delete the table's contents.
--
-- This migration closes that, and removes the default-privileges landmine
-- so the next table created doesn't repeat the mistake.

-- ── 1. Enable RLS ────────────────────────────────────────────────
ALTER TABLE public.feedbacks ENABLE ROW LEVEL SECURITY;
-- Table owners bypass RLS by default; force it so no path skips the policies.
ALTER TABLE public.feedbacks FORCE ROW LEVEL SECURITY;

-- ── 2. Revoke the blanket anon grant ─────────────────────────────
REVOKE ALL PRIVILEGES ON public.feedbacks FROM anon;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM anon;

-- Stop future tables from being born world-open.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;

-- Authenticated users still need table-level privileges; RLS narrows
-- them to their own rows.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.feedbacks TO authenticated;

-- ── 3. Admin role ────────────────────────────────────────────────
-- Who may triage all feedback. Reading this table is itself restricted,
-- so a normal user cannot enumerate the admin list.
CREATE TABLE IF NOT EXISTS public.admin_users (
  user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now(),
  note       text
);

ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON public.admin_users FROM anon, authenticated;
GRANT SELECT ON public.admin_users TO authenticated;

CREATE POLICY "admins_read_self" ON public.admin_users
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- SECURITY DEFINER so the check can read admin_users regardless of the
-- caller's own row-level visibility. search_path is pinned to prevent a
-- caller from shadowing the table with one of their own.
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM public.admin_users WHERE user_id = auth.uid());
$$;

REVOKE ALL ON FUNCTION public.is_admin() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

-- ── 4. Policies ──────────────────────────────────────────────────
-- Authors see and manage their own reports; admins see everything.

DROP POLICY IF EXISTS "feedbacks_select_own_or_admin" ON public.feedbacks;
CREATE POLICY "feedbacks_select_own_or_admin" ON public.feedbacks
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.is_admin());

-- user_id is forced to the caller so a report can't be attributed to
-- someone else.
DROP POLICY IF EXISTS "feedbacks_insert_own" ON public.feedbacks;
CREATE POLICY "feedbacks_insert_own" ON public.feedbacks
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "feedbacks_update_own_or_admin" ON public.feedbacks;
CREATE POLICY "feedbacks_update_own_or_admin" ON public.feedbacks
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id OR public.is_admin())
  WITH CHECK (auth.uid() = user_id OR public.is_admin());

DROP POLICY IF EXISTS "feedbacks_delete_own_or_admin" ON public.feedbacks;
CREATE POLICY "feedbacks_delete_own_or_admin" ON public.feedbacks
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id OR public.is_admin());

-- ── 5. Ownership default ─────────────────────────────────────────
-- The client currently omits user_id on insert. Default it to the caller
-- so existing client code satisfies the INSERT policy unchanged.
ALTER TABLE public.feedbacks
  ALTER COLUMN user_id SET DEFAULT auth.uid();

-- ── 6. Grant yourself admin ──────────────────────────────────────
-- Run once, manually, with your own account id:
--
--   INSERT INTO public.admin_users (user_id, note)
--   SELECT id, 'founder' FROM auth.users WHERE email = 'you@example.com';
