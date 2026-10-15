"""KittenTTS 2 worker for tts-tui. Run with kitten-env python (-X utf8). Speaks JSON lines on stdin/stdout."""
import json
import sys
import time

real_out = sys.stdout
sys.stdout = sys.stderr  # library prints must not corrupt the protocol stream
sys.stdin.reconfigure(encoding="utf-8")

import soundfile as sf
from kittenml import KittenTTS

MODEL = r"C:\Users\mason\tts\models\kitten-tts-2"


def send(**message):
    real_out.write(json.dumps(message) + "\n")
    real_out.flush()


model = KittenTTS(MODEL)
send(event="ready", voices=list(model.available_voices))

for line in sys.stdin:
    request = json.loads(line)
    try:
        kwargs = {"reference": request["reference"]} if request.get("reference") else {"voice": request["voice"]}
        if request.get("expressive"):
            kwargs["preset"] = "expressive"
        started = time.time()
        audio = model.generate(request["text"], **kwargs)
        sf.write(request["output"], audio, model.sample_rate, subtype="PCM_16")
        send(event="done", output=request["output"], seconds=len(audio) / model.sample_rate, elapsed=time.time() - started)
    except Exception as error:  # report and keep the model loaded
        send(event="error", message=f"{type(error).__name__}: {error}")
