/**
 * GET /api/health
 * -----------------------------------------------------------------------------
 * Verificare de sănătate pentru baza de date + migrare.
 * Public, dar NU expune nimic sensibil: doar un boolean „ready", numărul de
 * tabele și versiunea de schemă. Fără nume de host, credențiale sau detalii
 * de implementare.
 */

import { sql, ensureSchema, hasDatabase } from "../lib/db.mjs";

const EXPECTED_TABLES = ["activities", "rate_limits", "schema_migrations", "sessions", "users"];

export default async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Access-Control-Allow-Methods", "GET");

    if (req.method !== "GET") {
        return res.status(405).json({ ok: false, error: "Methode nicht erlaubt." });
    }
    if (!hasDatabase()) {
        return res.status(503).json({ ok: false, ready: false, error: "Datenbank nicht verbunden." });
    }

    try {
        await ensureSchema();

        const rows = await sql`
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public'
        `;
        const present = rows.map((r) => r.table_name);
        const ready = EXPECTED_TABLES.every((t) => present.includes(t));

        const v = await sql`
            SELECT version FROM schema_migrations ORDER BY applied_at DESC LIMIT 1
        `;

        return res.status(200).json({
            ok: true,
            ready,
            schemaVersion: v[0]?.version ?? null,
            tableCount: present.length,
        });
    } catch (err) {
        console.error("[health]", err);
        return res.status(500).json({ ok: false, ready: false, error: "Health-Check fehlgeschlagen." });
    }
}
