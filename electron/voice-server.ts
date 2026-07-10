import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type VoiceState = 'idle' | 'loading' | 'listening' | 'processing' | 'speaking' | 'error';

export interface VoiceCallbacks {
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onAudio: (id: string, pcmBase64: string) => void;
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

  private readonly scriptPath: string;

  constructor() {
    // __dirname is always dist-electron/ (both dev and prod builds)
    // Python script sits at electron/voice-server.py
    const pyPath = path.join(__dirname, '../electron/voice-server.py');
    this.scriptPath = pyPath;
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

    // On Windows use 'python' (python3 isn't available)
    // On macOS/Linux try 'python3' first, fall back to 'python'
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    console.log('[VoiceServer] Spawning:', pythonCmd, this.scriptPath);
    this.process = spawn(pythonCmd, ['-u', this.scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.process.stdout?.on('data', (data: Buffer) => {
      this.buffer += data.toString();
      this.processLines();
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      console.error('[VoiceServer]', data.toString().trim());
    });

    this.process.on('exit', (code) => {
      console.log(`[VoiceServer] Process exited with code ${code}`);
      this.process = null;
      this.ready = false;
      this.setState('idle');
      this.callbacks?.onError(`Voice server exited (code ${code}) — check that all Python packages are installed`);
    });

    this.process.on('error', (err) => {
      console.error('[VoiceServer] Failed to spawn:', err.message);
      this.setState('error');
      this.callbacks?.onError(`Voice server failed: ${err.message}`);
    });

    // Model loading can take 45-60s on slower CPUs (distil-small.en ~166MB)
    // Use 120s timeout to avoid restart death spiral
    const timeout = setTimeout(() => {
      if (!this.ready) {
        console.warn('[VoiceServer] Timed out waiting for ready (120s), restarting...');
        this.stop();
        this.start();
      }
    }, 120000);
    this.process.on('exit', () => clearTimeout(timeout));
  }

  stop(): void {
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

  speak(id: string, text: string): void {
    this.writeLine({ event: 'speak', id, text });
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
    switch (msg.event) {
      case 'ready':
        this.ready = true;
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
        this.callbacks?.onAudio(msg.id, msg.data);
        break;

      case 'done':
        this.setState('idle');
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
