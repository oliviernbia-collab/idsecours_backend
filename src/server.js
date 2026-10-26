require("dotenv").config();
const app = require("./app");
const engine = require("./lib/engine");
const { pool } = require("./config/db");

const PORT = +(process.env.PORT || 4000);

(async () => {
  try { await pool.query("SELECT 1"); }
  catch (e) { console.error(`Connexion MySQL impossible (${e.code || e.message}). Démarrez MySQL puis lancez « npm run db:init ».`); process.exit(1); }
  try { await require("./lib/migrate").migrate(); }
  catch (e) { console.error("Migration impossible :", e.message, "— lancez « npm run db:init »."); process.exit(1); }
  const server = app.listen(PORT, "0.0.0.0", () => {
    engine.start();
    console.log(`ID SECOURS API prête sur http://localhost:${PORT}`);
  });
  server.on("error", e => {
    if (e.code === "EADDRINUSE") console.error(`Le port ${PORT} est déjà utilisé : une autre instance de l’API tourne déjà. Arrêtez-la (Ctrl+C dans son terminal) ou changez PORT dans .env.`);
    else console.error(e);
    process.exit(1);
  });
})();
