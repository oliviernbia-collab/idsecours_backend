/* Mes protections — §5 à §9 */
const router = require("express").Router();
const { h, fail } = require("../lib/util");
const { requireUser } = require("../middleware/auth");
const D = require("../lib/domain");

router.use(requireUser);

router.get("/", h(async (req, res) => {
  const ctx = await D.userCtx(req.user.id);
  const items = ctx.prots.map(p => D.protView(p, ctx));
  const act = ctx.prots.filter(D.protActive);
  res.json({
    items,
    summary: {
      protectedDocs: ctx.docs.filter(d => { const p = ctx.prots.find(x => x.id === d.protection_id); return D.protActive(p); }).length,
      indiv: act.filter(p => p.kind === "INDIV").length, pack: act.some(p => p.kind === "PACK"), vip: D.vipActive(ctx),
      formule: D.activeFormule(ctx) ? D.activeFormule(ctx).formule_code : null
    }
  });
}));

/* couverture par catégorie (écran « Ajouter un document ») */
router.get("/coverage", h(async (req, res) => {
  const ctx = await D.userCtx(req.user.id);
  const out = {};
  for (const code of Object.keys(ctx.cats)) { const c = D.coverFor(ctx, code); out[code] = c ? { id: c.id, name: D.protName(c, ctx), exp: c.exp_at } : null; }
  res.json({ coverage: out });
}));
router.get("/checks/:cat", h(async (req, res) => {
  const ctx = await D.userCtx(req.user.id);
  if (!ctx.cats[req.params.cat]) fail(404, "Catégorie inconnue.");
  res.json({ checks: D.checks(ctx, req.params.cat) });
}));

module.exports = router;
