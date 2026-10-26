const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const { DIR } = require("./middleware/upload");

const app = express();
app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
const origins = (process.env.CORS_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: (o, cb) => cb(null, !o || !origins.length || origins.includes(o) || process.env.NODE_ENV !== "production"), exposedHeaders: [] }));
app.use(express.json({ limit: "1mb" }));
if (process.env.NODE_ENV !== "test") app.use(morgan("dev"));

app.get("/api/health", (req, res) => res.json({ ok: true, service: "ID SECOURS API", time: new Date() }));

/* fichiers privés : noms aléatoires de 128 bits, jamais listés */
app.get("/api/files/:name", (req, res) => {
  if (!/^[a-f0-9]{32}\.(jpg|png|webp|pdf|m4a|mp3|webm|aac)$/.test(req.params.name)) return res.status(404).end();
  res.set("Cache-Control", "private, max-age=86400");
  res.sendFile(path.join(DIR, req.params.name), err => err && res.status(404).end());
});

app.use("/api/auth", require("./routes/auth"));
app.use("/api/me", require("./routes/me"));
app.use("/api/protections", require("./routes/protections"));
app.use("/api/documents", require("./routes/documents"));
app.use("/api/payments", require("./routes/payments"));
app.use("/api/recoveries", require("./routes/recoveries"));
app.use("/api/messages", require("./routes/messages"));
app.use("/api/sos", require("./routes/sos"));
app.use("/api/alert", require("./routes/sos").publicAlert);
app.use("/api/admin", require("./routes/admin"));
app.use("/api/courier", require("./routes/courier"));
app.use("/api", require("./routes/public"));

app.use("/api", (req, res) => res.status(404).json({ error: "Route inconnue." }));

/* erreurs : message lisible côté client, détail dans les logs */
app.use((err, req, res, next) => {
  const status = err.status || (err.code === "LIMIT_FILE_SIZE" ? 413 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? "Erreur interne. Réessayez." : err.code === "LIMIT_FILE_SIZE" ? "Fichier trop volumineux (8 Mo max)." : err.message, ...(err.extra || {}) });
});

module.exports = app;
