#!/usr/bin/env bash
# Installs vLLM-Omni + fish-speech inside WSL Ubuntu and copies the Fish S2 Pro weights onto the Linux disk.
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y curl git build-essential python3-dev python3.12-dev libportaudio2 portaudio19-dev libsndfile1 sox ffmpeg ca-certificates

if ! command -v uv >/dev/null; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi
export PATH="$HOME/.local/bin:$PATH"

mkdir -p /root/fish && cd /root/fish
[ -d .venv ] || uv venv --python 3.12 .venv
source .venv/bin/activate

git config --global http.version HTTP/1.1
for attempt in 1 2 3 4; do
  uv pip install git+https://github.com/vllm-project/vllm-omni.git && break
  echo "vllm-omni install attempt $attempt failed, retrying"; sleep 10
done
uv pip install fish-speech

# Where the Fish S2 Pro weights are on the Windows side. Override with FISH_WEIGHTS=/mnt/c/... if you move them.
FISH_WEIGHTS="${FISH_WEIGHTS:-/mnt/c/Users/mason/tts/ComfyUI/models/TTS/fish_audio_s2_pro}"
if [ ! -f /root/fish/s2-pro/codec.pth ]; then
  if [ ! -d "$FISH_WEIGHTS" ]; then
    echo "Fish weights not found at $FISH_WEIGHTS. Set FISH_WEIGHTS to the folder holding codec.pth." >&2
    exit 1
  fi
  mkdir -p /root/fish/s2-pro
  cp -r "$FISH_WEIGHTS"/. /root/fish/s2-pro/
  rm -rf /root/fish/s2-pro/.cache
fi

python -c "import vllm, sys; print('vllm', vllm.__version__)"
python -c "import torch; print('torch', torch.__version__, torch.cuda.is_available())"
python -c "from vllm_omni.attention import fish_kvcache_attn; print('kvcache fast path', fish_kvcache_attn.is_available(), fish_kvcache_attn.load_error())" || true
echo "SETUP COMPLETE"
