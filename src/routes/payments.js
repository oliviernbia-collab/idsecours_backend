/* Paiements — §7, §36, §37. Le montant est toujours calculé côté serveur.
   PAYMENT_MODE=simulation : la transaction est confirmée ~2 s après sa création (à remplacer par l'agrégateur réel). */
const router = require("express").Router();
const { q, one } = require("../config/db");
const U = require("../lib/util");
const D = require("../lib/domain");
const { optionalUser } = require("../middleware/auth");
const { h, fail, fcfa, fmtD, fmtT, YEAR } = U;

router.use(optionalUser);

/* calcule l'objet d'un paiement à partir de la demande (aucune confiance dans le montant client) */
async function quote(req) {
  const b = req.body, kind = b.kind;
  const cats = await D.catMap();
  if (["indiv", "pack", "formule", "renew"].includes(kind) && !req.user) fail(401, "Connectez-vous pour souscrire une protection.");
  if (kind === "indiv") { const c = cats[b.cat]; if (!c) fail(400, "Catégorie inconnue."); return { kind, amount: c.prix, label: "Protection individuelle · " + c.label, meta: { cat: b.cat } }; }
  if (kind === "pack") { const p = await one("SELECT * FROM packs WHERE code = ? AND active = 1", [b.pack]); if (!p) fail(400, "Pack inconnu."); return { kind, amount: p.prix, label: p.label, meta: { pack: p.code, cat: b.cat || null } }; }
  if (kind === "formule") {
    const f = await one("SELECT * FROM formules WHERE code = ? AND active = 1", [b.formule]); if (!f) fail(400, "Formule inconnue.");
    const ctx = await D.userCtx(req.user.id), cur = D.activeFormule(ctx);
    if (cur && cur.formule_code === f.code) fail(409, "C’est déjà votre formule actuelle.");
    if (cur && f.max_docs > 0) { const used = ctx.docs.filter(d => d.protection_id === cur.id).length; if (used > f.max_docs) fail(409, `Votre formule couvre ${used} documents : la formule ${f.label} en autorise ${f.max_docs}.`); }
    return { kind, amount: f.prix, label: "Formule " + f.label, meta: { formule: f.code } };
  }
  if (kind === "renew") {
    const p = await one("SELECT * FROM protections WHERE id = ? AND user_id = ?", [b.protection, req.user.id]); if (!p) fail(404, "Protection introuvable.");
    const ctx = await D.userCtx(req.user.id), amount = p.kind === "FORMULE" ? ctx.forms[p.formule_code].prix : p.prix;
    const newExp = new Date(Math.max(new Date(p.exp_at).getTime(), Date.now()) + YEAR);
    return { kind, amount, label: "Renouvellement · " + D.protName(p, ctx), meta: { protection: p.id }, lines: [["Protection", D.protName(p, ctx)], ["Durée", "1 an"], ["Nouvelle expiration", fmtD(newExp)]] };
  }
  if (kind === "frais" || kind === "livraison") {
    const r = await one("SELECT * FROM recoveries WHERE ref = ?", [b.recovery]); if (!r) fail(404, "Dossier introuvable.");
    if (!(req.user && r.user_id === req.user.id) && req.get("x-access-token") !== r.access_token) fail(403, "Accès refusé.");
    const c = cats[r.category_code];
    if (kind === "frais") {
      if (r.protected || r.paid) fail(409, "Aucun frais à payer pour ce dossier.");
      if (r.verif_status !== "PROPRIÉTAIRE CONFIRMÉ") fail(409, "La vérification du propriétaire doit être validée.");
      const svc = +(await U.setting("frais_service", 100));
      return { kind, amount: r.fee_amount + svc, label: "Frais de récupération · " + c.label, meta: { recovery: r.ref }, lines: [["Document", c.label], ["Dossier", r.ref], ["Montant", fcfa(r.fee_amount)], ["Frais de service", fcfa(svc)]] };
    }
    const dl = await one("SELECT * FROM deliveries WHERE recovery_id = ? AND status = 'ATTENTE_PAIEMENT' ORDER BY id DESC LIMIT 1", [r.id]);
    if (!dl) fail(409, "Confirmez d’abord votre point de livraison.");
    return { kind, amount: +(await U.setting("frais_livraison", 1500)), label: "Livraison par partenaire · " + dl.ref, meta: { recovery: r.ref, delivery: dl.ref }, lines: [["Dossier", r.ref], ["Mission", dl.ref], ["Point de livraison", `${dl.commune}${dl.repere ? " · " + dl.repere : ""}`]] };
  }
  fail(400, "Type de paiement inconnu.");
}

router.post("/quote", h(async (req, res) => {
  const qt = await quote(req);
  res.json({ ...qt, lines: qt.lines || [["Durée", "1 an"], ["Expiration", fmtD(Date.now() + YEAR)]] });
}));

router.post("/", h(async (req, res) => {
  const qt = await quote(req);
  const m = await one("SELECT * FROM pay_methods WHERE code = ? AND active = 1", [req.body.method]);
  if (!m) fail(400, "Moyen de paiement indisponible.");
  const phone = U.normTel(req.body.phone);
  if (m.code !== "CB" && phone.length < 8) fail(400, "Numéro de paiement invalide.");
  const ref = await U.nextRef("pay", "PAY");
  await q("INSERT INTO payments (ref, user_id, kind, label, amount, method, phone, status, meta) VALUES (?,?,?,?,?,?,?, 'EN ATTENTE', ?)",
    [ref, req.user ? req.user.id : null, qt.kind, qt.label, qt.amount, m.code, phone || null, JSON.stringify(qt.meta)]);
  U.audit(req, "PAYMENT_INIT", "payment", ref, `${qt.label} · ${fcfa(qt.amount)}`);
  res.status(201).json({ ref, status: "EN ATTENTE", method: m.label });
}));

/* applique les effets d'un paiement réussi */
async function finalize(p) {
  const meta = JSON.parse(p.meta || "{}"), now = new Date(), exp = new Date(now.getTime() + YEAR);
  const cats = await D.catMap(), method = (await one("SELECT label FROM pay_methods WHERE code = ?", [p.method])).label;
  let lines = [], next = { name: "protections" }, title = "PAIEMENT RÉUSSI";
  if (p.kind === "indiv") {
    await q("INSERT INTO protections (user_id, kind, category_code, label, prix, start_at, exp_at) VALUES (?, 'INDIV', ?, 'Protection individuelle', ?, ?, ?)", [p.user_id, meta.cat, p.amount, now, exp]);
    lines = [["Protection", cats[meta.cat].short], ["Montant", fcfa(p.amount)], ["Durée", "1 an"], ["Expiration", fmtD(exp)]];
    await U.notify(p.user_id, "Protection individuelle activée", `${cats[meta.cat].label} protégé(e) jusqu’au ${fmtD(exp)}.`, "protections");
    next = { name: "addDocForm", id: meta.cat };
  } else if (p.kind === "pack") {
    const k = await one("SELECT * FROM packs WHERE code = ?", [meta.pack]);
    await q("INSERT INTO protections (user_id, kind, pack_code, label, prix, quota500, quota300, start_at, exp_at) VALUES (?, 'PACK', ?, ?, ?, ?, ?, ?, ?)", [p.user_id, k.code, k.label, k.prix, k.quota500, k.quota300, now, exp]);
    lines = [["Protection", k.label], ["Composition", k.description], ["Montant", fcfa(k.prix)], ["Durée", "1 an"], ["Expiration", fmtD(exp)]];
    await U.notify(p.user_id, "Pack activé", `${k.label} actif jusqu’au ${fmtD(exp)}.`, "protections");
    next = meta.cat ? { name: "addDocForm", id: meta.cat } : { name: "addDoc" };
  } else if (p.kind === "formule") {
    const f = await one("SELECT * FROM formules WHERE code = ?", [meta.formule]);
    const ctx = await D.userCtx(p.user_id), cur = D.activeFormule(ctx);
    if (cur) {
      /* changement de formule : le temps restant est conservé, la nouvelle formule s'applique immédiatement */
      const keep = Math.max(0, new Date(cur.exp_at) - now);
      await q("UPDATE protections SET formule_code = ?, label = ?, prix = ?, start_at = ?, exp_at = ? WHERE id = ?", [f.code, "Formule " + f.label, f.prix, now, new Date(exp.getTime() + keep), cur.id]);
    } else await q("INSERT INTO protections (user_id, kind, formule_code, label, prix, start_at, exp_at) VALUES (?, 'FORMULE', ?, ?, ?, ?, ?)", [p.user_id, f.code, "Formule " + f.label, f.prix, now, exp]);
    lines = [["Formule", f.label], ["Montant", fcfa(p.amount)], ["Durée", "1 an"]];
    await U.notify(p.user_id, `Formule ${f.label} activée`, f.publication ? "La publication de perte est disponible après validation de la déclaration officielle." : "Vos avantages sont actifs.", "protections");
  } else if (p.kind === "renew") {
    const pr = await one("SELECT * FROM protections WHERE id = ?", [meta.protection]);
    const newExp = new Date(Math.max(new Date(pr.exp_at).getTime(), now.getTime()) + YEAR);
    await q("UPDATE protections SET exp_at = ?, suspended = 0 WHERE id = ?", [newExp, pr.id]);
    const ctx = await D.userCtx(p.user_id);
    lines = [["Protection", D.protName(pr, ctx)], ["Montant", fcfa(p.amount)], ["Nouvelle expiration", fmtD(newExp)]];
    await U.notify(p.user_id, "Protection renouvelée", `${D.protName(pr, ctx)} jusqu’au ${fmtD(newExp)}.`, "protections");
  } else if (p.kind === "frais" || p.kind === "livraison") {
    const r = await one("SELECT * FROM recoveries WHERE ref = ?", [meta.recovery]);
    if (p.kind === "frais") await q("UPDATE recoveries SET paid = 1, pay_ref = ?, status = 'RÉCUPÉRATION AUTORISÉE', withdrawal_code = COALESCE(withdrawal_code, ?) WHERE id = ?", [p.ref, U.code6(), r.id]);
    else {
      await q("UPDATE recoveries SET delivery = 1, deliv_ref = ? WHERE id = ?", [p.ref, r.id]);
      await q("UPDATE deliveries SET status = 'A_PLANIFIER' WHERE recovery_id = ? AND status = 'ATTENTE_PAIEMENT'", [r.id]);
    }
    title = "PAIEMENT CONFIRMÉ";
    lines = [["Document", cats[r.category_code].label], ["Dossier", r.ref], ["Montant", fcfa(p.amount)], ["Date", fmtD(now)], ["Heure", fmtT(now)]];
    next = { name: "recAuth", id: r.ref };
    await U.notify(r.user_id, p.kind === "frais" ? "Paiement des frais reçu" : "Livraison commandée", `Dossier ${r.ref}.`, "recAuth|" + r.ref);
  }
  await q("UPDATE payments SET status = 'RÉUSSI', detail_lines = ?, meta = ?, provider_ref = COALESCE(provider_ref, ?) WHERE id = ?", [JSON.stringify(lines), JSON.stringify({ ...meta, next, title }), `${p.method}-${U.token(5).toUpperCase()}`, p.id]);
  if (p.user_id) await U.activity(p.user_id, `Paiement ${p.ref} · ${p.label} · ${fcfa(p.amount)}`);
  return { ref: p.ref, title, lines, next, method, amount: p.amount, label: p.label, t: p.created_at };
}

const finalizing = new Set();
router.get("/:ref", h(async (req, res) => {
  const p = await one("SELECT * FROM payments WHERE ref = ?", [req.params.ref]);
  if (!p) fail(404, "Transaction introuvable.");
  if (p.user_id && !(req.user && req.user.id === p.user_id)) fail(403, "Accès refusé.");
  if (p.status === "EN ATTENTE" && process.env.PAYMENT_MODE !== "live" && Date.now() - new Date(p.created_at) > 1800 && !finalizing.has(p.id)) {
    finalizing.add(p.id);
    try { return res.json({ status: "RÉUSSI", ...(await finalize(p)) }); } finally { finalizing.delete(p.id); }
  }
  if (p.status === "RÉUSSI") {
    const method = (await one("SELECT label FROM pay_methods WHERE code = ?", [p.method])).label, meta = JSON.parse(p.meta || "{}");
    return res.json({ status: p.status, ref: p.ref, title: meta.title || "PAIEMENT RÉUSSI", next: meta.next || { name: "protections" }, lines: JSON.parse(p.detail_lines || "[]"), method, amount: p.amount, label: p.label, t: p.created_at });
  }
  res.json({ status: p.status, ref: p.ref });
}));

module.exports = router;
