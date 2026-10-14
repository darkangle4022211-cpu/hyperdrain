#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

VERSION="${1:-$(node -p "require('./package.json').version" 2>/dev/null || echo "1.0.4")}"
PKG_NAME="hyperdrain_${VERSION}_amd64"

echo "========================================================="
echo " ⚡ Building HyperDrain Native Debian Package (${VERSION}) ⚡"
echo "========================================================="

# 1. Ensure Go backend engines are built
echo "1. Compiling backend engine binaries..."
bash "$DIR/scripts/build_engine.sh"
cp -f "$DIR/hyperdrain" "$DIR/hyperdrain-engine"

# 2. Package electron app using electron-builder to generate linux-unpacked
echo "2. Packaging electron application (linux-unpacked)..."
rm -rf "$DIR/dist-electron/linux-unpacked"
./node_modules/.bin/electron-builder --dir --linux

# 3. Assemble Debian package structure
PKG_DIR="/tmp/hyperdrain-deb-build"
rm -rf "$PKG_DIR"
mkdir -p "$PKG_DIR/DEBIAN"
mkdir -p "$PKG_DIR/opt/hyperdrain"
mkdir -p "$PKG_DIR/usr/bin"
mkdir -p "$PKG_DIR/usr/share/applications"
mkdir -p "$PKG_DIR/usr/share/pixmaps"
mkdir -p "$PKG_DIR/usr/share/icons/hicolor/512x512/apps"
mkdir -p "$PKG_DIR/usr/share/icons/hicolor/256x256/apps"
mkdir -p "$PKG_DIR/usr/share/icons/hicolor/128x128/apps"
mkdir -p "$PKG_DIR/usr/share/icons/hicolor/48x48/apps"
mkdir -p "$PKG_DIR/usr/share/icons/hicolor/16x16/apps"

echo "3. Assembling application binaries and resources..."
cp -r "$DIR/dist-electron/linux-unpacked/"* "$PKG_DIR/opt/hyperdrain/"

# Copy high-res and extension icons
if [ -f "$DIR/assets/hyperdrain.png" ]; then
    cp "$DIR/assets/hyperdrain.png" "$PKG_DIR/usr/share/icons/hicolor/512x512/apps/hyperdrain.png"
    cp "$DIR/assets/hyperdrain.png" "$PKG_DIR/usr/share/icons/hicolor/256x256/apps/hyperdrain.png"
    cp "$DIR/assets/hyperdrain.png" "$PKG_DIR/usr/share/pixmaps/hyperdrain.png"
fi
if [ -f "$DIR/extension/icons/icon128.png" ]; then
    cp "$DIR/extension/icons/icon128.png" "$PKG_DIR/usr/share/icons/hicolor/128x128/apps/hyperdrain.png"
fi
if [ -f "$DIR/extension/icons/icon48.png" ]; then
    cp "$DIR/extension/icons/icon48.png" "$PKG_DIR/usr/share/icons/hicolor/48x48/apps/hyperdrain.png"
fi
if [ -f "$DIR/extension/icons/icon16.png" ]; then
    cp "$DIR/extension/icons/icon16.png" "$PKG_DIR/usr/share/icons/hicolor/16x16/apps/hyperdrain.png"
fi

# Ensure chrome-sandbox has 4755 permissions
if [ -f "$PKG_DIR/opt/hyperdrain/chrome-sandbox" ]; then
    chmod 4755 "$PKG_DIR/opt/hyperdrain/chrome-sandbox"
fi

# Bundle Go engine and utilities into /opt/hyperdrain/bin/
mkdir -p "$PKG_DIR/opt/hyperdrain/bin"
cp "$DIR/hyperdrain-engine" "$PKG_DIR/opt/hyperdrain/bin/hyperdrain-engine"
cp "$DIR/hyperdrain-engine" "$PKG_DIR/opt/hyperdrain/bin/hyperdrain"
chmod 755 "$PKG_DIR/opt/hyperdrain/bin/"*

# Bundle yt-dlp
YTDLP_BIN="/home/hamza/.local/bin/yt-dlp"
if [ ! -f "$YTDLP_BIN" ]; then
    YTDLP_BIN="$(which yt-dlp 2>/dev/null || true)"
fi
if [ -f "$YTDLP_BIN" ]; then
    echo "   • Bundling yt-dlp..."
    cp "$YTDLP_BIN" "$PKG_DIR/opt/hyperdrain/bin/yt-dlp"
    chmod 755 "$PKG_DIR/opt/hyperdrain/bin/yt-dlp"
fi

# Bundle static ffmpeg
FFMPEG_BIN="/opt/pulsar-music-player/bin/ffmpeg"
if [ ! -f "$FFMPEG_BIN" ]; then
    FFMPEG_BIN="$(which ffmpeg 2>/dev/null || true)"
fi
if [ -f "$FFMPEG_BIN" ]; then
    echo "   • Bundling static ffmpeg..."
    cp "$FFMPEG_BIN" "$PKG_DIR/opt/hyperdrain/bin/ffmpeg"
    chmod 755 "$PKG_DIR/opt/hyperdrain/bin/ffmpeg"
fi

# Create launcher script in /usr/bin/hyperdrain
cat << 'EOF' > "$PKG_DIR/usr/bin/hyperdrain"
#!/bin/sh
exec /opt/hyperdrain/hyperdrain --no-sandbox "$@"
EOF
chmod 755 "$PKG_DIR/usr/bin/hyperdrain"

# Create .desktop file in /usr/share/applications/
cat << 'EOF' > "$PKG_DIR/usr/share/applications/hyperdrain.desktop"
[Desktop Entry]
Name=HyperDrain
Comment=32GB High-Speed Resilient Downloader with Universal Extension
Exec=/usr/bin/hyperdrain %U
Terminal=false
Type=Application
Icon=hyperdrain
StartupWMClass=hyperdrain
Categories=Network;FileTransfer;AudioVideo;
Keywords=download;downloader;video;series;m3u8;hls;fallocate;
EOF
chmod 644 "$PKG_DIR/usr/share/applications/hyperdrain.desktop"

# Post-installation hook
cat << 'EOF' > "$PKG_DIR/DEBIAN/postinst"
#!/bin/sh
set -e
if [ "$1" = "configure" ]; then
    chmod 4755 /opt/hyperdrain/chrome-sandbox 2>/dev/null || true
    for udir in /home/*; do
        if [ -d "$udir/.local/share/applications" ]; then
            rm -f "$udir/.local/share/applications/HyperDrain.desktop" 2>/dev/null || true
        fi
    done
    if which update-desktop-database >/dev/null 2>&1; then
        update-desktop-database -q /usr/share/applications || true
    fi
    if which gtk-update-icon-cache >/dev/null 2>&1; then
        gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
    fi
fi
exit 0
EOF
chmod 755 "$PKG_DIR/DEBIAN/postinst"

# Post-removal hook
cat << 'EOF' > "$PKG_DIR/DEBIAN/postrm"
#!/bin/sh
set -e
if [ "$1" = "remove" ] || [ "$1" = "purge" ]; then
    if which update-desktop-database >/dev/null 2>&1; then
        update-desktop-database -q /usr/share/applications || true
    fi
    if which gtk-update-icon-cache >/dev/null 2>&1; then
        gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
    fi
fi
exit 0
EOF
chmod 755 "$PKG_DIR/DEBIAN/postrm"

# Calculate Installed-Size
INSTALLED_SIZE=$(du -s "$PKG_DIR" | cut -f1)

# Create Debian control file
cat << EOF > "$PKG_DIR/DEBIAN/control"
Package: hyperdrain
Version: ${VERSION}
Section: net
Priority: optional
Architecture: amd64
Depends: libnotify4, libasound2 | libasound2t64
Installed-Size: ${INSTALLED_SIZE}
Maintainer: HyperDrain <support@hyperdrain.local>
Description: 32GB High-Speed Resilient Downloader with Universal Extension
 Multi-threaded accelerated downloader tailored for massive files (24-32 GB),
 web series archives, and video streams with Linux fallocate zero-fragmentation
 preallocation, SQLite WAL crash recovery, and high-speed online update system.
EOF
chmod 644 "$PKG_DIR/DEBIAN/control"

# 4. Build .deb package using dpkg-deb with fast gzip compression
mkdir -p "$DIR/dist-electron"
DEB_FILE="$DIR/dist-electron/${PKG_NAME}.deb"

echo "4. Assembling Debian archive with dpkg-deb..."
dpkg-deb -Zgzip --build --root-owner-group "$PKG_DIR" "$DEB_FILE"

# Clean up temporary build artifacts
rm -rf "$PKG_DIR"
rm -rf "$DIR/dist-electron/linux-unpacked"

echo "========================================================="
echo " ✅ SUCCESS: Debian Package Built Successfully!"
echo "========================================================="
ls -lh "$DEB_FILE"
dpkg-deb -I "$DEB_FILE"

# 5. Copy package to root of Disk D and user home folder for instant installation
mkdir -p "$DIR/releases"
cp -f "$DEB_FILE" "$DIR/releases/${PKG_NAME}.deb"
cp -f "$DEB_FILE" "/run/media/hamza/Disk D/${PKG_NAME}.deb"
cp -f "$DEB_FILE" "/run/media/hamza/Disk D/hyperdrain.deb"
cp -f "$DEB_FILE" "$HOME/${PKG_NAME}.deb"
cp -f "$DEB_FILE" "$HOME/hyperdrain.deb"

echo ""
echo "📍 Installable .deb package copied to:"
echo "   1. /run/media/hamza/Disk D/${PKG_NAME}.deb"
echo "   2. /run/media/hamza/Disk D/hyperdrain.deb"
echo "   3. $HOME/hyperdrain.deb"
echo ""
echo "To install on your system (or any Ubuntu/Debian/Mint machine):"
echo "   sudo dpkg -i /run/media/hamza/Disk\ D/hyperdrain.deb"
echo "   sudo apt-get install -f (if any dependencies needed)"
