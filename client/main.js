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
const { v4: uuidv4 } = require("uuid");
const WebSocket = require("ws");

const DEVICE_ID_FILE = path.join(app.getPath("userData"), "device.json");
const CONFIG_FILE = path.join(app.getPath("userData"), "config.json");

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
    }).then((r) => r.json());
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
        uploadClipToServer(clip).then(() => notifyNewClip(clip));
        if (mainWindow) mainWindow.webContents.send("clipboard-changed", clip);
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

          const httpUrl = currentConfig.httpUrl;
          const FormData = require("form-data");
          const form = new FormData();
          form.append("file", buffer, { filename: fileName, contentType: "image/png" });
          form.append("deviceId", deviceId);

          fetch(httpUrl + "/api/clips/image", {
            method: "POST",
            body: form,
            headers: form.getHeaders(),
          })
            .then((r) => r.json())
            .then((savedClip) => {
              const clip = {
                ...savedClip,
                type: "image",
                localPath: filePath,
                device_id: deviceId,
              };
              notifyNewClip(clip);
              if (mainWindow) mainWindow.webContents.send("clipboard-changed", clip);
            })
            .catch(() => {});
        }
      }
    } catch {}
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

  ipcMain.on("ws-status", (e) => e);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !tray) app.quit();
});

app.on("before-quit", () => {
  if (clipboardWatchTimer) clearInterval(clipboardWatchTimer);
  if (ws) ws.close();
});
