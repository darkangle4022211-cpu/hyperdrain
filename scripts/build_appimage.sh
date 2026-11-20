#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

VERSION="${1:-$(node -p "require('./package.json').version" 2>/dev/null || echo "1.0.9")}"
APPIMAGE_NAME="HyperDrain-${VERSION}.AppImage"
APPIMAGE_PATH="$DIR/dist-electron/${APPIMAGE_NAME}"

echo "========================================================="
echo " ⚡ Building HyperDrain Native AppImage Package (${VERSION}) ⚡"
echo "========================================================="

# 1. Compile backend engine binaries
echo "1. Compiling Go backend engine binaries..."
bash "$DIR/scripts/build_engine.sh"
cp -f "$DIR/hyperdrain" "$DIR/hyperdrain-engine"
chmod 755 "$DIR/hyperdrain-engine" "$DIR/hyperdrain"

# 2. Populate bundled bin/ utilities (engine, yt-dlp, ffmpeg)
echo "2. Preparing bundled utilities in bin/..."
mkdir -p "$DIR/bin"
cp -f "$DIR/hyperdrain-engine" "$DIR/bin/hyperdrain-engine"
cp -f "$DIR/hyperdrain-engine" "$DIR/bin/hyperdrain"

YTDLP_BIN="/home/hamza/.local/bin/yt-dlp"
if [ ! -f "$YTDLP_BIN" ]; then
    YTDLP_BIN="$(command -v yt-dlp 2>/dev/null || true)"
fi
if [ -f "$YTDLP_BIN" ]; then
    echo "   • Bundling yt-dlp from $YTDLP_BIN..."
    cp -f "$YTDLP_BIN" "$DIR/bin/yt-dlp"
fi

FFMPEG_BIN="/usr/bin/ffmpeg"
if [ ! -f "$FFMPEG_BIN" ]; then
    FFMPEG_BIN="$(command -v ffmpeg 2>/dev/null || true)"
fi
if [ -f "$FFMPEG_BIN" ]; then
    echo "   • Bundling ffmpeg from $FFMPEG_BIN..."
    cp -f "$FFMPEG_BIN" "$DIR/bin/ffmpeg"
fi
chmod 755 "$DIR/bin/"* 2>/dev/null || true

# 3. Package Electron app via electron-builder to generate AppImage
echo "3. Packaging Linux AppImage via electron-builder..."
mkdir -p "$DIR/dist-electron"
rm -f "$APPIMAGE_PATH"
./node_modules/.bin/electron-builder --linux AppImage

if [ ! -f "$APPIMAGE_PATH" ]; then
    echo "❌ Error: Expected AppImage not found at $APPIMAGE_PATH"
    exit 1
fi

# 4. Repack AppImage for sandbox-safe execution and self-contained bin/ bundling
echo "4. Repacking AppImage for sandbox-safe execution..."
RUNTIME_BIN="$HOME/.cache/electron-builder/appimage/appimage-12.0.1/runtime-x64"
MKSQUASHFS_BIN="$HOME/.cache/electron-builder/appimage/appimage-12.0.1/linux-x64/mksquashfs"

if [ ! -f "$RUNTIME_BIN" ] || [ ! -x "$MKSQUASHFS_BIN" ]; then
    echo "❌ Error: AppImage runtime or mksquashfs missing in $HOME/.cache/electron-builder/appimage/appimage-12.0.1"
    exit 1
fi

REPACK_TMP="$(mktemp -d)"
trap 'rm -rf "$REPACK_TMP"' EXIT

(
    cd "$REPACK_TMP"
    "$APPIMAGE_PATH" --appimage-extract >/dev/null
    rm -f squashfs-root/chrome-sandbox
    rm -f squashfs-root/resources/app/*.exe

    mkdir -p squashfs-root/bin squashfs-root/resources/app/bin
    cp -f "$DIR/bin/"* squashfs-root/bin/
    cp -f "$DIR/bin/"* squashfs-root/resources/app/bin/
    chmod 755 squashfs-root/bin/* squashfs-root/resources/app/bin/*
    chmod 755 squashfs-root/resources/app/hyperdrain-engine squashfs-root/resources/app/hyperdrain 2>/dev/null || true

    # Ensure bundled bin/ directories are on PATH and --no-sandbox is always applied for Chromium
    python3 - squashfs-root/AppRun << 'PYEOF'
import sys

apprun_path = sys.argv[1]
with open(apprun_path, 'r', encoding='utf-8') as f:
    text = f.read()

old_path_line = 'export PATH="${APPDIR}:${APPDIR}/usr/sbin:${PATH}"'
new_path_line = 'export PATH="${APPDIR}/bin:${APPDIR}/resources/app/bin:${APPDIR}:${APPDIR}/usr/sbin:${PATH}"'
if old_path_line not in text:
    raise RuntimeError('Expected PATH export line not found in AppRun')
text = text.replace(old_path_line, new_path_line, 1)

old_atexit = '''atexit()
{
  if [ $isEulaAccepted == 1 ] ; then
    if [ $NUMBER_OF_ARGS -eq 0 ] ; then
      exec "$BIN"
    else
      exec "$BIN" "${args[@]}"
    fi
  fi
}'''

new_atexit = '''atexit()
{
  if [ $isEulaAccepted == 1 ] ; then
    if [ -n "$ELECTRON_RUN_AS_NODE" ] ; then
      exec "$BIN" "${args[@]}"
    elif [ $NUMBER_OF_ARGS -eq 0 ] ; then
      exec "$BIN" --no-sandbox --disable-gpu-watchdog
    else
      exec "$BIN" --no-sandbox --disable-gpu-watchdog "${args[@]}"
    fi
  fi
}'''

if old_atexit not in text:
    raise RuntimeError('Expected atexit() block not found in AppRun')
text = text.replace(old_atexit, new_atexit, 1)

with open(apprun_path, 'w', encoding='utf-8') as f:
    f.write(text)
PYEOF
    chmod 755 squashfs-root/AppRun
    if [ -f squashfs-root/hyperdrain.desktop ]; then
        sed -i 's/^StartupWMClass=.*/StartupWMClass=hyperdrain/' squashfs-root/hyperdrain.desktop
    fi

    "$MKSQUASHFS_BIN" squashfs-root app.squashfs -comp gzip -root-owned -noappend >/dev/null
    cat "$RUNTIME_BIN" app.squashfs > "$APPIMAGE_PATH"
    chmod 755 "$APPIMAGE_PATH"
)

# 5. Publish and install AppImage deliverables locally
mkdir -p "$DIR/releases" "$HOME/Applications" "$HOME/.local/bin" "$HOME/.local/share/applications" "$HOME/.config/autostart" "$HOME/.local/share/icons/hicolor/512x512/apps"
INSTALLED_APPIMAGE="$HOME/Applications/HyperDrain.AppImage"
cp -f "$APPIMAGE_PATH" "$DIR/releases/${APPIMAGE_NAME}"
cp -f "$APPIMAGE_PATH" "/run/media/hamza/Disk D/${APPIMAGE_NAME}"
cp -f "$APPIMAGE_PATH" "/run/media/hamza/Disk D/HyperDrain.AppImage"
cp -f "$APPIMAGE_PATH" "$HOME/${APPIMAGE_NAME}"
cp -f "$APPIMAGE_PATH" "$HOME/HyperDrain.AppImage"
cp -f "$APPIMAGE_PATH" "$INSTALLED_APPIMAGE"
chmod 755 \
    "$DIR/releases/${APPIMAGE_NAME}" \
    "/run/media/hamza/Disk D/${APPIMAGE_NAME}" \
    "/run/media/hamza/Disk D/HyperDrain.AppImage" \
    "$HOME/${APPIMAGE_NAME}" \
    "$HOME/HyperDrain.AppImage" \
    "$INSTALLED_APPIMAGE"

if [ -f "$DIR/assets/hyperdrain.png" ]; then
    cp -f "$DIR/assets/hyperdrain.png" "$HOME/.local/share/icons/hicolor/512x512/apps/hyperdrain.png"
fi

cat << EOF > "$HOME/.local/bin/hyperdrain"
#!/bin/sh
exec "$INSTALLED_APPIMAGE" --no-sandbox "\$@"
EOF
chmod 755 "$HOME/.local/bin/hyperdrain"

cat << EOF > "$HOME/.local/share/applications/hyperdrain.desktop"
[Desktop Entry]
Type=Application
Name=HyperDrain
Comment=32GB High-Speed Resilient Downloader with Universal Extension
Exec="$INSTALLED_APPIMAGE" --no-sandbox %U
Icon=hyperdrain
Terminal=false
Categories=Network;FileTransfer;AudioVideo;
StartupWMClass=hyperdrain
MimeType=x-scheme-handler/hyperdrain;
EOF
chmod 644 "$HOME/.local/share/applications/hyperdrain.desktop"
rm -f "$HOME/.local/share/applications/HyperDrain.desktop"

cat << EOF > "$HOME/.config/autostart/hyperdrain.desktop"
[Desktop Entry]
Type=Application
Name=HyperDrain
Comment=32GB High-Speed Resilient Downloader
Exec="$INSTALLED_APPIMAGE" --no-sandbox --hidden
Icon=hyperdrain
Terminal=false
Categories=Network;FileTransfer;
StartupNotify=false
X-GNOME-Autostart-enabled=true
EOF
chmod 644 "$HOME/.config/autostart/hyperdrain.desktop"

rm -f \
    "$DIR/dist-electron"/hyperdrain*.deb \
    "$DIR/releases"/hyperdrain*.deb \
    "/run/media/hamza/Disk D"/hyperdrain*.deb \
    "$HOME"/hyperdrain*.deb

echo "========================================================="
echo " ✅ SUCCESS: AppImage Package Built & Installed!"
echo "========================================================="
ls -lh "$APPIMAGE_PATH"
echo ""
echo "📍 AppImage deliverables updated at:"
echo "   1. $APPIMAGE_PATH"
echo "   2. /run/media/hamza/Disk D/${APPIMAGE_NAME}"
echo "   3. /run/media/hamza/Disk D/HyperDrain.AppImage"
echo "   4. $HOME/${APPIMAGE_NAME}"
echo "   5. $HOME/HyperDrain.AppImage"
echo "   6. $INSTALLED_APPIMAGE (installed launcher & desktop entry)"
echo "========================================================="
