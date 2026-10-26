/* Accessible sans abonnement : catalogue, recherche protégée (§25–§31), « J'ai trouvé un document » (§40–§59) */
const router = require("express").Router();
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const QRCode = require("qrcode");
const { q, one } = require("../config/db");
const U = require("../lib/util");
const D = require("../lib/domain");
const { optionalUser } = require("../middleware/auth");
const { upload, fileUrl } = require("../middleware/upload");
const { dossierFor } = require("../lib/dossiers");
const { h, fail, str, normNum, normName } = U;

router.use(optionalUser);

const COMMUNES = ["Cocody", "Plateau", "Yopougon", "Abobo", "Adjamé", "Marcory", "Treichville", "Koumassi", "Port-Bouët", "Attécoubé", "Bingerville", "Anyama", "Songon"];
router.get("/catalog", h(async (req, res) => {
  const c = await D.catalog();
  const agencies = await q("SELECT id, nom, commune, adresse, horaires, lat, lng FROM agencies WHERE status = 'ACTIVE'");
  res.json({ ...c, communes: COMMUNES, agencies, fraisService: +(await U.setting("frais_service", 100)), fraisLivraison: +(await U.setting("frais_livraison", 1500)) });
}));

/* ---------- recherche : correspondance exacte uniquement, aucune liste, données masquées ---------- */
const searchLimiter = rateLimit({ windowMs: 60 * 60e3, limit: 30, standardHeaders: true, legacyHeaders: false, message: { error: "Trop de recherches. Réessayez dans quelques minutes." } });
const SECRET = () => process.env.JWT_SECRET || "dev-secret";

router.post("/search", searchLimiter, h(async (req, res) => {
  const { mode, type } = req.body, qv = String(req.body.q || "").trim();
  if (!qv) fail(400, mode === "nom" ? "Saisissez un nom complet." : "Saisissez un numéro.");
  if (mode === "nom" && (!type || qv.split(/\s+/).length < 2)) fail(400, "Indiquez le type de document et le nom complet (nom + prénom).");
  const rows = mode === "nom"
    ? await q("SELECT * FROM held_documents WHERE status IN ('RECU','CONSERVE') AND category_code = ?", [type])
    : await q(`SELECT * FROM held_documents WHERE status IN ('RECU','CONSERVE') AND numero = ? ${type ? "AND category_code = ?" : ""}`, type ? [normNum(qv), type] : [normNum(qv)]);
  const hit = mode === "nom" ? rows.find(r => normName(r.nom) === normName(qv)) : rows[0];
  U.audit(req, "PUBLIC_SEARCH", "held", hit ? hit.reception_ref : null, `${mode}:${hit ? "trouvé" : "non trouvé"}`);
  if (!hit) return res.json({ found: false });
  const match = jwt.sign({ held: hit.id }, SECRET(), { expiresIn: "30m", audience: "match" });
  res.json({ found: true, match, hit: { cat: hit.category_code, etat: hit.etat, num: U.maskNum(hit.numero), nom: U.maskName(hit.nom) } });
}));

/* « C'est mon document » → dossier de récupération (avec ou sans compte) */
router.post("/recoveries", h(async (req, res) => {
  let p; try { p = jwt.verify(String(req.body.match || ""), SECRET(), { audience: "match" }); } catch { fail(400, "Résultat expiré. Relancez la recherche."); }
  const held = await one("SELECT * FROM held_documents WHERE id = ? AND status IN ('RECU','CONSERVE')", [p.held]);
  if (!held) fail(409, "Ce document fait déjà l’objet d’un dossier de récupération.");
  const cats = await D.catMap();
  let doc = null, prot = false;
  if (req.user) {
    doc = await one("SELECT * FROM documents WHERE user_id = ? AND numero = ?", [req.user.id, held.numero]);
    if (doc) { const ctx = await D.userCtx(req.user.id); prot = D.protActive(ctx.prots.find(x => x.id === doc.protection_id)); }
  }
  const ref = await U.nextRef("rec", "IDS-REC"), token = U.token();
  await q(`INSERT INTO recoveries (ref, user_id, access_token, held_id, document_id, category_code, tel, protected, fee_amount) VALUES (?,?,?,?,?,?,?,?,?)`,
    [ref, req.user ? req.user.id : null, token, held.id, doc ? doc.id : null, held.category_code, req.user ? req.user.tel : null, prot ? 1 : 0, prot ? 0 : cats[held.category_code].frais]);
  await q("UPDATE held_documents SET status = 'EN_RESTITUTION' WHERE id = ?", [held.id]);
  if (doc) { await q("UPDATE documents SET status = 'RETROUVE' WHERE id = ?", [doc.id]); await q("INSERT INTO document_history (document_id, label) VALUES (?,?)", [doc.id, "Dossier de récupération " + ref]); }
  await q("INSERT INTO messages (dossier_ref, sender, body) VALUES (?, 'AGENT', ?)", [ref, `Dossier de récupération ${ref} ouvert. Merci de compléter la vérification de propriété.`]);
  if (req.user) await U.activity(req.user.id, "Dossier de récupération " + ref);
  U.audit(req, "RECOVERY_OPENED", "recovery", ref);
  res.status(201).json({ ref, token });
}));

/* ---------- j'ai trouvé un document ---------- */
router.post("/found/check", searchLimiter, h(async (req, res) => {
  const num = normNum(req.body.num);
  const registered = !!num && !!(await one("SELECT id FROM documents WHERE numero = ? LIMIT 1", [num]));
  res.json({ registered });
}));

router.post("/found", upload.fields([{ name: "recto", maxCount: 1 }, { name: "verso", maxCount: 1 }]), h(async (req, res) => {
  const b = req.body, cats = await D.catMap();
  if (!cats[b.cat]) fail(400, "Type de document inconnu.");
  const num = normNum(b.num), nom = str(b.nom, 120);
  if (!num && !nom) fail(400, "Indiquez au moins le numéro ou le nom visible.");
  const lat = parseFloat(b.lat), lng = parseFloat(b.lng);
  if (!isFinite(lat) || !isFinite(lng)) fail(400, "La géolocalisation (ou la commune) est requise.");
  const registered = !!num && !!(await one("SELECT id FROM documents WHERE numero = ? LIMIT 1", [num]));
  const ref = await U.nextRef("tro", "IDS-TRO"), token = U.token(), f = req.files || {};
  await q(`INSERT INTO found_reports (ref, reporter_user_id, reporter_tel, access_token, category_code, numero, nom_visible, photo_recto, photo_verso, registered, lat, lng, accuracy, commune, collect_code)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [ref, req.user ? req.user.id : null, req.user ? req.user.tel : U.normTel(b.tel) || null, token, b.cat, num || null, nom, fileUrl((f.recto || [])[0]), fileUrl((f.verso || [])[0]),
     registered ? 1 : 0, lat, lng, Math.round(+b.acc || 0), str(b.commune, 40), U.code6()]);
  await q("INSERT INTO messages (dossier_ref, sender, body) VALUES (?, 'AGENT', ?)", [ref, `Merci pour votre geste. Le dossier ${ref} est ouvert. Nous allons organiser la collecte du document avec un partenaire agréé.`]);
  if (req.user) await U.activity(req.user.id, "Signalement document trouvé " + ref);
  U.audit(req, "FOUND_REPORTED", "found", ref);
  res.status(201).json({ ref, token });
}));

/* cahier des charges (Collecte §28-29, Réception §3, Vérification §4) : livreur → Réception en agence → Vérification & Contrôle → conservé et recherchable */
const COL_STEPS = ["Signalement", "Collecte demandée", "Partenaire sélectionné", "Mission transmise au livreur", "Livreur en route", "Document remis au livreur", "Reçu en agence par Réception & Restitution", "Contrôlé par Vérification & Contrôle", "Conservé et recherchable"];
async function foundView(f) {
  const partner = f.partner_id ? await one("SELECT nom, collecteur, collecteur_code, vehicule FROM partners WHERE id = ?", [f.partner_id]) : null;
  return {
    ref: f.ref, t: f.created_at, cat: f.category_code, num: f.numero ? U.maskNum(f.numero) : null, registered: !!f.registered, step: f.step, steps: COL_STEPS,
    loc: { commune: f.commune, lat: +f.lat, lng: +f.lng, acc: f.accuracy }, repere: f.repere, slot: f.slot, mission: f.mission_ref,
    partner, code: f.step >= 3 && f.step < 5 ? f.collect_code : null, handT: f.handed_at, recvT: f.received_at,
    qr: f.step >= 3 && f.step < 5 ? await QRCode.toDataURL(`IDSECOURS:COL:${f.ref}:${f.collect_code}`, { margin: 1, width: 300 }) : null
  };
}
router.get("/found/:ref", h(async (req, res) => {
  const d = await dossierFor(req, req.params.ref); if (d.type !== "found") fail(404, "Signalement introuvable.");
  res.json({ found: await foundView(d.row) });
}));

/* demande de collecte : disponibilité + point de collecte ; sélection automatique du partenaire de la zone */
router.post("/found/:ref/collect", h(async (req, res) => {
  const d = await dossierFor(req, req.params.ref); if (d.type !== "found") fail(404, "Signalement introuvable.");
  const f = d.row, b = req.body;
  if (f.step >= 5) fail(409, "Le document a déjà été remis.");
  const lat = parseFloat(b.lat), lng = parseFloat(b.lng);
  await q("UPDATE found_reports SET lat = ?, lng = ?, accuracy = ?, commune = ?, repere = ?, slot = ? WHERE id = ?",
    [isFinite(lat) ? lat : f.lat, isFinite(lng) ? lng : f.lng, isFinite(lat) ? Math.round(+b.acc || 0) : f.accuracy, str(b.commune, 40) || f.commune, b.repere !== undefined ? str(b.repere, 160) : f.repere, b.slot !== undefined ? str(b.slot, 60) : f.slot, f.id]);
  if (f.step < 1) {
    await q("UPDATE found_reports SET step = 1, step_at = NOW() WHERE id = ?", [f.id]);
    const commune = str(b.commune, 40) || f.commune || "";
    const partner = await one("SELECT * FROM partners WHERE status = 'ACTIF' AND zones LIKE ? ORDER BY id LIMIT 1", [`%${commune}%`]) || await one("SELECT * FROM partners WHERE status = 'ACTIF' ORDER BY id LIMIT 1");
    if (partner) {
      const mission = "MIS-" + (await U.nextRef("mis", "X")).split("-").pop().slice(-5);
      await q("UPDATE found_reports SET step = 2, step_at = NOW(), partner_id = ?, mission_ref = ? WHERE id = ?", [partner.id, mission, f.id]);
      U.audit(req, "COLLECT_ASSIGNED", "found", f.ref, `${partner.nom} · ${mission}`);
    }
  }
  res.json({ found: await foundView(await one("SELECT * FROM found_reports WHERE id = ?", [f.id])) });
}));

module.exports = router;
module.exports.foundView = foundView;
