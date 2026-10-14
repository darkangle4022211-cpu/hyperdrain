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
  showItemInFolder: (filePath) => ipcRenderer.invoke('show-item-in-folder', filePath),

  // Browser Extension Helpers
  openExtensionFolder: () => ipcRenderer.invoke('open-extension-folder'),
  exportExtensionZip: () => ipcRenderer.invoke('export-extension-zip'),

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
  }
});
