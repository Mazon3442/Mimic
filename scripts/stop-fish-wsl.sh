#!/usr/bin/env bash
# Kills any running or half-dead Fish vLLM server so the port and GPU memory are free.
pkill -9 -f "vllm serve"
pkill -9 -f EngineCore
sleep 3
exit 0
