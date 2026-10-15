#!/usr/bin/env bash
set -euxo pipefail
export PATH="/root/.local/bin:$PATH"
cd /root/fish
source .venv/bin/activate
git config --global http.version HTTP/1.1
uv pip install "vllm==0.31.0"
uv pip install fish-speech
uv pip list 2>/dev/null | grep -iE '^(vllm|vllm-omni|torch|torchaudio|transformers|numpy|fish-speech) '
python -c "import vllm; print('vllm', vllm.__version__)"
python -c "import torch; print('torch', torch.__version__, 'cuda', torch.cuda.is_available(), torch.cuda.get_device_name(0))"
python -c "import torchaudio; print('torchaudio', torchaudio.__version__)"
python -c "import vllm_omni; print('vllm_omni import ok')"
python -c "from vllm_omni.attention import fish_kvcache_attn; print('kvcache fast path', fish_kvcache_attn.is_available(), fish_kvcache_attn.load_error())" || true
echo "VLLM INSTALL COMPLETE"
