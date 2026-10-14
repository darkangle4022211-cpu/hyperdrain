const { app, BrowserWindow, ipcMain, Tray, Menu, Notification, dialog, shell, session, nativeImage } = require('electron');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');

// Performance & quiet Linux flags: no-sandbox and disable GPU watchdog to eliminate spin loops
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-watchdog');

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
const GITHUB_REPO = 'darkangle4022211-cpu/hyperdrain';
const APP_VERSION = '1.0.3';

function getAppIcon() {
  const iconPaths = [
    path.join(ASSETS_DIR, 'hyperdrain.png'),
    path.join(EXTENSION_DIR, 'icons', 'icon128.png'),
    path.join(ROOT_DIR, 'icon.png'),
    '/usr/share/icons/hicolor/512x512/apps/hyperdrain.png',
    '/usr/share/pixmaps/hyperdrain.png',
    '/opt/hyperdrain/assets/hyperdrain.png'
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
    path.join(path.dirname(process.execPath), 'bin', engineBinary),
    path.join('/opt/hyperdrain', 'bin', engineBinary),
    path.join(ROOT_DIR, engineBinary),
    path.join(path.dirname(process.execPath), 'bin', genericBinary),
    path.join(path.dirname(process.execPath), 'resources', 'app', engineBinary),
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
      sandbox: false
    }
  });

  const localUi = path.join(ROOT_DIR, 'webui', 'index.html');
  if (fs.existsSync(localUi)) {
    mainWindow.loadFile(localUi);
  } else {
    mainWindow.loadURL(CORE_URL);
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('window-state-change', { maximized: true });
  });

  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window-state-change', { maximized: false });
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      isQuitting = true;
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (tray && !tray.isDestroyed()) {
      try { tray.destroy(); } catch (e) {}
      tray = null;
    }
    app.quit();
  });
}

// 4. Setup System Tray
function setupTray() {
  const iconPath = getAppIcon();
  if (!iconPath) return;

  const trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 20, height: 20 });
  tray = new Tray(trayIcon);
  tray.setToolTip('HyperDrain — 32GB High-Speed Resilient Downloader');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open HyperDrain Dashboard',
      click: () => {
        if (mainWindow) {
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
  tray.on('double-click', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
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
    const platformKey = isWin ? 'windows-x64' : 'linux-deb-x64';

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
            const fileName = isWin ? `HyperDrain-Setup-${latestVersion}.exe` : `hyperdrain_${latestVersion}_amd64.deb`;
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
          const platData = rawManifest.platforms?.[platformKey] || (isWin ? rawManifest.platforms?.['windows-x64'] : rawManifest.platforms?.['linux-deb-x64']);
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
              filename: platData?.filename || (isWin ? `HyperDrain-Setup-${rawManifest.version}.exe` : `hyperdrain_${rawManifest.version}_amd64.deb`),
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
            const platData = localManifest.platforms?.[platformKey] || (isWin ? localManifest.platforms?.['windows-x64'] : localManifest.platforms?.['linux-deb-x64']);
            return {
              updateAvailable: true,
              currentVersion: APP_VERSION,
              latestVersion: localManifest.version,
              releaseNotes: localManifest.changelog || 'Local test update available.',
              downloadUrl: platData?.url || '',
              filename: platData?.filename || (isWin ? `HyperDrain-Setup-${localManifest.version}.exe` : `hyperdrain_${localManifest.version}_amd64.deb`),
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

    // Filter platform-specific asset: .exe for Windows, .deb for Linux
    let targetAsset = null;
    if (isWin) {
      targetAsset = (rel.assets || []).find(a => a.name && (a.name.endsWith('.exe') || a.name.endsWith('.msi')));
    } else {
      targetAsset = (rel.assets || []).find(a => a.name && a.name.endsWith('.deb'));
    }

    const downloadUrl = targetAsset ? targetAsset.browser_download_url : (rel.html_url || '');

    return {
      updateAvailable: true,
      currentVersion: APP_VERSION,
      latestVersion,
      releaseNotes: (rel.body && rel.body.trim()) ? rel.body.trim() : 'Performance optimization, high-speed engine enhancement, and stability improvements.',
      downloadUrl,
      filename: targetAsset ? targetAsset.name : (isWin ? `HyperDrain-Setup-${latestVersion}.exe` : `hyperdrain_${latestVersion}_amd64.deb`),
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
  ipcMain.on('window-minimize', () => {
    if (mainWindow) mainWindow.minimize();
  });

  ipcMain.on('window-maximize', () => {
    if (mainWindow) {
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
      } else {
        mainWindow.maximize();
      }
    }
  });

  ipcMain.on('window-close', () => {
    if (mainWindow) mainWindow.close();
  });

  ipcMain.handle('window-is-maximized', () => {
    return mainWindow ? mainWindow.isMaximized() : false;
  });

  ipcMain.handle('choose-folder', async (_event, defaultPath) => {
    if (!mainWindow) return { cancelled: true };

    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select HyperDrain Download Directory',
      defaultPath: defaultPath || app.getPath('downloads'),
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
      await shell.openPath(targetPath);
      return true;
    } catch (e) {
      return false;
    }
  });

  ipcMain.handle('show-item-in-folder', async (_event, filePath) => {
    if (!filePath) return false;
    try {
      shell.showItemInFolder(filePath);
      return true;
    } catch (e) {
      return false;
    }
  });

  ipcMain.handle('open-extension-folder', async () => {
    try {
      await shell.openPath(EXTENSION_DIR);
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
      if (process.platform === 'win32') {
        const cmd = `powershell Compress-Archive -Path "${EXTENSION_DIR}\\*" -DestinationPath "${destFile}" -Force`;
        await new Promise((res, rej) => exec(cmd, (err) => err ? rej(err) : res()));
      } else {
        const cmd = `cd "${EXTENSION_DIR}" && zip -r "${destFile}" . -x "*.git*"`;
        await new Promise((res, rej) => exec(cmd, (err) => err ? rej(err) : res()));
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
    const ext = isWin ? '.exe' : '.deb';
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
    const defaultPackage = path.join(os.tmpdir(), isWin ? 'hyperdrain_latest.exe' : 'hyperdrain_latest.deb');
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

    const debPath = pkgPath;
    const currentPid = process.pid;
    const scriptPath = path.join(os.tmpdir(), 'hd_updater.sh');
    const disp = process.env.DISPLAY || ':0';
    const xauth = process.env.XAUTHORITY || '';
    const wayland = process.env.WAYLAND_DISPLAY || '';
    const xdgRuntime = process.env.XDG_RUNTIME_DIR || '';

    const scriptContent = `#!/usr/bin/env bash
export DISPLAY="${disp}"
export XAUTHORITY="${xauth}"
export WAYLAND_DISPLAY="${wayland}"
export XDG_RUNTIME_DIR="${xdgRuntime}"

# 1. Wait for old HyperDrain process to cleanly exit
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

# 2. Terminate backend engine without matching updater script
pkill -x 'hyperdrain-engine' 2>/dev/null || true
sleep 0.5

# 3. Prompt for administrative installation via pkexec (matches Pulsar Audio / Aero Player)
INSTALLED=0
if command -v pkexec >/dev/null 2>&1; then
  pkexec dpkg -i "${debPath}" && INSTALLED=1
fi

# Fallback: graphical password prompt via zenity if pkexec fails
if [ "$INSTALLED" -ne 1 ]; then
  if command -v zenity >/dev/null 2>&1; then
    PASS=$(zenity --password --title="HyperDrain System Update" 2>/dev/null)
    if [ -n "$PASS" ]; then
      echo "$PASS" | sudo -S dpkg -i "${debPath}" && INSTALLED=1
    fi
  fi
fi

# Final fallback: user-space rootless extraction
if [ "$INSTALLED" -ne 1 ]; then
  USER_APP_DIR="$HOME/.local/share/hyperdrain_app"
  mkdir -p "$USER_APP_DIR"
  if command -v dpkg-deb >/dev/null 2>&1; then
    dpkg-deb -x "${debPath}" "$USER_APP_DIR" && INSTALLED=1
  fi
fi

# 4. Relaunch newly updated application cleanly
sleep 0.5
if [ -x /usr/bin/hyperdrain ]; then
  nohup /usr/bin/hyperdrain >/dev/null 2>&1 &
elif [ -x /opt/hyperdrain/hyperdrain ]; then
  nohup /opt/hyperdrain/hyperdrain --no-sandbox >/dev/null 2>&1 &
elif [ -x "$HOME/.local/share/hyperdrain_app/opt/hyperdrain/hyperdrain" ]; then
  nohup "$HOME/.local/share/hyperdrain_app/opt/hyperdrain/hyperdrain" --no-sandbox >/dev/null 2>&1 &
fi

rm -f "${debPath}" "${scriptPath}" 2>/dev/null
`;

    try {
      fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
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
      console.error('[HyperDrain Updater] Launch script failed:', err);
      return { success: false, error: err.message };
    }
  });
}

// App lifecycle
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  // 1. Start Go Engine
  await ensureEngineRunning();

  // 2. Setup IPC, UI Window, and System Tray
  setupIPCHandlers();
  createMainWindow();
  setupTray();

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
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  if (engineProcess && spawnedEngine) {
    console.log('[HyperDrain Desktop] Gracefully terminating spawned engine...');
    try {
      engineProcess.kill('SIGTERM');
    } catch (e) {}
  }
});
