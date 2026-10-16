"""Audio8 TTS worker for Mimic. Run with audio8-env python (-X utf8). Speaks JSON lines on stdin/stdout.

Start args: the model folder (a download of Audio8/Audio8-TTS-Preview-0.6b; its model code runs from that folder).
Request: {"text", "output", "ref_audio", "ref_text", "seed"?, "controls"?}
controls: temperature, top_p, top_k; unset keeps the model's generation_config.json.
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
from transformers import AutoModel, AutoProcessor

MODEL = sys.argv[1]
MAX_FRAMES = 1536  # about 70 s of speech; the context also has to hold the reference clip


def send(**message):
    real_out.write(json.dumps(message) + "\n")
    real_out.flush()


def pick_device():
    wanted = os.environ.get("MIMIC_DEVICE", "")
    if wanted == "cuda" and torch.cuda.is_available():
        return "cuda", torch.bfloat16
    if wanted == "xpu" and hasattr(torch, "xpu") and torch.xpu.is_available():
        return "xpu", torch.bfloat16
    if not wanted and torch.cuda.is_available():
        return "cuda", torch.bfloat16
    return "cpu", torch.float32


device, dtype = pick_device()
processor = AutoProcessor.from_pretrained(MODEL, trust_remote_code=True)
model = AutoModel.from_pretrained(MODEL, trust_remote_code=True, dtype=dtype).eval().to(device)
rate = model.config.codec_sample_rate
send(event="ready", model=MODEL, device=device)

for line in sys.stdin:
    line = line.lstrip("﻿").strip()
    if not line:
        continue
    r = json.loads(line)
    try:
        if r.get("seed") is not None:
            torch.manual_seed(int(r["seed"]))
        controls = r.get("controls") or {}
        sampling = {k: float(controls[k]) for k in ("temperature", "top_p") if k in controls}
        if "top_k" in controls:
            sampling["top_k"] = int(controls["top_k"])
        started = time.time()
        inputs = processor(text=[r["text"]], reference_audio=[r["ref_audio"]], reference_text=[r["ref_text"]], return_tensors="pt")
        inputs = {k: v.to(device) for k, v in inputs.items()}
        with torch.inference_mode():
            out = model.generate(**inputs, max_new_tokens=MAX_FRAMES, do_sample=True, return_dict_in_generate=True, **sampling)
            waves, lengths = model.decode_audio(out.codes)
        audio = waves[0, : int(lengths[0])].float().cpu().numpy().astype(np.float32)
        sf.write(r["output"], audio, rate, subtype="PCM_16")
        send(event="done", output=r["output"], seconds=len(audio) / rate, elapsed=time.time() - started)
    except Exception as error:  # report and keep the model loaded
        send(event="error", message=f"{type(error).__name__}: {error}")
