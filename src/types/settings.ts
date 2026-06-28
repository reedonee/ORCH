/** Provider/CLI that an agent terminal can run */
export interface AgentProvider {
  id: string;
  name: string;
  command: string;
  args: string[];
  type: 'builtin' | 'custom';
  shell?: boolean;
  envKey?: string;
  autoInstall?: boolean;
  description?: string;
  launchMode?: 'embedded' | 'external';
  cwdMode?: 'inherit' | 'project';
}

export interface ApiKey {
  provider: string;
  key: string;
  endpoint?: string;
}

export interface McpConfig {
  id: string;
  name: string;
  type: 'stdio' | 'sse' | 'websocket';
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
}

export interface Settings {
  apiKeys: ApiKey[];
  mcpServers: McpConfig[];
  providers: AgentProvider[];
  customProviders: AgentProvider[];
  defaultProvider: string;
  terminalFontSize: number;
  hibernationEnabled: boolean;
  cloudAgents: boolean;
  gridSnap: boolean;
  showGrid: boolean;
  audioInputDeviceId: string;  // '' = system default
  /** Groq API key for premium STT fallback (whisper-large-v3-turbo) */
  groqApiKey: string;
  /** When local Whisper returns empty/gibberish, retry with Groq */
  enableGroqOnSTTFailure: boolean;
  instantStart: boolean;
  /** User-configurable keyboard shortcuts: actionId → key combo string */
  shortcuts: Record<string, string>;
  /** Push-to-talk key combo (e.g. 'Ctrl+E') */
  pttKey: string;
  /** Admin passkey flag — gates Feedback Inbox tab in ForgeNode */
  isAdmin: boolean;
}

export const BUILTIN_PROVIDERS: AgentProvider[] = [
  {
    id: 'hermes',
    name: 'Hermes',
    command: 'hermes',
    args: [],
    type: 'builtin',
    shell: false,
    envKey: 'anthropic',
    launchMode: 'embedded',
    cwdMode: 'project',
    description: 'Hermes Agent CLI — multi-agent orchestration',
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    command: 'claude',
    args: ['--dangerously-skip-permissions'],
    type: 'builtin',
    shell: false,
    envKey: 'anthropic',
    launchMode: 'embedded',
    cwdMode: 'project',
    description: 'Anthropic Claude Code TUI in-terminal',
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    command: 'npx',
    args: ['-y', '@openai/codex'],
    type: 'builtin',
    shell: false,
    envKey: 'openai',
    autoInstall: true,
    launchMode: 'embedded',
    cwdMode: 'project',
    description: 'OpenAI Codex CLI with npx fallback',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    args: [],
    type: 'builtin',
    shell: false,
    launchMode: 'embedded',
    cwdMode: 'project',
    description: 'OpenCode TUI in-terminal',
  },
  {
    id: 'cursor',
    name: 'Cursor CLI',
    command: 'cursor',
    args: ['.'],
    type: 'builtin',
    shell: false,
    launchMode: 'external',
    cwdMode: 'project',
    description: 'Launches the Cursor app in the ORCH project folder',
  },
  {
    id: 'antigravity',
    name: 'Antigravity CLI',
    command: 'antigravity',
    args: ['.'],
    type: 'builtin',
    shell: false,
    envKey: 'google',
    launchMode: 'external',
    cwdMode: 'project',
    description: 'Launches Antigravity in the ORCH project folder',
  },
  {
    id: 'cmd',
    name: 'CMD Prompt',
    command: 'cmd.exe',
    args: ['/Q', '/K', 'cd /d C:\\Users\\hp\\Desktop\\red\\create\\"ORCH (electron)"'],
    type: 'builtin',
    shell: true,
    launchMode: 'embedded',
    cwdMode: 'project',
    description: 'Persistent Windows command prompt in the ORCH (Electron) project',
  },
  {
    id: 'powershell',
    name: 'PowerShell',
    command: 'powershell.exe',
    args: ['-NoLogo', '-NoExit', '-Command', "Set-Location -LiteralPath 'C:\\Users\\hp\\Desktop\\red\\create\\ORCH (electron)'"],
    type: 'builtin',
    shell: true,
    launchMode: 'embedded',
    cwdMode: 'project',
    description: 'Persistent PowerShell in the ORCH (Electron) project',
  },
  {
    id: 'bash',
    name: 'Git Bash',
    command: 'C:\\Program Files\\Git\\bin\\bash.exe',
    args: ['--login', '-i'],
    type: 'builtin',
    shell: true,
    launchMode: 'embedded',
    cwdMode: 'project',
    description: 'Persistent Git Bash terminal in the ORCH (Electron) project',
  },
  {
    id: 'wsl',
    name: 'WSL (Ubuntu)',
    command: 'wsl.exe',
    args: ['--cd', '/mnt/c/Users/hp/Desktop/red/create/ORCH (electron)'],
    type: 'builtin',
    shell: true,
    launchMode: 'embedded',
    cwdMode: 'project',
    description: 'Persistent WSL shell in the ORCH (Electron) project',
  },
];

export const DEFAULT_SETTINGS: Settings = {
  apiKeys: [],
  mcpServers: [],
  providers: BUILTIN_PROVIDERS,
  customProviders: [],
  defaultProvider: 'hermes',
  terminalFontSize: 13,
  hibernationEnabled: false,
  cloudAgents: false,
  gridSnap: true,
  showGrid: false,
  audioInputDeviceId: '',
  groqApiKey: '',
  enableGroqOnSTTFailure: false,
  instantStart: false,
  shortcuts: {
    'toggle-browser': 'Ctrl+Shift+B',
    'toggle-music': 'Ctrl+Shift+M',
    'toggle-feedback': 'Ctrl+Shift+F',
    'toggle-forge': 'Ctrl+Shift+G',
  },
  pttKey: 'Ctrl+E',
  isAdmin: false,
};
