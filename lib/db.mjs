/**
 * lib/db.mjs — acces la baza de date (Neon / PostgreSQL)
 * -----------------------------------------------------------------------------
 * - `sql`           : query PARAMETRIZAT pentru aplicație -> sql`... WHERE id = ${id}`
 *                     (folosește conexiunea POOLED — potrivită pentru serverless)
 * - `getPool()`     : Pool peste WebSocket, pe conexiunea UNPOOLED — pentru
 *                     migrări / multi-statement / advisory locks / tranzacții
 * - `ensureSchema()`: aplică db/schema.sql o singură dată per proces (idempotent)
 *
 * Variabilele de conexiune sunt injectate de integrarea Neon din Vercel
 * (DATABASE_URL, DATABASE_URL_UNPOOLED, …) și NU ajung niciodată în frontend.
 */

import { neon, Pool } from "@neondatabase/serverless";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const POOLED =
    process.env.DATABASE_URL ||
    process.env.DATABASE_POSTGRES_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    "";

const UNPOOLED =
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.DATABASE_POSTGRES_URL_NON_POOLING ||
    process.env.POSTGRES_URL_NON_POOLING ||
    POOLED; // fallback: dacă nu există unpooled, folosim pooled

function missing() {
    throw new Error(
        "Datenbank ist nicht verbunden (keine DATABASE_URL). " +
        "Bitte in Vercel unter Storage eine Neon-Postgres-Datenbank mit dem Projekt verbinden."
    );
}

/** Query parametrizat. Ex.: `const rows = await sql\`SELECT * FROM users WHERE email = ${email}\`` */
export const sql = POOLED ? neon(POOLED) : missing;

/** Pool (protocol PG peste WebSocket, conexiune unpooled). Închide-l cu `pool.end()`. */
export function getPool() {
    if (!UNPOOLED) missing();
    return new Pool({ connectionString: UNPOOLED });
}

export const hasDatabase = () => Boolean(POOLED);

/* -------------------------------------------------------------------------- */
/* Migrare lazy — se rulează o singură dată per proces serverless.            */
/* -------------------------------------------------------------------------- */

const SCHEMA_VERSION = "2026-09-07-01";
let schemaReady = null;

export function ensureSchema() {
    if (!schemaReady) {
        schemaReady = runMigration().catch((err) => {
            schemaReady = null; // permite retry la următorul request
            throw err;
        });
    }
    return schemaReady;
}

async function runMigration() {
    if (!POOLED) missing();

    // Verificare ieftină: versiunea e deja aplicată?
    try {
        const rows = await sql`SELECT 1 FROM schema_migrations WHERE version = ${SCHEMA_VERSION}`;
        if (rows.length) return;
    } catch {
        /* schema_migrations nu există încă -> continuăm cu migrarea completă */
    }

    const schemaPath = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "db",
        "schema.sql"
    );
    const ddl = await readFile(schemaPath, "utf8");

    const pool = getPool();
    const client = await pool.connect();
    try {
        // Lock consultativ: 2 instanțe serverless nu migrează simultan.
        await client.query("SELECT pg_advisory_lock(4711815)");
        try {
            const done = await client
                .query("SELECT 1 FROM schema_migrations WHERE version = $1", [SCHEMA_VERSION])
                .catch(() => ({ rows: [] }));

            if (!done.rows.length) {
                await client.query(ddl); // schema.sql este idempotent
                await client.query(
                    "INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING",
                    [SCHEMA_VERSION]
                );
                // Curățare oportunistă a datelor expirate.
                await client.query("DELETE FROM sessions WHERE expires_at < now()").catch(() => {});
                await client
                    .query("DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'")
                    .catch(() => {});
            }
        } finally {
            await client.query("SELECT pg_advisory_unlock(4711815)");
        }
    } finally {
        client.release();
        await pool.end();
    }
}
