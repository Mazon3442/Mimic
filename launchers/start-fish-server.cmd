@echo off
rem Starts the Fish S2 Pro vLLM-Omni speech server in WSL on http://localhost:8091 (first start takes ~2-3 min).
rem Docs: POST /v1/audio/speech  (input, voice="default", ref_audio, ref_text). Output: 44.1 kHz mono WAV.
rem Uses ~15 GB of VRAM: unload the TUI models first (the TUI has an "Unload models" button).
rem Clear any old (possibly dead) server first so the port and GPU memory are free.
for /f "delims=" %%i in ('wsl wslpath -a "%~dp0..\scripts"') do set "SCRIPTS=%%i"
wsl -d Ubuntu-24.04 -u root -- bash "%SCRIPTS%/stop-fish-wsl.sh"
wsl -d Ubuntu-24.04 -u root -- bash "%SCRIPTS%/serve-fish-wsl.sh" --gpu-memory-utilization 0.95 --max-model-len 4096 --max-num-batched-tokens 4096
