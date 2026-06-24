# ── ORCH Voice Processor — STT (Whisper) + TTS (Kokoro) ──────

import io
import logging
import asyncio
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

log = logging.getLogger("agent-core.voice")


class VoiceProcessor:
    """Handles speech-to-text (faster-whisper) and text-to-speech (Kokoro)."""

    def __init__(self, model_size: str = "base"):
        self.model_size = model_size
        self.ready = False
        self._whisper = None
        self._kokoro = None
        self._executor = ThreadPoolExecutor(max_workers=1)
        self._pipeline: list[np.ndarray] = []  # accumulated PCM for current utterance

    async def load(self):
        """Load models in background thread to avoid blocking the event loop."""
        log.info(f"Loading Whisper ({self.model_size})...")

        def _load():
            from faster_whisper import WhisperModel
            self._whisper = WhisperModel(
                self.model_size,
                device="cpu",
                compute_type="int8",
                cpu_threads=4,
                num_workers=1,
            )
            log.info("Whisper loaded")

        await asyncio.get_event_loop().run_in_executor(self._executor, _load)

        log.info("Loading Kokoro TTS...")

        def _load_kokoro():
            from kokoro import KPipeline
            self._kokoro = KPipeline(lang_code='a')
            log.info("Kokoro loaded")

        await asyncio.get_event_loop().run_in_executor(self._executor, _load_kokoro)

        self.ready = True
        log.info("Voice processor ready")

    async def shutdown(self):
        """Cleanup resources."""
        self.ready = False
        self._executor.shutdown(wait=False)
        self._whisper = None
        self._kokoro = None

    # ── STT ────────────────────────────────────────────────────

    async def transcribe_chunk(self, pcm: np.ndarray) -> tuple[str, bool]:
        """Process a 50ms PCM chunk.
        
        The pipeline accumulates audio. When silence is detected,
        it runs Whisper and returns the final transcript.
        
        Returns: (text, is_final)
        """
        self._pipeline.append(pcm)

        # Estimate energy — if below threshold for the last few frames, finalize
        energy = np.sqrt(np.mean(pcm ** 2))
        SILENCE_THRESHOLD = 0.008

        if len(self._pipeline) > 5 and energy < SILENCE_THRESHOLD:
            # Concatenate accumulated audio
            audio = np.concatenate(self._pipeline)
            self._pipeline = []

            text = await self._transcribe(audio)
            return text, True

        return "", False

    async def _transcribe(self, audio: np.ndarray) -> str:
        """Run Whisper on a PCM array."""
        if self._whisper is None:
            return ""

        def _run():
            segments, info = self._whisper.transcribe(audio, beam_size=1, language="en")
            return " ".join(seg.text for seg in segments)

        try:
            text = await asyncio.get_event_loop().run_in_executor(self._executor, _run)
            return text.strip()
        except Exception as e:
            log.error(f"STT error: {e}")
            return ""

    # ── TTS ────────────────────────────────────────────────────

    async def synthesize(self, text: str, voice_id: str = "af_heart") -> str:
        """Synthesize text to speech. Returns base64-encoded PCM f32 at 24kHz."""
        if self._kokoro is None:
            return ""

        def _run():
            import base64
            audio_chunks = []
            for result in self._kokoro(text, voice=voice_id, speed=1.0):
                audio_chunks.append(result.audio)
            if not audio_chunks:
                return ""
            full_audio = np.concatenate(audio_chunks)
            return base64.b64encode(full_audio.tobytes()).decode("ascii")

        try:
            return await asyncio.get_event_loop().run_in_executor(self._executor, _run)
        except Exception as e:
            log.error(f"TTS error: {e}")
            return ""
