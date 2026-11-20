const { app, BrowserWindow, ipcMain, Tray, Menu, Notification, dialog, shell, session, nativeImage, screen, clipboard, net: electronNet } = require('electron');
const { spawn, exec, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const nodeNet = require('net');
const os = require('os');

// Performance & quiet Linux flags: no-sandbox, disable GPU watchdog, and disable QUIC/ECH/PQ TLS extensions that trigger ISP connection resets
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-watchdog');
app.commandLine.appendSwitch('disable-quic');
app.commandLine.appendSwitch('disable-features', 'PostQuantumKeyAgreement,X25519Kyber768Draft00,EncryptedClientHello,UseDnsHttpsSvcb');

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.exit(0);
}

let mainWindow = null;
let tray = null;
let engineProcess = null;
let spawnedEngine = false;
let isQuitting = false;

const ROOT_DIR = path.resolve(__dirname, '..');
const EXTENSION_DIR = path.join(ROOT_DIR, 'extension');
const ASSETS_DIR = path.join(ROOT_DIR, 'assets');
const CORE_URL = 'http://127.0.0.1:6880';
const MINI_IPC_PORT = 6882;
let miniServer = null;
const miniWindows = new Map(); // taskId -> BrowserWindow
const GITHUB_REPO = 'darkangle4022211-cpu/hyperdrain';
const APP_VERSION = '1.1.0';

// Register IDM-style deep-link scheme
app.setAsDefaultProtocolClient('hyperdrain');

// Windows-specific Action Center / Toast integration identifier
if (process.platform === 'win32') {
  app.setAppUserModelId('HyperDrain.HighSpeedDownloader');
}

// IDM-Style Autostart: starts silently in the system tray on login
function ensureAutostart() {
  if (process.platform === 'win32') {
    try {
      app.setLoginItemSettings({
        openAtLogin: true,
        args: ['--hidden']
      });
    } catch (e) {
      console.warn('[HyperDrain Desktop] Could not ensure Windows autostart:', e);
    }
    return;
  }
  try {
    const homeDir = os.homedir();
    if (!homeDir) return;
    const appImageCandidates = [
      process.env.APPIMAGE,
      path.join(homeDir, 'Applications', 'HyperDrain.AppImage'),
      path.join(homeDir, 'HyperDrain.AppImage')
    ].filter(Boolean);
    const appImagePath = appImageCandidates.find(p => fs.existsSync(p)) || '';
    const hasAppImage = Boolean(appImagePath);
    const execBase = hasAppImage
      ? `"${appImagePath}" --no-sandbox`
      : `"${process.execPath}" --no-sandbox`;

    const autostartDir = path.join(homeDir, '.config', 'autostart');
    const autostartFile = path.join(autostartDir, 'hyperdrain.desktop');
    if (!fs.existsSync(autostartDir)) {
      fs.mkdirSync(autostartDir, { recursive: true });
    }
    const content = `[Desktop Entry]
Type=Application
Name=HyperDrain
Comment=32GB High-Speed Resilient Downloader
Exec=${execBase} --hidden
Icon=hyperdrain
Terminal=false
Categories=Network;FileTransfer;
StartupNotify=false
X-GNOME-Autostart-enabled=true
`;
    fs.writeFileSync(autostartFile, content, { mode: 0o644 });

    if (hasAppImage) {
      const iconDir = path.join(homeDir, '.local', 'share', 'icons', 'hicolor', '512x512', 'apps');
      fs.mkdirSync(iconDir, { recursive: true });
      const srcIcon = path.join(ASSETS_DIR, 'hyperdrain.png');
      if (fs.existsSync(srcIcon)) {
        fs.copyFileSync(srcIcon, path.join(iconDir, 'hyperdrain.png'));
      }

      const appsDir = path.join(homeDir, '.local', 'share', 'applications');
      fs.mkdirSync(appsDir, { recursive: true });
      const duplicateDesktop = path.join(appsDir, 'HyperDrain.desktop');
      let removedDuplicate = false;
      if (fs.existsSync(duplicateDesktop)) {
        try {
          fs.unlinkSync(duplicateDesktop);
          removedDuplicate = true;
        } catch (_) {}
      }
      const desktopContent = `[Desktop Entry]
Type=Application
Name=HyperDrain
Comment=32GB High-Speed Resilient Downloader with Universal Extension
Exec=${execBase} %U
Icon=hyperdrain
Terminal=false
Categories=Network;FileTransfer;AudioVideo;
StartupWMClass=hyperdrain
MimeType=x-scheme-handler/hyperdrain;
`;
      fs.writeFileSync(path.join(appsDir, 'hyperdrain.desktop'), desktopContent, { mode: 0o644 });
      if (removedDuplicate) {
        exec(`update-desktop-database "${appsDir}"`, () => {});
      }
    }
  } catch (e) {
    console.warn('[HyperDrain Desktop] Could not ensure autostart:', e);
  }
}

function getAppIcon() {
  const iconPaths = [
    path.join(ASSETS_DIR, 'hyperdrain.png'),
    path.join(EXTENSION_DIR, 'icons', 'icon128.png'),
    path.join(ROOT_DIR, 'icon.png'),
    path.join(os.homedir(), '.local/share/icons/hicolor/512x512/apps/hyperdrain.png'),
    '/usr/share/icons/hicolor/512x512/apps/hyperdrain.png',
    '/usr/share/pixmaps/hyperdrain.png'
  ];
  for (const p of iconPaths) {
    if (fs.existsSync(p)) return p;
  }
  return '';
}

// 1. Check if HyperDrain backend is responding
function checkEngineHealth() {
  return new Promise((resolve) => {
    const req = http.get(`${CORE_URL}/api/settings`, { timeout: 350 }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

// 2. Launch background engine if not already active
async function ensureEngineRunning() {
  const isRunning = await checkEngineHealth();
  if (isRunning) {
    console.log('[HyperDrain Desktop] Engine already running on port 6880');
    return true;
  }

  console.log('[HyperDrain Desktop] Spawning Go backend engine...');
  const isWin = process.platform === 'win32';
  const engineBinary = isWin ? 'hyperdrain-engine.exe' : 'hyperdrain-engine';
  const genericBinary = isWin ? 'hyperdrain.exe' : 'hyperdrain';

  const candidatePaths = [
    ...(process.resourcesPath ? [
      path.join(process.resourcesPath, 'app', engineBinary),
      path.join(process.resourcesPath, 'app', genericBinary),
      path.join(process.resourcesPath, engineBinary),
      path.join(process.resourcesPath, genericBinary)
    ] : []),
    ...(process.env.SNAP ? [
      path.join(process.env.SNAP, 'resources', 'app', engineBinary),
      path.join(process.env.SNAP, 'resources', 'app', genericBinary),
      path.join(process.env.SNAP, engineBinary),
      path.join(process.env.SNAP, genericBinary)
    ] : []),
    path.join(path.dirname(process.execPath), 'bin', engineBinary),
    path.join(path.dirname(process.execPath), 'bin', genericBinary),
    path.join(path.dirname(process.execPath), 'resources', 'app', engineBinary),
    path.join(path.dirname(process.execPath), 'resources', 'app', genericBinary),
    path.join(path.dirname(process.execPath), engineBinary),
    path.join(path.dirname(process.execPath), genericBinary),
    path.join(ROOT_DIR, engineBinary),
    path.join(ROOT_DIR, genericBinary)
  ];

  let binaryPath = '';
  for (const cp of candidatePaths) {
    if (fs.existsSync(cp) && cp !== process.execPath) {
      binaryPath = cp;
      break;
    }
  }

  if (!binaryPath) {
    console.error(`[HyperDrain Desktop] Binary not found in any candidate path`);
    return false;
  }

  // Ensure execution permissions on Unix
  if (!isWin) {
    try { fs.chmodSync(binaryPath, 0o755); } catch (e) {}
  }

  try {
    const userDataDir = app.getPath('userData');
    try { fs.mkdirSync(userDataDir, { recursive: true }); } catch (e) {}

    engineProcess = spawn(binaryPath, ['--no-window'], {
      cwd: userDataDir,
      detached: false,
      stdio: 'ignore'
    });
    spawnedEngine = true;

    engineProcess.on('error', (err) => {
      console.error('[HyperDrain Desktop] Failed to start engine process:', err);
    });

    engineProcess.on('exit', (code, sig) => {
      console.log(`[HyperDrain Desktop] Engine process exited with code ${code}, signal ${sig}`);
      engineProcess = null;
    });

    // Wait for engine to respond (up to 8 seconds)
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 200));
      if (await checkEngineHealth()) {
        console.log('[HyperDrain Desktop] Engine started and responsive!');
        return true;
      }
    }
  } catch (err) {
    console.error('[HyperDrain Desktop] Error launching engine:', err);
  }

  return false;
}

// 3. Create Main Desktop Window (Clean, fast, zero webview overhead)
function createMainWindow() {
  const iconPath = getAppIcon();

  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 920,
    minHeight: 620,
    frame: false, // Frameless for custom human-crafted titlebar
    backgroundColor: '#070a13',
    show: false, // Smoothly show once content is ready (prevents black flash)
    icon: iconPath || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webviewTag: true
    }
  });

  const localUi = path.join(ROOT_DIR, 'webui', 'index.html');
  if (fs.existsSync(localUi)) {
    mainWindow.loadFile(localUi);
  } else {
    mainWindow.loadURL(CORE_URL);
  }

  const isHiddenStartup = process.argv.includes('--hidden') ||
                          process.argv.includes('--minimized') ||
                          process.argv.includes('--tray') ||
                          process.argv.includes('--background');

  mainWindow.once('ready-to-show', () => {
    if (isHiddenStartup) {
      mainWindow.hide();
      if (typeof mainWindow.setSkipTaskbar === 'function') {
        mainWindow.setSkipTaskbar(true);
      }
      console.log('[HyperDrain Desktop] Started silently in background tray mode (IDM style).');
    } else {
      mainWindow.show();
    }
  });

  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('window-state-change', { maximized: true });
  });

  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window-state-change', { maximized: false });
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      if (typeof mainWindow.setSkipTaskbar === 'function') {
        mainWindow.setSkipTaskbar(true);
      }
      return;
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (isQuitting) {
      if (tray && !tray.isDestroyed()) {
        try { tray.destroy(); } catch (e) {}
        tray = null;
      }
      app.quit();
    }
  });
}

// 4. Setup System Tray (Silent Background Daemon Mode)
function setupTray() {
  const iconPath = getAppIcon();
  if (!iconPath) return;

  const trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 20, height: 20 });
  tray = new Tray(trayIcon);
  tray.setToolTip('HyperDrain — 32GB High-Speed Resilient Downloader');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show HyperDrain Dashboard',
      click: () => {
        if (mainWindow) {
          mainWindow.setSkipTaskbar(false);
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Pause All Downloads',
      click: () => {
        if (mainWindow) {
          mainWindow.webContents.executeJavaScript(`
            fetch('${CORE_URL}/api/tasks').then(r=>r.json()).then(tasks=>{
              tasks.filter(t=>t.status==='downloading').forEach(t=>{
                fetch('${CORE_URL}/api/tasks/' + t.id + '/pause', {method:'POST'});
              });
            });
          `);
        }
      }
    },
    {
      label: 'Resume All Downloads',
      click: () => {
        if (mainWindow) {
          mainWindow.webContents.executeJavaScript(`
            fetch('${CORE_URL}/api/tasks').then(r=>r.json()).then(tasks=>{
              tasks.filter(t=>t.status==='paused').forEach(t=>{
                fetch('${CORE_URL}/api/tasks/' + t.id + '/resume', {method:'POST'});
              });
            });
          `);
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Quit HyperDrain',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
        mainWindow.setSkipTaskbar(true);
      } else {
        mainWindow.setSkipTaskbar(false);
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.setSkipTaskbar(false);
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// 4b. IDM-Style Mini Download Progress Window Manager (Disabled)
function createMiniDownloadWindow(taskId) {
  return null;
}

function resolveExistingDir(targetPath) {
  if (!targetPath) {
    try { return app.getPath('downloads'); } catch(e) { return os.homedir(); }
  }
  let curr = path.resolve(targetPath);
  while (curr && curr !== path.dirname(curr)) {
    try {
      if (fs.existsSync(curr) && fs.statSync(curr).isDirectory()) {
        return curr;
      }
    } catch (e) {}
    curr = path.dirname(curr);
  }
  try { return app.getPath('downloads'); } catch(e) { return os.homedir(); }
}

// 4c. Lightweight Internal Status & Mini Window Notification Server
function startMiniServer() {
  if (miniServer) return;

  miniServer = http.createServer((req, res) => {
    // 1. Full CORS Headers for browser extension and WebUI
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-HyperDrain-Token, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      const u = new URL(req.url, `http://127.0.0.1:${MINI_IPC_PORT}`);

      // Status endpoint: validates that the Electron desktop app is running
      if (u.pathname === '/status' || u.pathname === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          online: true,
          version: APP_VERSION,
          electron: true,
          tray_mode: true
        }));
        return;
      }

      // Notification endpoint: mini-window popup disabled
      if (u.pathname === '/notify-download') {
        const taskId = u.searchParams.get('taskId');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, taskId: taskId }));
        return;
      }

      // Native folder chooser endpoint (bridges Go engine/extension to Electron dialog)
      if (u.pathname === '/choose-folder' || u.pathname === '/api/choose-folder') {
        const defaultPath = u.searchParams.get('defaultPath') || '';
        const safeDefault = resolveExistingDir(defaultPath);
        dialog.showOpenDialog({
          title: 'Select Download Destination Folder',
          defaultPath: safeDefault,
          properties: ['openDirectory', 'createDirectory']
        }).then(result => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          if (result.canceled || result.filePaths.length === 0) {
            res.end(JSON.stringify({ cancelled: true }));
          } else {
            res.end(JSON.stringify({ cancelled: false, path: result.filePaths[0] }));
          }
        }).catch(err => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ cancelled: true, error: err.message }));
        });
        return;
      }

      // Helper endpoint: brings main dashboard forward if requested
      if (u.pathname === '/show-dashboard') {
        if (mainWindow) {
          mainWindow.setSkipTaskbar(false);
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Endpoint not found' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  miniServer.on('error', (err) => {
    console.warn(`[HyperDrain Desktop] Mini notification server error on port ${MINI_IPC_PORT}:`, err.message);
  });

  miniServer.listen(MINI_IPC_PORT, '127.0.0.1', () => {
    console.log(`[HyperDrain Desktop] Mini notification server active on http://127.0.0.1:${MINI_IPC_PORT}`);
  });
}

// ============================================================================
// 5. Online Auto-Update Engine (High-Speed Multi-Stream Segmented Downloader)
// ============================================================================
function compareVersions(v1, v2) {
  const p1 = (v1 || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const p2 = (v2 || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
    const a = p1[i] || 0;
    const b = p2[i] || 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https:') ? https : http;
    const req = proto.get(url, {
      headers: {
        'User-Agent': 'HyperDrain-Updater/' + APP_VERSION,
        'Accept': 'application/vnd.github.v3+json, application/json'
      }
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        return resolve(fetchJson(res.headers.location));
      }
      if (res.statusCode !== 200) {
        return reject(new Error('HTTP ' + res.statusCode));
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(6000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

async function checkOnlineUpdate() {
  try {
    const isWin = process.platform === 'win32';
    const platformKey = isWin ? 'windows-x64' : 'linux-appimage-x64';

    // 1. Check GitHub Releases API
    const releaseUrl = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
    let rel = null;
    try {
      rel = await fetchJson(releaseUrl);
    } catch (err) {
      // 2. Fallback: query GitHub release redirect (rate-limit immune)
      try {
        const webLatestTag = await new Promise((resolve) => {
          const req = https.get(`https://github.com/${GITHUB_REPO}/releases/latest`, {
            headers: { 'User-Agent': 'HyperDrain-Updater/' + APP_VERSION }
          }, (res) => {
            if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
              const m = res.headers.location.match(/\/tag\/([^/?#]+)/);
              if (m) return resolve(m[1]);
            }
            resolve(null);
          });
          req.on('error', () => resolve(null));
          req.setTimeout(5000, () => { req.destroy(); resolve(null); });
        });

        if (webLatestTag) {
          const latestVersion = webLatestTag.replace(/^v/i, '');
          if (compareVersions(latestVersion, APP_VERSION) > 0) {
            const fileName = isWin ? `HyperDrain-Setup-${latestVersion}.exe` : `HyperDrain-${latestVersion}.AppImage`;
            const downloadUrl = `https://github.com/${GITHUB_REPO}/releases/download/${webLatestTag}/${fileName}`;
            return {
              updateAvailable: true,
              currentVersion: APP_VERSION,
              latestVersion,
              releaseNotes: `HyperDrain update v${latestVersion} is available on GitHub releases.`,
              downloadUrl,
              filename: fileName,
              size: 0,
              support: {
                message: "If you're facing a problem, feel free to contact the developer:",
                email: "hamza.zafar4022211@gmail.com"
              }
            };
          }
        }
      } catch (eTag) {}

      // 3. Fallback to raw update.json in repo
      try {
        const rawJsonUrl = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/update.json`;
        const rawManifest = await fetchJson(rawJsonUrl);
        if (rawManifest && rawManifest.version) {
          const platData = rawManifest.platforms?.[platformKey] || (isWin ? rawManifest.platforms?.['windows-x64'] : rawManifest.platforms?.['linux-appimage-x64']);
          const targetUrl = platData?.url || '';
          if (compareVersions(rawManifest.version, APP_VERSION) > 0) {
            return {
              updateAvailable: true,
              currentVersion: APP_VERSION,
              latestVersion: rawManifest.version,
              releaseNotes: (rawManifest.changelog && rawManifest.changelog.trim())
                ? rawManifest.changelog.trim()
                : 'Performance optimization, high-speed engine enhancement, and stability improvements.',
              downloadUrl: targetUrl,
              filename: platData?.filename || (isWin ? `HyperDrain-Setup-${rawManifest.version}.exe` : `HyperDrain-${rawManifest.version}.AppImage`),
              size: platData?.size || 0,
              support: rawManifest.support || null
            };
          }
        }
      } catch (e2) {}

      // 3. Check local update.json for local/LAN testing
      const localUpdatePath = path.join(ROOT_DIR, 'update.json');
      if (fs.existsSync(localUpdatePath)) {
        try {
          const localManifest = JSON.parse(fs.readFileSync(localUpdatePath, 'utf8'));
          if (localManifest && localManifest.version && compareVersions(localManifest.version, APP_VERSION) > 0) {
            const platData = localManifest.platforms?.[platformKey] || (isWin ? localManifest.platforms?.['windows-x64'] : localManifest.platforms?.['linux-appimage-x64']);
            return {
              updateAvailable: true,
              currentVersion: APP_VERSION,
              latestVersion: localManifest.version,
              releaseNotes: localManifest.changelog || 'Local test update available.',
              downloadUrl: platData?.url || '',
              filename: platData?.filename || (isWin ? `HyperDrain-Setup-${localManifest.version}.exe` : `HyperDrain-${localManifest.version}.AppImage`),
              size: platData?.size || 0,
              support: localManifest.support || null
            };
          }
        } catch (_) {}
      }

      return { updateAvailable: false, error: err.message };
    }

    if (!rel || !rel.tag_name) {
      return { updateAvailable: false };
    }

    const latestVersion = rel.tag_name.replace(/^v/i, '');
    if (compareVersions(latestVersion, APP_VERSION) <= 0) {
      return { updateAvailable: false, currentVersion: APP_VERSION, latestVersion };
    }

    // Filter platform-specific asset: .exe for Windows, .AppImage for Linux
    let targetAsset = null;
    if (isWin) {
      targetAsset = (rel.assets || []).find(a => a.name && (a.name.endsWith('.exe') || a.name.endsWith('.msi')));
    } else {
      targetAsset = (rel.assets || []).find(a => a.name && a.name.endsWith('.AppImage'));
    }

    const downloadUrl = targetAsset ? targetAsset.browser_download_url : (rel.html_url || '');

    return {
      updateAvailable: true,
      currentVersion: APP_VERSION,
      latestVersion,
      releaseNotes: (rel.body && rel.body.trim()) ? rel.body.trim() : 'Performance optimization, high-speed engine enhancement, and stability improvements.',
      downloadUrl,
      filename: targetAsset ? targetAsset.name : (isWin ? `HyperDrain-Setup-${latestVersion}.exe` : `HyperDrain-${latestVersion}.AppImage`),
      size: targetAsset ? targetAsset.size : 0,
      support: {
        message: "If you're facing a problem, feel free to contact the developer:",
        email: "hamza.zafar4022211@gmail.com"
      }
    };
  } catch (err) {
    return { updateAvailable: false, error: err.message };
  }
}

function resolveDownloadMeta(u) {
  return new Promise((resolve, reject) => {
    function get(cur, redirectCount = 0) {
      if (redirectCount > 8) return reject(new Error('Too many redirects'));
      const proto = cur.startsWith('https:') ? https : http;
      proto.get(cur, {
        headers: {
          'User-Agent': 'HyperDrain-Updater/' + APP_VERSION,
          'Range': 'bytes=0-0'
        }
      }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          return get(res.headers.location, redirectCount + 1);
        }
        if (res.statusCode === 206) {
          const contentRange = res.headers['content-range'] || '';
          const m = contentRange.match(/\/(\d+)/);
          const total = m ? parseInt(m[1], 10) : parseInt(res.headers['content-length'] || '0', 10);
          res.resume();
          return resolve({ finalUrl: cur, total, acceptRanges: true });
        }
        if (res.statusCode === 200) {
          const total = parseInt(res.headers['content-length'] || '0', 10);
          const acceptRanges = (res.headers['accept-ranges'] || '').toLowerCase() === 'bytes';
          res.resume();
          return resolve({ finalUrl: cur, total, acceptRanges });
        }
        res.resume();
        reject(new Error('HTTP ' + res.statusCode));
      }).on('error', reject);
    }
    get(u);
  });
}

function downloadPartFile(finalUrl, start, end, partPath, onChunk) {
  return new Promise((resolve, reject) => {
    const proto = finalUrl.startsWith('https:') ? https : http;
    const req = proto.get(finalUrl, {
      headers: {
        'User-Agent': 'HyperDrain-Updater/' + APP_VERSION,
        'Range': `bytes=${start}-${end}`
      }
    }, (res) => {
      if (res.statusCode !== 206 && res.statusCode !== 200) {
        res.resume();
        return reject(new Error('Segment HTTP ' + res.statusCode));
      }
      const ws = fs.createWriteStream(partPath, { highWaterMark: 1024 * 1024 });
      res.on('data', (chunk) => {
        if (onChunk) onChunk(chunk.length);
      });
      res.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error('Segment timeout'));
    });
  });
}

async function assembleParts(partFiles, destPath) {
  const ws = fs.createWriteStream(destPath, { highWaterMark: 1024 * 1024 });
  for (const part of partFiles) {
    await new Promise((res, rej) => {
      const rs = fs.createReadStream(part, { highWaterMark: 1024 * 1024 });
      rs.pipe(ws, { end: false });
      rs.on('end', res);
      rs.on('error', rej);
    });
    try { fs.unlinkSync(part); } catch (_) {}
  }
  await new Promise((res, rej) => {
    ws.end(res);
    ws.on('error', rej);
  });
}

function singleStreamDownload(finalUrl, destPath, total, onChunk) {
  return new Promise((resolve, reject) => {
    const proto = finalUrl.startsWith('https:') ? https : http;
    const req = proto.get(finalUrl, {
      headers: { 'User-Agent': 'HyperDrain-Updater/' + APP_VERSION }
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const fileStream = fs.createWriteStream(destPath, { highWaterMark: 1024 * 1024 });
      res.on('data', chunk => {
        if (onChunk) onChunk(chunk.length);
      });
      res.pipe(fileStream);
      fileStream.on('finish', () => fileStream.close(() => resolve(destPath)));
      fileStream.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Download timeout')); });
  });
}

async function downloadFileWithProgress(url, destPath, onProgress) {
  const { finalUrl, total, acceptRanges } = await resolveDownloadMeta(url);
  let transferred = 0;
  let lastProgressTime = 0;
  let lastPercent = -1;
  const startTime = Date.now();

  function report(force = false) {
    const now = Date.now();
    const percent = total > 0 ? Math.round((transferred / total) * 100) : 0;
    const elapsedSec = (now - startTime) / 1000;
    const speed = elapsedSec > 0 ? transferred / elapsedSec : 0;
    if (force || percent === 100 || (now - lastProgressTime >= 400 && percent !== lastPercent)) {
      lastProgressTime = now;
      lastPercent = percent;
      if (onProgress) onProgress({ transferred, total, percent, speed });
    }
  }

  // 6 parallel asynchronous workers for maximum line saturation
  const CONCURRENCY = (acceptRanges && total > 5 * 1024 * 1024) ? 6 : 1;

  if (CONCURRENCY > 1) {
    const partFiles = [];
    const chunkSize = Math.ceil(total / CONCURRENCY);
    const tasks = [];
    for (let i = 0; i < CONCURRENCY; i++) {
      const partPath = `${destPath}.part${i}`;
      partFiles.push(partPath);
      const start = i * chunkSize;
      const end = Math.min((i + 1) * chunkSize - 1, total - 1);
      tasks.push(downloadPartFile(finalUrl, start, end, partPath, (len) => {
        transferred += len;
        report(false);
      }));
    }
    try {
      await Promise.all(tasks);
      await assembleParts(partFiles, destPath);
      report(true);
      return destPath;
    } catch (err) {
      for (const p of partFiles) {
        try { fs.unlinkSync(p); } catch (_) {}
      }
      throw err;
    }
  } else {
    await singleStreamDownload(finalUrl, destPath, total, (len) => {
      transferred += len;
      report(false);
    });
    report(true);
    return destPath;
  }
}

// 6. IPC Handlers
function setupIPCHandlers() {
  ipcMain.on('window-minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      win.minimize();
    } else if (mainWindow) {
      mainWindow.minimize();
    }
  });

  ipcMain.on('window-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      if (win.isMaximized()) {
        win.unmaximize();
      } else {
        win.maximize();
      }
    } else if (mainWindow) {
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
      } else {
        mainWindow.maximize();
      }
    }
  });

  ipcMain.on('window-close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win === mainWindow) {
      if (mainWindow) {
        mainWindow.hide();
        if (typeof mainWindow.setSkipTaskbar === 'function') {
          mainWindow.setSkipTaskbar(true);
        }
      }
    } else if (win) {
      win.close();
    } else if (mainWindow) {
      mainWindow.hide();
      if (typeof mainWindow.setSkipTaskbar === 'function') {
        mainWindow.setSkipTaskbar(true);
      }
    }
  });

  ipcMain.handle('window-is-maximized', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    return win ? win.isMaximized() : false;
  });

  function resolveExistingDir(targetPath) {
    if (!targetPath) return app.getPath('downloads');
    let curr = path.resolve(targetPath);
    while (curr && curr !== path.dirname(curr)) {
      try {
        if (fs.existsSync(curr) && fs.statSync(curr).isDirectory()) {
          return curr;
        }
      } catch (e) {}
      curr = path.dirname(curr);
    }
    return app.getPath('downloads');
  }

  ipcMain.handle('choose-folder', async (_event, defaultPath) => {
    if (!mainWindow) return { cancelled: true };

    const safeDefault = resolveExistingDir(defaultPath);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select HyperDrain Download Directory',
      defaultPath: safeDefault,
      properties: ['openDirectory', 'createDirectory']
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { cancelled: true };
    }

    const selected = result.filePaths[0];

    // Automatically sync chosen folder to engine settings
    try {
      const postData = JSON.stringify({ download_dir: selected });
      const req = http.request(`${CORE_URL}/api/settings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      });
      req.write(postData);
      req.end();
    } catch (e) {}

    return { cancelled: false, path: selected };
  });

  ipcMain.handle('open-path', async (_event, targetPath) => {
    if (!targetPath) return false;
    try {
      const safePath = resolveExistingDir(targetPath);
      await shell.openPath(safePath);
      return true;
    } catch (e) {
      return false;
    }
  });

  ipcMain.handle('open-external', async (_event, rawUrl) => {
    if (!rawUrl || typeof rawUrl !== 'string') return false;
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        await shell.openExternal(parsed.toString());
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  });

  ipcMain.handle('show-item-in-folder', async (_event, filePath) => {
    if (!filePath) return false;
    try {
      if (fs.existsSync(filePath)) {
        shell.showItemInFolder(filePath);
        return true;
      }
      const dir = path.dirname(filePath);
      const safeDir = resolveExistingDir(dir);
      await shell.openPath(safeDir);
      return true;
    } catch (e) {
      return false;
    }
  });

  function getPreparedExtensionDir() {
    const userExtDir = path.join(app.getPath('downloads'), 'HyperDrain-Extension');
    try {
      if (!fs.existsSync(userExtDir)) {
        fs.mkdirSync(userExtDir, { recursive: true });
      }
      const candidates = [
        EXTENSION_DIR,
        path.join(process.resourcesPath || '', 'app', 'extension'),
        path.join(process.resourcesPath || '', 'extension'),
        '/run/media/hamza/Disk D/downloader/extension',
        path.join(ROOT_DIR, 'extension')
      ];
      let srcDir = null;
      for (const c of candidates) {
        if (c && fs.existsSync(path.join(c, 'manifest.json'))) {
          srcDir = c;
          break;
        }
      }
      if (srcDir) {
        fs.cpSync(srcDir, userExtDir, { recursive: true });
      }
    } catch (e) {
      console.error('[EXT_HELPER] Error preparing extension dir:', e);
    }
    return userExtDir;
  }

  function detectSystemBrowsers() {
    const isWin = process.platform === 'win32';
    const isLinux = process.platform === 'linux';

    const browserDefs = [
      {
        id: 'chrome',
        name: 'Google Chrome',
        extUrl: 'chrome://extensions',
        linuxPaths: [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/opt/google/chrome/google-chrome',
          '/snap/bin/chromium'
        ],
        winPaths: [
          path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
          path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
          path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
        ]
      },
      {
        id: 'brave',
        name: 'Brave Browser',
        extUrl: 'brave://extensions',
        linuxPaths: [
          '/snap/bin/brave',
          '/usr/bin/brave-browser',
          '/usr/bin/brave'
        ],
        winPaths: [
          path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
          path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
          path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe')
        ]
      },
      {
        id: 'edge',
        name: 'Microsoft Edge',
        extUrl: 'edge://extensions',
        linuxPaths: [
          '/usr/bin/microsoft-edge',
          '/usr/bin/microsoft-edge-stable',
          '/opt/microsoft/msedge/msedge'
        ],
        winPaths: [
          path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
          path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
          path.join(process.env.LOCALAPPDATA || '', 'Microsoft\\Edge\\Application\\msedge.exe')
        ]
      },
      {
        id: 'firefox',
        name: 'Mozilla Firefox',
        extUrl: 'about:debugging#/runtime/this-firefox',
        linuxPaths: [
          '/usr/bin/firefox',
          '/snap/bin/firefox'
        ],
        winPaths: [
          path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Mozilla Firefox\\firefox.exe'),
          path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Mozilla Firefox\\firefox.exe')
        ]
      }
    ];

    return browserDefs.map(b => {
      let binaryPath = null;
      let installed = false;

      const paths = isWin ? b.winPaths : (isLinux ? b.linuxPaths : []);
      for (const p of paths) {
        if (p && fs.existsSync(p)) {
          binaryPath = p;
          installed = true;
          break;
        }
      }

      if (!installed) {
        try {
          const binName = isWin ? (b.id === 'edge' ? 'msedge.exe' : `${b.id}.exe`) : b.id;
          const whichCmd = isWin ? `where ${binName}` : `which ${binName} 2>/dev/null`;
          const found = execSync(whichCmd, { stdio: ['pipe', 'pipe', 'ignore'], encoding: 'utf-8' }).trim().split('\n')[0];
          if (found && fs.existsSync(found.trim())) {
            binaryPath = found.trim();
            installed = true;
          }
        } catch (_) {}
      }

      return {
        id: b.id,
        name: b.name,
        extUrl: b.extUrl,
        installed,
        path: binaryPath
      };
    });
  }

  ipcMain.handle('detect-browsers', async () => {
    return detectSystemBrowsers();
  });

  ipcMain.handle('copy-extension-path', async () => {
    try {
      const extDir = getPreparedExtensionDir();
      clipboard.writeText(extDir);
      return { success: true, path: extDir };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('connect-browser', async (_event, browserId) => {
    try {
      const extDir = getPreparedExtensionDir();
      clipboard.writeText(extDir);
      const browsers = detectSystemBrowsers();
      const b = browsers.find(x => x.id === browserId);
      if (b && b.installed && b.path) {
        const proc = spawn(b.path, [b.extUrl], {
          detached: true,
          stdio: 'ignore'
        });
        proc.unref();
        return { success: true, browser: b.name, path: extDir, url: b.extUrl };
      } else {
        const targetUrl = b ? b.extUrl : 'chrome://extensions';
        shell.openExternal(targetUrl);
        return { success: true, browser: b ? b.name : 'Browser', path: extDir, url: targetUrl };
      }
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('open-extension-folder', async () => {
    try {
      const userExtDir = getPreparedExtensionDir();
      await shell.openPath(userExtDir);
      return true;
    } catch (e) {
      return false;
    }
  });

  ipcMain.handle('export-extension-zip', async () => {
    const defaultExport = path.join(app.getPath('downloads'), 'HyperDrain-Browser-Extension.zip');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export HyperDrain Browser Extension',
      defaultPath: defaultExport,
      filters: [{ name: 'Zip Archive', extensions: ['zip'] }]
    });

    if (result.canceled || !result.filePath) {
      return { success: false, cancelled: true };
    }

    const destFile = result.filePath;
    try {
      // 1. Fetch from Go engine /api/extension.zip (zero external CLI dependencies, 100% reliable inside Snap & Windows AppX)
      const fetched = await new Promise((resolve) => {
        const fileStream = fs.createWriteStream(destFile);
        const req = http.get(`${CORE_URL}/api/extension.zip`, (res) => {
          if (res.statusCode === 200) {
            res.pipe(fileStream);
            fileStream.on('finish', () => {
              fileStream.close(() => resolve(true));
            });
          } else {
            fileStream.close(() => resolve(false));
          }
        });
        req.on('error', () => {
          fileStream.close(() => resolve(false));
        });
        req.setTimeout(6000, () => {
          req.destroy();
          fileStream.close(() => resolve(false));
        });
      });

      if (!fetched) {
        // 2. Fallback to platform commands if engine not yet started
        if (process.platform === 'win32') {
          const cmd = `powershell -Command "Compress-Archive -Path '${EXTENSION_DIR}\\*' -DestinationPath '${destFile}' -Force"`;
          await new Promise((res, rej) => exec(cmd, (err) => err ? rej(err) : res()));
        } else {
          const cmd = `cd "${EXTENSION_DIR}" && zip -r "${destFile}" . -x "*.git*"`;
          await new Promise((res, rej) => exec(cmd, (err) => err ? rej(err) : res()));
        }
      }

      shell.showItemInFolder(destFile);
      return { success: true, path: destFile };
    } catch (err) {
      console.error('Export zip failed:', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('show-notification', (_event, { title, body }) => {
    if (Notification.isSupported()) {
      const notif = new Notification({
        title: title || 'HyperDrain',
        body: body || '',
        icon: getAppIcon() || undefined
      });
      notif.show();
      return true;
    }
    return false;
  });

  // Online Auto-Update IPC Handlers
  ipcMain.handle('check-for-updates', async () => {
    return await checkOnlineUpdate();
  });

  ipcMain.handle('download-update', async (event, downloadUrl) => {
    if (!downloadUrl) return { success: false, error: 'No download URL specified' };
    const isWin = process.platform === 'win32';
    const ext = isWin ? '.exe' : '.AppImage';
    const destPath = path.join(os.tmpdir(), `hyperdrain_latest${ext}`);
    try {
      await downloadFileWithProgress(downloadUrl, destPath, (progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('update-download-progress', progress);
        }
      });
      return { success: true, path: destPath };
    } catch (err) {
      console.error('[HyperDrain Updater] Download error:', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('install-update', async (event, customPackagePath) => {
    const isWin = process.platform === 'win32';
    const defaultPackage = path.join(os.tmpdir(), isWin ? 'hyperdrain_latest.exe' : 'hyperdrain_latest.AppImage');
    const pkgPath = customPackagePath || defaultPackage;
    if (!fs.existsSync(pkgPath)) {
      return { success: false, error: 'Update installer package not found on disk' };
    }

    if (isWin) {
      // Windows Installer Execution: run setup executable and terminate current instance
      try {
        const child = spawn(pkgPath, [], {
          detached: true,
          stdio: 'ignore'
        });
        child.unref();
        setTimeout(() => {
          isQuitting = true;
          app.quit();
        }, 500);
        return { success: true };
      } catch (winErr) {
        try {
          await shell.openPath(pkgPath);
          setTimeout(() => {
            isQuitting = true;
            app.quit();
          }, 500);
          return { success: true };
        } catch (e) {
          return { success: false, error: winErr.message };
        }
      }
    }

    const currentPid = process.pid;
    const scriptPath = path.join(os.tmpdir(), 'hd_updater.sh');
    const disp = process.env.DISPLAY || ':0';
    const xauth = process.env.XAUTHORITY || '';
    const wayland = process.env.WAYLAND_DISPLAY || '';
    const xdgRuntime = process.env.XDG_RUNTIME_DIR || '';
    const targetAppImage = process.env.APPIMAGE ||
      (fs.existsSync(path.join(os.homedir(), 'Applications', 'HyperDrain.AppImage'))
        ? path.join(os.homedir(), 'Applications', 'HyperDrain.AppImage')
        : path.join(os.homedir(), 'HyperDrain.AppImage'));

    const appImageScript = `#!/usr/bin/env bash
export DISPLAY="${disp}"
export XAUTHORITY="${xauth}"
export WAYLAND_DISPLAY="${wayland}"
export XDG_RUNTIME_DIR="${xdgRuntime}"

OLD_PID=${currentPid}
if [ -n "$OLD_PID" ]; then
  kill -TERM "$OLD_PID" 2>/dev/null || true
  for i in {1..15}; do
    if ! kill -0 "$OLD_PID" 2>/dev/null; then
      break
    fi
    sleep 0.2
  done
  kill -9 "$OLD_PID" 2>/dev/null || true
fi

pkill -x 'hyperdrain-engine' 2>/dev/null || true
sleep 0.5

mkdir -p "$(dirname "${targetAppImage}")"
cp -f "${pkgPath}" "${targetAppImage}"
chmod 755 "${targetAppImage}"

sleep 0.3
nohup "${targetAppImage}" --no-sandbox >/dev/null 2>&1 &
rm -f "${pkgPath}" "${scriptPath}" 2>/dev/null
`;
    try {
      fs.writeFileSync(scriptPath, appImageScript, { mode: 0o755 });
      const child = spawn('/bin/bash', [scriptPath], {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
      setTimeout(() => {
        isQuitting = true;
        app.quit();
      }, 500);
      return { success: true };
    } catch (err) {
      console.error('[HyperDrain Updater] AppImage update script failed:', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('ensure-browser-shield', async () => {
    setupBrowserShieldSession();
    return { enabled: browserShieldEnabled, ...browserShieldStats };
  });

  ipcMain.handle('set-browser-shield', async (_event, enabled) => {
    setupBrowserShieldSession();
    browserShieldEnabled = Boolean(enabled);
    emitBrowserShieldStats(true);
    return { enabled: browserShieldEnabled, ...browserShieldStats };
  });

  ipcMain.handle('set-browser-eco', async (_event, enabled) => {
    setupBrowserShieldSession();
    browserEcoMode = Boolean(enabled);
    return { ecoMode: browserEcoMode };
  });

  ipcMain.handle('get-browser-eco', async () => {
    return { ecoMode: browserEcoMode };
  });

  ipcMain.handle('get-browser-shield-stats', async () => {
    return { enabled: browserShieldEnabled, ...browserShieldStats };
  });

  ipcMain.handle('reset-browser-shield-stats', async () => {
    browserShieldStats = { blockedAds: 0, blockedPopups: 0 };
    emitBrowserShieldStats(true);
    return { enabled: browserShieldEnabled, ...browserShieldStats };
  });

  ipcMain.handle('resolve-site-redirect', async (_event, targetUrl) => {
    return await resolveSiteRedirectChain(targetUrl);
  });

  ipcMain.handle('sync-browser-proxy', async () => {
    return await syncBrowserSessionProxy();
  });

  ipcMain.handle('clear-browser-session-data', async () => {
    try {
      const ses = session.fromPartition(BROWSER_PARTITION);
      await ses.clearCache();
      await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('get-webview-preload-path', () => {
    const p = path.join(__dirname, 'webview_preload.cjs');
    return require('url').pathToFileURL(p).toString();
  });

  ipcMain.handle('hd-ext-message', async (event, req) => {
    if (!req || typeof req !== 'object') return { status: 'error' };
    const senderId = event.sender ? event.sender.id : 0;
    const ses = session.fromPartition(BROWSER_PARTITION);
    const action = req.action;

    if (action === 'check_engine_status') {
      const now = Date.now();
      if (now - engineStatusCache.ts < 5000) {
        return { online: engineStatusCache.online };
      }
      const online = await new Promise((resolve) => {
        const r = http.get(`${CORE_URL}/api/settings`, {
          headers: { 'X-HyperDrain-Token': 'hyperdrain_secret_token' },
          timeout: 1500
        }, (res) => {
          res.resume();
          resolve(res.statusCode >= 200 && res.statusCode < 500);
        });
        r.on('error', () => resolve(false));
        r.on('timeout', () => { r.destroy(); resolve(false); });
      });
      engineStatusCache = { online, ts: Date.now() };
      return { online };
    }

    if (action === 'get_detected_streams') {
      return { streams: webviewStreamsByContentsId.get(senderId) || [] };
    }

    if (action === 'clear_tab_streams') {
      webviewStreamsByContentsId.delete(senderId);
      return { status: 'ok' };
    }

    if (action === 'report_stream_from_frame' && req.url) {
      handleWebviewStreamDetected(req.url, senderId, {
        referer: req.referer || (event.sender && !event.sender.isDestroyed() ? event.sender.getURL() : '')
      });
      return { status: 'ok' };
    }

    if (action === 'download_url' || action === 'download_stream_video') {
      const targetUrl = req.url || '';
      if (!targetUrl) return { status: 'error' };
      let cookieStr = req.cookie || '';
      if (!cookieStr) {
        try {
          const cookies = await ses.cookies.get({ url: targetUrl });
          if (Array.isArray(cookies) && cookies.length > 0) {
            cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
          }
        } catch (_) {}
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('browser-download-captured', {
          url: targetUrl,
          filename: req.title || '',
          format_id: req.format_id || '',
          referer: req.referer || (event.sender && !event.sender.isDestroyed() ? event.sender.getURL() : ''),
          origin: req.origin || '',
          cookie: cookieStr,
          userAgent: ses.getUserAgent() || ''
        });
      }
      return { status: 'ok' };
    }

    if (action === 'show_notification') {
      if (Notification.isSupported()) {
        new Notification({
          title: req.title || 'HyperDrain',
          body: req.message || '',
          icon: getAppIcon() || undefined
        }).show();
      }
      return { status: 'ok' };
    }

    if (action === 'open_dashboard') {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      }
      return { status: 'ok' };
    }

    return { status: 'ok' };
  });

  ipcMain.handle('hd-ext-local-fetch', async (_event, { url, options }) => {
    if (
      typeof url !== 'string' ||
      (!url.startsWith('http://127.0.0.1:6880/') &&
       !url.startsWith('http://127.0.0.1:6882/') &&
       !url.startsWith('http://localhost:6880/') &&
       !url.startsWith('http://localhost:6882/'))
    ) {
      return { ok: false, status: 403, statusText: 'Forbidden', body: '', contentType: 'text/plain' };
    }

    return await new Promise((resolve) => {
      try {
        const parsed = new URL(url);
        const method = (options && options.method) ? String(options.method).toUpperCase() : 'GET';
        const headers = (options && options.headers && typeof options.headers === 'object') ? { ...options.headers } : {};
        const req = http.request({
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname + parsed.search,
          method,
          headers,
          timeout: 15000
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf-8');
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode || 500,
              statusText: res.statusMessage || '',
              body,
              contentType: (res.headers && res.headers['content-type']) || 'application/json'
            });
          });
        });
        req.on('error', (err) => {
          resolve({ ok: false, status: 502, statusText: err.message, body: err.message, contentType: 'text/plain' });
        });
        req.on('timeout', () => {
          req.destroy();
          resolve({ ok: false, status: 504, statusText: 'Timeout', body: 'Timeout', contentType: 'text/plain' });
        });
        if (options && options.body != null) {
          req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
        }
        req.end();
      } catch (err) {
        resolve({ ok: false, status: 500, statusText: err.message, body: err.message, contentType: 'text/plain' });
      }
    });
  });
}

// ============================================================================
// Built-in Safe Browser Shield (Lazy Partition, Zero Startup Overhead)
// ============================================================================
const BROWSER_PARTITION = 'persist:hyperdrain-browser';
let browserSessionInitialized = false;
let browserShieldEnabled = true;
let browserEcoMode = true;
let engineStatusCache = { online: true, ts: 0 };
let browserShieldStats = { blockedAds: 0, blockedPopups: 0 };
let shieldEmitTimer = null;
const webviewStreamsByContentsId = new Map();
const webviewContentsById = new Map();
const webviewReqHeadersCache = new Map();
let cachedExtensionContentScript = null;

function getExtensionContentScript() {
  if (cachedExtensionContentScript !== null) return cachedExtensionContentScript;
  try {
    const p = path.join(EXTENSION_DIR, 'content.js');
    if (fs.existsSync(p)) {
      cachedExtensionContentScript = fs.readFileSync(p, 'utf-8');
      return cachedExtensionContentScript;
    }
  } catch (_) {}
  cachedExtensionContentScript = '';
  return cachedExtensionContentScript;
}

function buildExtensionInjectionPayload(isTopFrame) {
  const rawContent = getExtensionContentScript();
  if (!rawContent) return '';
  if (!isTopFrame) {
    return `(function(){
      if (window.__hdContentBootstrapped) return true;
      window.__hdContentBootstrapped = true;
      try { window.open = function() { return null; }; } catch (_) {}
      if (!window.chrome) window.chrome = {};
      if (!window.chrome.runtime) {
        window.chrome.runtime = {
          lastError: null,
          sendMessage: function(msg, cb) {
            try { window.top.postMessage({ __hdExtFrameMsg: msg }, '*'); } catch (_) {}
            const resp = { status: 'ok' };
            if (typeof cb === 'function') cb(resp);
            return Promise.resolve(resp);
          },
          onMessage: { addListener: function() {} }
        };
      }
      if (!window.chrome.storage) {
        window.chrome.storage = { local: { get: function(d, cb){ if(cb) cb(typeof d==='object'&&d?d:{}); }, set: function(_o,cb){ if(cb) cb(); } } };
      }
      ${rawContent}
      return true;
    })();`;
  }

  return `(function(){
    if (window.__hdContentBootstrapped) return true;
    window.__hdContentBootstrapped = true;
    const bridge = window.__hdExtensionBridge;
    if (!bridge) return false;
    const pushListeners = [];
    bridge.onPushMessage((msg) => {
      for (const fn of pushListeners) {
        try { fn(msg); } catch (_) {}
      }
    });
    window.addEventListener('message', (ev) => {
      if (ev && ev.data && ev.data.__hdExtFrameMsg) {
        bridge.sendMessage(ev.data.__hdExtFrameMsg).catch(() => {});
      }
    });
    if (!window.__hdFetchPatched) {
      window.__hdFetchPatched = true;
      const origFetch = window.fetch.bind(window);
      window.fetch = async function(input, init) {
        const u = (typeof input === 'string') ? input : (input && input.url ? input.url : '');
        if (/^http:\\/\\/(127\\.0\\.0\\.1|localhost):(6880|6882)\\//i.test(u)) {
          const opts = init ? { method: init.method || 'GET', headers: init.headers || {}, body: init.body } : { method: 'GET' };
          const res = await bridge.localFetch(u, opts);
          return new Response(res.body || '', {
            status: res.status || 500,
            statusText: res.statusText || '',
            headers: { 'Content-Type': res.contentType || 'application/json' }
          });
        }
        return origFetch(input, init);
      };
    }
    if (!window.chrome) window.chrome = {};
    window.chrome.runtime = {
      lastError: null,
      sendMessage: function(msg, cb) {
        const p = bridge.sendMessage(msg).then((res) => {
          window.chrome.runtime.lastError = null;
          if (typeof cb === 'function') cb(res);
          return res;
        }).catch((err) => {
          window.chrome.runtime.lastError = { message: err && err.message ? err.message : 'IPC error' };
          if (typeof cb === 'function') cb(null);
          return null;
        });
        return p;
      },
      onMessage: {
        addListener: function(fn) {
          if (typeof fn === 'function') pushListeners.push(fn);
        }
      }
    };
    window.chrome.storage = {
      local: {
        get: function(keys, cb) {
          const out = {};
          try {
            if (Array.isArray(keys)) {
              for (const k of keys) {
                const raw = localStorage.getItem('hd_ext_' + k);
                if (raw !== null) {
                  try { out[k] = JSON.parse(raw); } catch (_) { out[k] = raw; }
                }
              }
            } else if (keys && typeof keys === 'object') {
              for (const k of Object.keys(keys)) {
                const raw = localStorage.getItem('hd_ext_' + k);
                if (raw !== null) {
                  try { out[k] = JSON.parse(raw); } catch (_) { out[k] = raw; }
                } else {
                  out[k] = keys[k];
                }
              }
            } else if (typeof keys === 'string') {
              const raw = localStorage.getItem('hd_ext_' + keys);
              if (raw !== null) {
                try { out[keys] = JSON.parse(raw); } catch (_) { out[keys] = raw; }
              }
            }
          } catch (_) {}
          if (typeof cb === 'function') cb(out);
        },
        set: function(obj, cb) {
          try {
            if (obj && typeof obj === 'object') {
              for (const k of Object.keys(obj)) {
                localStorage.setItem('hd_ext_' + k, JSON.stringify(obj[k]));
              }
            }
          } catch (_) {}
          if (typeof cb === 'function') cb();
        }
      }
    };
    if (!window.__hdEcoStylePatched) {
      window.__hdEcoStylePatched = true;
      window.__hdApplyEcoMode = function(isEco) {
        let st = document.getElementById('__hd_eco_style');
        if (isEco) {
          if (!st) {
            st = document.createElement('style');
            st.id = '__hd_eco_style';
            st.textContent = '*, *::before, *::after { animation-duration: 0.001ms !important; transition-duration: 0.001ms !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }';
            (document.head || document.documentElement).appendChild(st);
          }
          document.querySelectorAll('video').forEach((v) => {
            try { v.pause(); v.preload = 'none'; } catch (_) {}
          });
        } else if (st) {
          st.remove();
        }
      };
      if (${browserEcoMode ? 'true' : 'false'}) {
        window.__hdApplyEcoMode(true);
      }
    }
    ${rawContent}
    return true;
  })();`;
}

function handleWebviewStreamDetected(rawUrl, webContentsId, meta = {}) {
  if (!rawUrl || !webContentsId) return;
  let parsedRaw;
  try {
    parsedRaw = new URL(rawUrl);
  } catch (_) {
    return;
  }
  const hostLower = parsedRaw.hostname.toLowerCase();
  const pathLower = parsedRaw.pathname.toLowerCase();
  const lower = rawUrl.toLowerCase();

  if (
    hostLower.includes('jwpltx.com') ||
    hostLower.includes('google-analytics') ||
    hostLower.includes('googletagmanager') ||
    hostLower.includes('statlytic') ||
    hostLower.includes('cloudflareinsights') ||
    pathLower.includes('/ping.gif') ||
    pathLower.includes('/beacon') ||
    pathLower.includes('/telemetry') ||
    /\.(gif|html|htm|json|css|js|txt|php|svg|png|jpg|jpeg|webp|ico|woff|woff2|ttf)(\?.*)?$/i.test(pathLower)
  ) {
    return;
  }

  if (
    lower.includes('/api/') ||
    lower.includes('/ajax/') ||
    lower.includes('/theme/') ||
    lower.includes('/episodes/')
  ) {
    if (!pathLower.includes('.m3u8') && !pathLower.includes('.mpd')) return;
  }

  let targetUrl = rawUrl;
  if (/\/(?:init|seg|chunk|frag|main)[^/?#]*\.(mp4|m4s)/i.test(targetUrl)) {
    targetUrl = targetUrl.replace(/\/(?:init|seg|chunk|frag|main)[^/?#]*\.(mp4|m4s)/i, '.m3u8');
  }

  let targetPathLower = pathLower;
  try {
    targetPathLower = new URL(targetUrl).pathname.toLowerCase();
  } catch (_) {}
  const targetLower = targetUrl.toLowerCase();
  const isChunkFragment =
    /\.(ts|m4s|m4f|key)$/i.test(targetPathLower) ||
    targetLower.includes('/seg_') ||
    targetLower.includes('/seg-') ||
    targetLower.includes('segment-') ||
    targetLower.includes('segment_') ||
    targetLower.includes('-frag') ||
    targetLower.includes('/frag_') ||
    targetLower.includes('/frag-') ||
    targetLower.includes('/chunk-') ||
    targetLower.includes('/chunk_') ||
    /\/(?:init|main|seg|chunk|frag)[^/?#]*\.mp4/i.test(targetPathLower);
  if (isChunkFragment) return;

  const isM3U8 =
    targetPathLower.includes('.m3u8') ||
    targetPathLower.includes('.mpd') ||
    targetPathLower.endsWith('master.txt') ||
    /\/playlist\.m3u8/i.test(targetPathLower) ||
    /\/master\.m3u8/i.test(targetPathLower) ||
    /\/index\.m3u8/i.test(targetPathLower) ||
    /\/hls\/[^\s"']+\.m3u8/i.test(targetPathLower) ||
    /[?&](?:format|type)=m3u8/i.test(parsedRaw.search.toLowerCase());
  const isDirectVideo = !isChunkFragment && /\.(mp4|mkv|webm|mov)$/i.test(targetPathLower);
  if (!isM3U8 && !isDirectVideo) return;

  const cachedMeta = webviewReqHeadersCache.get(rawUrl) || {};
  let referer = meta.referer || cachedMeta.referer || '';
  let origin = meta.origin || cachedMeta.origin || '';
  const cookie = meta.cookie || cachedMeta.cookie || '';

  if (!origin && referer) {
    try { origin = new URL(referer).origin; } catch (_) {}
  }

  let masterUrl = '';
  if (isM3U8) {
    const subPattern = /\/(?:aud|audio|vid|video|\d{3,4})(?:\/[^/]+)?\/index\.m3u8(\?.*)?$/i;
    if (subPattern.test(targetUrl)) {
      masterUrl = targetUrl.replace(subPattern, '/master.m3u8$1');
      targetUrl = masterUrl;
    } else if (targetUrl.includes('master.m3u8')) {
      masterUrl = targetUrl;
    }
  }

  const streams = webviewStreamsByContentsId.get(webContentsId) || [];
  const existingIdx = streams.findIndex(s => s.url === targetUrl);
  let streamInfo;
  if (existingIdx >= 0) {
    streamInfo = streams[existingIdx];
    if (referer && !streamInfo.referer) streamInfo.referer = referer;
    if (origin && !streamInfo.origin) streamInfo.origin = origin;
    if (cookie && !streamInfo.cookie) streamInfo.cookie = cookie;
    if (masterUrl && !streamInfo.master_url) streamInfo.master_url = masterUrl;
    streams.splice(existingIdx, 1);
    streams.unshift(streamInfo);
  } else {
    streamInfo = {
      url: targetUrl,
      master_url: masterUrl,
      type: isM3U8 ? 'HLS' : 'MP4',
      label: isM3U8 ? '🎬 Video Stream' : '🎬 Direct MP4 Video',
      referer: referer || '',
      origin: origin || '',
      cookie: cookie || ''
    };
    streams.unshift(streamInfo);
    if (streams.length > 8) streams.length = 8;
    webviewStreamsByContentsId.set(webContentsId, streams);

    const wc = webviewContentsById.get(webContentsId);
    if (wc && !wc.isDestroyed()) {
      wc.send('hd-ext-push', { action: 'stream_detected', stream: streamInfo });
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('browser-media-sniffed', {
        url: targetUrl,
        referer,
        origin,
        cookie
      });
    }
  }
}

const AD_BLOCK_DOMAINS = [
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'googletagmanager.com',
  'google-analytics.com',
  'popads.net',
  'popcash.net',
  'propellerads.com',
  'adsterra.com',
  'highperformanceformat.com',
  'effectivegatecpm.com',
  'profitablegatecpm.com',
  'exoclick.com',
  'realsrv.com',
  'juicyads.com',
  'trafficjunky.com',
  'ad-maven.com',
  'admaven.com',
  'monetag.com',
  'hilltopads.net',
  'clickadu.com',
  'onclicka.com',
  'galaksion.com',
  'taboola.com',
  'outbrain.com',
  'mgid.com',
  'adskeeper.com',
  'acscdn.com',
  'pushengage.com',
  'mc.yandex.ru',
  'scorecardresearch.com',
  'quantserve.com',
  'criteo.com',
  'pubmatic.com',
  'rubiconproject.com',
  'openx.net',
  'adnxs.com',
  'bidswitch.net',
  '3lift.com',
  'revcontent.com',
  'dtscout.com',
  'histats.com',
  'whos.amung.us',
  'bidgear.com',
  'tsyndicate.com',
  'tsyndicate.net',
  'syndication.exdynsrv.com',
  'a-ads.com',
  'coinzilla.com',
  'betterbannerscloud.com',
  'wayfarerorthodox.com',
  'onclicksuper.com',
  'al5sm.com',
  '1005166.xyz',
  'es344.com',
  '1xbet.com',
  'betwinner.com',
  'melbet.com',
  'mostbet.com',
  'connatix.com',
  'adform.net',
  'bidgx.com',
  'adsrvr.org',
  'stackadapt.com',
  'sharethrough.com',
  'unrulymedia.com',
  'sitescout.com',
  'smartadserver.com',
  'copper6.com',
  'media.net',
  'pmbmonetize.live'
];

const AD_BLOCK_DOMAINS_SET = new Set(AD_BLOCK_DOMAINS);

const AD_PATH_PATTERNS = [
  /\/afu\.php/i,
  /\/popunder/i,
  /\/pop\.js(\?|$)/i,
  /\/pagead\//i,
  /\/adserver\//i,
  /[?&]tag=d_\d+/i,
  /\b1xlite[-a-z0-9]*\./i
];

function isAdOrTrackerUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    const parts = host.split('.');
    for (let i = 0; i < parts.length - 1; i++) {
      if (AD_BLOCK_DOMAINS_SET.has(parts.slice(i).join('.'))) {
        return true;
      }
    }
    const pathAndQuery = parsed.pathname + parsed.search;
    for (const pat of AD_PATH_PATTERNS) {
      if (pat.test(rawUrl) || pat.test(pathAndQuery)) return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

function isHeavyMediaChunkUrl(rawUrl, resourceType) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  if (rawUrl.includes('.m3u8') || rawUrl.includes('.mpd')) return false;
  if (resourceType === 'media') return true;
  const lower = rawUrl.toLowerCase();
  return (
    /\.(ts|m4s|m4f)(\?|$)/i.test(lower) ||
    /\/(?:seg[-_]|frag[-_]|chunk[-_]|segment[-_])/i.test(lower)
  );
}

function isDirectDownloadUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  if (rawUrl.startsWith('magnet:')) return true;
  try {
    const parsed = new URL(rawUrl);
    const pathname = parsed.pathname.toLowerCase();
    return /\.(mp4|mkv|webm|avi|mov|flv|m4v|mp3|flac|zip|rar|7z|tar|gz|iso|exe|msi|deb|appimage|apk)$/i.test(pathname);
  } catch (_) {
    return false;
  }
}

function isSniffableMediaUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    const parsed = new URL(rawUrl);
    const p = parsed.pathname.toLowerCase();
    if (p.endsWith('.m3u8') || p.endsWith('.mpd')) return true;
    if (/\.(mp4|mkv|webm)(\?|$)/i.test(p)) return true;
    return false;
  } catch (_) {
    return false;
  }
}

function emitBrowserShieldStats(immediate = false) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const payload = { enabled: browserShieldEnabled, ...browserShieldStats };
  if (immediate) {
    if (shieldEmitTimer) {
      clearTimeout(shieldEmitTimer);
      shieldEmitTimer = null;
    }
    mainWindow.webContents.send('browser-shield-stats', payload);
    return;
  }
  if (shieldEmitTimer) return;
  shieldEmitTimer = setTimeout(() => {
    shieldEmitTimer = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('browser-shield-stats', {
        enabled: browserShieldEnabled,
        ...browserShieldStats
      });
    }
  }, 350);
}

function setupBrowserShieldSession() {
  if (browserSessionInitialized) return;
  browserSessionInitialized = true;

  const ses = session.fromPartition(BROWSER_PARTITION);
  const chromeVer = process.versions.chrome || '126.0.0.0';
  const cleanUA = process.platform === 'win32'
    ? `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`
    : `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`;
  ses.setUserAgent(cleanUA);

  // Sync optional HyperDrain proxy setting (e.g. ByeDPI/SpoofDPI) if configured
  syncBrowserSessionProxy().catch(() => {});

  ses.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    if (
      details.requestHeaders &&
      (details.resourceType === 'media' ||
       details.url.includes('.m3u8') ||
       details.url.includes('.mpd') ||
       (details.resourceType === 'xhr' && /\.(mp4|mkv|webm|mov)(\?|$)/i.test(details.url)))
    ) {
      const h = details.requestHeaders;
      const referer = h.Referer || h.referer || details.referrer || '';
      const origin = h.Origin || h.origin || '';
      const cookie = h.Cookie || h.cookie || '';
      if (referer || origin || cookie) {
        webviewReqHeadersCache.set(details.url, { referer, origin, cookie });
        if (webviewReqHeadersCache.size > 200) {
          const firstKey = webviewReqHeadersCache.keys().next().value;
          webviewReqHeadersCache.delete(firstKey);
        }
      }
    }
    callback({});
  });

  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    if (browserShieldEnabled && isAdOrTrackerUrl(details.url)) {
      browserShieldStats.blockedAds += 1;
      emitBrowserShieldStats(false);
      callback({ cancel: true });
      return;
    }

    if (
      details.webContentsId &&
      (details.resourceType === 'media' ||
       details.resourceType === 'xhr' ||
       details.resourceType === 'other' ||
       details.url.includes('.m3u8') ||
       details.url.includes('.mpd') ||
       /\.(mp4|mkv|webm|mov)(\?|$)/i.test(details.url))
    ) {
      handleWebviewStreamDetected(details.url, details.webContentsId, {
        referer: details.referrer || ''
      });
    }

    // In Eco Mode, skip heavy video chunk/media buffering once manifest URLs are sniffed
    if (browserEcoMode && isHeavyMediaChunkUrl(details.url, details.resourceType)) {
      callback({ cancel: true });
      return;
    }

    callback({ cancel: false });
  });

  ses.on('will-download', async (_event, item, webContents) => {
    const downloadUrl = item.getURL();
    const filename = item.getFilename() || '';
    const totalBytes = item.getTotalBytes() || 0;
    const mimeType = item.getMimeType() || '';
    const referer = (webContents && !webContents.isDestroyed()) ? (webContents.getURL() || '') : '';

    // Hand off directly to HyperDrain's high-speed multi-connection engine
    item.cancel();

    let cookieStr = '';
    try {
      const cookies = await ses.cookies.get({ url: downloadUrl });
      if (Array.isArray(cookies) && cookies.length > 0) {
        cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      }
    } catch (_) {}

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('browser-download-captured', {
        url: downloadUrl,
        filename,
        totalBytes,
        mimeType,
        referer,
        cookie: cookieStr,
        userAgent: cleanUA
      });
    }
  });
}

function isLocalProxyReachable(proxyUrl) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(proxyUrl);
      const host = parsed.hostname;
      const port = parseInt(parsed.port || (parsed.protocol.startsWith('socks') ? '1080' : '8080'), 10);
      if (!port || (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1')) {
        resolve(true);
        return;
      }
      const sock = nodeNet.connect(port, host);
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        try { sock.destroy(); } catch (_) {}
        resolve(ok);
      };
      sock.on('connect', () => done(true));
      sock.on('error', () => done(false));
      sock.setTimeout(500, () => done(false));
    } catch (_) {
      resolve(true);
    }
  });
}

async function syncBrowserSessionProxy() {
  const ses = session.fromPartition(BROWSER_PARTITION);
  try {
    const cfg = await new Promise((resolve) => {
      const req = http.get(`${CORE_URL}/api/settings`, {
        headers: { 'X-HyperDrain-Token': 'hyperdrain_secret_token' },
        timeout: 1500
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (_) {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
    });

    if (!cfg || !cfg.proxy_url || typeof cfg.proxy_url !== 'string' || !cfg.proxy_url.trim()) {
      await ses.setProxy({ mode: 'direct' });
      return { ok: true, mode: 'direct', proxyRules: '' };
    }

    const rawProxy = cfg.proxy_url.trim();
    const fallbackEnabled = cfg.proxy_fallback !== false;
    if (fallbackEnabled) {
      const reachable = await isLocalProxyReachable(rawProxy);
      if (!reachable) {
        await ses.setProxy({ mode: 'direct' });
        return { ok: true, mode: 'direct', fallbackFrom: rawProxy, proxyRules: '' };
      }
    }

    const proxyRules = rawProxy.replace(/^socks5h:\/\//i, 'socks5://');
    await ses.setProxy({ proxyRules });
    return { ok: true, mode: 'fixed_servers', proxyRules };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function extractHtmlLandingRedirect(htmlText) {
  if (!htmlText || typeof htmlText !== 'string') return '';
  const sample = htmlText.slice(0, 65536);
  const metaMatch = sample.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url\s*=\s*([^"'\s>]+)/i) ||
    sample.match(/<meta[^>]+content=["'][^"']*url\s*=\s*([^"'\s>]+)["'][^>]+http-equiv=["']?refresh["']?/i);
  if (metaMatch && metaMatch[1]) {
    return metaMatch[1].replace(/['"]/g, '').trim();
  }
  const jsMatch = sample.match(/(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i) ||
    sample.match(/location\.(?:replace|assign)\(\s*["']([^"']+)["']\s*\)/i);
  if (jsMatch && jsMatch[1]) {
    const candidate = jsMatch[1].trim();
    if (!candidate.startsWith('#') && !/^javascript:/i.test(candidate)) {
      return candidate;
    }
  }
  return '';
}

async function fetchRedirectHop(targetUrl, method = 'GET') {
  const ses = session.fromPartition(BROWSER_PARTITION);
  if (electronNet && typeof electronNet.fetch === 'function') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    try {
      const resp = await electronNet.fetch(targetUrl, {
        session: ses,
        method,
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8'
        }
      });
      const code = resp.status || 0;
      const loc = resp.headers.get('location') || '';
      let html = '';
      if (method === 'GET' && code >= 200 && code < 300) {
        const ct = (resp.headers.get('content-type') || '').toLowerCase();
        if (!ct || ct.includes('text/html') || ct.includes('application/xhtml')) {
          html = (await resp.text()).slice(0, 65536);
        }
      }
      clearTimeout(timer);
      return { statusCode: code, location: loc, html };
    } catch (err) {
      clearTimeout(timer);
      return { error: err && err.name === 'AbortError' ? 'Timeout' : (err.message || 'Network error') };
    }
  }

  return await new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (err) {
      resolve({ error: err.message });
      return;
    }
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request(targetUrl, {
      method,
      timeout: 7000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8'
      }
    }, (res) => {
      const code = res.statusCode || 0;
      const loc = res.headers && res.headers.location ? String(res.headers.location) : '';
      let body = '';
      if (method === 'GET' && code >= 200 && code < 300) {
        res.on('data', (chunk) => {
          if (body.length < 65536) body += chunk.toString('utf8');
        });
        res.on('end', () => resolve({ statusCode: code, location: loc, html: body }));
      } else {
        res.resume();
        resolve({ statusCode: code, location: loc, html: '' });
      }
    });
    req.on('error', (err) => resolve({ error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ error: 'Timeout' });
    });
    req.end();
  });
}

async function resolveSiteRedirectChain(inputUrl) {
  if (!inputUrl || !/^https?:\/\//i.test(inputUrl)) {
    return { ok: false, error: 'Invalid URL' };
  }

  let currentUrl = inputUrl.trim();
  const visited = new Set([currentUrl]);
  const maxHops = 8;
  let lastStatus = 0;

  for (let hop = 0; hop < maxHops; hop++) {
    let result = await fetchRedirectHop(currentUrl, hop === 0 ? 'HEAD' : 'GET');
    if (result.error) {
      return { ok: false, error: result.error, initialUrl: inputUrl, finalUrl: currentUrl };
    }

    lastStatus = result.statusCode;

    // Some servers reject HEAD or serve an HTML meta/JS landing redirect only on GET
    if (hop === 0 && (result.statusCode === 405 || result.statusCode === 501 || (result.statusCode >= 200 && result.statusCode < 300))) {
      const retryGet = await fetchRedirectHop(currentUrl, 'GET');
      if (!retryGet.error) {
        result = retryGet;
        lastStatus = result.statusCode;
      }
    }

    let nextLocation = '';
    if (result.statusCode >= 300 && result.statusCode < 400 && result.location) {
      nextLocation = result.location;
    } else if (result.statusCode >= 200 && result.statusCode < 300 && result.html) {
      nextLocation = extractHtmlLandingRedirect(result.html);
    }

    if (nextLocation) {
      let nextUrl;
      try {
        nextUrl = new URL(nextLocation, currentUrl).toString();
      } catch (_) {
        break;
      }
      if (isAdOrTrackerUrl(nextUrl) || visited.has(nextUrl)) {
        break;
      }
      visited.add(nextUrl);
      currentUrl = nextUrl;
      continue;
    }

    break;
  }

  let initialOrigin = '';
  let finalOrigin = '';
  try {
    initialOrigin = new URL(inputUrl).origin;
    finalOrigin = new URL(currentUrl).origin;
  } catch (_) {}

  return {
    ok: true,
    initialUrl: inputUrl,
    finalUrl: currentUrl,
    changed: Boolean(finalOrigin && initialOrigin && finalOrigin !== initialOrigin),
    statusCode: lastStatus
  };
}

app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;

  setupBrowserShieldSession();
  webviewContentsById.set(contents.id, contents);
  contents.on('destroyed', () => {
    webviewContentsById.delete(contents.id);
    webviewStreamsByContentsId.delete(contents.id);
  });

  const injectedFrameKeys = new Set();

  const injectFrameOnce = (frame, isTop) => {
    try {
      if (!frame || frame.detached) return;
      const fUrl = frame.url || '';
      if (!/^https?:\/\//i.test(fUrl)) return;
      const key = `${frame.routingId}|${fUrl}`;
      if (injectedFrameKeys.has(key)) return;
      injectedFrameKeys.add(key);
      const payload = buildExtensionInjectionPayload(isTop);
      if (payload) {
        frame.executeJavaScript(payload).catch(() => {
          injectedFrameKeys.delete(key);
        });
      }
    } catch (_) {}
  };

  contents.on('did-start-navigation', (_ev, navUrl, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace && navUrl && /^https?:\/\//i.test(navUrl)) {
      injectedFrameKeys.clear();
      webviewStreamsByContentsId.delete(contents.id);
      contents.send('hd-ext-push', { action: 'page_navigated', url: navUrl });
    }
  });

  contents.on('dom-ready', () => {
    try {
      if (contents.isDestroyed() || !contents.mainFrame) return;
      injectFrameOnce(contents.mainFrame, true);
    } catch (_) {}
  });

  contents.on('did-frame-finish-load', (_ev, isMainFrame, _frameProcessId, frameRoutingId) => {
    try {
      if (contents.isDestroyed() || !contents.mainFrame) return;
      if (isMainFrame) {
        injectFrameOnce(contents.mainFrame, true);
        return;
      }
      const subFrames = contents.mainFrame.framesInSubtree || [];
      let target = null;
      for (const f of subFrames) {
        try {
          if (f && !f.detached && f.routingId === frameRoutingId) {
            target = f;
            break;
          }
        } catch (_) {}
      }
      if (target) {
        injectFrameOnce(target, false);
      } else {
        for (const frame of subFrames) {
          injectFrameOnce(frame, false);
        }
      }
    } catch (_) {}
  });

  contents.setWindowOpenHandler(({ url, disposition, features }) => {
    const currentPageUrl = (!contents.isDestroyed() && contents.getURL()) ? contents.getURL() : '';

    if (isDirectDownloadUrl(url)) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('browser-download-captured', {
          url,
          filename: '',
          totalBytes: 0,
          mimeType: '',
          referer: currentPageUrl,
          cookie: ''
        });
      }
      return { action: 'deny' };
    }

    if (!url || !/^https?:\/\//i.test(url) || url === 'about:blank') {
      if (browserShieldEnabled) {
        browserShieldStats.blockedPopups += 1;
        emitBrowserShieldStats(false);
      }
      return { action: 'deny' };
    }

    const isPopupGeometry = Boolean(features && features.trim().length > 0);
    let sameRootSite = false;
    try {
      const targetParts = new URL(url).hostname.toLowerCase().split('.');
      const curParts = new URL(currentPageUrl).hostname.toLowerCase().split('.');
      const targetRoot = targetParts.slice(-2).join('.');
      const curRoot = curParts.slice(-2).join('.');
      sameRootSite = Boolean(targetRoot && curRoot && targetRoot === curRoot);
    } catch (_) {}

    if (browserShieldEnabled && (!sameRootSite || isAdOrTrackerUrl(url) || disposition === 'background-tab' || isPopupGeometry)) {
      browserShieldStats.blockedPopups += 1;
      emitBrowserShieldStats(false);
      if (!sameRootSite && disposition !== 'background-tab' && !isPopupGeometry && !isAdOrTrackerUrl(url) && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('browser-popup-blocked', { url });
      }
      return { action: 'deny' };
    }

    // Open same-site target="_blank" links cleanly inside the same webview
    setImmediate(() => {
      if (!contents.isDestroyed()) {
        contents.loadURL(url, currentPageUrl ? { httpReferrer: currentPageUrl } : undefined).catch(() => {});
      }
    });
    return { action: 'deny' };
  });

  contents.on('will-navigate', (navEvent, navUrl) => {
    if (browserShieldEnabled && isAdOrTrackerUrl(navUrl)) {
      navEvent.preventDefault();
      browserShieldStats.blockedAds += 1;
      emitBrowserShieldStats(false);
    }
  });
});

// App lifecycle
app.on('second-instance', (event, commandLine) => {
  const urlArg = (commandLine || []).find(arg => typeof arg === 'string' && arg.startsWith('hyperdrain://'));
  if (urlArg && urlArg.includes('wake')) {
    console.log('[HyperDrain Desktop] Woken up in background via hyperdrain://wake');
    return;
  }
  if (mainWindow) {
    mainWindow.setSkipTaskbar(false);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  // 1. Start Go Engine
  await ensureEngineRunning();

  // 2. Setup IPC, UI Window, System Tray & Mini Notification Server
  setupIPCHandlers();
  createMainWindow();
  setupTray();
  startMiniServer();
  ensureAutostart();

  // 3. Quiet Background Update Check (3 seconds after startup)
  setTimeout(async () => {
    try {
      const res = await checkOnlineUpdate();
      if (res && res.updateAvailable && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-available-detected', res);
      }
    } catch (_) {}
  }, 3000);
});

app.on('window-all-closed', () => {
  if (isQuitting) {
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  if (miniServer) {
    try { miniServer.close(); } catch (e) {}
    miniServer = null;
  }
  for (const win of miniWindows.values()) {
    try { win.destroy(); } catch (e) {}
  }
  miniWindows.clear();
  if (engineProcess && spawnedEngine) {
    console.log('[HyperDrain Desktop] Gracefully terminating spawned engine...');
    try {
      engineProcess.kill('SIGTERM');
    } catch (e) {}
  }
});
