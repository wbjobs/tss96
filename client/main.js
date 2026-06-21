const {
  app,
  BrowserWindow,
  ipcMain,
  clipboard,
  nativeImage,
  Menu,
  Tray,
  dialog,
} = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const WebSocket = require("ws");
const { applyRuleLocal, applyAllMatchingRulesLocal } = require("./converter");

const DEVICE_ID_FILE = path.join(app.getPath("userData"), "device.json");
const CONFIG_FILE = path.join(app.getPath("userData"), "config.json");

const CHUNK_SIZE = 5 * 1024 * 1024;
const LARGE_FILE_THRESHOLD = 20 * 1024 * 1024;
const CONCURRENT_CHUNKS = 3;

let mainWindow = null;
let tray = null;
let ws = null;
let wsReconnectTimer = null;
let currentConfig = { serverUrl: "ws://localhost:3200/ws", httpUrl: "http://localhost:3200" };
let deviceId = null;
let deviceName = null;
let lastClipboardText = "";
let lastClipboardImageHash = "";
let clipboardWatchTimer = null;

const uploadQueue = [];
let uploadActive = false;
const uploadsInProgress = new Map();

function loadDeviceId() {
  if (fs.existsSync(DEVICE_ID_FILE)) {
    const data = JSON.parse(fs.readFileSync(DEVICE_ID_FILE, "utf-8"));
    deviceId = data.id;
    deviceName = data.name;
  }
  if (!deviceId) {
    deviceId = uuidv4();
    deviceName = require("os").hostname();
    fs.writeFileSync(DEVICE_ID_FILE, JSON.stringify({ id: deviceId, name: deviceName }));
  }
}

function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    currentConfig = { ...currentConfig, ...data };
  }
}

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(currentConfig, null, 2));
}

function computeFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (d) => hash.update(d));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

function sendUploadProgress(upload) {
  if (mainWindow) {
    mainWindow.webContents.send("upload-progress", upload);
  }
}

function broadcastNewClip(clip) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "new_clip", clip }));
  }
}

async function enqueueUpload(task) {
  uploadQueue.push(task);
  processUploadQueue();
}

async function processUploadQueue() {
  if (uploadActive) return;
  if (!uploadQueue.length) return;
  uploadActive = true;

  const task = uploadQueue.shift();
  try {
    await performChunkedUpload(task);
  } catch (err) {
    task.status = "failed";
    task.error = err.message;
    sendUploadProgress(task);
  } finally {
    uploadActive = false;
    processUploadQueue();
  }
}

async function performChunkedUpload(task) {
  const httpUrl = currentConfig.httpUrl;
  const fileSize = fs.statSync(task.filePath).size;

  let fileHash = task.fileHash;
  if (!fileHash) {
    fileHash = await computeFileHash(task.filePath);
  }

  const initRes = await fetch(httpUrl + "/api/uploads/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deviceId,
      clipType: task.type,
      filename: task.filename,
      totalSize: fileSize,
      chunkSize: CHUNK_SIZE,
      fileHash,
    }),
  }).then((r) => r.json());

  if (initRes.alreadyExists) {
    task.status = "completed";
    task.progress = 100;
    task.result = { clip: initRes.clip };
    sendUploadProgress(task);
    broadcastNewClip(initRes.clip);
    if (mainWindow) mainWindow.webContents.send("clipboard-changed", initRes.clip);
    return;
  }

  const uploadId = initRes.uploadId;
  task.uploadId = uploadId;
  task.totalChunks = initRes.totalChunks;
  task.status = "uploading";
  task.progress = 0;
  uploadsInProgress.set(uploadId, task);
  sendUploadProgress(task);

  const totalChunks = initRes.totalChunks;
  let uploadedCount = 0;
  let chunkIndex = 0;

  const uploadChunk = async (idx) => {
    const form = new (require("form-data"))();
    const start = idx * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, fileSize);
    const chunkBuf = fs.readFileSync(task.filePath, { start, end: end - 1 });
    form.append("index", String(idx));
    form.append("chunk", chunkBuf, {
      filename: `chunk-${idx}`,
      contentType: "application/octet-stream",
    });

    const r = await fetch(`${httpUrl}/api/uploads/${uploadId}/chunk`, {
      method: "POST",
      body: form,
      headers: form.getHeaders(),
    });
    const data = await r.json();
    uploadedCount++;
    task.progress = Math.round((uploadedCount / totalChunks) * 100);
    sendUploadProgress(task);
    return data;
  };

  while (chunkIndex < totalChunks) {
    const batch = [];
    while (chunkIndex < totalChunks && batch.length < CONCURRENT_CHUNKS) {
      batch.push(uploadChunk(chunkIndex));
      chunkIndex++;
    }
    await Promise.all(batch);
  }

  const completeRes = await fetch(`${httpUrl}/api/uploads/${uploadId}/complete`, {
    method: "POST",
  }).then((r) => r.json());

  task.status = "completed";
  task.progress = 100;
  task.result = completeRes;
  uploadsInProgress.delete(uploadId);
  sendUploadProgress(task);

  if (completeRes.clip) {
    broadcastNewClip(completeRes.clip);
    if (mainWindow) mainWindow.webContents.send("clipboard-changed", completeRes.clip);
  }
}

function connectWebSocket() {
  if (ws) {
    ws.removeAllListeners();
    ws.close();
  }

  const url = currentConfig.serverUrl;
  try {
    ws = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "register", deviceId }));
    if (mainWindow) mainWindow.webContents.send("ws-status", "connected");
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "clip_pushed") {
      const clip = msg.clip;
      if (clip.type === "text" && clip.content) {
        clipboard.writeText(clip.content);
      } else if (clip.type === "image" && clip.file_path) {
        const imgUrl = currentConfig.httpUrl + clip.file_path;
        if (mainWindow) mainWindow.webContents.send("download-and-clipboard-image", imgUrl);
      }
      if (mainWindow) mainWindow.webContents.send("clip-received", clip);
    }

    if (msg.type === "clip_created") {
      if (mainWindow) mainWindow.webContents.send("clip-created-remote", msg.clip);
    }

    if (msg.type === "upload_progress") {
      if (mainWindow) {
        mainWindow.webContents.send("remote-upload-progress", {
          uploadId: msg.uploadId,
          filename: msg.filename,
          progress: msg.progress,
        });
      }
    }

    if (msg.type === "conflict_detected") {
      if (mainWindow) {
        mainWindow.webContents.send("conflict-detected", msg);
      }
    }
  });

  ws.on("close", () => {
    if (mainWindow) mainWindow.webContents.send("ws-status", "disconnected");
    scheduleReconnect();
  });

  ws.on("error", () => {
    if (mainWindow) mainWindow.webContents.send("ws-status", "error");
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
  wsReconnectTimer = setTimeout(() => connectWebSocket(), 5000);
}

function pushClipToDevice(targetDeviceId, clip) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        type: "push_clip",
        targetDeviceId,
        clip,
      })
    );
  }
}

function notifyNewClip(clip) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "new_clip", clip }));
  }
}

function uploadClipToServer(clip) {
  const httpUrl = currentConfig.httpUrl;

  if (clip.type === "text") {
    return fetch(httpUrl + "/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: clip.id,
        deviceId: deviceId,
        type: "text",
        content: clip.content,
      }),
    })
      .then((r) => r.json())
      .then((saved) => {
        if (saved.hasConflict) {
          if (mainWindow) mainWindow.webContents.send("clipboard-changed-conflict", saved);
        }
        return saved;
      });
  }

  if (clip.type === "image" || clip.type === "file") {
    if (clip.fileSize && clip.fileSize >= LARGE_FILE_THRESHOLD) {
      const task = {
        taskId: uuidv4(),
        type: clip.type,
        filePath: clip.localPath,
        filename: clip.filename || clip.content || "file",
        fileSize: clip.fileSize,
        fileHash: clip.fileHash,
        status: "queued",
        progress: 0,
      };
      enqueueUpload(task);
      if (mainWindow) mainWindow.webContents.send("clipboard-changed", { ...clip, uploading: true, taskId: task.taskId });
      return Promise.resolve({ ok: true, id: clip.id, uploading: true, taskId: task.taskId });
    }

    return new Promise((resolve, reject) => {
      const FormData = require("form-data");
      const form = new FormData();
      const buffer = fs.readFileSync(clip.localPath);
      form.append("file", buffer, {
        filename: clip.filename || clip.content || "file",
        contentType: clip.type === "image" ? "image/png" : "application/octet-stream",
      });
      form.append("deviceId", deviceId);
      if (clip.fileHash) form.append("fileHash", clip.fileHash);

      fetch(httpUrl + "/api/clips/" + clip.type, {
        method: "POST",
        body: form,
        headers: form.getHeaders(),
      })
        .then((r) => r.json())
        .then((saved) => {
          if (saved.hasConflict) {
            if (mainWindow) mainWindow.webContents.send("clipboard-changed-conflict", saved);
          }
          resolve(saved);
        })
        .catch(reject);
    });
  }

  return Promise.resolve({ ok: true, id: clip.id });
}

function startClipboardWatcher() {
  if (clipboardWatchTimer) clearInterval(clipboardWatchTimer);

  clipboardWatchTimer = setInterval(() => {
    try {
      const text = clipboard.readText();
      if (text && text !== lastClipboardText) {
        lastClipboardText = text;
        const clip = {
          id: uuidv4(),
          type: "text",
          content: text,
          created_at: new Date().toISOString(),
          device_id: deviceId,
        };
        uploadClipToServer(clip).then((saved) => {
          if (saved && saved.id && !saved.uploading) {
            notifyNewClip(saved);
            if (mainWindow && !saved.hasConflict) {
              mainWindow.webContents.send("clipboard-changed", saved);
            }
          }
        });
        if (mainWindow && !clip._skipNotify) {
          mainWindow.webContents.send("clipboard-changed", clip);
        }
        return;
      }

      const img = clipboard.readImage();
      if (!img.isEmpty()) {
        const hash = img.toDataURL().slice(0, 200);
        if (hash !== lastClipboardImageHash) {
          lastClipboardImageHash = hash;
          const buffer = img.toPNG();
          const clipId = uuidv4();
          const fileName = clipId + ".png";
          const uploadsDir = path.join(app.getPath("userData"), "clipboard-images");

          if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

          const filePath = path.join(uploadsDir, fileName);
          fs.writeFileSync(filePath, buffer);
          const fileSize = buffer.length;

          const clip = {
            id: clipId,
            type: "image",
            filename: fileName,
            localPath: filePath,
            fileSize,
            device_id: deviceId,
            created_at: new Date().toISOString(),
          };

          uploadClipToServer(clip).then((saved) => {
            if (saved && saved.id && !saved.uploading) {
              notifyNewClip(saved);
            }
          });
          if (mainWindow) mainWindow.webContents.send("clipboard-changed", clip);
        }
      }
    } catch (e) {
      console.error("Clipboard watcher error:", e);
    }
  }, 500);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 700,
    minHeight: 500,
    title: "ClipSync",
    icon: path.join(__dirname, "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  mainWindow.on("close", (e) => {
    if (tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  const iconPath = path.join(__dirname, "icon.png");
  if (!fs.existsSync(iconPath)) return;

  tray = new Tray(iconPath);
  const contextMenu = Menu.buildFromTemplate([
    { label: "Show ClipSync", click: () => mainWindow.show() },
    { type: "separator" },
    { label: "Quit", click: () => { tray = null; app.quit(); } },
  ]);
  tray.setToolTip("ClipSync");
  tray.setContextMenu(contextMenu);
  tray.on("double-click", () => mainWindow.show());
}

app.whenReady().then(() => {
  loadDeviceId();
  loadConfig();
  createWindow();
  createTray();
  connectWebSocket();
  startClipboardWatcher();

  ipcMain.handle("get-device-info", () => ({ id: deviceId, name: deviceName, platform: process.platform }));

  ipcMain.handle("get-config", () => currentConfig);

  ipcMain.handle("save-config", (_e, config) => {
    currentConfig = { ...currentConfig, ...config };
    saveConfig();
    connectWebSocket();
    return currentConfig;
  });

  ipcMain.handle("push-to-device", (_e, targetDeviceId, clip) => {
    pushClipToDevice(targetDeviceId, clip);
    return true;
  });

  ipcMain.handle("copy-to-clipboard", (_e, clip) => {
    if (clip.type === "text" && clip.content) {
      clipboard.writeText(clip.content);
      lastClipboardText = clip.content;
    } else if (clip.type === "image") {
      const imgUrl = clip.file_path
        ? currentConfig.httpUrl + clip.file_path
        : clip.localPath;
      if (imgUrl && fs.existsSync(imgUrl)) {
        const img = nativeImage.createFromBuffer(fs.readFileSync(imgUrl));
        clipboard.writeImage(img);
      } else if (imgUrl && imgUrl.startsWith("http")) {
        fetch(imgUrl)
          .then((r) => r.arrayBuffer())
          .then((buf) => {
            const img = nativeImage.createFromBuffer(Buffer.from(buf));
            clipboard.writeImage(img);
          });
      }
    }
    return true;
  });

  ipcMain.handle("write-clipboard-image-from-url", (_e, url) => {
    fetch(url)
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        const img = nativeImage.createFromBuffer(Buffer.from(buf));
        clipboard.writeImage(img);
      });
    return true;
  });

  ipcMain.handle("api-request", async (_e, method, path2, body, isFormData) => {
    const url = currentConfig.httpUrl + path2;
    const opts = { method };
    if (body && !isFormData) {
      opts.headers = { "Content-Type": "application/json" };
      opts.body = JSON.stringify(body);
    } else if (body && isFormData) {
      opts.body = body;
    }
    const r = await fetch(url, opts);
    return r.json();
  });

  ipcMain.handle("get-upload-queue", () => {
    return [...uploadQueue, ...Array.from(uploadsInProgress.values())];
  });

  ipcMain.handle("abort-upload", (_e, taskId) => {
    const idx = uploadQueue.findIndex((t) => t.taskId === taskId);
    if (idx >= 0) {
      uploadQueue.splice(idx, 1);
      return true;
    }
    const task = Array.from(uploadsInProgress.values()).find((t) => t.taskId === taskId);
    if (task && task.uploadId) {
      fetch(currentConfig.httpUrl + "/api/uploads/" + task.uploadId + "/abort", { method: "POST" })
        .then(() => {
          task.status = "aborted";
          sendUploadProgress(task);
        })
        .catch(() => {});
    }
    return true;
  });

  ipcMain.handle("convert-clip-local", async (_e, clip, rule) => {
    const converted = applyRuleLocal(rule, clip);
    return converted;
  });

  ipcMain.handle("convert-clip-all-local", async (_e, clip, rules) => {
    return applyAllMatchingRulesLocal(rules, clip);
  });

  ipcMain.handle("copy-to-clipboard-with-conversion", async (_e, clip, rule) => {
    const converted = applyRuleLocal(rule, clip);
    if (!converted) return { ok: false, error: "Conversion failed" };
    if (converted.type === "text" && converted.content) {
      clipboard.writeText(converted.content);
      lastClipboardText = converted.content;
    } else if (converted.type === "image" && converted.localPath && fs.existsSync(converted.localPath)) {
      const img = nativeImage.createFromBuffer(fs.readFileSync(converted.localPath));
      clipboard.writeImage(img);
    }
    return { ok: true, converted };
  });

  ipcMain.handle("test-regex", (_e, pattern, text) => {
    try {
      const regex = new RegExp(pattern, "gm");
      return { ok: true, matches: text.match(regex) || [] };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.on("ws-status", (e) => e);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !tray) app.quit();
});

app.on("before-quit", () => {
  if (clipboardWatchTimer) clearInterval(clipboardWatchTimer);
  if (ws) ws.close();
});
