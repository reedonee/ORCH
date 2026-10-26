"""End-to-end smoke test for the voice sidecar.

Boots the real process with real models and exercises the streaming TTS
path over the actual stdin/stdout protocol. Slow (models load in ~30-90s),
so it is not part of `npm test` — run it after changing the protocol.

    .venv-voice/Scripts/python.exe tests/voice_server_e2e.py
"""
import base64
import json
import os
import subprocess
import sys
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = os.path.join(ROOT, ".venv-voice", "Scripts", "python.exe")
if not os.path.exists(PY):
    PY = os.path.join(ROOT, ".venv-voice", "bin", "python")
SCRIPT = os.path.join(ROOT, "electron", "voice-server.py")

READY_TIMEOUT = 300

proc = subprocess.Popen(
    [PY, "-u", SCRIPT],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    text=True, bufsize=1,
)

events = []
lock = threading.Lock()
ready = threading.Event()
tts_ready = threading.Event()


def reader():
    for line in proc.stdout:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        with lock:
            events.append(msg)
        ev = msg.get("event")
        if ev == "ready":
            ready.set()
        elif ev == "tts_ready":
            tts_ready.set()
        elif ev == "status":
            print(f"   [status] {str(msg.get('data'))[:100]}")
        elif ev == "error":
            print(f"   [ERROR] {msg.get('data')}")


threading.Thread(target=reader, daemon=True).start()


def send(obj):
    proc.stdin.write(json.dumps(obj) + "\n")
    proc.stdin.flush()


def drain(event_name, tts_id=None):
    with lock:
        return [
            m for m in events
            if m.get("event") == event_name and (tts_id is None or m.get("id") == tts_id)
        ]


failures = []
t0 = time.time()
print("Booting sidecar (first load can take a while)...")

if not ready.wait(READY_TIMEOUT):
    print(f"FAIL: never reached 'ready' within {READY_TIMEOUT}s")
    proc.kill()
    sys.exit(1)
print(f"-> ready in {time.time() - t0:.1f}s")

# The command loop must accept input immediately after 'ready', even while
# TTS is still loading. Previously run() joined the TTS thread before
# reading stdin, so the server was deaf despite reporting ready.
send({"event": "ping"})
deadline = time.time() + 10
while not drain("pong") and time.time() < deadline:
    time.sleep(0.1)
if drain("pong"):
    print(f"-> command loop responsive while TTS loads ({time.time() - t0:.1f}s)")
else:
    failures.append("no pong: command loop blocked before TTS finished loading")

print("Waiting for TTS...")
if not tts_ready.wait(READY_TIMEOUT):
    failures.append("TTS never signalled ready")
else:
    print(f"-> TTS ready in {time.time() - t0:.1f}s")

# ── Streaming synthesis ─────────────────────────────────────────
with lock:
    events.clear()

t1 = time.time()
send({"event": "speak", "id": "e2e", "text": "First sentence here. Second sentence follows. And a third one."})

first_audio_at = None
deadline = time.time() + 90
while time.time() < deadline:
    audio = drain("audio", "e2e")
    if audio and first_audio_at is None:
        first_audio_at = time.time() - t1
    if drain("done", "e2e"):
        break
    time.sleep(0.05)

audio = drain("audio", "e2e")
if not audio:
    failures.append("no audio emitted for a 3-sentence utterance")
else:
    print(f"-> {len(audio)} span(s); first audio after {first_audio_at:.2f}s")
    seqs = [m.get("seq") for m in audio]
    if seqs != sorted(seqs):
        failures.append(f"spans out of order: {seqs}")
    if len(audio) < 2:
        failures.append(f"expected streaming across sentences, got {len(audio)} span(s)")
    if not audio[-1].get("final"):
        failures.append("last span not marked final")
    for m in audio:
        if m.get("sampleRate") != 24000:
            failures.append(f"unexpected sampleRate {m.get('sampleRate')}")
            break
        raw = base64.b64decode(m["data"])
        if len(raw) % 4 != 0:
            failures.append("PCM payload is not a whole number of float32 samples")
            break

# ── Interrupt ───────────────────────────────────────────────────
with lock:
    events.clear()

long_text = " ".join(f"This is filler sentence number {i}." for i in range(40))
send({"event": "speak", "id": "long", "text": long_text})
time.sleep(1.5)
before = len(drain("audio", "long"))
send({"event": "interrupt"})
time.sleep(3.0)
after = len(drain("audio", "long"))

if not drain("interrupted"):
    failures.append("no 'interrupted' acknowledgement")
if after >= 40:
    failures.append(f"interrupt did not stop synthesis ({after} spans emitted)")
else:
    print(f"-> interrupt stopped synthesis at {after} of 40 spans (was {before} when sent)")

send({"event": "interrupt"})
proc.stdin.close()
proc.wait(timeout=10)

print()
if failures:
    print("FAIL")
    for f in failures:
        print("  -", f)
    sys.exit(1)
print("voice sidecar e2e: all checks PASS")
