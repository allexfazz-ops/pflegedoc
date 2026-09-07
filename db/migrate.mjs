/**
 * db/migrate.mjs — rulează migrarea schemei manual.
 *
 * În mod normal NU e nevoie: lib/db.mjs aplică schema automat la primul request.
 * Rulare manuală (local), cu variabilele din .env.local:
 *
 *   node --env-file=.env.local db/migrate.mjs
 */

import { ensureSchema, hasDatabase } from "../lib/db.mjs";

if (!hasDatabase()) {
    console.error("Nicio DATABASE_URL în mediu. Setează .env.local sau rulează pe Vercel.");
    process.exit(1);
}

console.log("Aplic schema PflegeDoc…");
try {
    await ensureSchema();
    console.log("OK — schema este la zi.");
    process.exit(0);
} catch (err) {
    console.error("Migrare eșuată:", err.message);
    process.exit(1);
}
