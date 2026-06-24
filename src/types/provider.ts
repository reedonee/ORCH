// Mirrors src-tauri/src/sidecar.rs::ProviderStatus

export type CommandSource = 'embedded-sidecar' | 'embedded-resource' | 'system-fallback';

export interface ProviderStatus {
  provider: string;
  display_name: string;
  available: boolean;
  source: CommandSource;
  version: string | null;
  path: string | null;
  error: string | null;
}

export interface ResolvedCommand {
  command: string;
  args: string[];
  source: CommandSource;
  resolved_path: string;
}
