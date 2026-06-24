import { useState, useEffect, useRef, useCallback } from 'react';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useAppStore } from '../stores/useAppStore';
import {
  voiceIsReady, voiceSendAudio, voiceStopListening, voiceStartListening,
  voiceSpeak, voiceSpeakAck, voiceInterrupt, onVoicePartial, onVoiceFinal, onVoiceAudio, onVoiceState, onVoiceError, onVoiceStatus,
} from '../lib/electron-api';
import { vpsClient } from '../lib/vps-client';
import { executeVoiceAction } from '../lib/voice-actions';
import { parseVoiceCommand } from '../lib/voice-parser';
import { executeAppCommand } from '../lib/agent-commands';
import { isTranscriptValid, pcmFramesToWavBlob, transcribeWithGroq } from '../lib/groq-stt';

export type VoiceState = 'idle' | 'loading' | 'listening' | 'processing' | 'speaking' | 'error';

export interface UseVoiceInputOptions {
  /** Called when a final transcript is ready */
  onTranscript: (text: string) => void;
  /** Push-to-talk key code (default: 'e') */
  pttKey?: string;
}

export function useVoiceInput({ onTranscript }: UseVoiceInputOptions) {
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [partialText, setPartialText] = useState('');
  const [waveform, setWaveform] = useState<number[]>([]);
  const [ready, setReady] = useState(false);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);

  // Stable ref for onTranscript — prevents effects from re-running on every render
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const capturingRef = useRef(false); // guards against double-start
  const warmSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const warmTapRef = useRef<GainNode | null>(null);
  const warmWorkletRef = useRef<AudioWorkletNode | null>(null);

  // ── Groq fallback PCM buffer ─────────────────────────────────
  // Accumulates ALL raw Float32 frames from the AudioWorklet during
  // a single capture session. Cleared on stop. Used by the Groq
  // fallback to assemble a WAV blob when local STT fails.
  const groqBufferRef = useRef<Float32Array[]>([]);
  // ── Batch timer ref — so stopCapture can clear it ─────────────────
  const batchTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // ── Smoothed frequency bands for voice-reactive bars ───────────────
  const smoothedBands = useRef<number[]>([0, 0, 0, 0]);

  // ── Pre-emptive WAV Blob ──────────────────────────────────────
  // Assembled from groqBufferRef at capture end so it's ready the
  // instant Groq fallback is needed — no assembly latency on the
  // critical path.
  const prebuiltWavRef = useRef<Blob | null>(null);

  // ── Barge-in monitor ──────────────────────────────────────────
  // A lightweight energy monitor on the mic that runs even during TTS playback.
  // If the user speaks while the system is talking, we interrupt.
  const bargeInRef = useRef<{
    ctx: AudioContext | null;
    analyser: AnalyserNode | null;
    stream: MediaStream | null;
    rafId: number;
    consecutiveSpeech: number;
  }>({ ctx: null, analyser: null, stream: null, rafId: 0, consecutiveSpeech: 0 });
  const BARGE_THRESHOLD = 0.08;  // RMS energy threshold for barge-in
  const BARGE_CONSECUTIVE = 6;   // frames above threshold to trigger (≈100ms)

  // Keep a running barge-in monitor — start when we first get mic access
  const startBargeMonitor = useCallback(async () => {
    if (bargeInRef.current.ctx) return; // already running
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true },
      });
      const ctx = new AudioContext({ sampleRate: 16000 });
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      bargeInRef.current = { ctx, analyser, stream, rafId: 0, consecutiveSpeech: 0 };
    } catch { /* barge-in silently disabled if mic fails */ }
  }, []);

  // Stop the barge-in monitor (called on unmount)
  const stopBargeMonitor = useCallback(() => {
    const b = bargeInRef.current;
    if (b.rafId) cancelAnimationFrame(b.rafId);
    if (b.ctx) b.ctx.close();
    if (b.stream) b.stream.getTracks().forEach(t => t.stop());
    bargeInRef.current = { ctx: null, analyser: null, stream: null, rafId: 0, consecutiveSpeech: 0 };
  }, []);

  // Check if voice server is ready
  useEffect(() => {
    let cancelled = false;
    const startListening = async () => {
      const ok = await voiceIsReady();
      if (cancelled) return;
      setReady(ok);
      if (ok) {
        console.log('[Voice] Server ready, calling voiceStartListening()');
        try { await voiceStartListening(); } catch (e) {
          console.warn('[Voice] startListening failed:', e);
        }
        console.log('[Voice] voiceStartListening() completed');
      }
    };
    // Check immediately AND poll every 2s — both must call voiceStartListening()
    startListening();
    const id = setInterval(startListening, 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // ── Listen for voice events from main process ──────────────
  useEffect(() => {
    const unsubs: (() => void)[] = [];

    unsubs.push(onVoicePartial((text) => {
      // Partial transcript updates as user speaks — useful for
      // early visual feedback. The final transcript fires separately.
      if (text) setPartialText(text);
    }));

    unsubs.push(onVoiceFinal(async (text) => {
      console.log('[Voice] onVoiceFinal FIRED with:', JSON.stringify(text));
      setPartialText(text);
      setVoiceState('processing');

      const rawTranscript = text || '';

      // ── Groq STT Fallback ───────────────────────────────────────
      let transcript = rawTranscript;
      if (!isTranscriptValid(rawTranscript)) {
        const settings = useSettingsStore.getState();
        const groqKey = settings.groqApiKey?.trim();
        if (groqKey && settings.enableGroqOnSTTFailure) {
          console.log('[Voice] Local STT invalid, trying Groq fallback…');
          const wavBlob = prebuiltWavRef.current;
          if (wavBlob) {
            const result = await transcribeWithGroq(wavBlob, groqKey);
            if (result.success && result.text) {
              console.log('[Voice] Groq fallback succeeded:', result.text);
              transcript = result.text;
            } else {
              console.warn('[Voice] Groq fallback failed:', result.error);
              transcript = rawTranscript;
            }
          }
        }
      }

      // If the result is completely empty after all attempts, stop
      if (!transcript.trim()) {
        setVoiceState('idle');
        return;
      }

      // ── LOCAL NLU: Parse transcript into a command and execute ──
      const command = parseVoiceCommand(transcript);
      const cmdResult = await executeAppCommand(command);

      // Log what happened
      console.log('[Voice] Command executed:', command.kind, cmdResult.message);

      // ── Say feedback (canned response for voice command results) ─
      const feedback = cmdResult.ok
        ? cmdResult.message
        : `Hmm, ${cmdResult.message.toLowerCase()}`;

      // ── VPS Brain (enhancement — optional, non-blocking) ──────
      // Fire-and-forget: if VPS is available it can enhance the response
      // or execute advanced actions. If it fails, we already have feedback.
      const corrected = transcript;
      (async () => {
        try {
          const { agents } = useAppStore.getState();
          const context = agents.length > 0
            ? `Agents on canvas: ${agents.map(a => `${a.name} (${a.role})`).join(', ')}`
            : '';
          const brainResult = await vpsClient.processVoice(corrected, context);
          if (brainResult.action) {
            const actionResult = await executeVoiceAction(brainResult.action);
            console.log('[Voice] VPS action executed:', actionResult);
          }
          speak(brainResult.response);
        } catch {
          // VPS unreachable — use local feedback
          speak(feedback);
        }
      })();

      // ── STT Correction (fire-and-forget, improves next time) ───
      (async () => {
        try {
          const sttResult = await vpsClient.correctStt(transcript);
          if (sttResult.corrected && sttResult.corrected !== transcript) {
            console.log('[Voice] STT corrected:', transcript, '→', sttResult.corrected);
          }
        } catch {
          // correction is optional
        }
      })();
    }));

    unsubs.push(onVoiceAudio(({ data }) => {
      // Play raw f32 PCM from Kokoro (no WAV header — use createBuffer directly)
      if (!data) return;
      try {
        const binary = atob(data);
        const pcm = new Float32Array(binary.length / 4);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const view = new DataView(bytes.buffer);
        for (let i = 0; i < pcm.length; i++) pcm[i] = view.getFloat32(i * 4, true); // little-endian f32

        const audioCtx = new AudioContext();
        const buffer = audioCtx.createBuffer(1, pcm.length, 24000); // Kokoro outputs at 24kHz
        buffer.getChannelData(0).set(pcm);

        const source = audioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(audioCtx.destination);
        source.start(0);
        setVoiceState('speaking');
        source.onended = () => {
          audioCtx.close();
          setVoiceState('idle');
        };
      } catch (err) {
        console.error('[Voice] Audio playback error:', err);
        setVoiceState('idle');
      }
    }));

    unsubs.push(onVoiceState((state) => {
      setVoiceState(state as VoiceState);
    }));

    unsubs.push(onVoiceError((_msg) => {
      setVoiceState('error');
    }));

    unsubs.push(onVoiceStatus((msg) => {
      console.log('[Voice] Status:', msg);
      // Keep voice state as 'loading' if server is still starting up
      setPartialText(msg);
    }));

    return () => unsubs.forEach((u) => u());
  }, []);  // empty deps — onTranscript accessed via ref

  // ── Start mic capture (raw PCM via AudioWorklet) ────────
  const startCapture = useCallback(async () => {
    // Prevent double-start while previous capture is still settling
    if (capturingRef.current) return;
    capturingRef.current = true;
    // Clear any stale Groq buffer from previous capture
    groqBufferRef.current = [];
    try {
      const settings = useSettingsStore.getState();
      const instantStart = settings.instantStart;
      const deviceId = settings.audioInputDeviceId;
      const audioConstraints: MediaTrackConstraints = {
        sampleRate: 16000, channelCount: 1, echoCancellation: true,
      };
      if (deviceId) {
        audioConstraints.deviceId = { exact: deviceId };
      }
      let stream: MediaStream;
      if (instantStart && streamRef.current && streamRef.current.active) {
        stream = streamRef.current;
      } else {
        stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      }
      // Bail if stopCapture was called during the await
      if (!capturingRef.current) {
        if (!instantStart) stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;

      let audioCtx = audioCtxRef.current;
      if (!audioCtx || audioCtx.state === 'closed') {
        audioCtx = new AudioContext({ sampleRate: 16000 });
        audioCtxRef.current = audioCtx;
      } else if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }
      const source = audioCtx.createMediaStreamSource(stream);
      warmSourceRef.current = source;

      // AnalyserNode for waveform visualization
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;
      const tap = audioCtx.createGain();
      tap.gain.value = 0.005;
      analyser.connect(tap);
      tap.connect(audioCtx.destination);
      warmTapRef.current = tap;

      const bufferLen = analyser.frequencyBinCount;

      // rAF loop for 4-band voice-reactive waveform
      const ATTACK = 0.35;   // fast rise
      const RELEASE = 0.08;  // slow decay — smooth fall
      const readAnalyser = () => {
        if (!analyserRef.current) return;
        const data = new Uint8Array(bufferLen);
        analyserRef.current.getByteFrequencyData(data);

        // Split FFT bins into 4 frequency bands
        const bandCount = 4;
        const bandSize = Math.floor(bufferLen / bandCount);
        const rawBands = new Array(bandCount).fill(0);
        for (let b = 0; b < bandCount; b++) {
          let sum = 0;
          const start = b * bandSize;
          const end = b === bandCount - 1 ? bufferLen : start + bandSize;
          const count = end - start;
          for (let i = start; i < end; i++) sum += data[i];
          rawBands[b] = sum / count / 255;
        }

        // Envelope follower — per-band smoothing
        const smoothed = smoothedBands.current;
        for (let i = 0; i < bandCount; i++) {
          const raw = rawBands[i];
          smoothed[i] += raw > smoothed[i]
            ? (raw - smoothed[i]) * ATTACK
            : (raw - smoothed[i]) * RELEASE;
        }

        setWaveform([...smoothed]);
        requestAnimationFrame(readAnalyser);
      };
      requestAnimationFrame(readAnalyser);

      // AudioWorklet for raw PCM capture — streams f32 samples directly
      const workletCode = `
        try {
          class PCMCapture extends AudioWorkletProcessor {
            constructor() { super(); }
            process(inputs) {
              const input = inputs[0];
              if (input && input[0] && input[0].length > 0) {
                this.port.postMessage(input[0]);
              }
              return true;
            }
          }
          registerProcessor('pcm-capture', PCMCapture);
        } catch (e) {
          // Already registered on HMR re-mount — ignore
        }
      `;
      const blob = new Blob([workletCode], { type: 'application/javascript' });
      const workletUrl = URL.createObjectURL(blob);
      await audioCtx.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);

      // Bail if context was closed while we were awaiting addModule (e.g. quick PTT release)
      if (audioCtx.state === 'closed' || !capturingRef.current) {
        warmSourceRef.current?.disconnect();
        warmTapRef.current?.disconnect();
        warmWorkletRef.current?.disconnect();
        warmSourceRef.current = null;
        warmTapRef.current = null;
        warmWorkletRef.current = null;
        if (!instantStart) {
          stream.getTracks().forEach((t) => t.stop());
          if (audioCtx.state !== 'closed') audioCtx.close();
        } else {
          try { await audioCtx.suspend(); } catch {}
        }
        return;
      }

      const workletNode = new AudioWorkletNode(audioCtx, 'pcm-capture');
      source.connect(workletNode);
      warmWorkletRef.current = workletNode;

      // Batch PCM chunks to reduce IPC overhead — send every ~50ms
      let pcmBuffer: number[] = [];
      let batchTimer: ReturnType<typeof setInterval> | null = null;

      workletNode.port.onmessage = (e: MessageEvent) => {
        const pcm = e.data as Float32Array;
        pcmBuffer.push(...Array.from(pcm));

        // Also accumulate to the Groq fallback buffer (full session copy)
        groqBufferRef.current.push(new Float32Array(pcm));

        if (!batchTimerRef.current) {
          batchTimerRef.current = setInterval(() => {
            if (pcmBuffer.length === 0) return;
            const combined = new Float32Array(pcmBuffer);
            pcmBuffer = [];
            // Efficient base64: use native btoa on a typed array approach
            const view = new Uint8Array(combined.buffer);
            // Use chunked binary string to avoid stack overflow on large arrays
            let b64 = '';
            const chunkSize = 8192;
            for (let i = 0; i < view.length; i += chunkSize) {
              const end = Math.min(i + chunkSize, view.length);
              let binary = '';
              for (let j = i; j < end; j++) binary += String.fromCharCode(view[j]);
              b64 += btoa(binary);
            }
            voiceSendAudio(b64);
          }, 50); // 50ms frames ≈ ~800 samples @ 16kHz
        }
      };

      setVoiceState('listening');
      setPartialText('');
      // Enumerate audio devices after first mic access (needs permission)
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        setAudioDevices(devices.filter((d) => d.kind === 'audioinput'));
      } catch { /* enumeration not critical */ }
    } catch (err) {
      console.error('[Voice] Mic start failed:', err);
      setVoiceState('error');
      capturingRef.current = false;
    }
  }, []);

  // AudioWorklet + Parakeet fallback (slower but fully offline)
  // const startParakeetCapture = async () => {
  //   // ... existing AudioWorklet code
  // };

  // ── Stop mic capture ───────────────────────────────────────
  const stopCapture = useCallback(async () => {
    capturingRef.current = false;
    setVoiceState('processing');

    // Pre-assemble WAV blob for Groq fallback while local Whisper runs
    // This eliminates ~20ms of assembly latency from the Groq path.
    const chunks = groqBufferRef.current;
    if (chunks.length > 0) {
      let totalLen = 0;
      for (const c of chunks) totalLen += c.length;
      const combined = new Float32Array(totalLen);
      let offset = 0;
      for (const c of chunks) {
        combined.set(c, offset);
        offset += c.length;
      }
      prebuiltWavRef.current = pcmFramesToWavBlob(combined);
    } else {
      prebuiltWavRef.current = null;
    }

    // Finalize audio on the sidecar (raw PCM already streamed)
    await voiceStopListening();

    // ── Stop the batch PCM timer ─────────────────────────────────
    if (batchTimerRef.current) {
      clearInterval(batchTimerRef.current);
      batchTimerRef.current = null;
    }

    // Disconnect worklet from source before suspending
    if (warmWorkletRef.current) {
      try { warmWorkletRef.current.disconnect(); } catch {}
      warmWorkletRef.current = null;
    }
    if (warmSourceRef.current) {
      try { warmSourceRef.current.disconnect(); } catch {}
      // Keep warmSourceRef.current alive — we reconnect on next capture
    }
    if (warmTapRef.current) {
      try { warmTapRef.current.disconnect(); } catch {}
    }
    if (analyserRef.current) {
      try { analyserRef.current.disconnect(); } catch {}
      analyserRef.current = null;
    }

    // Clean up resources
    const instantStart = useSettingsStore.getState().instantStart;
    if (audioCtxRef.current) {
      if (instantStart) {
        try { await audioCtxRef.current.suspend(); } catch {}
      } else {
        await audioCtxRef.current.close();
        audioCtxRef.current = null;
      }
    }
    if (!instantStart && streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setWaveform([]);
  }, []);
  // ── Speak via VPS cloud TTS (with local fallback) ─────────
  const speak = useCallback(async (text: string) => {
    if (!text.trim()) { setVoiceState('idle'); return; }
    setVoiceState('speaking');
    startBargeMonitor();
    try {
      const { audio: b64, sample_rate } = await vpsClient.speak(text);
      if (!b64) { setVoiceState('idle'); return; }
      const binary = atob(b64);
      const pcm = new Float32Array(binary.length / 4);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const view = new DataView(bytes.buffer);
      for (let i = 0; i < pcm.length; i++) pcm[i] = view.getFloat32(i * 4, true);

      const audioCtx = new AudioContext();
      const buffer = audioCtx.createBuffer(1, pcm.length, sample_rate || 24000);
      buffer.getChannelData(0).set(pcm);
      const source = audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(audioCtx.destination);
      source.start(0);
      source.onended = () => { audioCtx.close(); setVoiceState('idle'); };
    } catch (err) {
      console.warn('[Voice] Cloud TTS failed, trying local:', err);
      // Fallback to local TTS
      await voiceSpeak('response', text);
      setVoiceState('idle');
    }
  }, [startBargeMonitor]);

  // ── Slot 1 ack: cached instant TTS ─────────────────────────
  const playAck = useCallback((phrase?: string) => {
    voiceSpeakAck('ack', phrase);
  }, []);

  // ── Interrupt ───────────────────────────────────────────────
  const interrupt = useCallback(async () => {
    await voiceInterrupt();
    setVoiceState('idle');
  }, []);

  // ── Processing safety timeout ──────────────────────────────
  // If voiceState stays on 'processing' for >15s, force idle
  // (catches cases where voice_final event never fires or hangs;
  //  on slow CPUs local STT can take several seconds)
  useEffect(() => {
    if (voiceState !== 'processing') return;
    const id = setTimeout(() => {
      console.warn('[Voice] Processing timeout — forcing idle');
      setVoiceState('idle');
    }, 15000);
    return () => clearTimeout(id);
  }, [voiceState]);

  // ── Barge-in: detect user speech during TTS ─────────────────
  useEffect(() => {
    let rafId = 0;
    const b = bargeInRef.current;
    if (!b.analyser) return;

    const check = () => {
      if (voiceState !== 'speaking') {
        b.consecutiveSpeech = 0;
        rafId = requestAnimationFrame(check);
        return;
      }
      const data = new Uint8Array(b.analyser!.frequencyBinCount);
      b.analyser!.getByteTimeDomainData(data);
      let sumSq = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / data.length);
      if (rms > BARGE_THRESHOLD) {
        b.consecutiveSpeech++;
        if (b.consecutiveSpeech >= BARGE_CONSECUTIVE) {
          // User is speaking while TTS is playing — barge in!
          console.log('[Voice] Barge-in triggered');
          b.consecutiveSpeech = 0;
          interrupt();
          // Immediately restart capture
          startCapture();
        }
      } else {
        b.consecutiveSpeech = 0;
      }
      rafId = requestAnimationFrame(check);
    };
    rafId = requestAnimationFrame(check);
    return () => cancelAnimationFrame(rafId);
  }, [voiceState, interrupt, startCapture]);

  // ── Cleanup ─────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (audioCtxRef.current) audioCtxRef.current.close();
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
      stopBargeMonitor();
    };
  }, [stopBargeMonitor]);

  return {
    voiceState,
    partialText,
    waveform,
    ready,
    audioDevices,
    startCapture,
    stopCapture,
    speak,
    playAck,
    interrupt,
    setPartialText,
  };
}
