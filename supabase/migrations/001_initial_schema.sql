-- ═══════════════════════════════════════════════════════════════════
-- ORCH Database Schema — Enterprise v1
-- Atmospheric Fusion architecture
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. workspaces ─────────────────────────────────────────────────
-- Single JSONB column keeps 1:1 parity with .orch-workspace.json.
-- version column enables optimistic concurrency for parallel agent writes.
-- Soft deletion for accidental-delete recovery buffer.
CREATE TABLE workspaces (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name        text NOT NULL,
  canvas_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  style       jsonb DEFAULT '{}'::jsonb,
  version     integer DEFAULT 1,
  is_deleted  boolean DEFAULT false,
  deleted_at  timestamptz,
  last_opened timestamptz DEFAULT now(),
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

-- ── 2. workspace_device_paths ─────────────────────────────────────
-- Decouples local filesystem paths from the workspace row so the same
-- workspace can map to different absolute paths on different machines.
CREATE TABLE workspace_device_paths (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid REFERENCES workspaces(id) ON DELETE CASCADE NOT NULL,
  user_id       uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  device_id     text NOT NULL,
  local_path    text NOT NULL,
  last_synced_at timestamptz DEFAULT now(),
  UNIQUE(workspace_id, device_id)
);

-- ── 3. user_preferences ──────────────────────────────────────────
CREATE TABLE user_preferences (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE NOT NULL,
  theme               text DEFAULT 'hologram',
  show_grid           boolean DEFAULT false,
  grid_snap           boolean DEFAULT true,
  terminal_font_size  integer DEFAULT 13,
  default_provider    text DEFAULT 'hermes',
  cloud_agents        boolean DEFAULT false,
  provider_modes      jsonb DEFAULT '{}'::jsonb,
  audio_input_device  text DEFAULT '',
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);

-- ── 4. provider_configs ──────────────────────────────────────────
-- API keys stored via pgcrypto / Supabase Vault for encryption at rest.
CREATE TABLE provider_configs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  provider_id     text NOT NULL,
  name            text NOT NULL,
  command         text,
  args            jsonb DEFAULT '[]'::jsonb,
  provider_type   text DEFAULT 'builtin',
  env_key         text,
  api_key         text,
  api_endpoint    text,
  launch_mode     text DEFAULT 'embedded',
  sort_order      integer DEFAULT 0,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now(),
  UNIQUE(user_id, provider_id)
);

-- ── 5. vps_connections ───────────────────────────────────────────
CREATE TABLE vps_connections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name            text NOT NULL,
  host            text NOT NULL,
  port            integer DEFAULT 22,
  username        text DEFAULT 'ubuntu',
  auth_type       text DEFAULT 'key',
  ssh_key         text,
  last_connected  timestamptz,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

-- ── 6. mcp_servers ───────────────────────────────────────────────
CREATE TABLE mcp_servers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name          text NOT NULL,
  server_type   text NOT NULL,
  command       text,
  args          jsonb DEFAULT '[]'::jsonb,
  url           text,
  enabled       boolean DEFAULT true,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);


-- ═══════════════════════════════════════════════════════════════════
-- ROW-LEVEL SECURITY
-- Every table locked to auth.uid() — users only see/change their own.
-- ═══════════════════════════════════════════════════════════════════

-- ── workspaces ───────────────────────────────────────────────────
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workspaces_select_own" ON workspaces
  FOR SELECT USING (auth.uid() = user_id AND is_deleted = false);

CREATE POLICY "workspaces_insert_own" ON workspaces
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "workspaces_update_own" ON workspaces
  FOR UPDATE USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Soft-delete uses UPDATE, not DELETE
CREATE POLICY "workspaces_soft_delete_own" ON workspaces
  FOR UPDATE USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ── workspace_device_paths ───────────────────────────────────────
ALTER TABLE workspace_device_paths ENABLE ROW LEVEL SECURITY;

CREATE POLICY "device_paths_select_own" ON workspace_device_paths
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "device_paths_insert_own" ON workspace_device_paths
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "device_paths_update_own" ON workspace_device_paths
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "device_paths_delete_own" ON workspace_device_paths
  FOR DELETE USING (auth.uid() = user_id);

-- ── user_preferences ─────────────────────────────────────────────
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "prefs_select_own" ON user_preferences
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "prefs_insert_own" ON user_preferences
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "prefs_update_own" ON user_preferences
  FOR UPDATE USING (auth.uid() = user_id);

-- ── provider_configs ─────────────────────────────────────────────
ALTER TABLE provider_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "providers_select_own" ON provider_configs
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "providers_insert_own" ON provider_configs
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "providers_update_own" ON provider_configs
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "providers_delete_own" ON provider_configs
  FOR DELETE USING (auth.uid() = user_id);

-- ── vps_connections ──────────────────────────────────────────────
ALTER TABLE vps_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "vps_select_own" ON vps_connections
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "vps_insert_own" ON vps_connections
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "vps_update_own" ON vps_connections
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "vps_delete_own" ON vps_connections
  FOR DELETE USING (auth.uid() = user_id);

-- ── mcp_servers ──────────────────────────────────────────────────
ALTER TABLE mcp_servers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "mcp_select_own" ON mcp_servers
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "mcp_insert_own" ON mcp_servers
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "mcp_update_own" ON mcp_servers
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "mcp_delete_own" ON mcp_servers
  FOR DELETE USING (auth.uid() = user_id);


-- ═══════════════════════════════════════════════════════════════════
-- INDEXES
-- ═══════════════════════════════════════════════════════════════════

CREATE INDEX idx_workspaces_user_id ON workspaces(user_id);
CREATE INDEX idx_workspaces_deleted ON workspaces(user_id, is_deleted) WHERE is_deleted = false;
CREATE INDEX idx_workspaces_last_opened ON workspaces(user_id, last_opened DESC);
CREATE INDEX idx_device_paths_workspace ON workspace_device_paths(workspace_id);
CREATE INDEX idx_device_paths_device ON workspace_device_paths(device_id);
CREATE INDEX idx_providers_user ON provider_configs(user_id);
CREATE INDEX idx_vps_user ON vps_connections(user_id);
CREATE INDEX idx_mcp_user ON mcp_servers(user_id);
