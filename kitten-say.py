"""Generate speech with KittenTTS 2. Run through kitten-say.cmd (it sets UTF-8 mode, which kittenml needs on Windows)."""
import argparse
import time

import soundfile as sf
from kittenml import KittenTTS

p = argparse.ArgumentParser()
p.add_argument("text", help="text to speak")
p.add_argument("-r", "--reference", help="5-30 s wav of one speaker to clone")
p.add_argument("-v", "--voice", default="Bruno", help="built-in voice when no reference is given")
p.add_argument("-o", "--output", default=r"C:\Users\mason\tts\out\kitten_out.wav")
p.add_argument("--expressive", action="store_true", help='use preset="expressive" (tags like [joyful] <laugh> (((word))))')
p.add_argument("--list-voices", action="store_true")
a = p.parse_args()

m = KittenTTS(r"C:\Users\mason\tts\models\kitten-tts-2")
if a.list_voices:
    print(", ".join(m.available_voices))
    raise SystemExit

kwargs = {"reference": a.reference} if a.reference else {"voice": a.voice}
if a.expressive:
    kwargs["preset"] = "expressive"
t = time.time()
audio = m.generate(a.text, **kwargs)
sf.write(a.output, audio, m.sample_rate)
print(f"saved {a.output} ({len(audio) / m.sample_rate:.1f}s audio in {time.time() - t:.1f}s)")
