/* Règles métier partagées : protections, couverture, quotas (R31–R37) */
const { q, one } = require("../config/db");
const { DAY, YEAR, fmtD, maskNum } = require("./util");

async function catalog() {
  const [cats, packs, formules, pay] = await Promise.all([
    q("SELECT * FROM doc_categories WHERE active = 1 ORDER BY position"),
    q("SELECT * FROM packs WHERE active = 1"),
    q("SELECT * FROM formules WHERE active = 1 ORDER BY position"),
    q("SELECT * FROM pay_methods WHERE active = 1 AND agency_only = 0 ORDER BY position") // les espèces ne sont encaissées qu'au guichet
  ]);
  return { cats, packs, formules, pay };
}
const catMap = async () => Object.fromEntries((await q("SELECT * FROM doc_categories")).map(c => [c.code, c]));
const formuleMap = async () => Object.fromEntries((await q("SELECT * FROM formules")).map(f => [f.code, f]));

function protStatus(p) {
  if (p.suspended) return { k: "SUSPENDUE", l: "Suspendue", c: "grey" };
  const left = new Date(p.exp_at) - Date.now();
  if (left < 0) return { k: "EXPIREE", l: "Expirée", c: "red" };
  if (left < 30 * DAY) return { k: "BIENTOT", l: "Expire bientôt", c: "orange" };
  return { k: "ACTIVE", l: p.kind === "INDIV" ? "Active" : "Actif", c: "green" };
}
const protActive = p => p && ["ACTIVE", "BIENTOT"].includes(protStatus(p).k);

/* contexte complet d'un utilisateur : protections + documents rattachés */
async function userCtx(userId) {
  const [prots, docs, cats, forms] = await Promise.all([
    q("SELECT * FROM protections WHERE user_id = ? ORDER BY id", [userId]),
    q("SELECT id, category_code, protection_id, status FROM documents WHERE user_id = ?", [userId]),
    catMap(), formuleMap()
  ]);
  return { prots, docs, cats, forms };
}
function quotaLeft(ctx, p, tier) {
  const attached = ctx.docs.filter(d => d.protection_id === p.id);
  if (p.kind === "PACK") return (tier === 500 ? p.quota500 : p.quota300) - attached.filter(d => ctx.cats[d.category_code].prix === tier).length;
  if (p.kind === "FORMULE") { const max = ctx.forms[p.formule_code].max_docs; return max === 0 ? 999 : max - attached.length; }
  return 0;
}
/* protection active capable de couvrir une catégorie (contrôle avant enregistrement §9) */
function coverFor(ctx, cat) {
  const tier = ctx.cats[cat].prix;
  const act = ctx.prots.filter(protActive);
  return act.find(p => p.kind === "INDIV" && p.category_code === cat && !ctx.docs.some(d => d.protection_id === p.id))
    || act.find(p => p.kind === "PACK" && quotaLeft(ctx, p, tier) > 0)
    || act.find(p => p.kind === "FORMULE" && quotaLeft(ctx, p) > 0) || null;
}
function checks(ctx, cat) {
  const act = ctx.prots.filter(protActive), c = ctx.cats[cat];
  return [
    ["Protection existante", act.length > 0],
    ["Statut et date d’expiration", act.length > 0],
    [`Catégorie ${c.short}`, act.some(x => x.kind === "INDIV" && x.category_code === cat && !ctx.docs.some(d => d.protection_id === x.id))],
    [`Quota disponible (${c.prix} FCFA)`, act.some(x => quotaLeft(ctx, x, c.prix) > 0)]
  ];
}
const protName = (p, ctx) => !p ? "Aucune" : p.kind === "FORMULE" ? "Formule " + ctx.forms[p.formule_code].label : p.kind === "PACK" ? p.label : "Protection individuelle " + ctx.cats[p.category_code].short;
const vipActive = ctx => ctx.prots.some(p => p.kind === "FORMULE" && ctx.forms[p.formule_code].publication && protActive(p));
const activeFormule = ctx => ctx.prots.find(p => p.kind === "FORMULE" && protActive(p)) || null;

function protView(p, ctx) {
  const st = protStatus(p);
  const docs = ctx.docs.filter(d => d.protection_id === p.id);
  const f = p.kind === "FORMULE" ? ctx.forms[p.formule_code] : null;
  return {
    id: p.id, kind: p.kind, cat: p.category_code, pack: p.pack_code, formule: p.formule_code, label: p.label,
    name: protName(p, ctx), prix: f ? f.prix : p.prix, start: p.start_at, exp: p.exp_at, status: st, active: protActive(p),
    quota: p.kind === "PACK" ? { 500: p.quota500, 300: p.quota300 } : null,
    left: p.kind === "PACK" ? { 500: quotaLeft(ctx, p, 500), 300: quotaLeft(ctx, p, 300) } : p.kind === "FORMULE" ? { max: f.max_docs, used: docs.length } : null,
    docs: docs.map(d => d.id),
    formuleInfo: f ? { collecte: f.collecte_label, livraison: f.livraison_label, priorite: f.priorite, publication: !!f.publication, max: f.max_docs, color: f.color } : null
  };
}

/* quotas de livraison d'une formule sur la période en cours */
async function deliveriesLeft(userId, ctx) {
  const p = activeFormule(ctx); if (!p) return 0;
  const f = ctx.forms[p.formule_code]; if (f.delivery_quota < 0) return 999; if (f.delivery_quota === 0) return 0;
  const used = await one("SELECT COUNT(*) n FROM recoveries WHERE user_id = ? AND delivery = 1 AND deliv_ref LIKE 'INCLUS%' AND created_at >= ?", [userId, p.start_at]);
  return f.delivery_quota - used.n;
}

function docView(d, ctx, extra = {}) {
  const p = ctx ? ctx.prots.find(x => x.id === d.protection_id) : null;
  return {
    id: d.id, cat: d.category_code, num: maskNum(d.numero), numFull: d.numero, nom: d.nom, prenoms: d.prenoms, dob: d.dob, org: d.organisme,
    deliv: d.date_deliv, exp: d.date_exp, st: d.status, created: d.created_at, photos: { recto: d.photo_recto, verso: d.photo_verso },
    prot: p ? { id: p.id, name: protName(p, ctx), exp: p.exp_at, status: protStatus(p), active: protActive(p) } : null, ...extra
  };
}

module.exports = { catalog, catMap, formuleMap, protStatus, protActive, userCtx, quotaLeft, coverFor, checks, protName, protView, vipActive, activeFormule, deliveriesLeft, docView, YEAR, fmtD };
