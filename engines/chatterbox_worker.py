"""Chatterbox Turbo worker for Mimic. Run with chatterbox-env python (-X utf8). Speaks JSON lines on stdin/stdout.

Start args: the model folder (a download of ResembleAI/chatterbox-turbo).
Request: {"text", "output", "ref_audio", "seed"?, "controls"?}. Clones from the clip alone (over 5 s; it listens to the first 10 s).
controls: temperature, top_p, top_k, repetition_penalty, gap (seconds between sentences).
Every take carries Resemble's inaudible PerTh watermark; the library always adds it.
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
import torch
from chatterbox.tts_turbo import ChatterboxTurboTTS

from chunks import GAP_SECONDS, sentences
from device import pick

MODEL = sys.argv[1]
MIN_CLIP = 5.0  # the library refuses anything shorter


def send(**message):
    real_out.write(json.dumps(message) + "\n")
    real_out.flush()


device, fallback = pick(torch)
model = ChatterboxTurboTTS.from_local(MODEL, device)
send(event="ready", model=MODEL, device=device, fallback=fallback)

voices = {}  # clip path -> conditionals, so a profile is only analyzed once

for line in sys.stdin:
    line = line.lstrip("﻿").strip()
    if not line:
        continue
    r = json.loads(line)
    try:
        clip = r["ref_audio"]
        if clip not in voices:
            if sf.info(clip).duration <= MIN_CLIP:
                raise ValueError(f"Chatterbox needs a clip longer than {MIN_CLIP:.0f} seconds")
            model.prepare_conditionals(clip)
            voices[clip] = model.conds
        model.conds = voices[clip]
        if r.get("seed") is not None:
            torch.manual_seed(int(r["seed"]))
        controls = r.get("controls") or {}
        sampling = {k: float(controls[k]) for k in ("temperature", "top_p", "repetition_penalty") if k in controls}
        if "top_k" in controls:
            sampling["top_k"] = int(controls["top_k"])
        gap = np.zeros(int(float(controls.get("gap", GAP_SECONDS)) * model.sr), dtype=np.float32)
        started = time.time()
        pieces = []
        for sentence in sentences(r["text"]):  # long inputs drift or get cut off in one pass
            if pieces:
                pieces.append(gap)
            pieces.append(model.generate(sentence, **sampling).squeeze(0).numpy().astype(np.float32))
        audio = np.concatenate(pieces)
        sf.write(r["output"], audio, model.sr, subtype="PCM_16")
        send(event="done", output=r["output"], seconds=len(audio) / model.sr, elapsed=time.time() - started)
    except Exception as error:  # report and keep the model loaded
        send(event="error", message=f"{type(error).__name__}: {error}")
