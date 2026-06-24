"""
ORCH Voice Server — Streaming VAD + Whisper + TTS
==================================================
Streaming architecture:
  Raw PCM frames (every ~50ms) → Silero VAD segments at speech/pause boundaries
  → Completed segments only → Whisper (constant-time, no growing buffer)
  → Running transcript appended from segments
  → Pre-cached ack phrases for slot 1 (<150ms from PTT release)
  → Kokoro TTS for slot 2 (full responses)

Protocol:
  → {"event":"audio","data":"<base64_f32_pcm_frame>"}
  → {"event":"stop"}
  → {"event":"speak","id":"...","text":"..."}
  → {"event":"ack","id":"..."}
  → {"event":"interrupt"}

  ← {"event":"partial","data":"..."}
  ← {"event":"final","data":"..."}
  ← {"event":"audio","id":"...","data":"<base64_f32_pcm>"}
  ← {"event":"done","id":"..."}
  ← {"event":"ready"}
  ← {"event":"error","data":"..."}
"""

import json
import base64
import os
import threading
import queue
import time
import sys
import numpy as np
from dataclasses import dataclass, field

SAMPLE_RATE = 16000
MODELS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "voice-models")
WHISPER_DIR = os.path.join(MODELS_DIR, "whisper")
KOKORO_DIR = os.path.join(MODELS_DIR, "kokoro")

# Timing debug
_timing_log = []
def log_timer(label: str):
    _timing_log.append((time.time(), label))

def flush_timing(prefix="[Timer]"):
    if not _timing_log:
        return
    t0 = _timing_log[0][0]
    msg = f"{prefix} "
    for i, (t, label) in enumerate(_timing_log):
        dt = (t - t0) * 1000
        msg += f"{label}={dt:.0f}ms "
        t0 = t
    send({"event": "status", "data": msg})
    _timing_log.clear()

# VAD config
VAD_SPEECH_THRESH = 0.50        # lower = more sensitive, faster detection
VAD_SILENCE_HANGOVER_MS = 300    # ms of silence before segment ends (was 600 — faster segment boundaries for short commands)
VAD_MIN_SEGMENT_MS = 300         # discard sub-300ms segments (noise)
PARTIAL_EVERY_CHUNKS = 4         # send partial every ~4 frames (~200ms) for tighter feedback

# ── Helpers ─────────────────────────────────────────────────────


def send(obj):
    """Thread-safe JSON line to stdout."""
    line = json.dumps(obj, ensure_ascii=False) + "\n"
    sys.stdout.write(line)
    sys.stdout.flush()


def pcm_to_base64(pcm: np.ndarray) -> str:
    return base64.b64encode(pcm.astype(np.float32).tobytes()).decode()


# ── Acknowledge cache: pre-generated TTS clips ──────────────────

ACK_PHRASES = ["On it", "Got it", "Checking", "Sure", "Working"]
_ack_cache: dict[str, bytes] = {}  # phrase -> raw f32 PCM bytes


def get_cached_ack(phrase: str) -> bytes | None:
    return _ack_cache.get(phrase)


def cache_ack(phrase: str, pcm_bytes: bytes):
    _ack_cache[phrase] = pcm_bytes


# ── VoiceProcessor ──────────────────────────────────────────────


class VoiceProcessor:
    def __init__(self):
        self.vad_model = None
        self.stt_model = None
        self.tts_model = None

        # Audio thread state
        self.audio_queue: queue.Queue = queue.Queue()
        self.audio_buffer = bytearray()          # raw PCM bytes accumulator
        self.segment_buffer = bytearray()        # current VAD segment
        self.running_transcript = ""             # appended from segments
        self._partial_sent_pos = 0               # byte offset into segment_buffer

        # VAD state
        self._vad_state = "silence"              # silence | speech | hold
        self._vad_hold_count = 0                 # frames of silence after speech
        self._vad_segment_id = 0

        # Model loading state
        self.models_ready = False

    # ── Silero VAD ──────────────────────────────────────────

    def load_vad(self):
        try:
            from silero_vad import load_silero_vad
            self.vad_model = load_silero_vad()
            self.vad_sr = 16000
            self.vad_frame_size = 512  # 32ms @ 16kHz — minimum viable frame
            send({"event": "status", "data": "Silero VAD ready"})
        except Exception as e:
            send({"event": "error", "data": f"VAD load failed: {e}"})

    def vad_speech_probability(self, audio_chunk: np.ndarray) -> float:
        """Get speech probability for an audio chunk. Chunk should be ~512 samples."""
        if self.vad_model is None or len(audio_chunk) < 512:
            return 0.0
        try:
            import torch
            # Ensure 512-sample frame (pad if needed)
            if len(audio_chunk) < 512:
                chunk = np.pad(audio_chunk, (0, 512 - len(audio_chunk)))
            else:
                chunk = audio_chunk[:512]
            inp = torch.from_numpy(chunk.astype(np.float32)).unsqueeze(0)
            result = self.vad_model(inp, self.vad_sr)
            # result is [1, 1] tensor
            return float(result.item())
        except Exception as e:
            return 0.0

    # ── STT: faster-whisper ─────────────────────────────────

    def load_stt(self):
        try:
            from faster_whisper import WhisperModel
            send({"event": "status", "data": "Loading Whisper base.en (74M params)...", "level": 0})
            self.stt_model = WhisperModel(
                "base.en",       # 74M params — 8x faster to load than distil-small.en,
                                 # far better accuracy than tiny.en for domain terms
                                 # (Claude vs cold, Codex vs codecs, Hermes vs herms)
                device="cpu",
                compute_type="int8",
                cpu_threads=4,
                num_workers=1,
            )
            self.stt_hotwords = (
                "Claude, Codex, Hermes, ORCH, Orchestra, "
                "Max, Sky, Zuma, Astra, Chase, Zed, Eve, Blade, Blue, Lily, "
                "open, close, spawn, vanish, layout, arrange, "
                "agent, terminal, canvas, prompt, focus, stop, interrupt"
            )
            send({"event": "status", "data": "Whisper STT ready"})
        except Exception as e:
            send({"event": "error", "data": f"STT load failed: {e}"})

    def transcribe(self, pcm: np.ndarray) -> str:
        """Whisper inference on a fixed-length audio segment."""
        if self.stt_model is None or len(pcm) < SAMPLE_RATE * 0.1:
            return ""
        try:
            # base.en is accurate even with greedy (beam=1), giving 0.0s inference
            # For longer segments (>3s), beam=3 for slightly better accuracy
            use_beam = 3 if len(pcm) > SAMPLE_RATE * 3 else 1
            segments, _ = self.stt_model.transcribe(
                np.ascontiguousarray(pcm, dtype=np.float32),
                language="en",
                beam_size=use_beam,       # 1 = fast (0s), 3 = accurate for long segments
                vad_filter=False,          # REDUNDANT on Silero-VAD-segmented audio
                initial_prompt=self.stt_hotwords,
                condition_on_previous_text=True,
                no_speech_threshold=0.6,
                hotwords=self.stt_hotwords,
            )
            text = " ".join(seg.text for seg in segments).strip()

            # Auto-retry: if result is suspiciously short for a long segment,
            # re-run with beam=3 to catch hallucinations
            if text and len(pcm) > SAMPLE_RATE * 1.5 and len(text) < 5 and use_beam < 3:
                segments, _ = self.stt_model.transcribe(
                    np.ascontiguousarray(pcm, dtype=np.float32),
                    language="en",
                    beam_size=3,
                    vad_filter=False,
                    initial_prompt=self.stt_hotwords,
                    condition_on_previous_text=True,
                    no_speech_threshold=0.6,
                    hotwords=self.stt_hotwords,
                )
                retry_text = " ".join(seg.text for seg in segments).strip()
                if len(retry_text) > len(text):
                    text = retry_text

            return text
        except Exception as e:
            send({"event": "error", "data": f"STT error: {e}"})
            return ""

    # ── TTS: Kokoro ─────────────────────────────────────────

    def load_tts(self):
        try:
            model_path = os.path.join(KOKORO_DIR, "kokoro-v1.0.onnx")
            voices_path = os.path.join(KOKORO_DIR, "voices-v1.0.bin")
            if not os.path.exists(model_path) or not os.path.exists(voices_path):
                send({"event": "status", "data": "Downloading Kokoro TTS model...", "level": 0})
                os.makedirs(KOKORO_DIR, exist_ok=True)
                from huggingface_hub import hf_hub_download
                hf_hub_download("leonelhs/kokoro-thewh1teagle", "kokoro-v1.0.onnx", local_dir=KOKORO_DIR)
                hf_hub_download("leonelhs/kokoro-thewh1teagle", "voices-v1.0.bin", local_dir=KOKORO_DIR)

            from kokoro_onnx import Kokoro
            send({"event": "status", "data": "Loading Kokoro TTS...", "level": 0})
            self.tts_model = Kokoro(model_path, voices_path)

            # Pre-cache ack phrases
            send({"event": "status", "data": "Caching ack phrases..."})
            for phrase in ACK_PHRASES:
                audio, sr = self.tts_model.create(phrase, voice="af_bella", speed=1.0)
                cache_ack(phrase, audio.astype(np.float32).tobytes())
                send({"event": "status", "data": f"  Cached: '{phrase}' ({len(audio)} samples)"})

            send({"event": "status", "data": "TTS ready, acks cached"})
        except Exception as e:
            send({"event": "error", "data": f"TTS load failed: {e}"})

    def speak(self, text: str, voice_id: str = "af_bella") -> bytes:
        if self.tts_model is None:
            return b""
        try:
            audio, sr = self.tts_model.create(text, voice=voice_id, speed=1.0)
            return audio.astype(np.float32).tobytes()
        except Exception as e:
            send({"event": "error", "data": f"TTS error: {e}"})
            return b""

    # ── VAD + Audio worker ──────────────────────────────────

    def audio_worker(self):
        """Continuously processes PCM through VAD → segmentation → transcription."""
        # Silero VAD expects 30ms frames (480 samples @ 16kHz).
        # We accumulate incoming chunks into a small buffer for VAD.
        vad_frame = bytearray()
        VAD_FRAME_BYTES = 480 * 4  # 480 samples × 4 bytes (f32)

        frame_count = 0
        partial_count = 0
        speech_start_time = None

        while True:
            chunk = self.audio_queue.get()
            if chunk is None:
                # Stop sentinel: transcribe current segment
                log_timer("stop_received")
                self._finalize_segment(force=True)
                log_timer("final_transcript_sent")
                flush_timing("[VoiceTimer]")
                send({"event": "status", "data": f"Final transcript: {self.running_transcript}"})
                send({"event": "final", "data": self.running_transcript})
                self.running_transcript = ""
                self.segment_buffer = bytearray()
                self._vad_state = "silence"
                self._vad_hold_count = 0
                continue

            # chunk is raw f32 PCM bytes
            self.audio_buffer.extend(chunk)
            self.segment_buffer.extend(chunk)
            vad_frame.extend(chunk)

            frame_count += 1

            # Process VAD when we have a full 30ms frame
            while len(vad_frame) >= VAD_FRAME_BYTES:
                frame_bytes = bytes(vad_frame[:VAD_FRAME_BYTES])
                vad_frame[:] = vad_frame[VAD_FRAME_BYTES:]

                frame_pcm = np.frombuffer(frame_bytes, dtype=np.float32)
                # Sanity: if frame is all zeros, skip VAD
                if np.max(np.abs(frame_pcm)) < 0.001:
                    is_speech = False
                else:
                    try:
                        prob = self.vad_speech_probability(frame_pcm)
                        is_speech = prob > VAD_SPEECH_THRESH
                    except:
                        is_speech = False

                # VAD state machine
                if is_speech:
                    if self._vad_state == "silence":
                        log_timer("vad_speech_detect")
                        self._vad_state = "speech"
                        self._vad_segment_id += 1
                        self.segment_buffer = bytearray()
                        self._partial_sent_pos = 0
                    elif self._vad_state == "hold":
                        # Came back before hangover → resume
                        self._vad_state = "speech"
                    self._vad_hold_count = 0
                else:
                    if self._vad_state == "speech":
                        self._vad_state = "hold"
                        self._vad_hold_count = 1
                    elif self._vad_state == "hold":
                        self._vad_hold_count += 1

                        hangover_frames = int(VAD_SILENCE_HANGOVER_MS / 30)
                        if self._vad_hold_count >= hangover_frames:
                            # Segment ended — transcribe only this segment
                            self._finalize_segment(force=False)
                            self._vad_state = "silence"
                            self._vad_hold_count = 0

            # Send partials for long ongoing segments
            segment_len = len(self.segment_buffer)
            if segment_len > SAMPLE_RATE * 4 * 1.0 and frame_count % PARTIAL_EVERY_CHUNKS == 0:
                partial_pcm = np.frombuffer(
                    bytes(self.segment_buffer[self._partial_sent_pos:]),
                    dtype=np.float32
                )
                if len(partial_pcm) > SAMPLE_RATE * 0.3:
                    text = self.transcribe(partial_pcm)
                    if text:
                        send({"event": "partial", "data": text})
                    self._partial_sent_pos = len(self.segment_buffer)

    def _finalize_segment(self, force: bool = False):
        """Transcribe the current VAD segment and append to running transcript."""
        seg_bytes = bytes(self.segment_buffer)
        if len(seg_bytes) < SAMPLE_RATE * 4 * (VAD_MIN_SEGMENT_MS / 1000) and not force:
            return

        if len(seg_bytes) == 0:
            return

        pcm = np.frombuffer(seg_bytes, dtype=np.float32)
        log_timer("transcribe_start")
        text = self.transcribe(pcm)
        log_timer("transcribe_done")
        if text:
            # Append to running transcript with space separator
            if self.running_transcript and not self.running_transcript.endswith(" "):
                self.running_transcript += " "
            self.running_transcript += text
            send({"event": "partial", "data": self.running_transcript})

        self.segment_buffer = bytearray()
        self._partial_sent_pos = 0

    # ── Main loop ───────────────────────────────────────────

    def run(self):
        # Send status immediately so the UI shows "connecting"
        send({"event": "status", "data": "Voice server starting, loading models..."})

        # Load models in background
        vad_thread = threading.Thread(target=self.load_vad, daemon=True)
        stt_thread = threading.Thread(target=self.load_stt, daemon=True)
        tts_thread = threading.Thread(target=self.load_tts, daemon=True)

        vad_thread.start()
        stt_thread.start()
        tts_thread.start()

        # Wait for VAD before starting audio processing
        vad_thread.join()
        audio_thread = threading.Thread(target=self.audio_worker, daemon=True)
        audio_thread.start()

        # Wait for STT (essential for transcription)
        stt_thread.join()

        # Now we're ready to accept voice — VAD + STT both loaded
        self.models_ready = True
        send({"event": "ready"})
        send({"event": "status", "data": "Voice ready — VAD + STT loaded, TTS loading in background"})

        # Wait for TTS (non-blocking — voice can work without TTS, user just won't hear responses)
        tts_thread.join()
        send({"event": "status", "data": "All models ready, voice pipeline fully operational"})

        # ── stdin command loop ──────────────────────────────
        line_buffer = ""
        while True:
            try:
                line = sys.stdin.readline()
                if not line:
                    break
                line_buffer += line

                while "\n" in line_buffer:
                    msg, line_buffer = line_buffer.split("\n", 1)
                    if not msg.strip():
                        continue
                    try:
                        cmd = json.loads(msg)
                    except json.JSONDecodeError:
                        continue

                    event = cmd.get("event")

                    if event == "audio":
                        raw = base64.b64decode(cmd["data"])
                        self.audio_queue.put(raw)

                    elif event == "stop":
                        self.audio_queue.put(None)

                    elif event == "speak":
                        # Slot 2: full Kokoro TTS response
                        tts_id = cmd.get("id", "0")
                        text = cmd.get("text", "")
                        if text:
                            send({"event": "status", "data": f"Speaking: {text[:40]}...", "level": 0})
                            pcm_bytes = self.speak(text)
                            if pcm_bytes:
                                send({
                                    "event": "audio",
                                    "id": tts_id,
                                    "data": base64.b64encode(pcm_bytes).decode(),
                                })
                            send({"event": "done", "id": tts_id})

                    elif event == "ack":
                        # Slot 1: play cached ack immediately (<150ms)
                        ack_id = cmd.get("id", "ack")
                        phrase = cmd.get("phrase", "On it")
                        cached = get_cached_ack(phrase)
                        if cached:
                            send({
                                "event": "audio",
                                "id": ack_id,
                                "data": base64.b64encode(cached).decode(),
                            })
                            send({"event": "done", "id": ack_id})
                        else:
                            # Fallback: generate on-the-fly
                            pcm_bytes = self.speak(phrase)
                            if pcm_bytes:
                                send({
                                    "event": "audio",
                                    "id": ack_id,
                                    "data": base64.b64encode(pcm_bytes).decode(),
                                })
                            send({"event": "done", "id": ack_id})

                    elif event == "interrupt":
                        with self.audio_queue.mutex:
                            self.audio_queue.queue.clear()
                        self.audio_queue.put(None)  # flush
                        self._vad_state = "silence"
                        self._vad_hold_count = 0
                        self.segment_buffer = bytearray()
                        self._partial_sent_pos = 0
                        send({"event": "status", "data": "Interrupted"})

                    elif event == "ping":
                        send({"event": "pong"})

            except Exception as e:
                send({"event": "error", "data": str(e)})

        send({"event": "status", "data": "Shutting down"})


if __name__ == "__main__":
    VoiceProcessor().run()
