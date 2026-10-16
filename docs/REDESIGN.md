# Mimic redesign plan

Status: plan only. Nothing here is built yet. Written 2026-10-15.

## 1. What this app is, and who it's for

One person (Mason) cloning voices on one 16 GB GPU with three engines that can't be loaded at once.
The job: **type a script, pick a voice, hear it fast, compare engines, keep the best take.**

What the TUI got wrong, from the setup notes:
- Engines are modelled as tabs, but the real constraint is VRAM. Fish alone takes ~15 GB. The UI never shows what is loaded.
- Breeze and Fish need the *exact* transcript of the reference clip; Kitten doesn't. The user finds this out after pressing Generate.
- Comparing engines means three separate runs, an unload, and hunting through a file list.
- Cloning is a file dialog plus a path. A voice is not a first-class object, so there is no library, no trim, no record.
- Every engine failure looks the same ("worker exited").

## 2. Stack decision

The UI language has almost no effect on perceived speed. What the user feels is: window-to-interactive time,
whether the engine is already warm, and time-to-first-audio. Those are fixed by architecture (section 4), not language.
So pick the stack for design freedom and for shipping a real `.exe`.

| Option | For | Against |
| --- | --- | --- |
| **Tauri 2 (Rust core + web UI)** | ~10 MB exe, WebView2 already installed, instant start, full CSS/canvas control, Rust supervises worker processes and audio, real installer | Needs Rust + MSVC Build Tools (several GB) installed; first compile is slow |
| Electron | Node already installed, no new toolchain | 150 MB+, slower start, heavier idle RAM |
| Python + pywebview | Zero new toolchain, reuses existing code | Python owns the UI process, no clean exe, weaker process/audio control |
| Qt/QML, WPF, egui | Native feel | Waveforms, type and motion are far harder to get distinctive; looks like a tool, not a product |

**Recommendation: Tauri 2, Svelte 5 + TypeScript + Vite, hand-written CSS from tokens.**
No component kit (shadcn, Material, etc.): kits are where the generic look comes from.
Python stays, but only as engine workers behind a protocol (section 4). Rust never imports a model.

Fallback if the Rust install is unwelcome: same Svelte frontend in pywebview. The frontend does not change; only the shell does.

## 3. Design direction

### Metaphor
A recording session, not a dashboard. Three nouns replace Create/Cloning/Output:
- **Script**: what is said.
- **Voices**: who says it (the cast).
- **Takes**: what came out. Takes are stacked and compared like takes in an ADR session.

### Layout (one screen, no tabs)

```
+-------------------------------------------------------------------------------+
| Mimic            [Engine: Breeze v]  warm  8.1 / 16.0 GB        Ctrl+K  settings|
+------------+------------------------------------------+-----------------------+
| VOICES     | SCRIPT                                   | TAKES                 |
|            |                                          |                       |
| Mason      |  Hello. This is a quick test of the      | 04  Breeze   4.2 s    |
| ~~|||~~|~~  |  voice. <laugh> Pretty good, right?      | ~~~||~~~~|||~~~~~~   |
| 14.1s  ok  |                                          |                       |
|            |                                          | 03  Kitten   3.9 s    |
| Narrator   |  [ Generate  Ctrl+Enter ]  [ All engines ]| ~~~|~~|||~~~~~~~~     |
| ~~~|~~     |                                          |                       |
| 9.8s  no   |  tags:  laugh  sigh  pause  emphasis     | 02  Fish     6.1 s    |
| transcript |                                          | ~~~~~|||||~~~~~~~     |
|            |  Needs transcript for Breeze / Fish.     |                       |
| + Record   |  Whisper filled it in. Check it.         |  A/B  blind  keep  x  |
| + Import   |                                          |                       |
+------------+------------------------------------------+-----------------------+
```

Voices are narrow waveform strips, not avatar cards. The script is the biggest thing on screen.
Takes are the only place with density; each is a waveform row you can scrub.

### Specific choices (and what they avoid)

| Choice | Avoids |
| --- | --- |
| Cool graphite (`#111213`) with off-white ink (`#ECEDE9`); light theme is cool paper (`#F4F4F1`) with graphite ink. (Bone paper with vermilion was dropped: it is the stock assistant palette.) | Blue/purple gradients, glassmorphism, neon glow, cream + terracotta |
| Slight rounding: 4 px small, 6 px controls and rows, 10 px panels and dialogs; list rows are inset so the rounding reads | Sharp boxes, or the 12-16 px "soft" default |
| One accent, tally red (`#FF4733`), the studio's "live" light: Generate, recording, playback, the VRAM preview. Nothing else is red. | Accent sprinkled on every control |
| Two faces: script in a text serif (Newsreader), UI in IBM Plex Sans with tabular figures for every number | Inter-everywhere, monospace "hacker" look |
| Regions separated by tone steps, never lines; 2 px radius; dense rows; shadows only on dialogs | Hairlines, rounded-2xl cards in a grid, resting shadows |
| **The VRAM bar is the engine picker.** Hover an engine and its footprint is outlined on the bar, with what has to unload first | A plain dropdown that hides the one constraint this app lives with |
| Waveform is the single expressive element, drawn from real peaks | Decorative blobs, fake equalizer bars, invented metrics |
| Tags (`<laugh>`) render as inline chips in the script | Emoji icons, sparkle buttons |
| Labels are domain words: Script, Voices, Takes, Warm, Cold, Unload | "Get started", "Supercharge", generic empty-state illustrations |
| No decorative copy anywhere; every number on screen is measured (VRAM from NVML, durations from audio) | Placeholder stats |

Final type and color values get settled in the mockup (phase 0), not here.

### Motion (Emil Kowalski rules applied)
- **No animation on keyboard actions.** Generate, play/pause, next/previous take, command palette: instant.
- Press feedback on buttons: `scale(0.97)`, 120 ms, ease-out.
- A take's waveform draws in once when generation finishes (occasional event). Playhead is plain linear.
- Panels and popovers: under 200 ms, `cubic-bezier(0.23, 1, 0.32, 1)`, origin-aware. Exits faster than enters.
- Only `transform` and `opacity`. CSS transitions (interruptible), not keyframes, for anything that can retrigger.
- `prefers-reduced-motion`: drop movement, keep opacity.

### Keyboard-first
`Ctrl+Enter` generate · `Space` play/pause · `1-9` jump to take · `J/K` move between takes · `A/B` flip compare ·
`Ctrl+K` command palette · `Esc` stop playback / cancel generation.

## 4. Architecture (this is where "snappy" comes from)

```
 Svelte UI  <-- Tauri IPC -->  Rust core  <-- NDJSON over stdio -->  engine workers (Python, own venvs)
 (canvas waveforms)            - process supervisor                   - kitten   (clone: clip only)
                               - SQLite (voices, takes, runs)         - breeze   (clone: clip + exact text)
                               - peaks/waveform cache                 - fish     (vLLM-Omni client, WSL server)
                               - NVML VRAM + residency policy         - whisper  (CPU, transcripts)
                               - audio device / file export
```

### Rules that make it feel fast
1. **Window opens before anything loads.** Engines start lazily in the background; UI shows `cold` honestly.
2. **One resident engine.** Rust enforces it: switching engines unloads the old one first and shows the VRAM bar move. No more OOM surprises.
3. **Idle unload** after N minutes (default 10) frees the GPU for games and other work.
4. **Stream audio when the engine can.** Breeze already has a streaming runtime. Play chunks as they arrive so time-to-first-audio drops from "whole clip" to roughly the first chunk. Fish via vLLM and Kitten get checked in phase 0.
5. **Cancel is real.** `Esc` cancels generation in the worker, not just in the UI.
6. **Pre-flight in the UI.** Missing transcript, clip too short or too long, engine not installed: shown on the Generate button before it is pressed.
7. **Everything cached.** Waveform peaks are computed once in Rust and stored. The takes list never decodes audio on scroll.

### Worker protocol v2 (NDJSON, versioned)
Replaces the current ad-hoc JSON lines. Messages: `hello` (name, version, capabilities), `load`, `unload`,
`generate` (text, voice ref, params, seed), `event` (progress, chunk, done, error), `cancel`, `status`.
Capabilities a worker declares: `needs_transcript`, `streaming`, `sample_rate`, `tags` (its own syntax), `vram_gb`.
The UI is built from capabilities, so adding a fourth engine is a worker, not a UI change.

### Data
- `%APPDATA%\Mimic\`: `mimic.db` (SQLite), `voices/`, `takes/`. Settings in the same folder.
- Voices: id, name, clip path, duration, transcript, transcript_verified, per-engine notes.
- Takes: id, voice, engine, text, params, seed, file, peaks, rating, created_at. Any take can be regenerated from its row.
- Nothing personal lives in the repo. `.gitignore` already blocks audio, `refs/`, `out/`, `logs/`.
- Engines folder (venvs, models) is a setting with auto-detect, replacing the hardcoded `C:\Users\mason\tts` paths in `tui/*.py`.

### Fish
The new app drives the vLLM-Omni server in WSL (the faster path) and owns its lifecycle: start, health check that runs
a real tiny generation (not just `/health`, which went green while every request returned 500), kill with `pkill -9`,
restart. ComfyUI is not part of Mimic (decided 2026-10-15); the vLLM server is the only Fish path.

## 5. Features, in priority order

1. **Voice profiles.** Every clone is a saved profile: name, reference clip, transcript, and its own defaults (engine, Kitten style / Breeze mode, seed). Picking a profile applies its defaults; "Save current" writes the current settings back to it. Stored in `mimic.db`, clips under `%APPDATA%\Mimic\voices\`. Created by guided recording (a passage to read aloud, so the transcript is exact) or by importing a file (ffmpeg converts to mono 24 kHz). Trim on the waveform.
2. **Automatic local speech-to-text.** As soon as a clip is recorded or imported, faster-whisper writes the transcript on the CPU. No button, no typing, no check step; the box stays editable if a word is wrong. Model size follows the machine (small.en with 16 GB+ RAM, base.en below). Engines that need a transcript wait for it a few seconds and then go.
3. **Takes are not saved automatically.** Generated audio lives in a temporary cache and is cleared when Mimic closes. **Save** (Ctrl+S) writes to the default folder (`Documents\Mimic`, configurable); **Save as…** (Ctrl+Shift+S) opens the Windows save dialog. Unsaved takes are counted in the Takes header. Waveform per take, scrub, A/B, redo with a new seed.
4. **Compare mode.** One script, one voice, run through every ready engine in sequence (one resident at a time), land as labelled takes. Optional blind mode hides engine names until you pick.
5. **Engine and VRAM panel.** Loaded engine, measured VRAM, load/unload, restart, log tail.
6. **Tag palette with per-engine dialects.** The user inserts a neutral tag; the adapter writes the engine's syntax (`[joyful]`, `<laugh>`, `(sigh)`, `<excited>`), and warns when an engine has no equivalent.
7. **Long text.** Split by sentence, generate chunks, stitch with short crossfades, regenerate a single chunk.
8. Command palette, tray icon, optional global "speak clipboard" hotkey.

### Settings (top-right button, Ctrl+,)
- **Appearance:** theme (dark / light / follow Windows), script text size.
- **Commands:** opens the command palette (Ctrl+K) and lists every shortcut.
- **Saving takes:** save folder, file-name pattern, format (WAV / FLAC / MP3), warn about unsaved takes on close.
- **Playback:** output device, play each take when it's ready.
- **Engines and memory:** idle-unload time (5 / 10 / 30 min / never), load the default engine at start, engines folder, link to Engines.
- **Recording and transcripts:** microphone, speech-to-text model size, transcript language.

### Engines for low VRAM and low RAM
Mimic detects the GPU (NVML), VRAM and RAM at start, and the engine picker only offers what fits. An **Engines** dialog lists
every engine with its device, memory need, what it clones from, license, and a fit verdict for this PC, with download and remove.

| Engine | Runs on | Memory (estimate) | Clones from | Licence | Tier |
| --- | --- | --- | --- | --- | --- |
| Fish S2 Pro (WSL vLLM) | GPU | ~14 GB VRAM | clip + transcript | research | 16 GB GPUs |
| Breeze TTS 2 | GPU | ~8 GB VRAM | clip + transcript | non-commercial | 10 GB+ GPUs |
| KittenTTS 2 | GPU | ~5 GB VRAM (to measure) | clip only | open | 6 GB+ GPUs |
| Qwen3-TTS 0.6B | GPU | ~4-6 GB VRAM (sources disagree) | clip + transcript | Apache 2.0 | small GPUs |
| Chatterbox Turbo 350M | GPU or CPU | 3.4 GB VRAM / 6.0 GB RAM (measured) | clip only (over 5 s) | MIT | small GPUs, CPU |
| VoxCPM2 2B | GPU | 6.9 GB VRAM (measured) | clip + transcript | Apache 2.0 | 8 GB+ GPUs |
| Audio8 TTS Preview 0.6B | GPU or CPU (slow) | 3.6 GB VRAM / 6.1 GB RAM (measured) | clip + transcript | Apache 2.0 | small GPUs |
| NeuTTS Air, Q4 GGUF | CPU (llama.cpp) | ~0.5-1 GB RAM | clip (3-15 s) + transcript | Apache 2.0 | no GPU / low RAM |

Candidates to check later: PocketTTS (100M, CPU-first cloning; one source only). Cactus Whistle (16.9 MB) is speech-to-text,
not TTS: a possible lighter replacement for faster-whisper transcripts on laptops.
All figures are third-party estimates; phase 0 measures each one on this machine, and Mimic records the real peak the first
time an engine loads. On a CPU-only machine the memory bar shows RAM instead of VRAM.

## 6. States the design must cover

| Area | States |
| --- | --- |
| Engine | not installed · cold · loading (with elapsed time) · warm · generating · unloading · crashed · out of memory |
| Voice | no transcript · transcript unverified · clip too short (<3 s) · clip too long (>30 s) · ready |
| Take | queued · generating (progress) · streaming · done · failed (reason + retry) · cancelled |
| Empty | no voices (record or import) · no takes · no engines found (point at engines folder) |
| Permission | microphone denied · GPU not found · WSL / Fish server unavailable |
| Read-only | engine busy: Generate disabled with the reason on the button |

## 7. Phases

**Phase 0: spike and mockup (go / no-go).**
- Install Rust and MSVC Build Tools (needs the user's OK, several GB).
- Static HTML mockup of the main screen in both themes, to settle type, color and density before any real code.
- Tauri hello-world that spawns the Kitten worker and plays one clip.
- Measure: window-to-interactive, time-to-first-audio per engine, whether Fish/Kitten can stream.
- Gate: window-to-interactive under 1 s and the toolchain behaves. Otherwise switch to the pywebview fallback.

**Phase 1: parity with the TUI.** Protocol v2, engine manager with the one-resident rule, Kitten + Breeze workers ported, Script + Voices (import) + Takes, playback.

**Phase 2: the reasons to switch.** Recording and trim, Whisper transcripts, Fish adapter, VRAM panel, compare mode.

**Phase 3: polish.** Streaming playback, long text, tag dialects, command palette, drag-out, tray.

**Phase 4: ship.** Settings and first-run engine detection, crash recovery, installer, README.

## 8. Risks

- **Rust toolchain on Windows** is the biggest unknown. Phase 0 exists to find out cheaply.
- **Streaming** may not be exposed by every engine; compare mode and caching still make it feel fast without it.
- **Whisper** adds a model download and a CPU load while a TTS engine holds the GPU. CPU int8 `small.en` keeps it off VRAM.
- **Engine updates** (the Fish worker patch, torchaudio changes) can break workers. Workers are isolated and versioned, so a break is one engine, not the app.
- **Voice cloning consent.** The app should say plainly: clone only voices you have permission to use. The README already does.

## 9. Open decisions for the user

1. Rust + MSVC Build Tools install: yes, or take the pywebview fallback?
2. Default theme: warm dark, or bone-paper light?
3. ~~Keep ComfyUI?~~ Decided: dropped. Fish runs only through the WSL vLLM server.
