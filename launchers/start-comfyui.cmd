@echo off
rem Starts ComfyUI (with the Fish S2 Pro workflow) and opens it in your browser. Close this window to stop it.
rem If ComfyUI is already running, it just opens the page.
if not defined TTS_HOME set "TTS_HOME=C:\Users\mason\tts"
curl -s -m 2 http://127.0.0.1:8188/system_stats >nul 2>&1
if not errorlevel 1 (
    echo ComfyUI is already running - opening http://127.0.0.1:8188
    start "" http://127.0.0.1:8188
    timeout /t 3 >nul
    exit /b 0
)
cd /d "%TTS_HOME%\ComfyUI"
"%TTS_HOME%\comfy-env\Scripts\python.exe" -X utf8 main.py --port 8188 --auto-launch
