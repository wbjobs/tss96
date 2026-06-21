const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("clipSync", {
  getDeviceInfo: () => ipcRenderer.invoke("get-device-info"),
  getConfig: () => ipcRenderer.invoke("get-config"),
  saveConfig: (config) => ipcRenderer.invoke("save-config", config),
  pushToDevice: (targetDeviceId, clip) => ipcRenderer.invoke("push-to-device", targetDeviceId, clip),
  copyToClipboard: (clip) => ipcRenderer.invoke("copy-to-clipboard", clip),
  apiRequest: (method, path, body, isFormData) => ipcRenderer.invoke("api-request", method, path, body, isFormData),
  getUploadQueue: () => ipcRenderer.invoke("get-upload-queue"),
  abortUpload: (taskId) => ipcRenderer.invoke("abort-upload", taskId),

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
  onUploadProgress: (cb) => {
    ipcRenderer.on("upload-progress", (_e, upload) => cb(upload));
  },
  onRemoteUploadProgress: (cb) => {
    ipcRenderer.on("remote-upload-progress", (_e, data) => cb(data));
  },
  onConflictDetected: (cb) => {
    ipcRenderer.on("conflict-detected", (_e, data) => cb(data));
  },
  onClipboardChangedConflict: (cb) => {
    ipcRenderer.on("clipboard-changed-conflict", (_e, clip) => cb(clip));
  },
});
