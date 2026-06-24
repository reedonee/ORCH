-- ═══════════════════════════════════════════════════════════════════
-- ORCH — Grant table privileges (comprehensive)
-- Covers existing tables + default privileges for future tables.
-- ═══════════════════════════════════════════════════════════════════

-- Schema usage
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Existing tables
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;

-- Future tables (created after this migration)
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
