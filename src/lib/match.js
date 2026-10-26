/* Score de correspondance document déclaré ↔ document retrouvé (Vérification §17–§21).
   Critères pondérés paramétrables (settings match_w_*), seuils match_forte / match_verifier.
   Résultat = aide à la décision : jamais d'autorisation automatique (VC02). */
const { q } = require("../config/db");
const { normName, normNum } = require("./util");

const CRITERIA = [["type", "Type de document"], ["numero", "Numéro"], ["nom", "Nom"], ["prenoms", "Prénoms"], ["dob", "Date de naissance"], ["exp", "Date d’expiration"]];
const DEFAULTS = { match_w_type: 10, match_w_numero: 50, match_w_nom: 15, match_w_prenoms: 10, match_w_dob: 10, match_w_exp: 5, match_forte: 90, match_verifier: 60 };

async function rules() {
  const rows = await q("SELECT k, v FROM settings WHERE k LIKE 'match_%'");
  const r = { ...DEFAULTS }; for (const x of rows) if (x.k in r) r[x.k] = +x.v;
  return r;
}

/* held : document retrouvé ; ref : { category_code, numero, nom, prenoms, dob, exp } (déclaré ou fourni par le demandeur) */
function score(held, ref, R) {
  const heldName = normName(held.nom || "");
  const words = heldName.split(" ").filter(Boolean);
  const cmp = {
    type: held.category_code && ref.category_code ? held.category_code === ref.category_code : null,
    numero: held.numero && ref.numero ? normNum(held.numero) === normNum(ref.numero) : null,
    nom: heldName && ref.nom ? words.includes(normName(ref.nom).split(" ")[0]) || heldName.startsWith(normName(ref.nom)) : null,
    prenoms: heldName && ref.prenoms ? normName(ref.prenoms).split(" ").filter(Boolean).every(w => words.includes(w)) : null,
    dob: held.dob && ref.dob ? String(held.dob) === String(ref.dob) : null,
    exp: held.date_exp && ref.exp ? String(held.date_exp) === String(ref.exp) : null
  };
  let total = 0, got = 0;
  const criteria = CRITERIA.map(([k, l]) => { const w = R["match_w_" + k] || 0; if (cmp[k] !== null) { total += w; if (cmp[k]) got += w; } return { k, l, ok: cmp[k], w }; });
  const pct = total ? Math.round(got / total * 100) : 0;
  const level = !total ? "AUCUNE CORRESPONDANCE" : cmp.numero === true && pct < R.match_verifier ? "INCOHÉRENCE"
    : pct >= R.match_forte ? "CORRESPONDANCE FORTE" : pct >= R.match_verifier ? "CORRESPONDANCE À VÉRIFIER" : "AUCUNE CORRESPONDANCE";
  return { pct, level, criteria, evaluated: total };
}

/* plusieurs titulaires enregistrés pour un même numéro de document retrouvé → correspondances multiples (VC08) */
async function owners(numero) {
  if (!numero) return [];
  return q(`SELECT d.id, d.user_id, d.category_code, d.numero, d.nom, d.prenoms, d.dob, d.date_exp exp, d.status, u.prenom, u.nom unom, u.commune
    FROM documents d JOIN users u ON u.id = d.user_id WHERE d.numero = ?`, [normNum(numero)]);
}
const isMultiple = list => new Set(list.map(o => o.user_id)).size > 1;

module.exports = { rules, score, owners, isMultiple, CRITERIA, DEFAULTS };
