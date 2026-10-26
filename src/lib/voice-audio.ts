// ── ORCH Voice Playback Engine ──────────────────────────────────
// Gapless, interruptible playback for streamed TTS audio.
//
// The sidecar emits an utterance as a sequence of chunks (one per
// sentence) so the first words start playing while the rest is still
// synthesizing. That only works if the renderer *schedules* chunks on a
// shared clock instead of firing each one immediately: the previous
// implementation created a new AudioContext per chunk and called
// start(0) on each, so chunks raced each other, speech came out
// overlapped and out of order, contexts leaked (browsers cap concurrent
// ones), and the 'speaking' → 'idle' transition fired on the first chunk
// to finish rather than the last.
//
// This engine keeps one AudioContext, maintains a playhead, and appends
// each chunk at the greater of (playhead, now). Interrupting stops every
// scheduled source and bumps a generation counter so late-arriving chunks
// from the abandoned utterance are dropped.

export interface VoiceAudioChunk {
  /** Utterance id — chunks of one utterance share it. */
  id: string;
  /** Monotonic index within the utterance; used to reject out-of-order arrivals. */
  seq?: number;
  /** Base64-encoded little-endian Float32 PCM. */
  data: string;
  /** Source sample rate. Kokoro emits 24 kHz. */
  sampleRate?: number;
  /** True on the last chunk of an utterance. */
  final?: boolean;
}

type PlaybackState = 'idle' | 'speaking';

const DEFAULT_SAMPLE_RATE = 24000;
/** Tiny lead-in so the first chunk isn't scheduled in the past. */
const SCHEDULE_LOOKAHEAD = 0.02;

function base64ToFloat32(b64: string): Float32Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // The byte length is guaranteed to be a multiple of 4 by the sender, but
  // a truncated transfer would otherwise produce a RangeError here.
  const usable = bytes.byteLength - (bytes.byteLength % 4);
  return new Float32Array(bytes.buffer, 0, usable / 4);
}

export class VoiceAudioPlayer {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  /** Desired output level, held independently of the audio graph.
   *
   *  The graph is built lazily on the first utterance, so setVolume() is
   *  almost always called BEFORE a gain node exists — settings are applied
   *  at mount, speech happens later. Storing it here and applying it in
   *  ensureContext() is what makes the control actually work; previously
   *  setVolume() no-oped on a null gain and the node was then created at
   *  the default 1.0, so the slider did nothing. */
  private volume = 1;

  /** Absolute AudioContext time at which the next chunk should start. */
  private playhead = 0;
  /** Sources still scheduled or playing, so interrupt() can stop them all. */
  private active = new Set<AudioBufferSourceNode>();
  /** Bumped on every interrupt; chunks tagged with an older generation are dropped. */
  private generation = 0;
  /** Utterance currently being played, for seq ordering. */
  private currentId: string | null = null;
  private lastSeq = -1;

  private state: PlaybackState = 'idle';

  /** Fired when playback starts and when the queue fully drains. */
  onStateChange: (state: PlaybackState) => void = () => {};

  private setState(next: PlaybackState) {
    if (this.state === next) return;
    this.state = next;
    this.onStateChange(next);
  }

  /** Create (or resume) the shared context. Must be called from a user
   *  gesture the first time, which push-to-talk already provides. */
  private ensureContext(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioContext();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.ctx.destination);
      this.playhead = 0;
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  /** Schedule one chunk at the end of the current queue. */
  enqueue(chunk: VoiceAudioChunk): void {
    if (!chunk.data) return;

    const gen = this.generation;
    const ctx = this.ensureContext();
    if (!this.gain) return;

    // New utterance — reset ordering state but keep the playhead so a
    // follow-up utterance doesn't clip the tail of the previous one.
    if (chunk.id !== this.currentId) {
      this.currentId = chunk.id;
      this.lastSeq = -1;
    }

    // Drop replays/out-of-order chunks. Chunks without a seq are always taken.
    if (typeof chunk.seq === 'number') {
      if (chunk.seq <= this.lastSeq) return;
      this.lastSeq = chunk.seq;
    }

    let pcm: Float32Array;
    try {
      pcm = base64ToFloat32(chunk.data);
    } catch (err) {
      console.warn('[VoiceAudio] Failed to decode chunk:', err);
      return;
    }
    if (pcm.length === 0) return;

    const rate = chunk.sampleRate || DEFAULT_SAMPLE_RATE;
    const buffer = ctx.createBuffer(1, pcm.length, rate);
    buffer.getChannelData(0).set(pcm);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);

    // Append to the queue: never schedule in the past, never leave a gap.
    const startAt = Math.max(this.playhead, ctx.currentTime + SCHEDULE_LOOKAHEAD);
    source.start(startAt);
    this.playhead = startAt + buffer.duration;

    this.active.add(source);
    this.setState('speaking');

    source.onended = () => {
      this.active.delete(source);
      // Only settle to idle when this generation's queue has fully drained —
      // an interrupt has already moved on and owns the state.
      if (gen === this.generation && this.active.size === 0) {
        this.currentId = null;
        this.lastSeq = -1;
        this.setState('idle');
      }
    };
  }

  /** Stop everything immediately and invalidate in-flight chunks. */
  interrupt(): void {
    this.generation++;
    for (const source of this.active) {
      try {
        source.onended = null;
        source.stop();
        source.disconnect();
      } catch { /* already stopped */ }
    }
    this.active.clear();
    this.currentId = null;
    this.lastSeq = -1;
    this.playhead = this.ctx ? this.ctx.currentTime : 0;
    this.setState('idle');
  }

  /** True while audio is scheduled or playing. */
  get isSpeaking(): boolean {
    return this.active.size > 0;
  }

  /** Seconds of audio still queued ahead of the clock. */
  get queuedSeconds(): number {
    if (!this.ctx) return 0;
    return Math.max(0, this.playhead - this.ctx.currentTime);
  }

  /** Set output level (0-1). Takes effect immediately on audio already
   *  playing, and persists for graphs created later. */
  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (!this.gain || !this.ctx) return;
    // Short ramp rather than an instant jump: setting gain.value directly
    // mid-playback produces an audible click.
    const now = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(this.gain.gain.value, now);
    this.gain.gain.linearRampToValueAtTime(this.volume, now + 0.03);
  }

  getVolume(): number {
    return this.volume;
  }

  /** Release the audio device. Safe to call repeatedly. */
  dispose(): void {
    this.interrupt();
    if (this.ctx && this.ctx.state !== 'closed') {
      void this.ctx.close();
    }
    this.ctx = null;
    this.gain = null;
  }
}

/** Process-wide player. TTS is inherently single-voiced, and a module
 *  singleton keeps the AudioContext count at one for the app's lifetime. */
export const voicePlayer = new VoiceAudioPlayer();
