const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__hdExtensionBridge', {
  sendMessage: (msg) => ipcRenderer.invoke('hd-ext-message', msg),
  localFetch: (url, options) => ipcRenderer.invoke('hd-ext-local-fetch', { url, options }),
  onPushMessage: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('hd-ext-push', (_event, data) => callback(data));
  }
});
