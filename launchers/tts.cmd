@echo off
rem Terminal GUI for KittenTTS 2 and Breeze TTS 2. Keys: Ctrl+G generate, Ctrl+L play last, Ctrl+X stop sound, Ctrl+Q quit.
rem Code lives next to this folder; venvs, models, refs and clips live in TTS_HOME.
if not defined TTS_HOME set "TTS_HOME=C:\Users\mason\tts"
"%TTS_HOME%\tui-env\Scripts\python.exe" -X utf8 "%~dp0..\tts-tui.py" %*
