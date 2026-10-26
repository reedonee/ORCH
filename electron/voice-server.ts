import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type VoiceState = 'idle' | 'loading' | 'listening' | 'processing' | 'speaking' | 'error';

/** One streamed span of synthesized speech. */
export interface VoiceAudioChunk {
  id: string;
  /** Index within the utterance; the renderer uses it to reject stale chunks. */
  seq: number;
  /** True on the final span, so the renderer knows the utterance is complete. */
  final: boolean;
  /** Source sample rate (Kokoro emits 24 kHz). */
  sampleRate: number;
  /** Base64 little-endian Float32 PCM. */
  data: string;
}

export interface VoiceCallbacks {
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onAudio: (chunk: VoiceAudioChunk) => void;
  onStateChange: (state: VoiceState) => void;
  onError: (msg: string) => void;
  onStatus: (msg: string) => void;
}

export class VoiceServer {
  private process: ChildProcess | null = null;
  private callbacks: VoiceCallbacks | null = null;
  private state: VoiceState = 'idle';
  private buffer = '';
  private audioQueue: Array<{ id: string; pcm: string }> = [];
  private isSpeaking = false;
  private ready = false;
  private stderrTail = '';
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private restarts = 0;

  private readonly scriptPath: string;
  private readonly pythonPath: string;

  constructor() {
    this.scriptPath = VoiceServer.resolveScript();
    this.pythonPath = VoiceServer.resolvePython();
    console.log('[VoiceServer] Interpreter:', this.pythonPath);
    console.log('[VoiceServer] Script:', this.scriptPath);
  }

  /** Locate voice-server.py in dev and in a packaged install.
   *
   *  In dev, __dirname is dist-electron/ and the script sits beside it in
   *  electron/. When packaged, dist-electron/ is inside app.asar — which
   *  cannot be read by a spawned Python process — so the script ships as an
   *  extraResource under process.resourcesPath instead. Packaged builds
   *  previously shipped no copy at all, so voice worked in dev and silently
   *  failed for every installed user. */
  private static resolveScript(): string {
    const candidates = [
      path.join(__dirname, '../electron/voice-server.py'),
      path.join(process.resourcesPath ?? '', 'electron', 'voice-server.py'),
    ];
    for (const c of candidates) {
      if (c && fs.existsSync(c)) return c;
    }
    return candidates[0];
  }

  /**
   * Pick an interpreter that actually has the voice dependencies.
   *
   * Spawning a bare `python` takes whatever is first on PATH, which on a
   * developer machine is frequently some other tool's virtualenv — here it
   * resolved to hermes-agent's venv, which has neither numpy nor pip, so
   * the sidecar died on import every launch. Prefer, in order:
   *   1. ORCH_PYTHON, for an explicit override
   *   2. the project's own .venv-voice
   *   3. a generic .venv in the project
   *   4. the platform default, as a last resort
   */
  private static resolvePython(): string {
    const override = process.env['ORCH_PYTHON'];
    if (override && fs.existsSync(override)) return override;

    const projectRoot = path.join(__dirname, '..');
    const binDir = process.platform === 'win32' ? 'Scripts' : 'bin';
    const exe = process.platform === 'win32' ? 'python.exe' : 'python';

    for (const venv of ['.venv-voice', '.venv']) {
      const candidate = path.join(projectRoot, venv, binDir, exe);
      if (fs.existsSync(candidate)) return candidate;
    }

    return process.platform === 'win32' ? 'python' : 'python3';
  }

  setCallbacks(cb: VoiceCallbacks): void {
    this.callbacks = cb;
  }

  getState(): VoiceState {
    return this.state;
  }

  isReady(): boolean {
    return this.ready;
  }

  start(): void {
    if (this.process) return;
    this.setState('loading');

    console.log('[VoiceServer] Spawning:', this.pythonPath, this.scriptPath);
    this.process = spawn(this.pythonPath, ['-u', this.scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.process.stdout?.on('data', (data: Buffer) => {
      this.buffer += data.toString();
      this.processLines();
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      // Keep a bounded tail so exit handling can explain *why* it died.
      this.stderrTail = `${this.stderrTail}\n${text}`.slice(-2000);
      // stderr is where HuggingFace writes model-download progress, so it
      // is proof of life just as much as a stdout event is.
      if (!this.ready) this.armWatchdog();
      console.error('[VoiceServer]', text);
    });

    this.process.on('exit', (code) => {
      console.log(`[VoiceServer] Process exited with code ${code}`);
      this.process = null;
      this.ready = false;
      this.setState('idle');

      // A missing package is by far the most common failure and the raw
      // traceback tells the user nothing actionable, so name the package
      // and the exact command that fixes it.
      const missing = /No module named '([^']+)'/.exec(this.stderrTail);
      if (missing) {
        this.callbacks?.onError(
          `Voice server can't start: Python package '${missing[1]}' is missing. ` +
          `Run: uv pip install -r electron/requirements-voice.txt`,
        );
        return;
      }
      this.callbacks?.onError(`Voice server exited (code ${code}) — check that all Python packages are installed`);
    });

    this.process.on('error', (err) => {
      console.error('[VoiceServer] Failed to spawn:', err.message);
      this.setState('error');
      this.callbacks?.onError(`Voice server failed: ${err.message}`);
    });

    // Watchdog for a genuinely hung sidecar.
    //
    // A fixed deadline is wrong here: first run downloads ~600 MB of STT
    // and TTS models, which can easily exceed any fixed timeout on a slow
    // link. The old 120s timer fired mid-download and restarted the
    // process, which restarted the download — a death spiral that could
    // never converge.
    //
    // Instead, treat *silence* as the failure signal. Any line from the
    // sidecar (including download progress) proves it is alive and resets
    // the clock; only a genuinely mute process gets restarted.
    this.armWatchdog();
    this.process.on('exit', () => this.clearWatchdog());
  }

  /** (Re)start the silence watchdog. */
  private armWatchdog(): void {
    this.clearWatchdog();
    // Generous: model loading is genuinely slow, and a false restart is
    // far more damaging than a slow start.
    this.watchdog = setTimeout(() => {
      if (this.ready) return;
      if (this.restarts >= 2) {
        console.error('[VoiceServer] Silent after 3 attempts — giving up');
        this.callbacks?.onError('Voice server is not responding. Check the ORCH logs for Python errors.');
        this.stop();
        return;
      }
      this.restarts++;
      console.warn(`[VoiceServer] No output for 180s — restarting (attempt ${this.restarts})`);
      this.stop();
      this.start();
    }, 180000);
    this.watchdog.unref?.();
  }

  private clearWatchdog(): void {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }

  stop(): void {
    this.clearWatchdog();
    if (this.process) {
      try {
        this.process.stdin?.end();
        this.process.kill();
      } catch { /* already dead */ }
      this.process = null;
    }
    this.ready = false;
    this.setState('idle');
  }

  sendAudio(pcmBase64: string): void {
    this.writeLine({ event: 'audio', data: pcmBase64 });
  }

  stopListening(): void {
    this.writeLine({ event: 'stop' });
  }

  speak(id: string, text: string, opts?: { voice?: string; speed?: number }): void {
    this.writeLine({ event: 'speak', id, text, voice: opts?.voice, speed: opts?.speed });
  }

  /** Set the default TTS voice and rate for subsequent utterances. */
  configure(opts: { voice?: string; speed?: number }): void {
    this.writeLine({ event: 'config', ...opts });
  }

  /** Slot 1: play a cached ack phrase immediately (<150ms). */
  speakAck(id: string = 'ack', phrase?: string): void {
    const p = phrase || this.pickAckPhrase();
    this.writeLine({ event: 'ack', id, phrase: p });
  }

  private ackIndex = 0;
  private ackPhrases = ['On it', 'Got it', 'Checking', 'Sure', 'Working'];

  private pickAckPhrase(): string {
    const p = this.ackPhrases[this.ackIndex % this.ackPhrases.length];
    this.ackIndex++;
    return p;
  }

  interrupt(): void {
    this.writeLine({ event: 'interrupt' });
    this.isSpeaking = false;
  }

  private writeLine(obj: Record<string, any>): void {
    if (!this.process?.stdin?.writable) {
      console.warn('[VoiceServer] writeLine skipped — stdin not writable');
      return;
    }
    try {
      const line = JSON.stringify(obj) + '\n';
      this.process.stdin.write(line);
    } catch (e) {
      console.warn('[VoiceServer] writeLine error:', e);
    }
  }

  private setState(s: VoiceState): void {
    if (this.state !== s) {
      this.state = s;
      this.callbacks?.onStateChange(s);
    }
  }

  private processLines(): void {
    while (this.buffer.includes('\n')) {
      const idx = this.buffer.indexOf('\n');
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;

      try {
        const msg = JSON.parse(line);
        this.handleMessage(msg);
      } catch { /* non-JSON line, skip */ }
    }
  }

  private handleMessage(msg: any): void {
    // Proof of life — restart the silence watchdog on every message.
    if (!this.ready) this.armWatchdog();

    switch (msg.event) {
      case 'ready':
        this.ready = true;
        this.restarts = 0;
        this.clearWatchdog();
        this.setState('idle');
        break;

      case 'status':
        this.callbacks?.onStatus(msg.data);
        break;

      case 'partial':
        this.callbacks?.onPartial(msg.data);
        break;

      case 'final':
        this.setState('processing');
        this.callbacks?.onFinal(msg.data);
        break;

      case 'audio':
        this.isSpeaking = true;
        this.setState('speaking');
        this.callbacks?.onAudio({
          id: msg.id,
          seq: typeof msg.seq === 'number' ? msg.seq : 0,
          final: Boolean(msg.final),
          sampleRate: typeof msg.sampleRate === 'number' ? msg.sampleRate : 24000,
          data: msg.data,
        });
        break;

      case 'done':
        // Synthesis finished. Playback may still be draining in the
        // renderer's scheduler, so it owns the speaking → idle transition.
        this.isSpeaking = false;
        break;

      case 'interrupted':
        this.isSpeaking = false;
        this.setState('idle');
        break;

      case 'tts_ready':
        this.callbacks?.onStatus('TTS ready');
        break;

      case 'error':
        console.error('[VoiceServer] Error:', msg.data);
        this.callbacks?.onError(msg.data);
        break;

      case 'pong':
        break;
    }
  }
}
