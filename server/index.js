const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const http = require("http");

const db = require("./db");
const { setupWebSocket } = require("./ws");

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3200;

app.use(cors());
app.use(express.json({ limit: "50mb" }));

const UPLOAD_DIR = path.join(__dirname, "..", "data", "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  },
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

app.use("/uploads", express.static(UPLOAD_DIR));

setupWebSocket(server);

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
  res.json(devices);
});

app.post("/api/clips", (req, res) => {
  const { id, deviceId, type, content, filePath, thumbnail } = req.body;
  if (!deviceId || !type) return res.status(400).json({ error: "Missing fields" });

  const clipId = id || uuidv4();
  db.prepare(
    "INSERT INTO clips (id, device_id, type, content, file_path, thumbnail) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(clipId, deviceId, type, content || null, filePath || null, thumbnail || null);

  const clip = db.prepare("SELECT * FROM clips WHERE id = ?").get(clipId);
  res.json(clip);
});

app.post("/api/clips/image", upload.single("file"), (req, res) => {
  const { deviceId } = req.body;
  if (!deviceId || !req.file) return res.status(400).json({ error: "Missing fields" });

  const clipId = uuidv4();
  const filePath = `/uploads/${req.file.filename}`;
  db.prepare(
    "INSERT INTO clips (id, device_id, type, content, file_path) VALUES (?, ?, 'image', ?, ?)"
  ).run(clipId, deviceId, req.file.originalname, filePath);

  const clip = db.prepare("SELECT * FROM clips WHERE id = ?").get(clipId);
  res.json(clip);
});

app.post("/api/clips/file", upload.single("file"), (req, res) => {
  const { deviceId } = req.body;
  if (!deviceId || !req.file) return res.status(400).json({ error: "Missing fields" });

  const clipId = uuidv4();
  const filePath = `/uploads/${req.file.filename}`;
  db.prepare(
    "INSERT INTO clips (id, device_id, type, content, file_path) VALUES (?, ?, 'file', ?, ?)"
  ).run(clipId, deviceId, req.file.originalname, filePath);

  const clip = db.prepare("SELECT * FROM clips WHERE id = ?").get(clipId);
  res.json(clip);
});

app.get("/api/clips", (req, res) => {
  const { type, deviceId, limit, offset } = req.query;
  let sql = "SELECT c.* FROM clips c";
  const params = [];
  const conditions = [];

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

  let sql = `SELECT c.* FROM clips c WHERE c.content LIKE ?`;
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

  db.prepare("DELETE FROM clip_tags WHERE clip_id = ? AND tag_id = ?").run(
    req.params.id,
    tag.id
  );
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

app.get("/api/stats", (_req, res) => {
  const totalClips = db.prepare("SELECT COUNT(*) as count FROM clips").get().count;
  const totalDevices = db.prepare("SELECT COUNT(*) as count FROM devices").get().count;
  const totalTags = db.prepare("SELECT COUNT(*) as count FROM tags").get().count;
  const byType = db
    .prepare("SELECT type, COUNT(*) as count FROM clips GROUP BY type")
    .all();
  res.json({ totalClips, totalDevices, totalTags, byType });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`ClipSync server running on http://0.0.0.0:${PORT}`);
});
