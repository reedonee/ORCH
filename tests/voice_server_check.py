"""Unit checks for the voice server's pure logic.

Covers the sentence chunker and the TTS worker's cancellation semantics
without loading any ML models — those take ~60s and need ~1 GB of
weights, which makes them useless as a fast feedback loop.
"""
import os
import sys
import threading
import time

# The sidecar is named voice-server.py, which is not a valid module name,
# so load it by path.
import importlib.util  # noqa: E402

_script = os.path.join(os.path.dirname(__file__), "..", "electron", "voice-server.py")
_spec = importlib.util.spec_from_file_location("orch_voice_server", _script)
vs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(vs)

failures = []


def check(label, actual, expected):
    if actual != expected:
        failures.append(f"{label}: got {actual!r}, want {expected!r}")


def check_true(label, cond):
    if not cond:
        failures.append(label)


# ── split_for_streaming ─────────────────────────────────────────

check("empty", vs.split_for_streaming(""), [])
check("whitespace", vs.split_for_streaming("   \n  "), [])
check("single", vs.split_for_streaming("Hello there"), ["Hello there"])

check(
    "sentences",
    vs.split_for_streaming("Spawned Max. Ready to go! What next?"),
    ["Spawned Max.", "Ready to go!", "What next?"],
)

check(
    "newlines",
    vs.split_for_streaming("Line one\nLine two"),
    ["Line one", "Line two"],
)

# A long clause-free sentence must still be broken up, or the first-audio
# latency win disappears for exactly the case that needs it most.
long_sentence = "word " * 100
spans = vs.split_for_streaming(long_sentence.strip())
check_true("long sentence is split", len(spans) > 1)
check_true("no span exceeds cap", all(len(s) <= 180 for s in spans))
# Splitting must be lossless — dropping words would silently mangle speech.
check(
    "long split preserves words",
    " ".join(spans).split(),
    long_sentence.strip().split(),
)

clausey = "First we do this, then we do that, and afterwards " + ("x" * 200)
spans = vs.split_for_streaming(clausey)
check_true("clause split produced spans", len(spans) >= 2)

# ── TtsWorker cancellation ──────────────────────────────────────

class FakeTts:
    """Stands in for Kokoro. Slow enough that cancel() lands mid-utterance."""

    def __init__(self):
        self.calls = []
        self.lock = threading.Lock()

    def speak(self, text, voice_id="af_bella", speed=1.0):
        with self.lock:
            self.calls.append(text)
        time.sleep(0.05)
        return b"\x00\x00\x00\x00", 24000


sent = []
sent_lock = threading.Lock()


def capture(obj):
    with sent_lock:
        sent.append(obj)


vs.send = capture

fake = FakeTts()
worker = vs.TtsWorker(fake)
worker.start()

# 1. A normal utterance streams one audio event per span, final on the last.
worker.submit("u1", "One. Two. Three.", "af_bella", 1.0)
time.sleep(0.6)
audio = [m for m in sent if m.get("event") == "audio" and m.get("id") == "u1"]
check("stream span count", len(audio), 3)
check("stream seq order", [m["seq"] for m in audio], [0, 1, 2])
check("only last is final", [m["final"] for m in audio], [False, False, True])
check_true("done emitted", any(m.get("event") == "done" and m.get("id") == "u1" for m in sent))
check_true("sample rate present", all(m.get("sampleRate") == 24000 for m in audio))

# 2. Cancel mid-utterance: the remaining spans must not be synthesized.
sent.clear()
long_text = ". ".join(f"Sentence number {i}" for i in range(40)) + "."
worker.submit("u2", long_text, "af_bella", 1.0)
time.sleep(0.12)
worker.cancel()
time.sleep(0.5)

u2_audio = [m for m in sent if m.get("event") == "audio" and m.get("id") == "u2"]
check_true(
    f"cancel stopped synthesis early (emitted {len(u2_audio)} of 40 spans)",
    0 < len(u2_audio) < 40,
)

# 3. Work queued before a cancel must be dropped entirely.
sent.clear()
with fake.lock:
    fake.calls.clear()
worker.submit("u3", "Alpha. Beta. Gamma.", "af_bella", 1.0)
worker.cancel()
time.sleep(0.4)
u3_audio = [m for m in sent if m.get("event") == "audio" and m.get("id") == "u3"]
check("queued job dropped after cancel", len(u3_audio), 0)

# 4. Cached acks bypass synthesis completely.
sent.clear()
with fake.lock:
    before = len(fake.calls)
worker.submit("ack1", "On it", "af_bella", 1.0, cached=b"\x00\x00\x00\x00")
time.sleep(0.3)
ack_audio = [m for m in sent if m.get("event") == "audio" and m.get("id") == "ack1"]
check("cached ack emits one chunk", len(ack_audio), 1)
check("cached ack is final", ack_audio[0]["final"] if ack_audio else None, True)
with fake.lock:
    check("cached ack skipped synthesis", len(fake.calls), before)

# ── Report ──────────────────────────────────────────────────────

if failures:
    print("FAIL")
    for f in failures:
        print("  -", f)
    sys.exit(1)
print("voice-server logic: all checks PASS")
