// ── Supabase Database Service ─────────────────────────────────────
// CRUD operations for all ORCH tables. All queries are scoped via RLS
// to the authenticated user. Callers should check auth before invoking.

import { supabase, isSupabaseConfigured } from './supabase';
import type { WorkspaceFile } from '../types/workspace';

// ── Guard ─────────────────────────────────────────────────────────
function db() {
  if (!supabase) throw new Error('Supabase not configured');
  return supabase;
}

// ── Current user helper ───────────────────────────────────────────
async function currentUserId(): Promise<string> {
  const { data: { user }, error } = await db().auth.getUser();
  if (error || !user) throw new Error('Not authenticated');
  return user.id;
}

// ── Device ID (stable per machine) ────────────────────────────────
function getDeviceId(): string {
  let id = localStorage.getItem('orch_device_id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('orch_device_id', id);
  }
  return id;
}

// ═════════════════════════════════════════════════════════════════
// WORKSPACES
// ═════════════════════════════════════════════════════════════════

export interface WorkspaceRow {
  id: string;
  name: string;
  canvas_data: WorkspaceFile;
  style: Record<string, any>;
  version: number;
  last_opened: string;
  updated_at: string;
}

/** Upsert a workspace. Returns the new/existing id. */
export async function upsertWorkspace(
  workspace: {
    id?: string;
    name: string;
    canvas_data: WorkspaceFile;
    style: Record<string, any>;
    last_opened?: string;
  },
): Promise<{ id: string; version: number }> {
  const now = new Date().toISOString();
  const payload: Record<string, any> = {
    name: workspace.name,
    canvas_data: workspace.canvas_data,
    style: workspace.style,
    updated_at: now,
  };
  if (workspace.last_opened) payload.last_opened = workspace.last_opened;

  if (workspace.id) {
    // Optimistic concurrency: client sends expected version
    const current = workspace.canvas_data as any;
    const expectedVersion = current._version ?? 0;
    payload.version = expectedVersion + 1;

    const { data, error } = await db()
      .from('workspaces')
      .update(payload)
      .eq('id', workspace.id)
      .eq('version', expectedVersion)
      .select('id, version')
      .single();

    if (error) throw error;
    if (!data) throw new Error('Version conflict — workspace was modified elsewhere');
    return { id: data.id, version: data.version };
  } else {
    // New workspace
    const uid = await currentUserId();
    payload.user_id = uid;
    payload.version = 1;
    const { data, error } = await db()
      .from('workspaces')
      .insert(payload)
      .select('id, version')
      .single();

    if (error) throw error;
    return { id: data!.id, version: data!.version };
  }
}

/** List all non-deleted workspaces for the current user. */
export async function listWorkspaces(): Promise<WorkspaceRow[]> {
  const { data, error } = await db()
    .from('workspaces')
    .select('*')
    .eq('is_deleted', false)
    .order('last_opened', { ascending: false });

  if (error) throw error;
  return (data || []) as WorkspaceRow[];
}

/** Get a single workspace by id. */
export async function getWorkspace(id: string): Promise<WorkspaceRow | null> {
  const { data, error } = await db()
    .from('workspaces')
    .select('*')
    .eq('id', id)
    .eq('is_deleted', false)
    .single();

  if (error && error.code === 'PGRST116') return null; // not found
  if (error) throw error;
  return data as WorkspaceRow;
}

/** Soft-delete a workspace. */
export async function deleteWorkspace(id: string): Promise<void> {
  const { error } = await db()
    .from('workspaces')
    .update({ is_deleted: true, deleted_at: new Date().toISOString() })
    .eq('id', id);

  if (error) throw error;
}

/** Sync the local folder path for a workspace on this device. */
export async function upsertDevicePath(
  workspaceId: string,
  localPath: string,
): Promise<void> {
  const uid = await currentUserId();
  const { error } = await db()
    .from('workspace_device_paths')
    .upsert({
      user_id: uid,
      workspace_id: workspaceId,
      device_id: getDeviceId(),
      local_path: localPath,
      last_synced_at: new Date().toISOString(),
    }, { onConflict: 'workspace_id, device_id' });

  if (error) throw error;
}

/** Get the local path for a workspace on this device. */
export async function getDevicePath(workspaceId: string): Promise<string | null> {
  const { data, error } = await db()
    .from('workspace_device_paths')
    .select('local_path')
    .eq('workspace_id', workspaceId)
    .eq('device_id', getDeviceId())
    .single();

  if (error && error.code === 'PGRST116') return null;
  if (error) throw error;
  return data?.local_path ?? null;
}

// ═════════════════════════════════════════════════════════════════
// USER PREFERENCES
// ═════════════════════════════════════════════════════════════════

export interface UserPreferences {
  theme: string;
  show_grid: boolean;
  grid_snap: boolean;
  terminal_font_size: number;
  default_provider: string;
  cloud_agents: boolean;
  provider_modes: Record<string, string>;
  audio_input_device: string;
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  theme: 'hologram',
  show_grid: false,
  grid_snap: true,
  terminal_font_size: 13,
  default_provider: 'hermes',
  cloud_agents: false,
  provider_modes: {},
  audio_input_device: '',
};

/** Fetch user preferences. Returns defaults if none stored. */
export async function getUserPreferences(): Promise<UserPreferences> {
  const { data, error } = await db()
    .from('user_preferences')
    .select('*')
    .single();

  if (error && error.code === 'PGRST116') return { ...DEFAULT_PREFERENCES };
  if (error) throw error;
  if (!data) return { ...DEFAULT_PREFERENCES };

  return {
    theme: data.theme ?? DEFAULT_PREFERENCES.theme,
    show_grid: data.show_grid ?? DEFAULT_PREFERENCES.show_grid,
    grid_snap: data.grid_snap ?? DEFAULT_PREFERENCES.grid_snap,
    terminal_font_size: data.terminal_font_size ?? DEFAULT_PREFERENCES.terminal_font_size,
    default_provider: data.default_provider ?? DEFAULT_PREFERENCES.default_provider,
    cloud_agents: data.cloud_agents ?? DEFAULT_PREFERENCES.cloud_agents,
    provider_modes: data.provider_modes ?? DEFAULT_PREFERENCES.provider_modes,
    audio_input_device: data.audio_input_device ?? DEFAULT_PREFERENCES.audio_input_device,
  };
}

/** Save user preferences. */
export async function saveUserPreferences(prefs: Partial<UserPreferences>): Promise<void> {
  const uid = await currentUserId();
  const { error } = await db()
    .from('user_preferences')
    .upsert({
      user_id: uid,
      ...prefs,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });

  if (error) throw error;
}

// ═════════════════════════════════════════════════════════════════
// PROVIDER CONFIGS
// ═════════════════════════════════════════════════════════════════

export interface ProviderConfigRow {
  id?: string;
  provider_id: string;
  name: string;
  command?: string;
  args?: string[];
  provider_type: string;
  env_key?: string;
  api_key?: string;
  api_endpoint?: string;
  launch_mode: string;
  sort_order: number;
}

/** List all provider configs for the user. */
export async function listProviderConfigs(): Promise<ProviderConfigRow[]> {
  const { data, error } = await db()
    .from('provider_configs')
    .select('*')
    .order('sort_order', { ascending: true });

  if (error) throw error;
  return (data || []) as ProviderConfigRow[];
}

/** Upsert a provider config. */
export async function upsertProviderConfig(config: ProviderConfigRow): Promise<void> {
  const uid = await currentUserId();
  const { error } = await db()
    .from('provider_configs')
    .upsert({
      user_id: uid,
      ...config,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id, provider_id' });

  if (error) throw error;
}

/** Delete a provider config. */
export async function deleteProviderConfig(providerId: string): Promise<void> {
  const { error } = await db()
    .from('provider_configs')
    .delete()
    .eq('provider_id', providerId);

  if (error) throw error;
}

// ═════════════════════════════════════════════════════════════════
// VPS CONNECTIONS
// ═════════════════════════════════════════════════════════════════

export interface VpsConnectionRow {
  id?: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_type: string;
  ssh_key?: string;
}

/** List VPS connections. */
export async function listVpsConnections(): Promise<VpsConnectionRow[]> {
  const { data, error } = await db()
    .from('vps_connections')
    .select('*')
    .order('name');

  if (error) throw error;
  return (data || []) as VpsConnectionRow[];
}

/** Upsert a VPS connection. */
export async function upsertVpsConnection(conn: VpsConnectionRow): Promise<void> {
  const uid = await currentUserId();
  const { error } = await db()
    .from('vps_connections')
    .upsert({
      user_id: uid,
      ...conn,
      updated_at: new Date().toISOString(),
    });

  if (error) throw error;
}

/** Delete a VPS connection. */
export async function deleteVpsConnection(id: string): Promise<void> {
  const { error } = await db()
    .from('vps_connections')
    .delete()
    .eq('id', id);

  if (error) throw error;
}

// ═════════════════════════════════════════════════════════════════
// MCP SERVERS
// ═════════════════════════════════════════════════════════════════

export interface McpServerRow {
  id?: string;
  name: string;
  server_type: string;
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
}

/** List MCP servers. */
export async function listMcpServers(): Promise<McpServerRow[]> {
  const { data, error } = await db()
    .from('mcp_servers')
    .select('*')
    .order('name');

  if (error) throw error;
  return (data || []) as McpServerRow[];
}

/** Upsert an MCP server. */
export async function upsertMcpServer(server: McpServerRow): Promise<void> {
  const uid = await currentUserId();
  const { error } = await db()
    .from('mcp_servers')
    .upsert({
      user_id: uid,
      ...server,
      updated_at: new Date().toISOString(),
    });

  if (error) throw error;
}

/** Delete an MCP server. */
export async function deleteMcpServer(id: string): Promise<void> {
  const { error } = await db()
    .from('mcp_servers')
    .delete()
    .eq('id', id);

  if (error) throw error;
}

/** Check if Supabase is configured and the user is authenticated. */
export function isCloudReady(): boolean {
  return isSupabaseConfigured();
}
