// Checks for the TTS playback scheduler, with a stubbed Web Audio API.
//
// The regression this exists to catch: setVolume() used to no-op when the
// gain node did not exist yet. Settings are applied at mount, but the
// audio graph is built lazily on the first utterance — so the slider was
// ALWAYS called before the graph existed, and the node was then created
// at the default 1.0. The control appeared wired and did nothing.

// ── Minimal Web Audio stub ──────────────────────────────────────
class FakeParam {
  value = 1;
  ramps: Array<{ to: number; at: number }> = [];
  cancelScheduledValues() {}
  setValueAtTime(v: number) { this.value = v; }
  linearRampToValueAtTime(v: number, at: number) { this.ramps.push({ to: v, at }); this.value = v; }
}
class FakeGain {
  gain = new FakeParam();
  connect() {}
}
class FakeSource {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  started: number | null = null;
  connect() {}
  start(at: number) { this.started = at; }
  stop() {}
  disconnect() {}
}
class FakeBuffer {
  duration: number;
  private data: Float32Array;
  constructor(len: number, rate: number) { this.duration = len / rate; this.data = new Float32Array(len); }
  getChannelData() { return this.data; }
}
class FakeAudioContext {
  state = 'running';
  currentTime = 0;
  gains: FakeGain[] = [];
  sources: FakeSource[] = [];
  createGain() { const g = new FakeGain(); this.gains.push(g); return g; }
  createBuffer(_ch: number, len: number, rate: number) { return new FakeBuffer(len, rate); }
  createBufferSource() { const s = new FakeSource(); this.sources.push(s); return s; }
  resume() {}
  close() { this.state = 'closed'; }
  get destination() { return {}; }
}

const contexts: FakeAudioContext[] = [];
(globalThis as Record<string, unknown>).AudioContext = function () {
  const c = new FakeAudioContext();
  contexts.push(c);
  return c;
} as unknown as typeof AudioContext;

(globalThis as Record<string, unknown>).atob = (b64: string) =>
  Buffer.from(b64, 'base64').toString('binary');

const { VoiceAudioPlayer } = await import('../src/lib/voice-audio.ts');

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  if (got === want) pass++; else { fail++; console.log(`FAIL ${l}\n  got:  ${got}\n  want: ${want}`); }
};
const ok = (l: string, c: boolean) => { if (c) pass++; else { fail++; console.log(`FAIL ${l}`); } };

/** 4 float32 samples as base64 — enough to schedule. */
const pcm = Buffer.alloc(16).toString('base64');

// ── The regression ──────────────────────────────────────────────
{
  contexts.length = 0;
  const p = new VoiceAudioPlayer();
  // Volume set BEFORE any audio exists — the real-world ordering.
  p.setVolume(0.3);
  eq('volume retained before graph exists', p.getVolume(), 0.3);

  p.enqueue({ id: 'u1', seq: 0, data: pcm, sampleRate: 24000 });
  const ctx = contexts[contexts.length - 1];
  eq('gain node created with the stored volume', ctx.gains[0].gain.value, 0.3);
}

// ── Live change while speaking ──────────────────────────────────
{
  contexts.length = 0;
  const p = new VoiceAudioPlayer();
  p.enqueue({ id: 'u1', seq: 0, data: pcm, sampleRate: 24000 });
  const ctx = contexts[contexts.length - 1];
  eq('defaults to full volume', ctx.gains[0].gain.value, 1);

  p.setVolume(0.5);
  eq('applies to audio already playing', ctx.gains[0].gain.value, 0.5);
  ok('ramps rather than jumping (avoids a click)', ctx.gains[0].gain.ramps.length === 1);
}

// ── Clamping ────────────────────────────────────────────────────
{
  const p = new VoiceAudioPlayer();
  p.setVolume(5);   eq('clamps above 1', p.getVolume(), 1);
  p.setVolume(-2);  eq('clamps below 0', p.getVolume(), 0);
  p.setVolume(0);   eq('mute is representable', p.getVolume(), 0);
}

// ── Volume survives a disposed context ──────────────────────────
{
  contexts.length = 0;
  const p = new VoiceAudioPlayer();
  p.setVolume(0.25);
  p.enqueue({ id: 'a', seq: 0, data: pcm, sampleRate: 24000 });
  p.dispose();
  p.enqueue({ id: 'b', seq: 0, data: pcm, sampleRate: 24000 });
  const ctx = contexts[contexts.length - 1];
  eq('rebuilt graph keeps the volume', ctx.gains[0].gain.value, 0.25);
}

// ── Scheduling still gapless and ordered ────────────────────────
{
  contexts.length = 0;
  const p = new VoiceAudioPlayer();
  p.enqueue({ id: 'u', seq: 0, data: pcm, sampleRate: 24000 });
  p.enqueue({ id: 'u', seq: 1, data: pcm, sampleRate: 24000 });
  const ctx = contexts[contexts.length - 1];
  eq('both chunks scheduled', ctx.sources.length, 2);
  ok('second starts after the first', (ctx.sources[1].started ?? 0) > (ctx.sources[0].started ?? 0));

  // Out-of-order / replayed chunks are dropped.
  p.enqueue({ id: 'u', seq: 1, data: pcm, sampleRate: 24000 });
  eq('stale seq rejected', ctx.sources.length, 2);
}

console.log(`\nvoice-audio pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
