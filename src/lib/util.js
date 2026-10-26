const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { q, one } = require("../config/db");

const DEV = process.env.NODE_ENV !== "production";
const DAY = 864e5, YEAR = 365 * DAY;

class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }
const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };
/* enveloppe les handlers async pour transmettre les erreurs à Express */
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const pad = (n, l = 2) => String(n).padStart(l, "0");
const fmtD = t => { const d = new Date(t); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`; };
const fmtT = t => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fcfa = n => `${Number(n).toLocaleString("fr-FR").replace(/\s/g, " ")} FCFA`;
const normTel = t => String(t || "").replace(/\D/g, "").replace(/^225/, "");
const fmtTel = t => normTel(t).replace(/(\d{2})(?=\d)/g, "$1 ").trim();
const normNum = s => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const normName = s => String(s || "").toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const maskNum = n => { n = String(n || ""); if (n.length <= 4) return "••••"; return n.slice(0, 2) + "•".repeat(Math.max(3, n.length - 6)) + n.slice(-4); };
const maskName = n => String(n || "").split(" ").map(w => w ? w[0] + "•".repeat(Math.max(2, w.length - 1)) : "").join(" ");
const rnd = (a, b) => crypto.randomInt(a, b + 1);
const code6 = () => String(rnd(100000, 999999));
const token = (n = 24) => crypto.randomBytes(n).toString("hex");

/* références lisibles : IDS-PER-2026-000125 */
async function nextRef(k, prefix, digits = 6) {
  await q("UPDATE sequences SET v = LAST_INSERT_ID(v + 1) WHERE k = ?", [k]);
  const r = await one("SELECT LAST_INSERT_ID() v");
  return `${prefix}-${new Date().getFullYear()}-${pad(r.v, digits)}`;
}

async function setting(k, def) { const r = await one("SELECT v FROM settings WHERE k = ?", [k]); return r ? r.v : def; }

/* journal d'audit (back-office) */
function audit(req, action, entity, entityRef, details) {
  const actor = req && req.staff ? ["STAFF", req.staff.id] : req && req.user ? ["USER", req.user.id] : req ? ["PUBLIC", null] : ["SYSTEM", null];
  return q("INSERT INTO audit_logs (actor_type, actor_id, action, entity, entity_ref, details, ip) VALUES (?,?,?,?,?,?,?)",
    [actor[0], actor[1], action, entity || null, entityRef || null, details ? String(details).slice(0, 500) : null, req ? (req.ip || null) : null]).catch(() => {});
}
/* journal d'activité visible par l'utilisateur dans son profil */
const activity = (userId, label) => userId ? q("INSERT INTO user_activity (user_id, label) VALUES (?,?)", [userId, label]) : null;

async function notify(userId, title, body, link) {
  if (!userId) return;
  await q("INSERT INTO notifications (user_id, title, body, link) VALUES (?,?,?,?)", [userId, title, body, link || null]);
}

/* passerelle SMS (simulation : outbox + console) */
async function sms(tel, body) {
  await q("INSERT INTO sms_outbox (tel, body) VALUES (?,?)", [normTel(tel), body.slice(0, 500)]);
  if (process.env.SMS_MODE !== "live") console.log(`[SMS → ${fmtTel(tel)}] ${body}`);
}

/* OTP : stocké haché, durée de vie et nombre d'essais limités */
async function createOtp(tel, purpose, ref, payload) {
  const code = code6();
  const ttl = +(await setting("otp_ttl_min", 10));
  await q("UPDATE otp_codes SET used = 1 WHERE tel = ? AND purpose = ? AND used = 0", [normTel(tel), purpose]);
  await q("INSERT INTO otp_codes (tel, purpose, ref, code_hash, payload, expires_at) VALUES (?,?,?,?,?,?)",
    [normTel(tel), purpose, ref || null, await bcrypt.hash(code, 8), payload ? JSON.stringify(payload) : null, new Date(Date.now() + ttl * 60e3)]);
  return code;
}
async function checkOtp(tel, purpose, code, ref) {
  const max = +(await setting("otp_max_attempts", 3));
  const row = await one(`SELECT * FROM otp_codes WHERE tel = ? AND purpose = ? AND used = 0 ${ref ? "AND ref = ?" : ""} ORDER BY id DESC LIMIT 1`,
    ref ? [normTel(tel), purpose, ref] : [normTel(tel), purpose]);
  if (!row) fail(400, "Aucun code en cours. Demandez un nouveau code.");
  if (new Date(row.expires_at) < new Date()) fail(400, "Code expiré. Demandez un nouveau code.");
  if (row.attempts >= max) fail(429, "Trop de tentatives. Demandez un nouveau code.");
  if (!(await bcrypt.compare(String(code || ""), row.code_hash))) {
    await q("UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?", [row.id]);
    fail(400, row.attempts + 1 >= max ? "Trop de tentatives. Demandez un nouveau code." : "Code incorrect.");
  }
  await q("UPDATE otp_codes SET used = 1 WHERE id = ?", [row.id]);
  return row.payload ? JSON.parse(row.payload) : {};
}

const pick = (o, keys) => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]));
const str = (v, max = 255) => v == null ? null : String(v).trim().slice(0, max) || null;
const dateOrNull = v => (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) ? v : null;

module.exports = {
  DEV, DAY, YEAR, HttpError, fail, h, pad, fmtD, fmtT, fcfa, normTel, fmtTel, normNum, normName, maskNum, maskName,
  rnd, code6, token, nextRef, setting, audit, activity, notify, sms, createOtp, checkOtp, pick, str, dateOrNull
};
