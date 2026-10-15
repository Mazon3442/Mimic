#!/usr/bin/env bash
# Sets up WSL Ubuntu to build and test Mimic's Linux version (Tauri needs WebKitGTK 4.1).
# Usage (from Windows): wsl -d Ubuntu-24.04 -u root -- bash /mnt/c/.../packaging/wsl-linux-dev-setup.sh
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update -q
apt-get install -y -q build-essential curl wget file pkg-config libssl-dev libxdo-dev \
  libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
  nodejs npm ffmpeg pciutils xvfb imagemagick xdg-user-dirs >/dev/null

if ! command -v cargo >/dev/null && [ ! -x "$HOME/.cargo/bin/cargo" ]; then
  curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal >/dev/null
fi
if ! command -v uv >/dev/null && [ ! -x "$HOME/.local/bin/uv" ]; then
  curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null
fi
"$HOME/.cargo/bin/rustc" --version
node --version
echo "LINUX DEV SETUP COMPLETE"
