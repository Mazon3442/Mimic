"""VoxCPM2 worker for Mimic. Run with voxcpm-env python (-X utf8). Speaks JSON lines on stdin/stdout.

Start args: the model folder (a download of openbmb/VoxCPM2).
Request: {"text", "output", "ref_audio", "ref_text", "seed"?, "controls"?}
controls: cfg (guidance), steps (diffusion steps per frame; more is cleaner and slower).
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
from voxcpm import VoxCPM

from device import pick

MODEL = sys.argv[1]


def send(**message):
    real_out.write(json.dumps(message) + "\n")
    real_out.flush()


device, fallback = pick(torch)
# optimize=False skips torch.compile, which needs Triton (not available on Windows) and slows the first take.
model = VoxCPM.from_pretrained(MODEL, load_denoiser=False, optimize=False, local_files_only=True, device=device)
rate = model.tts_model.sample_rate
send(event="ready", model=MODEL, device=device, fallback=fallback)

for line in sys.stdin:
    line = line.lstrip("﻿").strip()
    if not line:
        continue
    r = json.loads(line)
    try:
        if r.get("seed") is not None:
            torch.manual_seed(int(r["seed"]))
        controls = r.get("controls") or {}
        started = time.time()
        # The clip goes in twice, as the model card recommends for the closest likeness: once as the speaker
        # reference and once, with its transcript, as the recording the new speech continues from.
        audio = model.generate(text=r["text"], reference_wav_path=r["ref_audio"],
                               prompt_wav_path=r["ref_audio"], prompt_text=r["ref_text"],
                               cfg_value=float(controls.get("cfg", 2.0)),
                               inference_timesteps=int(controls.get("steps", 10)))
        audio = np.asarray(audio, dtype=np.float32).reshape(-1)
        sf.write(r["output"], audio, rate, subtype="PCM_16")
        send(event="done", output=r["output"], seconds=len(audio) / rate, elapsed=time.time() - started)
    except Exception as error:  # report and keep the model loaded
        send(event="error", message=f"{type(error).__name__}: {error}")
