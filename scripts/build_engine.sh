#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

if [ -d "$HOME/.local/go/bin" ]; then
    export PATH="$HOME/.local/go/bin:$PATH"
fi

echo "⚡ [HyperDrain] Compiling Go backend engine for Linux (amd64)..."
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o hyperdrain .

echo "⚡ [HyperDrain] Compiling Go backend engine for Windows (amd64)..."
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" -o hyperdrain.exe .

echo "✅ [HyperDrain] Both engine binaries compiled successfully!"
