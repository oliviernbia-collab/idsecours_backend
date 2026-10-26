/* Conditions de restitution / livraison et clôture d'un dossier de récupération (Réception §45–§56, Collecte §32–§43) */
const { q, one, tx } = require("../config/db");
const U = require("./util");
const M = require("./match");

/* checklist affichée avant restitution ou livraison : aucune condition obligatoire ne peut être contournée */
async function conditions(r) {
  const held = await one("SELECT * FROM held_documents WHERE id = ?", [r.held_id]);
  let offiOk = true;
  if (r.document_id) {
    const c = await one("SELECT c.official FROM documents d JOIN doc_categories c ON c.code = d.category_code WHERE d.id = ?", [r.document_id]);
    const decl = await one("SELECT id FROM loss_declarations WHERE document_id = ? ORDER BY id DESC LIMIT 1", [r.document_id]);
    if (c && c.official && decl) { const o = await one("SELECT status FROM official_declarations WHERE declaration_id = ? ORDER BY id DESC LIMIT 1", [decl.id]); offiOk = !!o && o.status === "VALIDÉE"; }
  }
  const multiple = held && M.isMultiple(await M.owners(held.numero)) && !r.multi_resolved;
  const incident = await one("SELECT COUNT(*) n FROM ops_incidents WHERE dossier_ref IN (?, ?) AND statut IN ('OUVERT','EN COURS') AND priorite IN ('HAUTE','CRITIQUE')", [r.ref, held ? held.reception_ref : ""]);
  const list = [
    ["Document présent physiquement et contrôlé", !!held && ["RECU", "CONSERVE", "EN_RESTITUTION"].includes(held.status), held && held.status === "QUARANTAINE" ? "Document en quarantaine" : held && held.status === "A_CONTROLER" ? "Contrôle du document en cours" : null],
    ["Identité du propriétaire vérifiée", r.verif_status === "PROPRIÉTAIRE CONFIRMÉ", "Vérification d’identité en cours"],
    ["Aucune correspondance multiple non résolue", !multiple, "Correspondances multiples à résoudre"],
    ["Déclaration officielle validée si requise", offiOk, "Déclaration officielle manquante"],
    ["Condition financière satisfaite si applicable", !!(r.protected || r.paid), "Paiement non confirmé"],
    ["Aucun incident bloquant", !incident.n, "Dossier en litige / incident ouvert"],
    ["Autorisation opérationnelle", r.status === "RÉCUPÉRATION AUTORISÉE", "Autorisation opérationnelle manquante"]
  ].map(([l, ok, motif]) => ({ l, ok, motif: ok ? null : motif }));
  return { list, ok: list.every(x => x.ok), held };
}

/* remise effective (au comptoir ou par livraison) : clôture du dossier, libération de l'emplacement, R47 */
async function complete(r, { staffId = null, label, mode = null, signature = null }) {
  const proof = await U.nextRef("res", "RES");
  await tx(async c => {
    await c.query("UPDATE recoveries SET done_at = NOW(), done_by = ?, status = 'RÉCUPÉRÉ', proof_ref = ?, proof_mode = ?, signature = ? WHERE id = ?", [staffId, proof, mode, signature, r.id]);
    await c.query("UPDATE held_documents SET status = 'RESTITUE', emplacement = NULL WHERE id = ?", [r.held_id]);
    await c.query("INSERT INTO stock_movements (held_id, label, staff_id) VALUES (?, ?, ?)", [r.held_id, label, staffId]);
    if (r.document_id) {
      await c.query("UPDATE documents SET status = 'RECUPERE' WHERE id = ?", [r.document_id]);
      await c.query("INSERT INTO document_history (document_id, label) VALUES (?,?)", [r.document_id, label]);
      const [decls] = await c.query("SELECT id FROM loss_declarations WHERE document_id = ? AND closed = 0", [r.document_id]);
      for (const l of decls) {
        await c.query("UPDATE loss_declarations SET closed = 1 WHERE id = ?", [l.id]);
        await c.query("UPDATE publications SET status = 'CLÔTURÉE', closed_at = NOW() WHERE declaration_id = ? AND status IN ('ACTIVE','EN VALIDATION')", [l.id]);
      }
    }
  });
  await U.notify(r.user_id, "Document récupéré", `Dossier ${r.ref} clôturé · preuve de restitution ${proof}.`, "recDone|" + r.ref);
  return proof;
}

/* preuve de restitution (§55) : données minimisées (numéro masqué) */
async function proof(ref) {
  const r = await one(`SELECT r.ref, r.proof_ref, r.proof_mode, r.signature, r.done_at, r.category_code, c.label cat, h.reception_ref, h.numero, a.nom agence, a.adresse,
      s.prenom sprenom, s.nom snom, u.prenom, u.nom, d.ref liv_ref, p.nom partner
    FROM recoveries r JOIN held_documents h ON h.id = r.held_id JOIN agencies a ON a.id = h.agency_id JOIN doc_categories c ON c.code = r.category_code
    LEFT JOIN staff s ON s.id = r.done_by LEFT JOIN users u ON u.id = r.user_id
    LEFT JOIN deliveries d ON d.recovery_id = r.id AND d.status = 'LIVREE' LEFT JOIN partners p ON p.id = d.partner_id WHERE r.ref = ?`, [ref]);
  if (!r || !r.done_at) return null;
  return { reference: r.proof_ref, dossier: r.ref, document: r.cat, numero: U.maskNum(r.numero), reception: r.reception_ref, agence: r.agence, adresse: r.adresse,
    date: r.done_at, agent: r.sprenom ? `${r.sprenom} ${r.snom}` : null, mode: r.proof_mode || (r.liv_ref ? "Livraison" : "—"), livraison: r.liv_ref ? `${r.liv_ref} · ${r.partner}` : null,
    beneficiaire: r.prenom ? `${r.prenom} ${r.nom}` : "Titulaire vérifié", signature: r.signature };
}

module.exports = { conditions, complete, proof };
