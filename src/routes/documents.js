/* Mes documents, déclaration de perte, déclaration officielle, publication VIP — §11 à §23, R38–R47 */
const router = require("express").Router();
const { q, one, tx } = require("../config/db");
const U = require("../lib/util");
const D = require("../lib/domain");
const { requireUser } = require("../middleware/auth");
const { upload, fileUrl } = require("../middleware/upload");
const { h, fail, str, dateOrNull, normNum } = U;

router.use(requireUser);

const getDoc = async (req, id) => { const d = await one("SELECT * FROM documents WHERE id = ? AND user_id = ?", [id, req.user.id]); if (!d) fail(404, "Document introuvable."); return d; };
const hist = (docId, label) => q("INSERT INTO document_history (document_id, label) VALUES (?,?)", [docId, label]);
const openDecl = docId => one("SELECT * FROM loss_declarations WHERE document_id = ? AND closed = 0 ORDER BY id DESC LIMIT 1", [docId]);
const lastDecl = docId => one("SELECT * FROM loss_declarations WHERE document_id = ? ORDER BY id DESC LIMIT 1", [docId]);
const declView = l => l && ({ ref: l.ref, t: l.created_at, date: l.date_perte, circ: l.circonstances, obs: l.observation, closed: !!l.closed,
  loc: l.lat ? { commune: l.commune, lat: +l.lat, lng: +l.lng, acc: l.accuracy, t: l.created_at } : null });
const offiView = o => o ? { st: o.status, num: o.numero, date: o.date_decl, lieu: o.lieu, adm: o.administration, file: o.file_url, motif: o.motif } : { st: "NON TRANSMISE" };

/* moteur de rapprochement : un document de l'utilisateur correspond-il à un document détenu ? */
async function matchHeldForDoc(d) {
  const held = await one("SELECT * FROM held_documents WHERE numero = ? AND status IN ('RECU','CONSERVE') ORDER BY id DESC LIMIT 1", [d.numero]);
  if (held && ["PERDU", "RECHERCHE", "PRESENT"].includes(d.status)) {
    await q("UPDATE documents SET status = 'POT' WHERE id = ?", [d.id]);
    await hist(d.id, "Correspondance détectée (document détenu par ID SECOURS)");
    await U.notify(d.user_id, "BONNE NOUVELLE !", "Un document susceptible de correspondre au vôtre a été signalé.", "dossier|" + d.id);
    return held;
  }
  return null;
}

router.get("/", h(async (req, res) => {
  const ctx = await D.userCtx(req.user.id);
  const docs = await q("SELECT * FROM documents WHERE user_id = ? ORDER BY id", [req.user.id]);
  res.json({ items: docs.map(d => D.docView(d, ctx)) });
}));

router.get("/:id", h(async (req, res) => {
  const d = await getDoc(req, req.params.id), ctx = await D.userCtx(req.user.id);
  const [history, decl] = await Promise.all([q("SELECT label l, created_at t FROM document_history WHERE document_id = ? ORDER BY id", [d.id]), openDecl(d.id)]);
  const last = decl || await lastDecl(d.id);
  const offi = last ? await one("SELECT * FROM official_declarations WHERE declaration_id = ? ORDER BY id DESC LIMIT 1", [last.id]) : null;
  const pub = decl ? await one("SELECT * FROM publications WHERE declaration_id = ? ORDER BY id DESC LIMIT 1", [decl.id]) : null;
  const rec = await one("SELECT ref, verif_status, protected, paid, status FROM recoveries WHERE document_id = ? AND done_at IS NULL ORDER BY id DESC LIMIT 1", [d.id]);
  res.json({ doc: D.docView(d, ctx, {
    hist: history, dossier: declView(last), offi: last && !last.closed ? offiView(offi) : { st: "NON TRANSMISE" },
    pub: pub ? { ref: pub.ref, st: pub.status } : null,
    rec: rec ? { ref: rec.ref, verifSt: rec.verif_status, st: rec.status, protected: !!rec.protected, paid: !!rec.paid } : null
  }) });
}));

/* enregistrement : contrôle de la protection côté serveur (§9) */
router.post("/", upload.fields([{ name: "recto", maxCount: 1 }, { name: "verso", maxCount: 1 }]), h(async (req, res) => {
  const b = req.body, ctx = await D.userCtx(req.user.id);
  if (!ctx.cats[b.cat]) fail(400, "Catégorie inconnue.");
  const cat = ctx.cats[b.cat], f = req.files || {};
  /* champs exigés par le paramétrage de la catégorie (§36) ; sans numéro, une référence interne est attribuée */
  const num = normNum(b.num) || (cat.num_required ? "" : "NC" + U.code6());
  if (!num || !str(b.nom) || !str(b.prenoms)) fail(400, cat.num_required ? "Numéro, nom et prénom(s) sont obligatoires." : "Nom et prénom(s) sont obligatoires.");
  if (cat.recto_required && !(f.recto || [])[0]) fail(400, `La photo recto est obligatoire pour : ${cat.label}.`);
  if (cat.verso_required && !(f.verso || [])[0]) fail(400, `La photo verso est obligatoire pour : ${cat.label}.`);
  if (await one("SELECT id FROM documents WHERE user_id = ? AND numero = ?", [req.user.id, num])) fail(409, "Ce numéro est déjà enregistré dans votre dossier.");
  if (b.deliv && b.exp && b.exp < b.deliv) fail(400, "La date d’expiration doit suivre la date de délivrance.");
  const cov = D.coverFor(ctx, b.cat);
  if (!cov) fail(402, "Protection requise.", { code: "PROTECTION_REQUIRED" });
  const r = await q(`INSERT INTO documents (user_id, category_code, numero, nom, prenoms, dob, organisme, date_deliv, date_exp, protection_id, photo_recto, photo_verso)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [req.user.id, b.cat, num, str(b.nom, 60).toUpperCase(), str(b.prenoms, 80), dateOrNull(b.dob), cat.has_issuer ? str(b.org, 80) : null, dateOrNull(b.deliv), cat.has_expiry ? dateOrNull(b.exp) : null, cov.id,
     fileUrl((f.recto || [])[0]), fileUrl((f.verso || [])[0])]);
  await hist(r.insertId, `Document enregistré · ${D.protName(cov, ctx)}`);
  await U.activity(req.user.id, "Document enregistré " + ctx.cats[b.cat].short);
  const d = await one("SELECT * FROM documents WHERE id = ?", [r.insertId]);
  await matchHeldForDoc(d);
  res.status(201).json({ doc: D.docView(await one("SELECT * FROM documents WHERE id = ?", [r.insertId]), await D.userCtx(req.user.id)) });
}));

router.delete("/:id", h(async (req, res) => {
  const d = await getDoc(req, req.params.id);
  if (!["PRESENT", "RECUPERE"].includes(d.status)) fail(409, "Un dossier est en cours pour ce document.");
  await q("DELETE FROM documents WHERE id = ?", [d.id]);
  await U.activity(req.user.id, "Document supprimé");
  res.json({ ok: true });
}));

/* ---------- déclaration de perte ---------- */
router.post("/:id/declare", h(async (req, res) => {
  const d = await getDoc(req, req.params.id), b = req.body;
  if (d.status !== "PRESENT") fail(409, "Ce document n’est pas au statut Présent.");
  if (!dateOrNull(b.date) || !str(b.circ)) fail(400, "Indiquez la date et les circonstances.");
  if (b.date > new Date().toISOString().slice(0, 10)) fail(400, "La date de perte ne peut pas être dans le futur.");
  if (!b.ok) fail(400, "Cochez « Je confirme avoir perdu ce document ».");
  const ref = await U.nextRef("per", "IDS-PER");
  const loc = b.loc && isFinite(b.loc.lat) ? b.loc : null;
  await tx(async c => {
    await c.query(`INSERT INTO loss_declarations (ref, document_id, user_id, date_perte, circonstances, observation, lat, lng, accuracy, commune) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [ref, d.id, req.user.id, b.date, str(b.circ, 120), str(b.obs, 500), loc && loc.lat, loc && loc.lng, loc && Math.round(loc.acc || 0), loc && str(loc.commune, 40)]);
    await c.query("UPDATE documents SET status = 'PERDU' WHERE id = ?", [d.id]);
    await c.query("INSERT INTO document_history (document_id, label) VALUES (?,?)", [d.id, `Perte déclarée · ${ref}`]);
    await c.query("INSERT INTO messages (dossier_ref, sender, body) VALUES (?, 'AGENT', ?)", [ref,
      `Bonjour ${req.user.prenom}, votre déclaration ${ref} est enregistrée. Votre document est désormais rapproché automatiquement des documents signalés, collectés et conservés.`]);
  });
  const cat = (await D.catMap())[d.category_code];
  await U.notify(req.user.id, "Déclaration enregistrée", `${cat.label} · ${ref}`, "dossier|" + d.id);
  await U.activity(req.user.id, "Déclaration de perte " + ref);
  U.audit(req, "LOSS_DECLARED", "declaration", ref);
  await matchHeldForDoc({ ...d, status: "PERDU" });
  res.status(201).json({ ref, official: !!cat.official });
}));

/* le propriétaire a retrouvé lui-même son document */
router.post("/:id/found-mine", h(async (req, res) => {
  const d = await getDoc(req, req.params.id);
  if (!["PERDU", "RECHERCHE", "POT"].includes(d.status)) fail(409, "Aucune perte en cours.");
  await q("UPDATE documents SET status = 'PRESENT' WHERE id = ?", [d.id]);
  const decl = await openDecl(d.id);
  if (decl) {
    await q("UPDATE loss_declarations SET closed = 1 WHERE id = ?", [decl.id]);
    await q("UPDATE publications SET status = 'CLÔTURÉE', closed_at = NOW() WHERE declaration_id = ? AND status <> 'CLÔTURÉE'", [decl.id]);
  }
  await hist(d.id, "Retrouvé par le propriétaire · dossier clôturé");
  res.json({ ok: true });
}));
router.post("/:id/back-present", h(async (req, res) => {
  const d = await getDoc(req, req.params.id);
  if (d.status !== "RECUPERE") fail(409, "Statut incompatible.");
  await q("UPDATE documents SET status = 'PRESENT' WHERE id = ?", [d.id]);
  await hist(d.id, "Statut remis à PRÉSENT");
  res.json({ ok: true });
}));

/* correspondance détectée → ouverture du dossier de récupération */
router.post("/:id/match", h(async (req, res) => {
  const d = await getDoc(req, req.params.id);
  let rec = await one("SELECT * FROM recoveries WHERE document_id = ? AND done_at IS NULL", [d.id]);
  if (!rec) {
    if (d.status !== "POT") fail(409, "Aucune correspondance en attente.");
    const held = await one("SELECT * FROM held_documents WHERE numero = ? AND status IN ('RECU','CONSERVE') ORDER BY id DESC LIMIT 1", [d.numero]);
    if (!held) fail(409, "Le document signalé n’est pas encore arrivé en agence. Vous serez notifié dès sa réception.");
    const ctx = await D.userCtx(req.user.id), p = ctx.prots.find(x => x.id === d.protection_id);
    const decl = await lastDecl(d.id);
    const protectedAtLoss = !!p && !p.suspended && new Date(p.exp_at) >= new Date(decl ? decl.created_at : Date.now());
    const ref = await U.nextRef("rec", "IDS-REC");
    await q(`INSERT INTO recoveries (ref, user_id, access_token, held_id, document_id, category_code, tel, protected, fee_amount) VALUES (?,?,?,?,?,?,?,?,?)`,
      [ref, req.user.id, U.token(), held.id, d.id, d.category_code, req.user.tel, protectedAtLoss ? 1 : 0, protectedAtLoss ? 0 : ctx.cats[d.category_code].frais]);
    await q("UPDATE held_documents SET status = 'EN_RESTITUTION' WHERE id = ?", [held.id]);
    await q("UPDATE documents SET status = 'RETROUVE' WHERE id = ?", [d.id]);
    await hist(d.id, "Dossier de récupération " + ref);
    await q("INSERT INTO messages (dossier_ref, sender, body) VALUES (?, 'AGENT', ?)", [ref, `Dossier de récupération ${ref} ouvert. Merci de compléter la vérification de propriété.`]);
    rec = await one("SELECT * FROM recoveries WHERE ref = ?", [ref]);
  }
  res.json({ ref: rec.ref });
}));

/* ---------- déclaration officielle (§23) — rattachée à la perte en cours ---------- */
router.post("/:id/official", upload.single("file"), h(async (req, res) => {
  const d = await getDoc(req, req.params.id), b = req.body;
  const cat = (await D.catMap())[d.category_code];
  if (!cat.official) fail(400, "Aucune déclaration officielle n’est exigée pour ce document.");
  const decl = await openDecl(d.id); if (!decl) fail(409, "Déclarez d’abord la perte.");
  const cur = await one("SELECT * FROM official_declarations WHERE declaration_id = ? ORDER BY id DESC LIMIT 1", [decl.id]);
  if (cur && !["COMPLÉMENT REQUIS", "REJETÉE"].includes(cur.status)) fail(409, "Une déclaration officielle est déjà en cours de traitement.");
  if (!str(b.num) || !dateOrNull(b.date) || !str(b.lieu) || !str(b.adm) || !req.file) fail(400, "Numéro, date, lieu, administration et pièce sont obligatoires.");
  await q(`INSERT INTO official_declarations (declaration_id, document_id, numero, date_decl, lieu, administration, file_url, status) VALUES (?,?,?,?,?,?,?, 'EN VÉRIFICATION')`,
    [decl.id, d.id, str(b.num, 60), b.date, str(b.lieu, 80), str(b.adm, 60), fileUrl(req.file)]);
  await hist(d.id, "Déclaration officielle transmise");
  await U.notify(req.user.id, "Déclaration officielle reçue", "Votre déclaration est en vérification par ID SECOURS.", "offiDecl|" + d.id);
  U.audit(req, "OFFICIAL_SUBMITTED", "declaration", decl.ref);
  res.json({ ok: true });
}));

/* ---------- publication de perte VIP (R38–R47) ---------- */
async function eligibility(req, d) {
  const ctx = await D.userCtx(req.user.id), cat = ctx.cats[d.category_code];
  const decl = await openDecl(d.id);
  const offi = decl ? await one("SELECT status FROM official_declarations WHERE declaration_id = ? ORDER BY id DESC LIMIT 1", [decl.id]) : null;
  return { ctx, cat, decl, vip: D.vipActive(ctx), needOffi: !!cat.official && (!offi || offi.status !== "VALIDÉE"), offiSt: offi ? offi.status : "NON TRANSMISE" };
}
router.get("/:id/publication", h(async (req, res) => {
  const d = await getDoc(req, req.params.id), e = await eligibility(req, d);
  const pub = e.decl ? await one("SELECT * FROM publications WHERE declaration_id = ? ORDER BY id DESC LIMIT 1", [e.decl.id]) : null;
  const ph = pub ? await q("SELECT label l, created_at t FROM publication_history WHERE publication_id = ? ORDER BY id", [pub.id]) : [];
  const p = e.ctx.prots.find(x => x.id === d.protection_id);
  res.json({
    vip: e.vip, needOffi: e.needOffi, offiSt: e.offiSt, declared: !!e.decl, official: !!e.cat.official, protName: D.protName(p, e.ctx),
    preview: { label: e.cat.label, titulaire: U.maskName(d.nom + " " + d.prenoms), num: U.maskNum(d.numero), zone: (e.decl && e.decl.commune) || req.user.pos_commune || req.user.commune, date: e.decl && e.decl.date_perte },
    pub: pub ? { ref: pub.ref, st: pub.status, views: pub.views, reports: pub.reports, live: pub.live_at, hist: ph } : null
  });
}));
router.post("/:id/publication", h(async (req, res) => {
  const d = await getDoc(req, req.params.id), e = await eligibility(req, d);
  if (!e.vip) fail(403, "Votre protection actuelle ne donne pas accès à la publication (R36).");
  if (!e.decl) fail(409, "Déclarez la perte avant de demander une publication.");
  if (e.needOffi) fail(409, "La déclaration officielle doit être validée avant toute publication (R39).");
  if (!(Array.isArray(req.body.consents) && req.body.consents.length === 4 && req.body.consents.every(Boolean))) fail(400, "Cochez les quatre consentements.");
  if (await one("SELECT id FROM publications WHERE declaration_id = ? AND status <> 'REJETÉE'", [e.decl.id])) fail(409, "Une publication existe déjà pour cette perte.");
  const ref = await U.nextRef("pub", "IDS-PUB");
  const r = await q("INSERT INTO publications (ref, declaration_id, document_id) VALUES (?,?,?)", [ref, e.decl.id, d.id]);
  await q("INSERT INTO publication_history (publication_id, label) VALUES (?, 'Publication VIP demandée · consentement enregistré')", [r.insertId]);
  await hist(d.id, "Publication VIP demandée");
  await U.notify(req.user.id, "Demande de publication reçue", "Votre publication est en validation par l’agence.", "vipPub|" + d.id);
  U.audit(req, "PUBLICATION_REQUESTED", "publication", ref);
  res.status(201).json({ ref });
}));
router.post("/:id/publication/close", h(async (req, res) => {
  const d = await getDoc(req, req.params.id), decl = await openDecl(d.id);
  const pub = decl && await one("SELECT * FROM publications WHERE declaration_id = ? AND status = 'ACTIVE'", [decl.id]);
  if (!pub) fail(409, "Aucune publication active.");
  await q("UPDATE publications SET status = 'CLÔTURÉE', closed_at = NOW() WHERE id = ?", [pub.id]);
  await q("INSERT INTO publication_history (publication_id, label) VALUES (?, 'Publication clôturée par le propriétaire')", [pub.id]);
  res.json({ ok: true });
}));

module.exports = router;
module.exports.matchHeldForDoc = matchHeldForDoc;
