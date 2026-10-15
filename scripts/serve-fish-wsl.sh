#!/usr/bin/env bash
# Starts the Fish S2 Pro OpenAI-compatible speech server (port 8091). Extra args are passed to vllm serve.
export CUDA_HOME=/usr/local/cuda-13.0
export PATH="$CUDA_HOME/bin:/root/.local/bin:$PATH"
cd /root/fish
source .venv/bin/activate
exec vllm serve /root/fish/s2-pro --served-model-name fishaudio/s2-pro --omni --host 0.0.0.0 --port 8091 "$@"
