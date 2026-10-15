"""NeuTTS Air worker for Mimic: voice cloning on the CPU in about 1 GB of RAM (quantized GGUF via llama.cpp).
Run with neutts-env python (-X utf8). Speaks JSON lines on stdin/stdout.

Request: {"text", "output", "ref_audio", "ref_text", "seed"?, "controls"?}. controls: gap (seconds between sentences). The reference clip should be 3-15 s.
"""
import json
import os
import sys
import time

real_out = sys.stdout
sys.stdout = sys.stderr  # library prints must not corrupt the protocol stream
sys.stdin.reconfigure(encoding="utf-8")

import numpy as np
import soundfile as sf
from neutts import NeuTTS

from chunks import GAP_SECONDS, sentences

BACKBONE = os.environ.get("NEUTTS_BACKBONE", "neuphonic/neutts-air-q4-gguf")
RATE = 24000


def send(**message):
    real_out.write(json.dumps(message) + "\n")
    real_out.flush()


tts = NeuTTS(backbone_repo=BACKBONE, backbone_device="cpu", codec_repo="neuphonic/neucodec", codec_device="cpu")
send(event="ready", model=BACKBONE, device="cpu")

references = {}  # clip path -> encoded reference, so a profile is only analyzed once

for line in sys.stdin:
    line = line.lstrip("﻿").strip()
    if not line:
        continue
    r = json.loads(line)
    try:
        if r["ref_audio"] not in references:
            references[r["ref_audio"]] = tts.encode_reference(r["ref_audio"])
        if r.get("seed") is not None:
            np.random.seed(int(r["seed"]) % 2**32)
        started = time.time()
        gap = np.zeros(int(float((r.get("controls") or {}).get("gap", GAP_SECONDS)) * RATE), dtype=np.float32)
        pieces = []
        for sentence in sentences(r["text"]):  # short inputs keep the small model on track
            if pieces:
                pieces.append(gap)
            pieces.append(np.asarray(tts.infer(sentence, references[r["ref_audio"]], r["ref_text"]), dtype=np.float32).reshape(-1))
        audio = np.concatenate(pieces)
        sf.write(r["output"], audio, RATE, subtype="PCM_16")
        send(event="done", output=r["output"], seconds=len(audio) / RATE, elapsed=time.time() - started)
    except Exception as error:  # report and keep the model loaded
        send(event="error", message=f"{type(error).__name__}: {error}")
