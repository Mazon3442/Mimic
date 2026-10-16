"""Qwen3-TTS worker for Mimic. Run with qwen-env python (-X utf8). Speaks JSON lines on stdin/stdout.

Start args: the Hugging Face repo of a Base model (e.g. Qwen/Qwen3-TTS-12Hz-0.6B-Base).
Request: {"text", "output", "ref_audio", "ref_text", "language"?, "seed"?, "controls"?}
controls: temperature, top_p, top_k, repetition_penalty; unset keeps the model's generate_config.json.
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
from qwen_tts import Qwen3TTSModel

REPO = sys.argv[1] if len(sys.argv) > 1 else "Qwen/Qwen3-TTS-12Hz-0.6B-Base"


def send(**message):
    real_out.write(json.dumps(message) + "\n")
    real_out.flush()


def pick_device():
    wanted = os.environ.get("MIMIC_DEVICE", "")
    if wanted == "cuda" and torch.cuda.is_available():
        return "cuda:0", torch.bfloat16
    if wanted == "xpu" and hasattr(torch, "xpu") and torch.xpu.is_available():
        return "xpu", torch.bfloat16
    if not wanted and torch.cuda.is_available():
        return "cuda:0", torch.bfloat16
    return "cpu", torch.float32  # bfloat16 is slow or unsupported on most laptop CPUs


device, dtype = pick_device()
model = Qwen3TTSModel.from_pretrained(REPO, device_map=device, dtype=dtype)
send(event="ready", model=REPO, device=device)

prompts = {}  # (clip, transcript) -> voice clone prompt, so a profile is only analyzed once

for line in sys.stdin:
    line = line.lstrip("﻿").strip()
    if not line:
        continue
    r = json.loads(line)
    try:
        key = (r["ref_audio"], r["ref_text"])
        if key not in prompts:
            prompts[key] = model.create_voice_clone_prompt(ref_audio=r["ref_audio"], ref_text=r["ref_text"])
        if r.get("seed") is not None:
            torch.manual_seed(int(r["seed"]))
        controls = r.get("controls") or {}
        sampling = {k: float(controls[k]) for k in ("temperature", "top_p", "repetition_penalty") if k in controls}
        if "top_k" in controls:
            sampling["top_k"] = int(controls["top_k"])
        started = time.time()
        # non_streaming_mode: feed the whole script before the reference audio. The library default (False)
        # interleaves it with the reference frames, which makes the first word drift off the cloned voice.
        wavs, rate = model.generate_voice_clone(text=r["text"], language=r.get("language") or "English",
                                                voice_clone_prompt=prompts[key], non_streaming_mode=True,
                                                **sampling)
        audio = np.asarray(wavs[0], dtype=np.float32).reshape(-1)
        sf.write(r["output"], audio, rate, subtype="PCM_16")
        send(event="done", output=r["output"], seconds=len(audio) / rate, elapsed=time.time() - started)
    except Exception as error:  # report and keep the model loaded
        send(event="error", message=f"{type(error).__name__}: {error}")
