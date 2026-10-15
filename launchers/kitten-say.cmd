@echo off
rem Usage: kitten-say.cmd "text to speak" [-r my_voice.wav] [-v Bruno] [-o out.wav] [--expressive] [--list-voices]
if not defined TTS_HOME set "TTS_HOME=C:\Users\mason\tts"
"%TTS_HOME%\kitten-env\Scripts\python.exe" -X utf8 "%~dp0..\kitten-say.py" %*
