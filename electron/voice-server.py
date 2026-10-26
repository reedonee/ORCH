"""
ORCH Voice Server — Streaming VAD + Parakeet STT + Kokoro TTS
=============================================================
Fully local voice pipeline. No cloud, no VPS.

Architecture:
  Raw PCM frames (every ~50ms) → Silero VAD segments at speech/pause boundaries
  → Completed segments → Parakeet STT (ONNX, CTC) → Running transcript
  → Optional fallback to Whisper if Parakeet is unavailable
  → Pre-cached ack phrases for slot 1 (<150ms from PTT release)
  → Kokoro TTS (ONNX) for slot 2 (full responses)

Protocol:
  → {"event":"audio","data":"<base64_f32_pcm_frame>"}
  → {"event":"stop"}
  → {"event":"speak","id":"...","text":"..."}
  → {"event":"ack","id":"..."}
  → {"event":"interrupt"}
  → {"event":"ping"}

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
import re
import threading
import queue
import time
import sys
import numpy as np

SAMPLE_RATE = 16000
KOKORO_SAMPLE_RATE = 24000
MODELS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "voice-models")
WHISPER_DIR = os.path.join(MODELS_DIR, "whisper")
KOKORO_DIR = os.path.join(MODELS_DIR, "kokoro")
PARAKEET_DIR = os.path.join(MODELS_DIR, "parakeet")

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
VAD_SPEECH_THRESH = 0.50
VAD_SILENCE_HANGOVER_MS = 300
VAD_MIN_SEGMENT_MS = 300
PARTIAL_EVERY_CHUNKS = 4

# ── Helpers ─────────────────────────────────────────────────────


_send_lock = threading.Lock()


def send(obj):
    """Serialise a JSON line to stdout.

    Genuinely thread-safe: the STT worker, the TTS worker and the stdin
    loop all emit concurrently, and interleaved partial writes would
    corrupt the newline-delimited protocol the Electron side parses.
    """
    line = json.dumps(obj, ensure_ascii=False) + "\n"
    with _send_lock:
        sys.stdout.write(line)
        sys.stdout.flush()


def pcm_to_base64(pcm: np.ndarray) -> str:
    return base64.b64encode(pcm.astype(np.float32).tobytes()).decode()


# ── Acknowledge cache: pre-generated TTS clips ──────────────────

ACK_PHRASES = ["On it", "Got it", "Checking", "Sure", "Working"]
_ack_cache: dict[str, bytes] = {}


def get_cached_ack(phrase: str) -> bytes | None:
    return _ack_cache.get(phrase)


def cache_ack(phrase: str, pcm_bytes: bytes):
    _ack_cache[phrase] = pcm_bytes


# ── STT Engine ─────────────────────────────────────────────────


class SttEngine:
    """
    Multi-engine STT with automatic fallback.
    Priority: Parakeet (ONNX) → Whisper (faster-whisper)
    """

    def __init__(self):
        self.parakeet_model = None
        self.parakeet_processor = None
        self.whisper_model = None
        self.engine_name = "none"
        self.hotwords = (
            "Claude, Codex, Hermes, ORCH, Orchestra, "
            "Max, Sky, Zuma, Astra, Chase, Zed, Eve, Blade, Blue, Lily, "
            "open, close, spawn, vanish, layout, arrange, "
            "agent, terminal, canvas, prompt, focus, stop, interrupt"
        )

    def load(self):
        """Try Parakeet first, fall back to Whisper."""
        if self._try_load_parakeet():
            return
        send({"event": "status", "data": "Parakeet not available, trying Whisper..."})
        if self._try_load_whisper():
            return
        send({"event": "error", "data": "No STT engine could be loaded! Install onnxruntime or faster-whisper."})

    def _try_load_parakeet(self) -> bool:
        """Load NVIDIA Parakeet TDT V3 model via sherpa-onnx (csukuangfj export)."""
        try:
            import sherpa_onnx
            from huggingface_hub import hf_hub_download

            send({"event": "status", "data": "Loading Parakeet TDT V3 (sherpa-onnx)...", "level": 0})

            repo_id = "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8"
            os.makedirs(PARAKEET_DIR, exist_ok=True)

            # Download model files (INT8 quantized — self-contained)
            encoder_path = hf_hub_download(
                repo_id, "encoder.int8.onnx", local_dir=PARAKEET_DIR,
                local_dir_use_symlinks=False
            )
            decoder_path = hf_hub_download(
                repo_id, "decoder.int8.onnx", local_dir=PARAKEET_DIR,
                local_dir_use_symlinks=False
            )
            joiner_path = hf_hub_download(
                repo_id, "joiner.int8.onnx", local_dir=PARAKEET_DIR,
                local_dir_use_symlinks=False
            )
            tokens_path = hf_hub_download(
                repo_id, "tokens.txt", local_dir=PARAKEET_DIR,
                local_dir_use_symlinks=False
            )

            # Tell sherpa-onnx the voice server is auto-starting
            send({"event": "status", "data": "Building TDT transducer recognizer...", "level": 0})

            self.parakeet_model = sherpa_onnx.OfflineRecognizer.from_transducer(
                encoder=encoder_path,
                decoder=decoder_path,
                joiner=joiner_path,
                tokens=tokens_path,
                num_threads=4,
                sample_rate=16000,
                feature_dim=80,
                model_type="nemo_transducer",
            )
            self.engine_name = "parakeet_v3"
            # Signal that voice is ready immediately — no manual start needed
            send({"event": "status", "data": "Parakeet TDT V3 ready (sherpa-onnx INT8)"})
            send({"event": "state", "data": "ready"})
            return True

        except ImportError:
            send({"event": "status", "data": "sherpa-onnx not installed, trying Whisper..."})
            return False
        except Exception as e:
            send({"event": "status", "data": f"Parakeet V3 load failed: {e}, trying Whisper..."})
            return False

    def _try_load_whisper(self) -> bool:
        """Load faster-whisper as fallback STT engine."""
        try:
            from faster_whisper import WhisperModel
            send({"event": "status", "data": "Loading Whisper base.en...", "level": 0})
            self.whisper_model = WhisperModel(
                "base.en",
                device="cpu",
                compute_type="int8",
                cpu_threads=4,
                num_workers=1,
            )
            self.engine_name = "whisper"
            send({"event": "status", "data": "Whisper STT ready"})
            return True
        except Exception as e:
            send({"event": "error", "data": f"Whisper load failed: {e}"})
            return False

    def transcribe(self, pcm: np.ndarray) -> str:
        """Transcribe audio using the loaded engine."""
        if self.engine_name in ("parakeet", "parakeet_v3") and self.parakeet_model:
            return self._transcribe_parakeet(pcm)
        elif self.engine_name == "whisper" and self.whisper_model:
            return self._transcribe_whisper(pcm)
        return ""
    def _transcribe_parakeet(self, pcm: np.ndarray) -> str:
        """Run Parakeet TDT V3 inference via sherpa-onnx."""
        try:
            if len(pcm) < SAMPLE_RATE * 0.1:
                return ""

            audio = np.ascontiguousarray(pcm, dtype=np.float32)

            # sherpa-onnx expects sample rate and returns decoded text directly
            stream = self.parakeet_model.create_stream()
            stream.accept_waveform(sample_rate=SAMPLE_RATE, waveform=audio)
            self.parakeet_model.decode_stream(stream)
            text = stream.result.text.strip()

            # Normalize casing
            if text and text.isupper():
                text = text[0] + text[1:].lower() if len(text) > 1 else text.lower()

            return text

        except Exception as e:
            send({"event": "error", "data": f"Parakeet V3 inference error: {e}"})
            return ""

    def _ctc_decode(self, pred_ids: np.ndarray, vocab: dict) -> str:
        """Simple CTC beam/greedy decoder for Parakeet output."""
        # Build reverse vocab (id → char)
        id_to_char = {}
        for char, idx in vocab.items():
            id_to_char[idx] = char

        # Greedy decode with collapse
        result = []
        prev = -1
        blank_id = len(vocab)  # Usually the last ID is blank
        for idx in pred_ids:
            if idx != prev and idx != blank_id:
                char = id_to_char.get(idx, "")
                if char:
                    result.append(char)
            prev = idx
        return "".join(result)

    def _transcribe_whisper(self, pcm: np.ndarray) -> str:
        """Run Whisper inference."""
        if self.whisper_model is None or len(pcm) < SAMPLE_RATE * 0.1:
            return ""
        try:
            use_beam = 3 if len(pcm) > SAMPLE_RATE * 3 else 1
            segments, _ = self.whisper_model.transcribe(
                np.ascontiguousarray(pcm, dtype=np.float32),
                language="en",
                beam_size=use_beam,
                vad_filter=False,
                initial_prompt=self.hotwords,
                condition_on_previous_text=True,
                no_speech_threshold=0.6,
                hotwords=self.hotwords,
            )
            text = " ".join(seg.text for seg in segments).strip()

            # Auto-retry for suspiciously short output
            if text and len(pcm) > SAMPLE_RATE * 1.5 and len(text) < 5 and use_beam < 3:
                segments, _ = self.whisper_model.transcribe(
                    np.ascontiguousarray(pcm, dtype=np.float32),
                    language="en",
                    beam_size=3,
                    vad_filter=False,
                    initial_prompt=self.hotwords,
                    condition_on_previous_text=True,
                    no_speech_threshold=0.6,
                    hotwords=self.hotwords,
                )
                retry_text = " ".join(seg.text for seg in segments).strip()
                if len(retry_text) > len(text):
                    text = retry_text
            return text
        except Exception as e:
            send({"event": "error", "data": f"Whisper error: {e}"})
            return ""


# ── TTS Engine ─────────────────────────────────────────────────


class TtsEngine:
    """Kokoro ONNX TTS engine with pre-cached ack phrases."""

    def __init__(self):
        self.model = None

    def load(self):
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
            self.model = Kokoro(model_path, voices_path)

            # Pre-cache ack phrases for instant playback
            send({"event": "status", "data": "Caching ack phrases..."})
            for phrase in ACK_PHRASES:
                audio, sr = self.model.create(phrase, voice="af_bella", speed=1.0)
                cache_ack(phrase, audio.astype(np.float32).tobytes())
                send({"event": "status", "data": f"  Cached: '{phrase}' ({len(audio)} samples)"})

            send({"event": "status", "data": "TTS ready, acks cached"})
        except Exception as e:
            send({"event": "error", "data": f"TTS load failed: {e}"})

    def speak(self, text: str, voice_id: str = "af_bella", speed: float = 1.0):
        """Synthesize one span. Returns (pcm_bytes, sample_rate)."""
        if self.model is None:
            return b"", KOKORO_SAMPLE_RATE
        try:
            audio, sr = self.model.create(text, voice=voice_id, speed=speed)
            return audio.astype(np.float32).tobytes(), int(sr or KOKORO_SAMPLE_RATE)
        except Exception as e:
            send({"event": "error", "data": f"TTS error: {e}"})
            return b"", KOKORO_SAMPLE_RATE


# ── Sentence chunking ───────────────────────────────────────────


def split_for_streaming(text: str, max_chars: int = 180) -> list[str]:
    """Split an utterance into speakable spans.

    Synthesizing a long reply as one blob means the user waits for the
    whole thing before hearing a word. Splitting on sentence boundaries
    lets the first span start playing while the rest is still being
    generated, which is most of the perceived latency win.

    Long sentences are further split on clause boundaries so a rambling
    sentence can't reintroduce the original stall.
    """
    text = (text or "").strip()
    if not text:
        return []

    # Split after ., !, ? or a newline, keeping the punctuation.
    raw = re.split(r"(?<=[.!?])\s+|\n+", text)

    spans: list[str] = []
    for sentence in raw:
        sentence = sentence.strip()
        if not sentence:
            continue
        if len(sentence) <= max_chars:
            spans.append(sentence)
            continue
        # Too long — break on clause punctuation, then hard-wrap on words.
        parts = re.split(r"(?<=[,;:])\s+", sentence)
        buf = ""
        for part in parts:
            if len(buf) + len(part) + 1 <= max_chars:
                buf = f"{buf} {part}".strip()
            else:
                if buf:
                    spans.append(buf)
                while len(part) > max_chars:
                    cut = part.rfind(" ", 0, max_chars)
                    if cut <= 0:
                        cut = max_chars
                    spans.append(part[:cut].strip())
                    part = part[cut:].strip()
                buf = part
        if buf:
            spans.append(buf)

    return [s for s in spans if s]


# ── TTS Worker ──────────────────────────────────────────────────


class TtsWorker:
    """Runs synthesis off the stdin loop.

    Previously `tts.speak()` was called inline while reading stdin, so the
    server was deaf for the whole duration of a synthesis: it could not
    read incoming mic frames, and — critically — could not process the
    `interrupt` that barge-in sends, because that interrupt was queued
    behind the very speech it was trying to cancel. Interrupt could
    therefore never work by construction.

    Now synthesis happens on this thread and cancellation is a generation
    counter checked between spans, so an interrupt takes effect after at
    most one short span.
    """

    def __init__(self, tts: "TtsEngine"):
        self.tts = tts
        self.jobs: queue.Queue = queue.Queue()
        self.generation = 0
        self._lock = threading.Lock()

    def start(self):
        threading.Thread(target=self._run, daemon=True).start()

    def submit(self, tts_id: str, text: str, voice: str, speed: float, cached: bytes | None = None):
        with self._lock:
            gen = self.generation
        self.jobs.put((gen, tts_id, text, voice, speed, cached))

    def cancel(self) -> int:
        """Invalidate queued and in-flight work. Returns the new generation."""
        with self._lock:
            self.generation += 1
            gen = self.generation
        # Drain anything already queued; in-flight work sees the new gen.
        try:
            while True:
                self.jobs.get_nowait()
        except queue.Empty:
            pass
        return gen

    def _is_stale(self, gen: int) -> bool:
        with self._lock:
            return gen != self.generation

    def _run(self):
        while True:
            job = self.jobs.get()
            if job is None:
                break
            gen, tts_id, text, voice, speed, cached = job
            if self._is_stale(gen):
                continue
            try:
                self._speak_job(gen, tts_id, text, voice, speed, cached)
            except Exception as e:
                send({"event": "error", "data": f"TTS worker error: {e}"})

    def _speak_job(self, gen, tts_id, text, voice, speed, cached):
        # Pre-rendered ack clip — emit immediately, nothing to synthesize.
        if cached is not None:
            send({
                "event": "audio",
                "id": tts_id,
                "seq": 0,
                "final": True,
                "sampleRate": KOKORO_SAMPLE_RATE,
                "data": base64.b64encode(cached).decode(),
            })
            send({"event": "done", "id": tts_id})
            return

        spans = split_for_streaming(text)
        if not spans:
            send({"event": "done", "id": tts_id})
            return

        for i, span in enumerate(spans):
            if self._is_stale(gen):
                send({"event": "status", "data": f"TTS cancelled at span {i}"})
                return
            pcm_bytes, sr = self.tts.speak(span, voice_id=voice, speed=speed)
            # Re-check after synthesis: an interrupt may have landed while
            # this span was rendering, and playing it would talk over the user.
            if self._is_stale(gen):
                send({"event": "status", "data": f"TTS cancelled after span {i}"})
                return
            if not pcm_bytes:
                continue
            send({
                "event": "audio",
                "id": tts_id,
                "seq": i,
                "final": i == len(spans) - 1,
                "sampleRate": sr,
                "data": base64.b64encode(pcm_bytes).decode(),
            })

        send({"event": "done", "id": tts_id})


# ── VoiceProcessor ──────────────────────────────────────────────


class VoiceProcessor:
    def __init__(self):
        self.vad_model = None
        self.stt = SttEngine()
        self.tts = TtsEngine()
        self.tts_worker = TtsWorker(self.tts)

        # Voice settings — overridable at runtime via the "config" event.
        self.voice_id = "af_bella"
        self.voice_speed = 1.0

        # Audio thread state
        self.audio_queue: queue.Queue = queue.Queue()
        self.audio_buffer = bytearray()
        self.segment_buffer = bytearray()
        self.running_transcript = ""
        self._partial_sent_pos = 0

        # VAD state
        self._vad_state = "silence"
        self._vad_hold_count = 0
        self._vad_segment_id = 0

        # Model loading state
        self.models_ready = False

    # ── Silero VAD ──────────────────────────────────────────

    def load_vad(self):
        try:
            from silero_vad import load_silero_vad
            self.vad_model = load_silero_vad()
            self.vad_sr = 16000
            self.vad_frame_size = 512
            send({"event": "status", "data": "Silero VAD ready"})
        except Exception as e:
            send({"event": "error", "data": f"VAD load failed: {e}"})

    def vad_speech_probability(self, audio_chunk: np.ndarray) -> float:
        if self.vad_model is None or len(audio_chunk) < 512:
            return 0.0
        try:
            import torch
            if len(audio_chunk) < 512:
                chunk = np.pad(audio_chunk, (0, 512 - len(audio_chunk)))
            else:
                chunk = audio_chunk[:512]
            inp = torch.from_numpy(chunk.astype(np.float32)).unsqueeze(0)
            result = self.vad_model(inp, self.vad_sr)
            return float(result.item())
        except Exception:
            return 0.0

    # ── Audio worker ────────────────────────────────────────

    def audio_worker(self):
        """Continuous VAD → segmentation → transcription pipeline."""
        vad_frame = bytearray()
        VAD_FRAME_BYTES = 480 * 4  # 480 samples × 4 bytes (f32)

        frame_count = 0
        partial_count = 0

        while True:
            chunk = self.audio_queue.get()
            if chunk is None:
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

            self.audio_buffer.extend(chunk)
            self.segment_buffer.extend(chunk)
            vad_frame.extend(chunk)

            frame_count += 1

            while len(vad_frame) >= VAD_FRAME_BYTES:
                frame_bytes = bytes(vad_frame[:VAD_FRAME_BYTES])
                vad_frame[:] = vad_frame[VAD_FRAME_BYTES:]

                frame_pcm = np.frombuffer(frame_bytes, dtype=np.float32)
                if np.max(np.abs(frame_pcm)) < 0.001:
                    is_speech = False
                else:
                    try:
                        prob = self.vad_speech_probability(frame_pcm)
                        is_speech = prob > VAD_SPEECH_THRESH
                    except:
                        is_speech = False

                if is_speech:
                    if self._vad_state == "silence":
                        log_timer("vad_speech_detect")
                        self._vad_state = "speech"
                        self._vad_segment_id += 1
                        self.segment_buffer = bytearray()
                        self._partial_sent_pos = 0
                    elif self._vad_state == "hold":
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
                    text = self.stt.transcribe(partial_pcm)
                    if text:
                        send({"event": "partial", "data": text})
                    self._partial_sent_pos = len(self.segment_buffer)

    def _finalize_segment(self, force: bool = False):
        """Transcribe the current VAD segment."""
        seg_bytes = bytes(self.segment_buffer)
        if len(seg_bytes) < SAMPLE_RATE * 4 * (VAD_MIN_SEGMENT_MS / 1000) and not force:
            return
        if len(seg_bytes) == 0:
            return

        pcm = np.frombuffer(seg_bytes, dtype=np.float32)
        log_timer("transcribe_start")
        text = self.stt.transcribe(pcm)
        log_timer("transcribe_done")
        if text:
            if self.running_transcript and not self.running_transcript.endswith(" "):
                self.running_transcript += " "
            self.running_transcript += text
            send({"event": "partial", "data": self.running_transcript})

        self.segment_buffer = bytearray()
        self._partial_sent_pos = 0

    # ── Main loop ───────────────────────────────────────────

    def run(self):
        send({"event": "status", "data": "Voice server starting, loading models..."})

        # Load models in background threads
        vad_thread = threading.Thread(target=self.load_vad, daemon=True)
        stt_thread = threading.Thread(target=self.stt.load, daemon=True)
        tts_thread = threading.Thread(target=self.tts.load, daemon=True)

        vad_thread.start()
        stt_thread.start()
        tts_thread.start()

        # Wait for VAD before starting audio processing
        vad_thread.join()
        audio_thread = threading.Thread(target=self.audio_worker, daemon=True)
        audio_thread.start()

        # Wait for STT
        stt_thread.join()

        self.models_ready = True
        send({"event": "ready"})
        send({"event": "status", "data": f"Voice ready — {self.stt.engine_name} STT loaded, TTS loading in background"})

        # Start the TTS worker and enter the command loop immediately.
        # Joining tts_thread here (as before) meant the server accepted no
        # commands until Kokoro had loaded and cached every ack phrase —
        # while having already told the renderer it was "ready", so mic
        # frames piled up unread in the stdin pipe.
        self.tts_worker.start()

        def announce_tts_ready():
            tts_thread.join()
            send({"event": "status", "data": "All models ready, voice pipeline fully operational"})
            send({"event": "tts_ready"})

        threading.Thread(target=announce_tts_ready, daemon=True).start()

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
                        tts_id = cmd.get("id", "0")
                        text = cmd.get("text", "")
                        if text:
                            self.tts_worker.submit(
                                tts_id, text,
                                cmd.get("voice") or self.voice_id,
                                float(cmd.get("speed") or self.voice_speed),
                            )

                    elif event == "ack":
                        ack_id = cmd.get("id", "ack")
                        phrase = cmd.get("phrase", "On it")
                        # Cached acks skip synthesis entirely; uncached ones
                        # go through the worker like any other utterance.
                        self.tts_worker.submit(
                            ack_id, phrase,
                            cmd.get("voice") or self.voice_id,
                            float(cmd.get("speed") or self.voice_speed),
                            cached=get_cached_ack(phrase),
                        )

                    elif event == "config":
                        if cmd.get("voice"):
                            self.voice_id = str(cmd["voice"])
                        if cmd.get("speed"):
                            self.voice_speed = max(0.5, min(2.0, float(cmd["speed"])))
                        send({"event": "status",
                              "data": f"Voice config: {self.voice_id} @ {self.voice_speed}x"})

                    elif event == "interrupt":
                        # Cancel speech first so the user stops hearing the
                        # assistant within one span, then reset capture state.
                        self.tts_worker.cancel()
                        with self.audio_queue.mutex:
                            self.audio_queue.queue.clear()
                        self.audio_queue.put(None)
                        self._vad_state = "silence"
                        self._vad_hold_count = 0
                        self.segment_buffer = bytearray()
                        self._partial_sent_pos = 0
                        send({"event": "interrupted"})
                        send({"event": "status", "data": "Interrupted"})

                    elif event == "ping":
                        send({"event": "pong"})

            except Exception as e:
                send({"event": "error", "data": str(e)})

        send({"event": "status", "data": "Shutting down"})


if __name__ == "__main__":
    VoiceProcessor().run()
