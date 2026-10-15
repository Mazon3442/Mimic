#!/usr/bin/env bash
export PATH="/root/.local/bin:$PATH"
cd /root/fish
uv pip list --python .venv/bin/python 2>&1 | grep -iE '^(vllm|vllm-omni|torch|fish-speech|fish_speech|transformers|flash|triton|numpy|pyaudio)' || echo "none of the key packages matched"
echo "--- total packages:"; uv pip list --python .venv/bin/python 2>&1 | wc -l
ls /root/fish/s2-pro | head -20
du -sh /root/fish/s2-pro
