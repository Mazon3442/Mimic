# Mimic

A local terminal app for cloning voices. One TUI drives KittenTTS 2 and Breeze TTS 2, with launchers for Fish S2 Pro. Everything runs on your own GPU.

Only clone voices you have consent to use.

```
tts-tui.py          Textual terminal GUI (Create / Cloning / Output tabs)
kitten-say.py       one-shot Kitten CLI
tui/                persistent model workers (JSON lines over stdin/stdout), one venv each
launchers/          tts.cmd, kitten-say.cmd, start-comfyui.cmd, start-fish-server.cmd
scripts/            WSL scripts for the Fish vLLM server (serve/stop/install/check)
```

## Setup

This repo holds only the code. Venvs, models, ComfyUI, reference clips, generated audio and logs live in a separate folder, set with the `TTS_HOME` environment variable (default `C:\Users\mason\tts`). Expected layout there: `kitten-env/`, `breeze-env/`, `comfy-env/`, `tui-env/`, `models/kitten-tts-2`, `models/breeze-tts-2`, `breeze-tts/`, `ComfyUI/`.

Run one model at a time (16 GB VRAM). Use "Unload models" in the TUI before starting Fish. Python needs `-X utf8` on Windows; the launchers set it.

`tui/*.py` still hardcode the model paths under `C:\Users\mason\tts`.

## Models and licenses

The code here is MIT. No model weights are included, and each model has its own license: Breeze TTS 2 is non-commercial, and Fish S2 Pro and KittenTTS 2 have their own terms. Check them before any commercial use.
