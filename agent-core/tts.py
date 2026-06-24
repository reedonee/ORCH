"""
ORCH TTS — Kokoro ONNX on VPS
=================================
Cloud TTS endpoint that frees the local machine from model inference.
Model files auto-download from HuggingFace on first use.
"""

import os
import base64
import asyncio
from pathlib import Path

TTS_DIR = Path("/app/tts-models")
TTS_DIR.mkdir(exist_ok=True)

_model = None

def get_tts():
    """Lazy-load Kokoro TTS model."""
    global _model
    if _model is not None:
        return _model

    model_path = TTS_DIR / "kokoro-v1.0.onnx"
    voices_path = TTS_DIR / "voices-v1.0.bin"

    if not model_path.exists() or not voices_path.exists():
        print("[TTS] Downloading Kokoro model from HuggingFace...")
        from huggingface_hub import hf_hub_download
        hf_hub_download("leonelhs/kokoro-thewh1teagle", "kokoro-v1.0.onnx", local_dir=str(TTS_DIR))
        hf_hub_download("leonelhs/kokoro-thewh1teagle", "voices-v1.0.bin", local_dir=str(TTS_DIR))
        print("[TTS] Download complete")

    from kokoro_onnx import Kokoro
    _model = Kokoro(str(model_path), str(voices_path))
    print("[TTS] Kokoro ready")
    return _model


async def synthesize(text: str, voice: str = "af_bella", speed: float = 1.0) -> bytes:
    """Generate PCM audio from text. Returns raw f32 PCM bytes at 24kHz."""
    def _sync():
        tts = get_tts()
        audio, sr = tts.create(text, voice=voice, speed=speed)
        return audio.astype("float32").tobytes()

    return await asyncio.to_thread(_sync)


def synthesize_sync(text: str, voice: str = "af_bella", speed: float = 1.0) -> bytes:
    """Synchronous version for use in FastAPI."""
    tts = get_tts()
    audio, sr = tts.create(text, voice=voice, speed=speed)
    return audio.astype("float32").tobytes()
