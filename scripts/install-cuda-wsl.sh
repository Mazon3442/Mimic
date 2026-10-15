#!/usr/bin/env bash
# CUDA toolkit only (no driver) from NVIDIA's WSL-Ubuntu repo; the GPU driver comes from Windows.
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive
cd /tmp
curl -fsSLO https://developer.download.nvidia.com/compute/cuda/repos/wsl-ubuntu/x86_64/cuda-keyring_1.1-1_all.deb
dpkg -i cuda-keyring_1.1-1_all.deb
apt-get update
apt-get install -y cuda-toolkit-13-0
/usr/local/cuda-13.0/bin/nvcc --version
echo "CUDA INSTALL COMPLETE"
