#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Ensure local Go and Node are in PATH if present
if [ -d "$HOME/.local/go/bin" ]; then
    export PATH="$HOME/.local/go/bin:$PATH"
fi
if [ -d "$HOME/.local/node/bin" ]; then
    export PATH="$HOME/.local/node/bin:$PATH"
fi

# 1. Compile native binary if missing or Go available
if [ ! -f "$SCRIPT_DIR/hyperdrain" ]; then
    if command -v go &> /dev/null; then
        echo "⚡ [HyperDrain] Compiling native binary..."
        CGO_ENABLED=0 go build -ldflags="-s -w" -o hyperdrain .
    else
        echo "[!] Pre-compiled 'hyperdrain' binary not found and 'go' compiler is missing."
        exit 1
    fi
fi
chmod +x "$SCRIPT_DIR/hyperdrain" 2>/dev/null || true

# 2. Keep ~/hyperdrain-extension synchronized for browsers
if [ -d "$HOME/hyperdrain-extension" ]; then
    cp -ru "$SCRIPT_DIR/extension/"* "$HOME/hyperdrain-extension/" 2>/dev/null || true
fi

# 3. Stop any stale instances
killall -9 hyperdrain 2>/dev/null || pkill -9 -f "hyperdrain" 2>/dev/null || true
sleep 0.3

# 4. Launch Desktop App
ELECTRON_BIN=""
if [ -f "$SCRIPT_DIR/node_modules/.bin/electron" ]; then
    ELECTRON_BIN="$SCRIPT_DIR/node_modules/.bin/electron"
elif command -v electron &>/dev/null; then
    ELECTRON_BIN="electron"
fi

if [ -n "$ELECTRON_BIN" ]; then
    echo "⚡ [HyperDrain] Launching Native Desktop App with Built-in Video Browser..."
    exec "$ELECTRON_BIN" --no-sandbox "$SCRIPT_DIR" "$@"
else
    echo "⚡ [HyperDrain] Launching HyperDrain 32GB High-Speed Downloader..."
    exec "$SCRIPT_DIR/hyperdrain" "$@"
fi
