const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const http = require("http");

const db = require("./db");
const { setupWebSocket, clients } = require("./ws");
const { applyRule, applyAllMatchingRules } = require("./converter");

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3200;

app.use(cors());
app.use(express.json({ limit: "50mb" }));

const DATA_DIR = path.join(__dirname, "..", "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const CHUNK_DIR = path.join(DATA_DIR, "chunks");
for (const d of [UPLOAD_DIR, CHUNK_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  },
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

const chunkStorage = multer.diskStorage({
  destination: CHUNK_DIR,
  filename: (_req, file, cb) => {
    cb(null, uuidv4() + ".chunk");
  },
});
const chunkUpload = multer({
  storage: chunkStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
});

app.use("/uploads", express.static(UPLOAD_DIR));

const wss = setupWebSocket(server);

const CONFLICT_WINDOW_MS = 5000;

function broadcastToAllExcept(senderId, msg) {
  for (const [cid, client] of clients) {
    if (cid !== senderId && client.readyState === 1) {
      client.send(JSON.stringify(msg));
    }
  }
}

function sendToDevice(deviceId, msg) {
  const client = clients.get(deviceId);
  if (client && client.readyState === 1) {
    client.send(JSON.stringify(msg));
  }
}

function detectPotentialConflict(newClip) {
  const recent = db
    .prepare(
      `SELECT * FROM clips WHERE device_id != ? AND created_at > datetime('now', ?) ORDER BY created_at DESC LIMIT 1`
    )
    .get(newClip.device_id, "-" + CONFLICT_WINDOW_MS / 1000 + " seconds");

  if (!recent) return null;

  const sameType = recent.type === newClip.type;
  if (!sameType) return null;

  if (newClip.type === "text" && newClip.content && recent.content) {
    if (newClip.content.length > 20 && recent.content.length > 20) {
      return recent;
    }
  }
  if (newClip.type === "image" || newClip.type === "file") {
    if (newClip.file_hash && recent.file_hash && newClip.file_hash !== recent.file_hash) {
      return recent;
    }
  }
  return null;
}

function createConflictRecord(clipA, clipB) {
  const id = uuidv4();
  db.prepare(
    `INSERT INTO conflicts (id, clip_id_a, clip_id_b, device_id_a, device_id_b) VALUES (?, ?, ?, ?, ?)`
  ).run(id, clipA.id, clipB.id, clipA.device_id, clipB.device_id);

  db.prepare("UPDATE clips SET resolved = 2, conflict_of = ? WHERE id = ?").run(
    id,
    clipB.id
  );

  const conflict = db.prepare("SELECT * FROM conflicts WHERE id = ?").get(id);

  for (const deviceId of [clipA.device_id, clipB.device_id]) {
    sendToDevice(deviceId, {
      type: "conflict_detected",
      conflict,
      clips: [clipA, clipB],
    });
  }

  return conflict;
}

app.post("/api/devices", (req, res) => {
  const { id, name, platform } = req.body;
  if (!id || !name || !platform) return res.status(400).json({ error: "Missing fields" });

  const existing = db.prepare("SELECT id FROM devices WHERE id = ?").get(id);
  if (existing) {
    db.prepare("UPDATE devices SET last_seen = datetime('now') WHERE id = ?").run(id);
    return res.json({ ok: true });
  }

  db.prepare("INSERT INTO devices (id, name, platform) VALUES (?, ?, ?)").run(id, name, platform);
  res.json({ ok: true });
});

app.get("/api/devices", (_req, res) => {
  const devices = db.prepare("SELECT * FROM devices ORDER BY last_seen DESC").all();
  const onlineIds = new Set(clients.keys());
  res.json(
    devices.map((d) => ({
      ...d,
      online: onlineIds.has(d.id),
    }))
  );
});

app.post("/api/clips", (req, res) => {
  const { id, deviceId, type, content, filePath, thumbnail, fileHash, fileSize } = req.body;
  if (!deviceId || !type) return res.status(400).json({ error: "Missing fields" });

  const clipId = id || uuidv4();
  db.prepare(
    "INSERT INTO clips (id, device_id, type, content, file_path, thumbnail, file_hash, file_size) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    clipId,
    deviceId,
    type,
    content || null,
    filePath || null,
    thumbnail || null,
    fileHash || null,
    fileSize || null
  );

  const clip = db.prepare("SELECT * FROM clips WHERE id = ?").get(clipId);

  const conflicting = detectPotentialConflict(clip);
  if (conflicting) {
    createConflictRecord(conflicting, clip);
    clip.hasConflict = true;
    clip.conflictWith = conflicting.id;
  } else {
    broadcastToAllExcept(deviceId, {
      type: "clip_created",
      clip,
      fromDeviceId: deviceId,
    });
  }

  res.json(clip);
});

app.post("/api/clips/image", upload.single("file"), (req, res) => {
  const { deviceId, fileHash } = req.body;
  if (!deviceId || !req.file) return res.status(400).json({ error: "Missing fields" });

  const clipId = uuidv4();
  const filePath = `/uploads/${req.file.filename}`;
  const fileSize = req.file.size;
  db.prepare(
    "INSERT INTO clips (id, device_id, type, content, file_path, file_hash, file_size) VALUES (?, ?, 'image', ?, ?, ?, ?)"
  ).run(clipId, deviceId, req.file.originalname, filePath, fileHash || null, fileSize);

  const clip = db.prepare("SELECT * FROM clips WHERE id = ?").get(clipId);

  const conflicting = detectPotentialConflict(clip);
  if (conflicting) {
    createConflictRecord(conflicting, clip);
    clip.hasConflict = true;
    clip.conflictWith = conflicting.id;
  } else {
    broadcastToAllExcept(deviceId, {
      type: "clip_created",
      clip,
      fromDeviceId: deviceId,
    });
  }

  res.json(clip);
});

app.post("/api/clips/file", upload.single("file"), (req, res) => {
  const { deviceId, fileHash } = req.body;
  if (!deviceId || !req.file) return res.status(400).json({ error: "Missing fields" });

  const clipId = uuidv4();
  const filePath = `/uploads/${req.file.filename}`;
  const fileSize = req.file.size;
  db.prepare(
    "INSERT INTO clips (id, device_id, type, content, file_path, file_hash, file_size) VALUES (?, ?, 'file', ?, ?, ?, ?)"
  ).run(clipId, deviceId, req.file.originalname, filePath, fileHash || null, fileSize);

  const clip = db.prepare("SELECT * FROM clips WHERE id = ?").get(clipId);

  const conflicting = detectPotentialConflict(clip);
  if (conflicting) {
    createConflictRecord(conflicting, clip);
    clip.hasConflict = true;
    clip.conflictWith = conflicting.id;
  } else {
    broadcastToAllExcept(deviceId, {
      type: "clip_created",
      clip,
      fromDeviceId: deviceId,
    });
  }

  res.json(clip);
});

app.post("/api/uploads/init", (req, res) => {
  const { deviceId, clipType, filename, totalSize, chunkSize, fileHash } = req.body;
  if (!deviceId || !clipType || !filename || !totalSize || !chunkSize) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const existing = db
    .prepare("SELECT * FROM clips WHERE file_hash = ? AND file_size = ? LIMIT 1")
    .get(fileHash, totalSize);
  if (existing) {
    return res.json({ alreadyExists: true, clip: existing });
  }

  const uploadId = uuidv4();
  const totalChunks = Math.ceil(totalSize / chunkSize);
  const tempPath = path.join(CHUNK_DIR, uploadId + ".tmp");

  db.prepare(
    `INSERT INTO uploads (id, device_id, clip_type, filename, total_size, chunk_size, total_chunks, uploaded_chunks, temp_path, file_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`
  ).run(
    uploadId,
    deviceId,
    clipType,
    filename,
    totalSize,
    chunkSize,
    totalChunks,
    tempPath,
    fileHash || null
  );

  if (!fs.existsSync(tempPath)) fs.writeFileSync(tempPath, Buffer.alloc(0));

  res.json({
    uploadId,
    totalChunks,
    chunkSize,
    uploadedChunks: [],
    status: "in_progress",
  });
});

app.get("/api/uploads/:id", (req, res) => {
  const upload = db.prepare("SELECT * FROM uploads WHERE id = ?").get(req.params.id);
  if (!upload) return res.status(404).json({ error: "Not found" });
  try {
    upload.uploaded_chunks = JSON.parse(upload.uploaded_chunks || "[]");
  } catch {
    upload.uploaded_chunks = [];
  }
  res.json(upload);
});

app.post("/api/uploads/:id/chunk", chunkUpload.single("chunk"), (req, res) => {
  const uploadId = req.params.id;
  const { index } = req.body;
  if (!req.file || index === undefined) {
    return res.status(400).json({ error: "Missing chunk or index" });
  }

  const upload = db.prepare("SELECT * FROM uploads WHERE id = ?").get(uploadId);
  if (!upload) return res.status(404).json({ error: "Upload not found" });
  if (upload.status === "completed") return res.json({ ok: true, alreadyDone: true });

  let uploaded;
  try {
    uploaded = JSON.parse(upload.uploaded_chunks || "[]");
  } catch {
    uploaded = [];
  }
  const chunkIdx = parseInt(index);

  if (!uploaded.includes(chunkIdx)) {
    const chunkData = fs.readFileSync(req.file.path);
    const fd = fs.openSync(upload.temp_path, "r+");
    try {
      fs.writeSync(fd, chunkData, 0, chunkData.length, chunkIdx * upload.chunk_size);
    } finally {
      fs.closeSync(fd);
    }
    uploaded.push(chunkIdx);
    uploaded.sort((a, b) => a - b);
    db.prepare("UPDATE uploads SET uploaded_chunks = ? WHERE id = ?").run(
      JSON.stringify(uploaded),
      uploadId
    );
  }

  fs.unlink(req.file.path, () => {});

  const progress = uploaded.length / upload.total_chunks;
  broadcastToAllExcept(upload.device_id, {
    type: "upload_progress",
    uploadId,
    progress,
    filename: upload.filename,
  });

  res.json({
    ok: true,
    progress,
    uploadedChunks: uploaded.length,
    totalChunks: upload.total_chunks,
  });
});

app.post("/api/uploads/:id/complete", (req, res) => {
  const uploadId = req.params.id;
  const upload = db.prepare("SELECT * FROM uploads WHERE id = ?").get(uploadId);
  if (!upload) return res.status(404).json({ error: "Upload not found" });

  let uploaded;
  try {
    uploaded = JSON.parse(upload.uploaded_chunks || "[]");
  } catch {
    uploaded = [];
  }

  if (uploaded.length < upload.total_chunks) {
    return res
      .status(400)
      .json({ error: `Missing chunks: ${uploaded.length}/${upload.total_chunks}` });
  }

  const stats = fs.statSync(upload.temp_path);
  if (stats.size !== upload.total_size) {
    return res.status(400).json({
      error: `Size mismatch: expected ${upload.total_size}, got ${stats.size}`,
    });
  }

  const ext = path.extname(upload.filename);
  const destFilename = uuidv4() + (ext || "");
  const destPath = path.join(UPLOAD_DIR, destFilename);
  fs.renameSync(upload.temp_path, destPath);

  const clipId = uuidv4();
  const filePath = `/uploads/${destFilename}`;
  db.prepare(
    "INSERT INTO clips (id, device_id, type, content, file_path, file_hash, file_size) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(clipId, upload.device_id, upload.clip_type, upload.filename, filePath, upload.file_hash, upload.total_size);

  db.prepare("UPDATE uploads SET status = 'completed' WHERE id = ?").run(uploadId);

  const clip = db.prepare("SELECT * FROM clips WHERE id = ?").get(clipId);

  const conflicting = detectPotentialConflict(clip);
  if (conflicting) {
    createConflictRecord(conflicting, clip);
    clip.hasConflict = true;
    clip.conflictWith = conflicting.id;
  } else {
    broadcastToAllExcept(upload.device_id, {
      type: "clip_created",
      clip,
      fromDeviceId: upload.device_id,
    });
  }

  res.json({ clip, status: "completed" });
});

app.post("/api/uploads/:id/abort", (req, res) => {
  const uploadId = req.params.id;
  const upload = db.prepare("SELECT * FROM uploads WHERE id = ?").get(uploadId);
  if (!upload) return res.status(404).json({ error: "Upload not found" });

  db.prepare("UPDATE uploads SET status = 'aborted' WHERE id = ?").run(uploadId);
  if (upload.temp_path && fs.existsSync(upload.temp_path)) {
    fs.unlink(upload.temp_path, () => {});
  }
  res.json({ ok: true });
});

app.get("/api/clips", (req, res) => {
  const { type, deviceId, limit, offset, includeResolved } = req.query;
  let sql = "SELECT c.* FROM clips c";
  const params = [];
  const conditions = [];

  if (includeResolved !== "true") {
    conditions.push("c.resolved != 2");
  }
  if (type) {
    conditions.push("c.type = ?");
    params.push(type);
  }
  if (deviceId) {
    conditions.push("c.device_id = ?");
    params.push(deviceId);
  }

  if (conditions.length) {
    sql += " WHERE " + conditions.join(" AND ");
  }

  sql += " ORDER BY c.created_at DESC";

  const lim = Math.min(parseInt(limit) || 100, 500);
  const off = parseInt(offset) || 0;
  sql += " LIMIT ? OFFSET ?";
  params.push(lim, off);

  const clips = db.prepare(sql).all(...params);
  res.json(clips);
});

app.get("/api/clips/search", (req, res) => {
  const { q, type } = req.query;
  if (!q) return res.status(400).json({ error: "Missing query" });

  let sql = `SELECT c.* FROM clips c WHERE c.content LIKE ? AND c.resolved != 2`;
  const params = [`%${q}%`];

  if (type) {
    sql += " AND c.type = ?";
    params.push(type);
  }

  sql += " ORDER BY c.created_at DESC LIMIT 100";
  const clips = db.prepare(sql).all(...params);
  res.json(clips);
});

app.get("/api/clips/:id", (req, res) => {
  const clip = db.prepare("SELECT * FROM clips WHERE id = ?").get(req.params.id);
  if (!clip) return res.status(404).json({ error: "Not found" });
  res.json(clip);
});

app.delete("/api/clips/:id", (req, res) => {
  db.prepare("DELETE FROM clips WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

app.get("/api/conflicts", (req, res) => {
  const { resolved } = req.query;
  let sql = "SELECT c.* FROM conflicts c";
  const params = [];
  if (resolved !== undefined) {
    sql += " WHERE c.resolved = ?";
    params.push(resolved === "true" ? 1 : 0);
  }
  sql += " ORDER BY c.created_at DESC LIMIT 100";
  const conflicts = db.prepare(sql).all(...params);

  const withClips = conflicts.map((conflict) => {
    const clipA = db.prepare("SELECT * FROM clips WHERE id = ?").get(conflict.clip_id_a);
    const clipB = db.prepare("SELECT * FROM clips WHERE id = ?").get(conflict.clip_id_b);
    return { ...conflict, clips: [clipA, clipB] };
  });

  res.json(withClips);
});

app.post("/api/conflicts/:id/resolve", (req, res) => {
  const { chosenClipId, keepBoth } = req.body;
  const conflictId = req.params.id;

  const conflict = db.prepare("SELECT * FROM conflicts WHERE id = ?").get(conflictId);
  if (!conflict) return res.status(404).json({ error: "Conflict not found" });

  if (keepBoth) {
    db.prepare("UPDATE conflicts SET resolved = 1 WHERE id = ?").run(conflictId);
    db.prepare("UPDATE clips SET resolved = 1, conflict_of = NULL WHERE id IN (?, ?)").run(
      conflict.clip_id_a,
      conflict.clip_id_b
    );
  } else if (chosenClipId) {
    const toKeep = db.prepare("SELECT * FROM clips WHERE id = ?").get(chosenClipId);
    const losingId =
      chosenClipId === conflict.clip_id_a ? conflict.clip_id_b : conflict.clip_id_a;
    if (!toKeep) return res.status(400).json({ error: "Invalid chosenClipId" });

    db.prepare("UPDATE conflicts SET resolved = 1, chosen_clip_id = ? WHERE id = ?").run(
      chosenClipId,
      conflictId
    );
    db.prepare("UPDATE clips SET resolved = 1, conflict_of = NULL WHERE id = ?").run(
      chosenClipId
    );
    db.prepare("DELETE FROM clips WHERE id = ?").run(losingId);

    broadcastToAllExcept(toKeep.device_id, {
      type: "clip_created",
      clip: toKeep,
      fromDeviceId: toKeep.device_id,
    });
  } else {
    return res.status(400).json({ error: "Missing chosenClipId or keepBoth" });
  }

  const updated = db.prepare("SELECT * FROM conflicts WHERE id = ?").get(conflictId);
  res.json({ ok: true, conflict: updated });
});

app.post("/api/clips/:id/tags", (req, res) => {
  const { tagName } = req.body;
  if (!tagName) return res.status(400).json({ error: "Missing tagName" });

  let tag = db.prepare("SELECT id FROM tags WHERE name = ?").get(tagName);
  if (!tag) {
    const tagId = uuidv4();
    db.prepare("INSERT INTO tags (id, name) VALUES (?, ?)").run(tagId, tagName);
    tag = { id: tagId };
  }

  db.prepare("INSERT OR IGNORE INTO clip_tags (clip_id, tag_id) VALUES (?, ?)").run(
    req.params.id,
    tag.id
  );
  res.json({ ok: true });
});

app.delete("/api/clips/:id/tags/:tagName", (req, res) => {
  const tag = db.prepare("SELECT id FROM tags WHERE name = ?").get(req.params.tagName);
  if (!tag) return res.status(404).json({ error: "Tag not found" });

  db.prepare("DELETE FROM clip_tags WHERE clip_id = ? AND tag_id = ?").run(req.params.id, tag.id);
  res.json({ ok: true });
});

app.get("/api/clips/:id/tags", (req, res) => {
  const tags = db
    .prepare(
      `SELECT t.* FROM tags t JOIN clip_tags ct ON t.id = ct.tag_id WHERE ct.clip_id = ?`
    )
    .all(req.params.id);
  res.json(tags);
});

app.get("/api/tags", (_req, res) => {
  const tags = db
    .prepare(
      `SELECT t.*, COUNT(ct.clip_id) as clip_count FROM tags t LEFT JOIN clip_tags ct ON t.id = ct.tag_id GROUP BY t.id ORDER BY t.name`
    )
    .all();
  res.json(tags);
});

app.get("/api/tags/:tagName/clips", (req, res) => {
  const { limit, offset } = req.query;
  const tag = db.prepare("SELECT id FROM tags WHERE name = ?").get(req.params.tagName);
  if (!tag) return res.json([]);

  const lim = Math.min(parseInt(limit) || 100, 500);
  const off = parseInt(offset) || 0;

  const clips = db
    .prepare(
      `SELECT c.* FROM clips c JOIN clip_tags ct ON c.id = ct.clip_id WHERE ct.tag_id = ? ORDER BY c.created_at DESC LIMIT ? OFFSET ?`
    )
    .all(tag.id, lim, off);
  res.json(clips);
});

app.get("/api/conversion-rules", (_req, res) => {
  const rules = db
    .prepare("SELECT * FROM conversion_rules ORDER BY priority ASC, created_at ASC")
    .all();
  res.json(rules);
});

app.post("/api/conversion-rules", (req, res) => {
  const { name, description, source_type, target_type, transform, pattern, replacement, priority } = req.body;
  if (!name || !source_type || !target_type || !transform) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  if (!["text", "image", "file", "any"].includes(source_type)) {
    return res.status(400).json({ error: "Invalid source_type" });
  }
  if (!["text", "image", "file"].includes(target_type)) {
    return res.status(400).json({ error: "Invalid target_type" });
  }

  const id = uuidv4();
  const p = priority || 100;
  db.prepare(
    `INSERT INTO conversion_rules (id, name, description, source_type, target_type, transform, pattern, replacement, builtin, priority)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(id, name, description || null, source_type, target_type, transform, pattern || null, replacement || null, p);

  const rule = db.prepare("SELECT * FROM conversion_rules WHERE id = ?").get(id);
  res.json(rule);
});

app.put("/api/conversion-rules/:id", (req, res) => {
  const rule = db.prepare("SELECT * FROM conversion_rules WHERE id = ?").get(req.params.id);
  if (!rule) return res.status(404).json({ error: "Rule not found" });

  const { name, description, source_type, target_type, transform, pattern, replacement, enabled, priority } = req.body;

  if (source_type && !["text", "image", "file", "any"].includes(source_type)) {
    return res.status(400).json({ error: "Invalid source_type" });
  }
  if (target_type && !["text", "image", "file"].includes(target_type)) {
    return res.status(400).json({ error: "Invalid target_type" });
  }

  db.prepare(
    `UPDATE conversion_rules SET
       name = COALESCE(?, name),
       description = COALESCE(?, description),
       source_type = COALESCE(?, source_type),
       target_type = COALESCE(?, target_type),
       transform = COALESCE(?, transform),
       pattern = ?,
       replacement = ?,
       enabled = COALESCE(?, enabled),
       priority = COALESCE(?, priority)
     WHERE id = ?`
  ).run(
    name || null,
    description !== undefined ? description : null,
    source_type || null,
    target_type || null,
    transform || null,
    pattern !== undefined ? pattern : null,
    replacement !== undefined ? replacement : null,
    enabled !== undefined ? (enabled ? 1 : 0) : null,
    priority !== undefined ? priority : null,
    req.params.id
  );

  const updated = db.prepare("SELECT * FROM conversion_rules WHERE id = ?").get(req.params.id);
  res.json(updated);
});

app.delete("/api/conversion-rules/:id", (req, res) => {
  const rule = db.prepare("SELECT * FROM conversion_rules WHERE id = ?").get(req.params.id);
  if (!rule) return res.status(404).json({ error: "Rule not found" });
  if (rule.builtin) return res.status(403).json({ error: "Cannot delete builtin rule" });

  db.prepare("DELETE FROM conversion_rules WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

app.post("/api/conversion-rules/:id/apply", async (req, res) => {
  const rule = db.prepare("SELECT * FROM conversion_rules WHERE id = ?").get(req.params.id);
  if (!rule) return res.status(404).json({ error: "Rule not found" });

  const clip = req.body.clip;
  if (!clip) return res.status(400).json({ error: "Missing clip" });

  if (rule.source_type !== "any" && clip.type !== rule.source_type) {
    return res.json({ converted: null, skipped: true, reason: "type_mismatch" });
  }

  try {
    const converted = await applyRule(rule, clip, DATA_DIR, "");
    res.json({ converted, rule });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/clips/:id/convert-all", async (req, res) => {
  const clip = db.prepare("SELECT * FROM clips WHERE id = ?").get(req.params.id);
  if (!clip) return res.status(404).json({ error: "Clip not found" });

  try {
    const rules = db.prepare("SELECT * FROM conversion_rules WHERE enabled = 1").all();
    const results = await applyAllMatchingRules(rules, clip, DATA_DIR, "");
    res.json({ conversions: results, clip });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/clips/:id/convert/:ruleId", async (req, res) => {
  const clip = db.prepare("SELECT * FROM clips WHERE id = ?").get(req.params.id);
  if (!clip) return res.status(404).json({ error: "Clip not found" });
  const rule = db.prepare("SELECT * FROM conversion_rules WHERE id = ?").get(req.params.ruleId);
  if (!rule) return res.status(404).json({ error: "Rule not found" });

  try {
    const converted = await applyRule(rule, clip, DATA_DIR, "");
    res.json({ converted, rule });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/conversion-transforms", (_req, res) => {
  res.json([
    { id: "regex_replace", name: "Regex Replace", description: "Match a regex pattern and replace with a string (supports $1, $2 capture groups). Uses 'gm' flags.", fields: ["pattern", "replacement"] },
    { id: "image_to_base64", name: "Image → Base64 Data URL", description: "Convert an image clip into a base64-encoded data URI.", fields: [] },
    { id: "file_to_base64", name: "File → Base64", description: "Encode a binary file as base64 text.", fields: [] },
    { id: "url_decode", name: "URL Decode", description: "Decode percent-encoded URL strings.", fields: [] },
  ]);
});

app.get("/api/stats", (_req, res) => {
  const totalClips = db.prepare("SELECT COUNT(*) as count FROM clips").get().count;
  const totalDevices = db.prepare("SELECT COUNT(*) as count FROM devices").get().count;
  const totalTags = db.prepare("SELECT COUNT(*) as count FROM tags").get().count;
  const totalConflicts = db.prepare("SELECT COUNT(*) as count FROM conflicts").get().count;
  const totalConversionRules = db.prepare("SELECT COUNT(*) as count FROM conversion_rules").get().count;
  const pendingConflicts = db
    .prepare("SELECT COUNT(*) as count FROM conflicts WHERE resolved = 0")
    .get().count;
  const byType = db.prepare("SELECT type, COUNT(*) as count FROM clips GROUP BY type").all();
  res.json({ totalClips, totalDevices, totalTags, totalConflicts, totalConversionRules, pendingConflicts, byType });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`ClipSync server running on http://0.0.0.0:${PORT}`);
});
