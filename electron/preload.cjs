const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,

  // Window Controls
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  maximizeWindow: () => ipcRenderer.send('window-maximize'),
  closeWindow: () => ipcRenderer.send('window-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  onWindowStateChange: (callback) => {
    ipcRenderer.on('window-state-change', (_event, state) => callback(state));
  },

  // Native Dialogs & System Explorer
  chooseFolder: (defaultPath) => ipcRenderer.invoke('choose-folder', defaultPath),
  openPath: (targetPath) => ipcRenderer.invoke('open-path', targetPath),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  showItemInFolder: (filePath) => ipcRenderer.invoke('show-item-in-folder', filePath),

  // Browser Extension Helpers
  openExtensionFolder: () => ipcRenderer.invoke('open-extension-folder'),
  exportExtensionZip: () => ipcRenderer.invoke('export-extension-zip'),
  detectBrowsers: () => ipcRenderer.invoke('detect-browsers'),
  connectBrowser: (browserId) => ipcRenderer.invoke('connect-browser', browserId),
  copyExtensionPath: () => ipcRenderer.invoke('copy-extension-path'),

  // Native Notifications
  showNotification: (title, body) => ipcRenderer.invoke('show-notification', { title, body }),

  // Online Auto-Update System
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: (downloadUrl) => ipcRenderer.invoke('download-update', downloadUrl),
  installUpdate: (debPath) => ipcRenderer.invoke('install-update', debPath),
  onUpdateDownloadProgress: (callback) => {
    ipcRenderer.on('update-download-progress', (_event, data) => callback(data));
  },
  onUpdateAvailableDetected: (callback) => {
    ipcRenderer.on('update-available-detected', (_event, data) => callback(data));
  },

  // Built-in Safe Browser Shield & Redirect Tracking
  getWebviewPreloadPath: () => ipcRenderer.invoke('get-webview-preload-path'),
  ensureBrowserShield: () => ipcRenderer.invoke('ensure-browser-shield'),
  setBrowserShield: (enabled) => ipcRenderer.invoke('set-browser-shield', enabled),
  setBrowserEco: (enabled) => ipcRenderer.invoke('set-browser-eco', enabled),
  getBrowserEco: () => ipcRenderer.invoke('get-browser-eco'),
  getBrowserShieldStats: () => ipcRenderer.invoke('get-browser-shield-stats'),
  resetBrowserShieldStats: () => ipcRenderer.invoke('reset-browser-shield-stats'),
  resolveSiteRedirect: (url) => ipcRenderer.invoke('resolve-site-redirect', url),
  syncBrowserProxy: () => ipcRenderer.invoke('sync-browser-proxy'),
  clearBrowserSessionData: () => ipcRenderer.invoke('clear-browser-session-data'),
  onBrowserDownloadCaptured: (callback) => {
    ipcRenderer.on('browser-download-captured', (_event, data) => callback(data));
  },
  onBrowserPopupBlocked: (callback) => {
    ipcRenderer.on('browser-popup-blocked', (_event, data) => callback(data));
  },
  onBrowserShieldStats: (callback) => {
    ipcRenderer.on('browser-shield-stats', (_event, data) => callback(data));
  },
  onBrowserMediaSniffed: (callback) => {
    ipcRenderer.on('browser-media-sniffed', (_event, data) => callback(data));
  }
});
