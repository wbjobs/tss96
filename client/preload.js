const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("clipSync", {
  getDeviceInfo: () => ipcRenderer.invoke("get-device-info"),
  getConfig: () => ipcRenderer.invoke("get-config"),
  saveConfig: (config) => ipcRenderer.invoke("save-config", config),
  pushToDevice: (targetDeviceId, clip) => ipcRenderer.invoke("push-to-device", targetDeviceId, clip),
  copyToClipboard: (clip) => ipcRenderer.invoke("copy-to-clipboard", clip),
  apiRequest: (method, path, body, isFormData) => ipcRenderer.invoke("api-request", method, path, body, isFormData),

  onClipboardChanged: (cb) => {
    ipcRenderer.on("clipboard-changed", (_e, clip) => cb(clip));
  },
  onClipReceived: (cb) => {
    ipcRenderer.on("clip-received", (_e, clip) => cb(clip));
  },
  onClipCreatedRemote: (cb) => {
    ipcRenderer.on("clip-created-remote", (_e, clip) => cb(clip));
  },
  onWsStatus: (cb) => {
    ipcRenderer.on("ws-status", (_e, status) => cb(status));
  },
  onDownloadAndClipboardImage: (cb) => {
    ipcRenderer.on("download-and-clipboard-image", (_e, url) => cb(url));
  },
});
