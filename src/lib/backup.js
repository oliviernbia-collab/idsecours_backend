/* Sauvegardes de la base (Super Admin §56) : export SQL complet (structure + données), compressé,
   conservé hors du dossier web (backend/backups), avec rotation. Restauration : gunzip puis mysql < fichier.sql */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { pool, q, one } = require("../config/db");
const U = require("./util");

const DIR = path.join(__dirname, "..", "..", "backups");
const val = v => v === null ? "NULL" : v instanceof Date ? pool.escape(v.toISOString().slice(0, 19).replace("T", " ")) : Buffer.isBuffer(v) ? "0x" + v.toString("hex") : pool.escape(v);

async function run(kind, staffId) {
  if (await one("SELECT id FROM backups WHERE status = 'EN_COURS' AND created_at > DATE_SUB(NOW(), INTERVAL 10 MINUTE)")) throw Object.assign(new Error("Une sauvegarde est déjà en cours."), { status: 409 });
  const r = await q("INSERT INTO backups (kind, staff_id) VALUES (?,?)", [kind, staffId || null]);
  const id = r.insertId, stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const file = `idsecours-${stamp}-${id}.sql.gz`;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const gz = zlib.createGzip(), out = fs.createWriteStream(path.join(DIR, file));
    gz.pipe(out);
    const write = s => new Promise(res => gz.write(s, res));
    await write(`-- Sauvegarde ID SECOURS · ${new Date().toISOString()} · ${kind}\nSET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS = 0;\n\n`);
    const tables = (await q("SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'")).map(t => Object.values(t)[0]);
    let rows = 0;
    for (const t of tables) {
      const ddl = await one(`SHOW CREATE TABLE \`${t}\``);
      await write(`DROP TABLE IF EXISTS \`${t}\`;\n${ddl["Create Table"]};\n`);
      for (let off = 0; ; off += 500) {
        const batch = (await pool.query({ sql: `SELECT * FROM \`${t}\` LIMIT 500 OFFSET ${off}`, dateStrings: true }))[0];
        if (!batch.length) break;
        const cols = Object.keys(batch[0]).map(c => `\`${c}\``).join(", ");
        await write(`INSERT INTO \`${t}\` (${cols}) VALUES\n${batch.map(x => "(" + Object.values(x).map(val).join(", ") + ")").join(",\n")};\n`);
        rows += batch.length;
        if (batch.length < 500) break;
      }
      await write("\n");
    }
    await write("SET FOREIGN_KEY_CHECKS = 1;\n");
    await new Promise((res, rej) => { out.on("finish", res); out.on("error", rej); gz.end(); });
    const kb = Math.round(fs.statSync(path.join(DIR, file)).size / 1024);
    await q("UPDATE backups SET status = 'REUSSIE', file = ?, size_kb = ?, tables_n = ?, rows_n = ?, ended_at = NOW() WHERE id = ?", [file, kb, tables.length, rows, id]);
    await rotate();
    return { id, file, kb, tables: tables.length, rows };
  } catch (e) {
    await q("UPDATE backups SET status = 'ECHEC', error = ?, ended_at = NOW() WHERE id = ?", [String(e.message).slice(0, 255), id]);
    throw e;
  }
}

/* rotation : seuls les N derniers fichiers réussis sont conservés (l'historique reste en base) */
async function rotate() {
  const keep = +(await U.setting("backup_keep", 14));
  const old = await q("SELECT id, file FROM backups WHERE status = 'REUSSIE' AND file IS NOT NULL ORDER BY id DESC LIMIT 1000 OFFSET ?", [keep]);
  for (const b of old) { try { fs.unlinkSync(path.join(DIR, b.file)); } catch { /* déjà absent */ } await q("UPDATE backups SET file = NULL WHERE id = ?", [b.id]); }
}

/* sauvegarde automatique selon la périodicité paramétrée (backup_auto_h, 0 = désactivée) */
async function autoTick() {
  const h = +(await U.setting("backup_auto_h", 24)); if (!h) return;
  const last = await one("SELECT created_at FROM backups WHERE kind = 'AUTO' ORDER BY id DESC LIMIT 1");
  if (last && Date.now() - new Date(last.created_at) < h * 3600e3) return;
  await run("AUTO").catch(e => console.error("[sauvegarde]", e.message));
}

module.exports = { run, autoTick, DIR };
