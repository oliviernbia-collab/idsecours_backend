/* Emplacements de stockage (Réception §29–§33) : Agence → Salle → Armoire/Coffre → Compartiment,
   capacité, occupation et statut ; seuls les emplacements actifs et non complets sont proposés */
const { q, one } = require("../config/db");
const { fail, str } = require("./util");

/* documents physiquement présents dans un emplacement */
const HELD = "('A_CONTROLER','RECU','CONSERVE','QUARANTAINE','EN_RESTITUTION')";
const OCC = `(SELECT COUNT(*) FROM held_documents h WHERE h.location_id = l.id AND h.status IN ${HELD})`;
const ETAT = { DISPONIBLE: "Disponible", PARTIEL: "Partiellement occupé", COMPLET: "Complet", RESERVE: "Réservé", BLOQUE: "Bloqué", MAINTENANCE: "Maintenance" };

const etat = l => l.status !== "ACTIF" ? l.status : +l.occ >= +l.capacite ? "COMPLET" : +l.occ > 0 ? "PARTIEL" : "DISPONIBLE";
const qrText = (agencyCode, code) => `IDSECOURS:EMP:${agencyCode}:${code}`;

async function list(agencyId) {
  const rows = await q(`SELECT l.*, ${OCC} occ, a.code agency_code FROM storage_locations l JOIN agencies a ON a.id = l.agency_id
    WHERE l.agency_id = ? ORDER BY l.salle, l.armoire, l.compartiment`, [agencyId]);
  return rows.map(l => ({ ...l, occ: +l.occ, etat: etat(l), etatLabel: ETAT[etat(l)] }));
}

/* emplacement choisi pour un document : contrôlé (même agence, actif, place libre).
   Une agence sans plan de stockage configuré garde la saisie libre. */
async function pick(agencyId, b, exceptHeldId = 0) {
  const n = (await one("SELECT COUNT(*) n FROM storage_locations WHERE agency_id = ?", [agencyId])).n;
  if (!n) { const t = str(b.emplacement, 40); return t ? { id: null, code: t.toUpperCase() } : null; }
  const id = parseInt(b.location_id, 10), code = str(b.emplacement, 40);
  if (!id && !code) return null;
  const l = await one(`SELECT l.*, (SELECT COUNT(*) FROM held_documents h WHERE h.location_id = l.id AND h.status IN ${HELD} AND h.id <> ?) occ
    FROM storage_locations l WHERE l.agency_id = ? AND ${id ? "l.id = ?" : "l.code = ?"}`, [exceptHeldId, agencyId, id || code.toUpperCase()]);
  if (!l) fail(400, "Emplacement inconnu dans cette agence.");
  const e = etat(l);
  if (e === "COMPLET") fail(409, `L’emplacement ${l.code} est complet.`);
  if (e !== "DISPONIBLE" && e !== "PARTIEL") fail(409, `L’emplacement ${l.code} n’est pas disponible (${ETAT[e].toLowerCase()}).`);
  return { id: l.id, code: l.code };
}

/* plan de stockage : taux d'occupation par salle */
function plan(items) {
  const by = {};
  for (const l of items) { const s = by[l.salle] || (by[l.salle] = { salle: l.salle, cap: 0, occ: 0, n: 0, indispo: 0 }); s.n++; if (l.status === "ACTIF") s.cap += +l.capacite; else s.indispo++; s.occ += l.occ; }
  return Object.values(by).map(s => ({ ...s, pct: s.cap ? Math.round(s.occ * 100 / s.cap) : 0 }));
}

module.exports = { list, pick, plan, etat, qrText, ETAT, HELD };
