"""Local speech-to-text worker for Mimic (faster-whisper on the CPU). Run with stt-env python (-X utf8).

Writes the transcript of a reference clip so Breeze and Fish can clone it without anyone typing.
Start args: model name (e.g. small.en). Request: {"audio", "language"?}. Events: ready, done {text}, error.
"""
import json
import sys
import time

real_out = sys.stdout
sys.stdout = sys.stderr  # library prints must not corrupt the protocol stream
sys.stdin.reconfigure(encoding="utf-8")

import numpy as np
import soundfile as sf
from faster_whisper import WhisperModel

MODEL = sys.argv[1] if len(sys.argv) > 1 else "small.en"
WHISPER_RATE = 16000


def load_16k_mono(path):
    """Decode with soundfile (Mimic's clips are already WAV) instead of PyAV, and resample to 16 kHz."""
    audio, rate = sf.read(path, dtype="float32", always_2d=True)
    audio = audio.mean(axis=1)
    if rate != WHISPER_RATE:
        n = int(round(len(audio) * WHISPER_RATE / rate))
        audio = np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio).astype(np.float32)
    return audio


def send(**message):
    real_out.write(json.dumps(message) + "\n")
    real_out.flush()


# CPU + int8 keeps it off the GPU, which belongs to the TTS engine.
model = WhisperModel(MODEL, device="cpu", compute_type="int8")
send(event="ready", model=MODEL)

for line in sys.stdin:
    line = line.lstrip("\ufeff").strip()
    if not line:
        continue
    request = json.loads(line)
    try:
        started = time.time()
        language = request.get("language") or None
        segments, info = model.transcribe(load_16k_mono(request["audio"]), language=language, beam_size=5, vad_filter=True)
        text = " ".join(s.text.strip() for s in segments).strip()
        send(event="done", text=text, language=info.language, elapsed=time.time() - started)
    except Exception as error:
        send(event="error", message=f"{type(error).__name__}: {error}")
