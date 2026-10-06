#!/usr/bin/env bash
set -u
MODEL_DIR="${QWEN_MODEL_DIR:-models}"
MODEL_PATH="${QWEN_MODEL_PATH:-$MODEL_DIR/qwen3-0.6b-q4_k_m.gguf}"
MODEL_URL="${QWEN_MODEL_URL:-https://huggingface.co/gvij/qwen3-0.6b-gguf/resolve/main/qwen3-0.6b-q4_k_m.gguf}"
mkdir -p "$MODEL_DIR"
if [ ! -s "$MODEL_PATH" ]; then
  echo "Qwen3 model missing; downloading verified Q4_K_M model..."
  curl -fL --retry 3 --retry-delay 2 "$MODEL_URL" -o "$MODEL_PATH" || { echo "Qwen download unavailable; continuing without Qwen."; exit 0; }
fi
SHA="$(sha256sum "$MODEL_PATH" | awk '{print $1}')"
EXPECTED="3479875d3e4c726f7a20b2181f5e1536aefe9925f284f9ae9997a39a7e0d8dc9"
if [ "$SHA" != "$EXPECTED" ]; then
  echo "Qwen model SHA mismatch; continuing without Qwen."
  rm -f "$MODEL_PATH"
  exit 0
fi
if ! docker image inspect ghcr.io/ggml-org/llama.cpp:server >/dev/null 2>&1; then
  docker pull ghcr.io/ggml-org/llama.cpp:server || { echo "llama.cpp image unavailable; continuing without Qwen."; exit 0; }
fi
docker rm -f crypto-signal-qwen >/dev/null 2>&1 || true
docker run -d --name crypto-signal-qwen -p 11434:8080 -v "$(pwd)/$MODEL_DIR:/models:ro" ghcr.io/ggml-org/llama.cpp:server -m "/models/$(basename "$MODEL_PATH")" --alias qwen3-0.6b --host 0.0.0.0 --port 8080 -c 4096 --threads 4 --threads-batch 4 --parallel 1 >/tmp/crypto-signal-qwen.log 2>&1 || { echo "Qwen server failed to start; continuing without Qwen."; exit 0; }
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:11434/health >/dev/null 2>&1; then echo "Qwen3 local server ready."; exit 0; fi
  sleep 2
done
echo "Qwen server health check timed out; scanner will continue deterministically."
