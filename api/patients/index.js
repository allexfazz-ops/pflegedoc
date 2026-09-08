/**
 * /api/patients
 * -----------------------------------------------------------------------------
 * GET  — lista pacienților (proiecte de Pflegeplanung) ai utilizatorului curent,
 *        cu numărul de versiuni de plan. Fără textele planurilor.
 * POST — creează un pacient. user_id vine EXCLUSIV din sesiune. Necesită CSRF.
 *
 * Query-uri parametrizate. Autorizare + ownership server-side.
 */

import { ensureSchema, sql } from "../../lib/db.mjs";
import { json, fail, methodNotAllowed, readJson } from "../../lib/http.mjs";
import { requireAuth, requireCsrf, requireVerified } from "../../lib/auth.mjs";
import { enforceRateLimit } from "../../lib/ratelimit.mjs";
import { requireText, optText } from "../../lib/validate.mjs";

const MAX_NAME = 120;
const MAX_NOTE = 2000;

export default async function handler(req, res) {
    if (methodNotAllowed(req, res, ["GET", "POST"])) return;

    try {
        await ensureSchema();
        const auth = await requireAuth(req, res);
        if (!auth) return;
        const userId = auth.user.id;

        /* ------------------------------- GET ------------------------------- */
        if (req.method === "GET") {
            const rows = await sql`
                SELECT p.id, p.name, p.note, p.created_at, p.updated_at,
                       COUNT(a.id)::int AS plan_count,
                       MAX(a.created_at) AS last_plan_at
                FROM patients p
                LEFT JOIN activities a
                       ON a.patient_id = p.id AND a.type = 'pflegeplanung'
                WHERE p.user_id = ${userId}
                GROUP BY p.id
                ORDER BY p.updated_at DESC, p.id DESC
                LIMIT 200
            `;
            return json(res, 200, {
                items: rows.map((r) => ({
                    id: r.id,
                    name: r.name,
                    note: r.note,
                    created_at: r.created_at,
                    updated_at: r.updated_at,
                    plan_count: r.plan_count,
                    last_plan_at: r.last_plan_at,
                })),
            });
        }

        /* ------------------------------ POST ------------------------------ */
        if (!requireVerified(auth, res)) return;
        if (!requireCsrf(req, res, auth.session)) return;
        if (await enforceRateLimit(res, `patient_create:user:${userId}`, 60, 3600, req)) return;

        let body;
        try {
            body = await readJson(req, { maxBytes: 16 * 1024 });
        } catch (e) {
            return fail(res, e.status || 400, e.message || "Ungültige Anfrage.");
        }

        const name = requireText(body.name, MAX_NAME);
        if (!name.ok) return fail(res, 400, name.error);
        const note = optText(body.note, MAX_NOTE);
        if (!note.ok) return fail(res, 400, note.error);

        const rows = await sql`
            INSERT INTO patients (user_id, name, note)
            VALUES (${userId}, ${name.value}, ${note.value})
            RETURNING id, name, note, created_at, updated_at
        `;
        return json(res, 201, { ok: true, patient: rows[0] });
    } catch (err) {
        return fail(res, 500, "Patienten derzeit nicht verfügbar.", err);
    }
}
