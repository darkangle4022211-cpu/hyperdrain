#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

if [ -d "$HOME/.local/go/bin" ]; then
    export PATH="$HOME/.local/go/bin:$PATH"
fi

mkdir -p "$HOME/.cache/gotmp"
export TMPDIR="$HOME/.cache/gotmp"

echo "⚡ [HyperDrain] Compiling Go backend engine for Linux (amd64)..."
mkdir -p bin
if [ -f "$HOME/.local/bin/yt-dlp" ]; then
    cp -f "$HOME/.local/bin/yt-dlp" bin/yt-dlp
    chmod +x bin/yt-dlp
fi
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o hyperdrain .
cp -f hyperdrain hyperdrain-engine
chmod +x hyperdrain hyperdrain-engine

echo "⚡ [HyperDrain] Compiling Go backend engine for Windows (amd64)..."
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" -o hyperdrain.exe .
cp -f hyperdrain.exe hyperdrain-engine.exe

echo "✅ [HyperDrain] Both engine binaries compiled successfully!"
