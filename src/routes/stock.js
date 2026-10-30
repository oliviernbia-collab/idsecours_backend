/* Réception & Restitution — compléments du cahier des charges : transfert entre agences (Super Admin §63),
   inventaire physique (Réception §67–§69) et documents non réclamés (§70) */
const router = require("express").Router();
const { q, one } = require("../config/db");
const U = require("../lib/util");
const { requireStaff, can } = require("../middleware/auth");
const { h, fail, str } = U;

router.use(requireStaff);

const IN_STOCK = ["A_CONTROLER", "RECU", "CONSERVE", "QUARANTAINE"];
const move = (heldId, label, staffId) => q("INSERT INTO stock_movements (held_id, label, staff_id) VALUES (?,?,?)", [heldId, label, staffId]);
const incident = async (req, titre, description, priorite, dossier) => {
  const ref = "INC-" + (await U.nextRef("inc", "X")).split("-").pop().replace(/^0+/, "");
  await q("INSERT INTO ops_incidents (ref, titre, description, priorite, dossier_ref, created_by, agency_id) VALUES (?,?,?,?,?,?,?)", [ref, titre, str(description, 1000), priorite, dossier, req.staff.id, req.staff.agency_id || null]);
  return ref;
};
/* un agent rattaché à une agence n'agit que sur le stock de son agence */
const ownAgency = (req, agencyId) => { if (req.staff.agency_id && req.staff.agency_id !== agencyId) fail(403, "Ce document n’est pas dans le stock de votre agence."); };

/* ---------- transfert entre agences : demande → autorisation → envoi → réception (double confirmation) ---------- */
router.get("/transfers", can("reception.manage", "stock.view", "stock.transfer.authorize"), h(async (req, res) => {
  res.json({ items: await q(`SELECT t.*, h.reception_ref, c.short cat, af.nom from_nom, at.nom to_nom,
      CONCAT(s1.prenom, ' ', s1.nom) requested, CONCAT(s2.prenom, ' ', s2.nom) authorized, CONCAT(s3.prenom, ' ', s3.nom) sent, CONCAT(s4.prenom, ' ', s4.nom) received
    FROM stock_transfers t JOIN held_documents h ON h.id = t.held_id JOIN doc_categories c ON c.code = h.category_code
    JOIN agencies af ON af.id = t.from_agency JOIN agencies at ON at.id = t.to_agency
    LEFT JOIN staff s1 ON s1.id = t.requested_by LEFT JOIN staff s2 ON s2.id = t.authorized_by LEFT JOIN staff s3 ON s3.id = t.sent_by LEFT JOIN staff s4 ON s4.id = t.received_by
    ORDER BY t.id DESC LIMIT 200`) });
}));
router.post("/stock/:id/transfer", can("reception.manage"), h(async (req, res) => {
  const hd = await one("SELECT * FROM held_documents WHERE id = ?", [req.params.id]); if (!hd) fail(404, "Document introuvable.");
  ownAgency(req, hd.agency_id);
  if (!["RECU", "CONSERVE"].includes(hd.status)) fail(409, "Seul un document contrôlé et conservé peut être transféré.");
  const to = +req.body.to, motif = str(req.body.motif, 255);
  if (!motif) fail(400, "Le motif du transfert est obligatoire.");
  const dest = await one("SELECT id, nom FROM agencies WHERE id = ? AND status = 'ACTIVE'", [to]);
  if (!dest || to === hd.agency_id) fail(400, "Agence de destination invalide.");
  if (await one("SELECT id FROM stock_transfers WHERE held_id = ? AND status IN ('DEMANDE','AUTORISE','EN_TRANSIT')", [hd.id])) fail(409, "Un transfert est déjà en cours pour ce document.");
  const ref = await U.nextRef("trf", "IDS-TRF");
  await q("INSERT INTO stock_transfers (ref, held_id, from_agency, to_agency, motif, requested_by) VALUES (?,?,?,?,?,?)", [ref, hd.id, hd.agency_id, to, motif, req.staff.id]);
  await move(hd.id, `Demande de transfert ${ref} vers ${dest.nom} · motif : ${motif}`, req.staff.id);
  U.audit(req, "TRANSFER_REQUESTED", "held", hd.reception_ref, ref);
  res.status(201).json({ ref });
}));
const transfer = async ref => { const t = await one("SELECT * FROM stock_transfers WHERE ref = ?", [ref]); if (!t) fail(404, "Transfert introuvable."); return t; };
router.post("/transfers/:ref/authorize", can("stock.transfer.authorize"), h(async (req, res) => {
  const t = await transfer(req.params.ref);
  if (t.status !== "DEMANDE") fail(409, "Transfert déjà traité.");
  if (t.requested_by === req.staff.id) fail(403, "Séparation des pouvoirs : le demandeur ne peut pas autoriser son propre transfert.");
  await q("UPDATE stock_transfers SET status = 'AUTORISE', authorized_by = ?, authorized_at = NOW() WHERE id = ?", [req.staff.id, t.id]);
  await move(t.held_id, `Transfert ${t.ref} autorisé`, req.staff.id);
  U.audit(req, "TRANSFER_AUTHORIZED", "transfer", t.ref); res.json({ ok: true });
}));
router.post("/transfers/:ref/cancel", can("reception.manage", "stock.transfer.authorize"), h(async (req, res) => {
  const t = await transfer(req.params.ref), motif = str(req.body.motif, 255);
  if (!["DEMANDE", "AUTORISE"].includes(t.status)) fail(409, "Un document déjà parti ne peut plus être annulé : il doit être réceptionné.");
  if (!motif) fail(400, "Motif obligatoire.");
  await q("UPDATE stock_transfers SET status = 'ANNULE', cancel_reason = ? WHERE id = ?", [motif, t.id]);
  await move(t.held_id, `Transfert ${t.ref} annulé · motif : ${motif}`, req.staff.id);
  U.audit(req, "TRANSFER_CANCELLED", "transfer", t.ref, motif); res.json({ ok: true });
}));
/* sortie du stock de l'agence A : le document reste suivi (statut EN_TRANSIT, ni recherchable ni restituable) */
router.post("/transfers/:ref/send", can("reception.manage"), h(async (req, res) => {
  const t = await transfer(req.params.ref);
  if (t.status !== "AUTORISE") fail(409, "Le transfert doit d’abord être autorisé.");
  ownAgency(req, t.from_agency);
  const hd = await one("SELECT * FROM held_documents WHERE id = ?", [t.held_id]);
  const code = String(req.body.code || "").trim();
  if (code !== hd.internal_qr && code !== hd.reception_ref) fail(400, "Scannez le QR interne de l’enveloppe pour confirmer la sortie du bon document.");
  await q("UPDATE stock_transfers SET status = 'EN_TRANSIT', sent_by = ?, sent_at = NOW(), prev_status = ? WHERE id = ?", [req.staff.id, hd.status, t.id]);
  await q("UPDATE held_documents SET status = 'EN_TRANSIT', emplacement = NULL WHERE id = ?", [hd.id]);
  await move(hd.id, `Sortie du stock pour transfert ${t.ref} (ancien emplacement ${hd.emplacement || "—"}) · transport sécurisé`, req.staff.id);
  U.audit(req, "TRANSFER_SENT", "transfer", t.ref); res.json({ ok: true });
}));
/* réception à l'agence B : un autre agent que l'expéditeur confirme et affecte le nouvel emplacement */
router.post("/transfers/:ref/receive", can("reception.manage"), h(async (req, res) => {
  const t = await transfer(req.params.ref);
  if (t.status !== "EN_TRANSIT") fail(409, "Ce document n’est pas en transit.");
  ownAgency(req, t.to_agency);
  if (t.sent_by === req.staff.id) fail(403, "Double confirmation : la réception doit être confirmée par un autre agent que l’expéditeur.");
  const hd = await one("SELECT * FROM held_documents WHERE id = ?", [t.held_id]);
  const code = String(req.body.code || "").trim(), emp = str(req.body.emplacement, 40);
  if (code !== hd.internal_qr && code !== hd.reception_ref) fail(400, "Le QR scanné ne correspond pas au document attendu.");
  if (!emp) fail(400, "Indiquez le nouvel emplacement.");
  await q("UPDATE held_documents SET status = ?, agency_id = ?, emplacement = ? WHERE id = ?", [t.prev_status || "CONSERVE", t.to_agency, emp, hd.id]);
  await q("UPDATE stock_transfers SET status = 'RECU', received_by = ?, received_at = NOW() WHERE id = ?", [req.staff.id, t.id]);
  const dest = await one("SELECT nom FROM agencies WHERE id = ?", [t.to_agency]);
  await move(hd.id, `Transfert ${t.ref} réceptionné à ${dest.nom} · nouvel emplacement ${emp} (double confirmation)`, req.staff.id);
  U.audit(req, "TRANSFER_RECEIVED", "transfer", t.ref, emp); res.json({ ok: true });
}));

/* ---------- inventaire physique : stock théorique figé, scans, comparaison ---------- */
router.get("/inventories", can("reception.manage", "stock.view"), h(async (req, res) => {
  res.json({ items: await q(`SELECT i.*, a.nom agence, CONCAT(s.prenom, ' ', s.nom) agent,
      (SELECT COUNT(*) FROM inventory_lines l WHERE l.inventory_id = i.id AND l.result = 'CONFORME') conformes,
      (SELECT COUNT(*) FROM inventory_lines l WHERE l.inventory_id = i.id AND l.result = 'MANQUANT') manquants,
      (SELECT COUNT(*) FROM inventory_lines l WHERE l.inventory_id = i.id AND l.result = 'INATTENDU') inattendus,
      (SELECT COUNT(*) FROM inventory_lines l WHERE l.inventory_id = i.id AND l.expected = 1) attendus
    FROM inventories i JOIN agencies a ON a.id = i.agency_id LEFT JOIN staff s ON s.id = i.opened_by ORDER BY i.id DESC LIMIT 50`) });
}));
router.get("/inventories/:ref", can("reception.manage", "stock.view"), h(async (req, res) => {
  const inv = await one("SELECT i.*, a.nom agence FROM inventories i JOIN agencies a ON a.id = i.agency_id WHERE i.ref = ?", [req.params.ref]); if (!inv) fail(404, "Inventaire introuvable.");
  const lines = await q(`SELECT l.*, h.reception_ref, h.emplacement, c.short cat FROM inventory_lines l LEFT JOIN held_documents h ON h.id = l.held_id
    LEFT JOIN doc_categories c ON c.code = h.category_code WHERE l.inventory_id = ? ORDER BY l.expected DESC, h.emplacement`, [inv.id]);
  res.json({ inventory: inv, lines });
}));
router.post("/inventories", can("reception.manage"), h(async (req, res) => {
  const agency = req.staff.agency_id || +req.body.agency;
  if (!(await one("SELECT id FROM agencies WHERE id = ?", [agency]))) fail(400, "Agence invalide.");
  const zone = str(req.body.zone, 20).toUpperCase();
  if (await one("SELECT id FROM inventories WHERE agency_id = ? AND status = 'OUVERT'", [agency])) fail(409, "Un inventaire est déjà ouvert pour cette agence.");
  const ref = await U.nextRef("inv", "IDS-INV");
  const r = await q("INSERT INTO inventories (ref, agency_id, zone, opened_by) VALUES (?,?,?,?)", [ref, agency, zone || null, req.staff.id]);
  /* stock théorique figé au moment de l'ouverture */
  await q(`INSERT INTO inventory_lines (inventory_id, held_id, expected) SELECT ?, id, 1 FROM held_documents
    WHERE agency_id = ? AND status IN (?) ${zone ? "AND emplacement LIKE ?" : ""}`, zone ? [r.insertId, agency, IN_STOCK, zone + "%"] : [r.insertId, agency, IN_STOCK]);
  U.audit(req, "INVENTORY_OPENED", "inventory", ref, zone || "toute l’agence");
  res.status(201).json({ ref });
}));
router.post("/inventories/:ref/scan", can("reception.manage"), h(async (req, res) => {
  const inv = await one("SELECT * FROM inventories WHERE ref = ? AND status = 'OUVERT'", [req.params.ref]); if (!inv) fail(404, "Inventaire introuvable ou clôturé.");
  const code = str(req.body.code, 60); if (!code) fail(400, "Code vide.");
  const hd = await one("SELECT id, reception_ref FROM held_documents WHERE internal_qr = ? OR reception_ref = ?", [code, code]);
  const line = hd && await one("SELECT * FROM inventory_lines WHERE inventory_id = ? AND held_id = ?", [inv.id, hd.id]);
  if (line && line.result) return res.json({ result: line.result, ref: hd.reception_ref, already: true });
  if (line) { await q("UPDATE inventory_lines SET result = 'CONFORME', scanned_at = NOW(), code = ? WHERE id = ?", [code, line.id]); return res.json({ result: "CONFORME", ref: hd.reception_ref }); }
  await q("INSERT INTO inventory_lines (inventory_id, held_id, expected, result, code, scanned_at) VALUES (?,?,0,'INATTENDU',?,NOW())", [inv.id, hd ? hd.id : null, code]);
  res.json({ result: "INATTENDU", ref: hd ? hd.reception_ref : null });
}));
/* clôture : les documents attendus non scannés sont MANQUANTS → incident critique, restitution bloquée (§69) */
router.post("/inventories/:ref/close", can("reception.manage"), h(async (req, res) => {
  const inv = await one("SELECT * FROM inventories WHERE ref = ? AND status = 'OUVERT'", [req.params.ref]); if (!inv) fail(404, "Inventaire introuvable ou clôturé.");
  await q("UPDATE inventory_lines SET result = 'MANQUANT' WHERE inventory_id = ? AND expected = 1 AND result IS NULL", [inv.id]);
  const missing = await q(`SELECT h.*, (SELECT CONCAT(m.label, ' · ', COALESCE(CONCAT(s.prenom, ' ', s.nom), 'système'), ' · ', DATE_FORMAT(m.created_at, '%d/%m %H:%i')) FROM stock_movements m
      LEFT JOIN staff s ON s.id = m.staff_id WHERE m.held_id = h.id ORDER BY m.id DESC LIMIT 1) last_move
    FROM inventory_lines l JOIN held_documents h ON h.id = l.held_id WHERE l.inventory_id = ? AND l.result = 'MANQUANT'`, [inv.id]);
  const incidents = [];
  for (const m of missing) {
    await q("UPDATE held_documents SET status = 'QUARANTAINE', anomalie = 'Manquant à l’inventaire' WHERE id = ?", [m.id]);
    await move(m.id, `INCIDENT CRITIQUE — document manquant à l’inventaire ${inv.ref} (dernier emplacement ${m.emplacement || "—"}) · restitution bloquée`, req.staff.id);
    const ref = await incident(req, "Document manquant à l’inventaire", `${m.reception_ref} · dernier emplacement ${m.emplacement || "—"} · dernier mouvement : ${m.last_move || "—"}`, "CRITIQUE", m.reception_ref);
    incidents.push(ref); // l'alerte « Incident critique ouvert » est émise par lib/alerts
  }
  await q("UPDATE inventories SET status = 'CLOS', closed_at = NOW(), closed_by = ? WHERE id = ?", [req.staff.id, inv.id]);
  U.audit(req, "INVENTORY_CLOSED", "inventory", inv.ref, `${missing.length} manquant(s)`);
  res.json({ ok: true, missing: missing.length, incidents });
}));

/* ---------- documents non réclamés (§70) ---------- */
router.get("/stock/unclaimed", can("reception.manage", "stock.view"), h(async (req, res) => {
  const rows = await q(`SELECT h.id, h.reception_ref, c.short cat, h.numero, h.emplacement, h.status, h.received_at, a.nom agence, DATEDIFF(NOW(), h.received_at) jours
    FROM held_documents h JOIN doc_categories c ON c.code = h.category_code JOIN agencies a ON a.id = h.agency_id
    WHERE h.status IN ('RECU','CONSERVE') AND NOT EXISTS (SELECT 1 FROM recoveries r WHERE r.held_id = h.id)
    ${req.staff.agency_id ? "AND h.agency_id = ?" : ""} ORDER BY h.received_at`, req.staff.agency_id ? [req.staff.agency_id] : []);
  const B = [["Moins de 30 jours", 0, 29], ["30–60 jours", 30, 60], ["60–90 jours", 61, 90], ["Plus de 90 jours", 91, 1e9]];
  res.json({
    conservation: +(await U.setting("conservation_jours", 365)),
    buckets: B.map(([l, a, b]) => ({ l, a, b, n: rows.filter(r => r.jours >= a && r.jours <= b).length })),
    items: rows.map(r => ({ ...r, numero: r.numero ? U.maskNum(r.numero) : null }))
  });
}));

module.exports = router;
