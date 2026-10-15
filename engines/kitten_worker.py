"""KittenTTS 2 worker for Mimic. Run with kitten-env python (-X utf8). Speaks JSON lines on stdin/stdout.

Request:  {"text", "output", "reference"? | "voice"?, "expressive"?, "seed"?}
Events:   {"event": "ready", "voices": [...]} once, then {"event": "done", ...} or {"event": "error", ...} per request.
"""
import json
import os
import random
import sys
import time

real_out = sys.stdout
sys.stdout = sys.stderr  # library prints must not corrupt the protocol stream
sys.stdin.reconfigure(encoding="utf-8")

import numpy
import soundfile as sf
from kittenml import KittenTTS

from chunks import GAP_SECONDS, sentences

HOME = os.environ.get("TTS_HOME", r"C:\Users\mason\tts")
MODEL = os.path.join(HOME, "models", "kitten-tts-2")


def send(**message):
    real_out.write(json.dumps(message) + "\n")
    real_out.flush()


def seed_everything(seed):
    random.seed(seed)
    try:
        import numpy
        numpy.random.seed(seed % 2**32)
    except ImportError:
        pass
    try:
        import torch
        torch.manual_seed(seed)
    except ImportError:
        pass


DEVICE = os.environ.get("MIMIC_DEVICE") or None  # "cuda" | "xpu" | "cpu"; None lets Kitten choose
model = KittenTTS(MODEL, device=DEVICE)
send(event="ready", voices=list(model.available_voices))

for line in sys.stdin:
    line = line.lstrip("\ufeff").strip()
    if not line:
        continue
    request = json.loads(line)
    try:
        kwargs = {"reference": request["reference"]} if request.get("reference") else {"voice": request.get("voice") or "Bruno"}
        if request.get("expressive"):
            kwargs["preset"] = "expressive"
        if request.get("seed") is not None:
            seed_everything(int(request["seed"]))
        started = time.time()
        # Kitten stops after the first sentence or two, so each sentence is generated on its own and joined.
        gap = numpy.zeros(int(GAP_SECONDS * model.sample_rate), dtype=numpy.float32)
        pieces = []
        for sentence in sentences(request["text"]):
            if pieces:
                pieces.append(gap)
            pieces.append(numpy.asarray(model.generate(sentence, **kwargs), dtype=numpy.float32).reshape(-1))
        audio = numpy.concatenate(pieces)
        sf.write(request["output"], audio, model.sample_rate, subtype="PCM_16")
        send(event="done", output=request["output"], seconds=len(audio) / model.sample_rate, elapsed=time.time() - started)
    except Exception as error:  # report and keep the model loaded
        send(event="error", message=f"{type(error).__name__}: {error}")
