"""Pre-download Kokoro TTS model at build time."""
from huggingface_hub import hf_hub_download
import os

tts_dir = "/app/tts-models"
os.makedirs(tts_dir, exist_ok=True)

print("[Build] Downloading Kokoro TTS model...")
hf_hub_download("leonelhs/kokoro-thewh1teagle", "kokoro-v1.0.onnx", local_dir=tts_dir)
hf_hub_download("leonelhs/kokoro-thewh1teagle", "voices-v1.0.bin", local_dir=tts_dir)
print("[Build] Kokoro TTS model ready")
