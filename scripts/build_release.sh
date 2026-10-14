#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

echo "⚡ [HyperDrain] Starting Full Desktop Release Packaging..."

# 1. Compile engine binaries
bash "$SCRIPT_DIR/scripts/build_engine.sh"

# 2. Prepare staging directory
DIST_DIR="$SCRIPT_DIR/dist-release"
STAGE_DIR="$DIST_DIR/HyperDrain-Desktop-Release"
rm -rf "$STAGE_DIR" "$DIST_DIR/HyperDrain-Desktop-Release.zip"
mkdir -p "$STAGE_DIR"

echo "📦 [HyperDrain] Bundling desktop application files..."
cp -r assets electron extension webui "$STAGE_DIR/"
cp hyperdrain hyperdrain.exe package.json update.json HyperDrain.desktop HyperDrain.bat start.sh "$STAGE_DIR/"

# Friendly Quick Start Guide
cat << 'EOF' > "$STAGE_DIR/README.txt"
===================================================================
 ⚡ HyperDrain — 32GB High-Speed Resilient Downloader
===================================================================

Thank you for using HyperDrain!

HOW TO RUN:
-------------------------------------------------------------------
ON LINUX:
1. Double-click "start.sh" (or run "./start.sh" in terminal).
2. The native desktop app window will launch!

ON WINDOWS:
1. Double-click "HyperDrain.bat".
2. The desktop app window will open automatically!

FEATURES:
-------------------------------------------------------------------
1. "Active Downloads"  : 32-stream accelerated parallel multi-part engine.
2. "Browser Extension" : Universal Manifest V3 extension ready to load
                         into Chrome, Brave, Edge, or Firefox.
3. "Online Auto-Update": Built-in delta updates with high-speed download.

Enjoy ultra-fast, resilient downloads!
===================================================================
EOF

# Ensure execute permissions on Unix binaries
chmod +x "$STAGE_DIR/hyperdrain" "$STAGE_DIR/start.sh"

echo "📦 [HyperDrain] Creating distributable ZIP package..."
cd "$DIST_DIR"
zip -r "HyperDrain-Desktop-Release.zip" "HyperDrain-Desktop-Release" -x "*.git*"

echo "✅ [HyperDrain] Release package created successfully!"
echo "📍 Location: $DIST_DIR/HyperDrain-Desktop-Release.zip"
ls -lh "$DIST_DIR/HyperDrain-Desktop-Release.zip"
