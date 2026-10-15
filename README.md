# Mimic

A local voice-cloning app for Windows. Write a script, pick a voice profile, and generate speech with KittenTTS 2, Breeze TTS 2 or Fish S2 Pro, all on your own GPU. Nothing leaves your PC.

Only clone voices you have consent to use.

## What it does

- **Voice profiles.** Record a voice (you read a set passage, so the transcript is exact), import a clip, or drop audio files onto the window. Each profile keeps its clip, transcript and default engine settings.
- **Engines you can download.** Settings > Engines lists every engine Mimic knows, what it needs, and whether it fits this PC. Qwen3-TTS 0.6B and 1.7B download from there (an isolated environment with CUDA PyTorch, then the model). Pin the engines you want in the top bar.
- **Automatic transcripts.** Imported clips are transcribed locally by faster-whisper on the CPU, so Breeze and Fish can clone them without you typing anything.
- **One engine in memory at a time.** The bar at the top shows real VRAM use and doubles as the engine picker. Switching engines unloads the old one first; idle engines unload after a set time.
- **Takes aren't saved automatically.** They sit in a temporary cache until you press Save (Ctrl+S) or Save as (Ctrl+Shift+S). WAV, FLAC or MP3.
- **Compare engines**, optionally blind, to pick the best take.

## Layout

```
app/ui/            the interface (HTML, CSS, JS; fonts bundled)
app/src-tauri/     the Rust core (Tauri 2): engine manager, Fish server control, profiles, saving
engines/           Python workers, one per engine, each run from its own venv
scripts/           WSL scripts for the Fish vLLM-Omni server
design/            the clickable design mockup
docs/REDESIGN.md   design plan and decisions
tui/, tts-tui.py   the old terminal app (superseded by app/)
```

## Engines folder

Mimic's code ships the workers, but the heavy parts live in an engines folder (Settings > Engines folder, default `%USERPROFILE%\tts`):

```
kitten-env/   models/kitten-tts-2/                     KittenTTS 2
breeze-env/   models/breeze-tts-2/   breeze-tts/        Breeze TTS 2
stt-env/      (pip install faster-whisper soundfile)    transcripts
qwen-env/     models/Qwen3-TTS-12Hz-*-Base/             Qwen3-TTS (downloaded by Mimic)
```

Engines can also be downloaded from the command line: `mimic.exe --install qwen06` (or `qwen17`). Downloads need [uv](https://docs.astral.sh/uv/).

Measured VRAM on an RTX 5070 Ti: Kitten about 8.8 GB when cloning (4.7 GB with built-in voices), Qwen 0.6B about 2.5 GB, Qwen 1.7B about 4.7 GB.

For automated testing, `MIMIC_TEST="import:C:\clip.wav;engine:qwen06;generate;save"` runs steps inside the app and logs them to `logs\ui.log`; the window opens without taking focus.

Fish S2 Pro runs in WSL (`Ubuntu-24.04`) via `scripts/setup-vllm-wsl.sh`; set `FISH_WEIGHTS` to the folder with the weights.
ffmpeg must be on PATH (import, recording, MP3/FLAC export).

## Build

Needs Rust (stable, MSVC) and the Microsoft C++ Build Tools.

```
cd app/src-tauri
cargo run                                   # development
npx @tauri-apps/cli@2 build                 # release exe + installer in target/release/bundle/nsis
```

User data lives in `%APPDATA%\com.mazon.mimic` (profiles, voice clips, settings) and `%LOCALAPPDATA%\com.mazon.mimic` (take cache, logs).

## Linux (Arch, Hyprland, Caelestia)

Mimic runs natively on Linux (Wayland or X11). On Arch:

```
sudo pacman -S --needed uv ffmpeg pciutils xdg-user-dirs webkit2gtk-4.1
cd packaging/arch && makepkg -si        # builds the tagged release set in pkgver
```

Release tags also publish a `.deb`, `.rpm` and AppImage.

- **Caelestia:** with Caelestia installed, the Theme setting defaults to *Caelestia*. Mimic reads the live scheme from `~/.local/state/caelestia/scheme.json` and re-colors itself when the wallpaper changes.
- **Hyprland:** the window has no GTK title bar (Hyprland draws borders). Its class is `mimic`, e.g. `windowrulev2 = float, class:^(mimic)$`.
- **Where models run:** Settings › Run engines on. *Automatic* uses an NVIDIA GPU (CUDA), an Intel Arc-class GPU (XPU, experimental), or the CPU. Older Intel graphics (Iris Xe, UHD) aren't supported by PyTorch, so those laptops use the CPU.
- **Engines on a laptop CPU** (measured on a 16-thread CPU; a laptop will be slower):

  | Engine | RAM | Speed | Notes |
  | --- | --- | --- | --- |
  | NeuTTS Air | about 1 GB | quick | Built for CPUs. Needs a free Hugging Face account, `espeak-ng`, and `cmake` + `base-devel` to build llama.cpp |
  | Qwen3-TTS 0.6B | 5.6 GB | ~17 s for 3.6 s of speech | Good on 16 GB laptops |
  | Qwen3-TTS 1.7B | 10.9 GB | ~26 s for 4.6 s | Needs 16 GB+ |
  | KittenTTS 2 | 14.5 GB | ~38 s for 7 s | Too heavy for most laptops on the CPU |

- **NeuTTS and Hugging Face:** its models are gated (free, instant approval). Sign in at huggingface.co, accept the terms on [neutts-air-q4-gguf](https://huggingface.co/neuphonic/neutts-air-q4-gguf) and [neucodec](https://huggingface.co/neuphonic/neucodec), create a read token, and paste it in Settings › Engines and memory.
- Engines and models live in `~/.local/share/mimic/engines`; profiles and settings in `~/.local/share/com.mazon.mimic`. Breeze and Fish are Windows/NVIDIA-only for now.

## Models and licenses

The code here is MIT. No model weights are included, and each model has its own license: Breeze TTS 2 is non-commercial, and Fish S2 Pro and KittenTTS 2 have their own terms. Check them before any commercial use.
