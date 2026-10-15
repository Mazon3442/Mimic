"""Breeze TTS 2 worker for tts-tui. Run with breeze-env python (-X utf8). Speaks JSON lines on stdin/stdout.

Mirrors breeze-tts/infer.py, but loads the model once and serves many requests.
"""
import json
import math
import os
import sys
import time
from pathlib import Path

real_out = sys.stdout
sys.stdout = sys.stderr  # library prints must not corrupt the protocol stream
sys.stdin.reconfigure(encoding="utf-8")

REPO = Path(r"C:\Users\mason\tts\breeze-tts")
MODEL = Path(r"C:\Users\mason\tts\models\breeze-tts-2")
os.chdir(REPO)
sys.path.insert(0, str(REPO))

import soundfile as sf

from breeze_infer.runtime import load_runtime, resolve_device, set_all_seeds, update_generation_config_for_breeze
from breeze_infer.templates import get_template, prepare_inputs, select_template_name
from models.fast_streaming import FastBreezeStreamingRuntime, FastStreamingConfig


def send(**message):
    real_out.write(json.dumps(message) + "\n")
    real_out.flush()


tokenizer, model, audio_tokenizer = load_runtime(MODEL, device=resolve_device(), attn_implementation="eager")
update_generation_config_for_breeze(model)
runtime = FastBreezeStreamingRuntime(
    model,
    audio_tokenizer,
    FastStreamingConfig(max_new_tokens=1500, max_seq_len=2048, repetition_penalty=1.1),
    tokenizer=tokenizer,
)
send(event="ready")

for line in sys.stdin:
    r = json.loads(line)
    try:
        instruction = (r.get("instruction") or "").strip()
        ref_audio = (r.get("ref_audio") or "").strip()
        ref_text = (r.get("ref_text") or "").strip()
        if bool(ref_audio) != bool(ref_text):
            raise ValueError("reference audio and reference text must be given together")
        if ref_audio and not Path(ref_audio).is_file():
            raise FileNotFoundError(f"Reference audio not found: {ref_audio}")
        cfg = float(r["cfg"]) if r.get("cfg") else (4.0 if instruction else 1.0)
        if not math.isfinite(cfg) or cfg <= 0:
            raise ValueError("cfg scale must be greater than 0")
        seed = int(r.get("seed") or 42)

        request = {"id": "tui-request", "text": r["text"], "speaker": "S0"}
        if instruction:
            request["instruction"] = instruction
        if ref_audio:
            request["ref_audio_path"] = ref_audio
            request["ref_text"] = ref_text

        started = time.time()
        set_all_seeds(seed)
        inputs = prepare_inputs(
            tokenizer, audio_tokenizer, model, [request],
            get_template(select_template_name(request)),
            guidance_scale=cfg, guidance_scale_ref=None, guidance_scale_ins=None,
        )
        Path(r["output"]).parent.mkdir(parents=True, exist_ok=True)
        frames = 0
        with sf.SoundFile(r["output"], mode="w", samplerate=runtime.sample_rate, channels=1, subtype="PCM_16") as out:
            for chunk in runtime.iter_audio_chunks(inputs, request_id="tui-request", seed=seed):
                out.write(chunk.audio)
                frames += len(chunk.audio)
        send(event="done", output=r["output"], seconds=frames / runtime.sample_rate, elapsed=time.time() - started)
    except Exception as error:  # report and keep the model loaded
        send(event="error", message=f"{type(error).__name__}: {error}")
