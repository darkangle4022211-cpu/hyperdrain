# ⚡ HyperDrain — 32GB High-Speed Resilient Desktop Downloader

An accelerated, multi-threaded native desktop downloader tailored for massive files (24–32 GB movies and web series archives) on unstable internet connections. Designed with **zero web hosting (100% local)**, a Go backend engine, a Universal Manifest V3 browser extension, a built-in Web Video Browser, and a Dark Glassmorphism Electron desktop shell.

---

## 🚀 Key Features

1. **Native Desktop Application**:
   * Packaged with Electron, custom frameless dark title bar, system tray controls, and cross-platform native notifications.
   * Runs natively on both **Linux** and **Windows** (includes both ELF and PE 64-bit binaries).
   * Native OS directory picker dialogs without external dependencies.

2. **Built-in Web Video Browser (Zero Setup for Friends)**:
   * Embedded Chromium browser with automatic HLS/DASH `.m3u8` playlist and `.mp4` video sniffing.
   * Friends don't even have to install an extension! Just navigate to any movie/series site in the app, play the video, and click **⚡ Download with HyperDrain** with quality selection (1080p, 720p, 360p, MP3).

3. **Universal Browser Extension Hub (Manifest V3)**:
   * Compatible with Chrome, Brave, Edge, and Firefox.
   * 1-Click **Export Extension (.ZIP)** for sharing with friends.
   * Auto-forwards session cookies, Referer, and User-Agent headers to bypass 403 Forbidden errors.

4. **Massive 32 GB File Support & Zero Fragmentation**:
   * Uses Linux `fallocate` / Windows pre-allocation for instant disk space reservation, eliminating fragmentation and write stalls.
   * Concurrent `WriteAt` (pwrite syscall) writes up to 32 parallel streams directly into target byte offsets with zero joining time.

5. **Unstable Internet Connection Resilience**:
   * **Zombie Stream Watchdog**: Automatically detects stalled sockets within 10s and respawns fresh TCP connections at current byte positions.
   * Infinite persistent retries with exponential jitter backoff on HTTP 429 / 503 errors.
   * SQLite WAL (Write-Ahead Logging) database tracks byte offsets every second so power cuts or connection drops never corrupt downloads.

6. **Web Series Auto-Extractor & Archiver**:
   * Integrated non-blocking streaming extractor automatically unpacks multi-gigabyte ZIP/RAR archives upon completion.
   * Automatically packages series into single ZIP batches with episode ranges.

---

## 💻 Quick Start

### Running on Linux
Simply launch via terminal or double-click `start.sh`:
```bash
cd "/run/media/hamza/Disk D/downloader"
./start.sh
```
Or launch from the Ubuntu Applications menu: click the **HyperDrain** icon!

### Running on Windows
Double-click `HyperDrain.bat` inside the folder. It will start the background engine and open the desktop application window.

---

## 🎁 Sharing with Friends

We have pre-packaged a standalone release ZIP ready to give to friends:
* **File**: `/run/media/hamza/Disk D/Hyperdrain-Desktop-App.zip` (also in `dist-release/HyperDrain-Desktop-Release.zip`)
* **Contains**:
  * `hyperdrain` (Linux executable)
  * `hyperdrain.exe` (Windows executable)
  * `electron/` (Desktop application shell)
  * `webui/` (Dark Glassmorphism dashboard + Built-in Video Browser)
  * `extension/` (Universal MV3 extension)
  * `start.sh` (Linux launcher)
  * `HyperDrain.bat` (Windows launcher)
  * `README.txt` (Clear instructions for friends)

---

## 📁 Directory Structure

```
downloader/
├── assets/
│   └── hyperdrain.png       # 512x512 High-Res App Icon
├── electron/
│   ├── main.cjs             # Electron Main Process (Tray, IPC, Sniffer)
│   └── preload.cjs          # Safe Context Bridge IPC API
├── engine/
│   ├── allocator_linux.go   # Linux fallocate & disk space checks
│   ├── allocator_windows.go # Windows SetFileLength & disk space checks
│   ├── proc_unix.go         # Unix process group management
│   ├── proc_windows.go      # Windows process management
│   ├── db.go                # SQLite WAL crash-proof persistence
│   ├── downloader.go        # Dynamic segment splitting & zombie watchdog
│   ├── extractor.go         # Streaming ZIP/RAR archive unpacker
│   ├── notify.go            # Desktop notification dispatcher
│   ├── server.go            # Local REST & WebSocket telemetry server
│   ├── torrent.go           # BitTorrent/Magnet link helper
│   └── types.go             # Data structures and schemas
├── extension/
│   ├── manifest.json        # Universal Manifest V3 configuration
│   ├── background.js        # Download interceptor & cookie forwarder
│   ├── content.js           # Magnet & web link click catcher
│   ├── popup.html           # Mini glassmorphism popup UI
│   ├── prompt.html          # IDM-style download confirmation dialog
│   └── icons/               # 16, 48, 128px icons
├── webui/
│   ├── index.html           # Desktop dashboard + Built-in Video Browser + Extension Hub
│   ├── app.css              # Dark Glassmorphism design tokens & window controls
│   └── app.js               # WebSocket stream, 60fps Canvas graph & webview controller
├── scripts/
│   ├── build_engine.sh      # Dual-target (Linux & Windows) Go compilation
│   └── build_release.sh     # Bundles standalone distributable ZIP package
├── dist-release/
│   └── HyperDrain-Desktop-Release.zip # Ready-to-share release package for friends
├── HyperDrain.bat           # 1-Click Windows desktop launcher
├── HyperDrain.desktop       # Linux application menu entry
├── package.json             # Electron configuration & build targets
├── main.go                  # Main server & headless engine entrypoint
├── signal_unix.go           # Unix signal handling
├── signal_windows.go        # Windows signal handling
├── start.sh                 # 1-Click Linux desktop launcher
└── README.md                # Documentation
```
