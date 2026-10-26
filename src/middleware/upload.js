const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const DIR = path.join(__dirname, "..", "..", "uploads");
fs.mkdirSync(DIR, { recursive: true });

const OK = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "application/pdf": ".pdf", "audio/m4a": ".m4a", "audio/mp4": ".m4a", "audio/mpeg": ".mp3", "audio/webm": ".webm", "audio/aac": ".aac" };

/* fichiers privés : nom aléatoire, servis uniquement via /api/files/:name avec contrôle d'accès */
const upload = multer({
  storage: multer.diskStorage({
    destination: DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString("hex") + (OK[file.mimetype] || ""))
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => OK[file.mimetype] ? cb(null, true) : cb(Object.assign(new Error("Format non autorisé (images, PDF ou audio)."), { status: 400 }))
});

const fileUrl = f => f ? `/api/files/${f.filename}` : null;
module.exports = { upload, fileUrl, DIR };
