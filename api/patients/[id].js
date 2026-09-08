/**
 * /api/patients/:id
 * -----------------------------------------------------------------------------
 * GET    — pacientul + versiunile de Pflegeplanung (preview) + planul curent
 *          (cel mai recent, text complet). Ownership: WHERE user_id = <sesiune>.
 *          Nu aparține -> 404 (nu 403).
 * PATCH  — redenumire / notă. Necesită CSRF.
 * DELETE — șterge pacientul (+ toate planurile lui prin ON DELETE CASCADE). CSRF.
 *
 * :id validat ca UUID înainte de orice query.
 */

import { ensureSchema, sql } from "../../lib/db.mjs";
import { json, fail, methodNotAllowed, readJson } from "../../lib/http.mjs";
import { requireAuth, requireCsrf, requireVerified } from "../../lib/auth.mjs";
import { enforceRateLimit } from "../../lib/ratelimit.mjs";
import { isUuid, requireText, optText } from "../../lib/validate.mjs";
import { securityEvent } from "../../lib/securitylog.mjs";

const NOT_FOUND = "Patient nicht gefunden.";
const MAX_NAME = 120;
const MAX_NOTE = 2000;

function preview(text) {
    return String(text || "").replace(/\s+/g, " ").trim().slice(0, 140);
}

export default async function handler(req, res) {
    if (methodNotAllowed(req, res, ["GET", "PATCH", "DELETE"])) return;

    try {
        await ensureSchema();
        const auth = await requireAuth(req, res);
        if (!auth) return;
        const userId = auth.user.id;

        const id = req.query?.id;
        if (!isUuid(id)) return fail(res, 404, NOT_FOUND);

        /* ------------------------------ GET ------------------------------ */
        if (req.method === "GET") {
            const pr = await sql`
                SELECT id, name, note, created_at, updated_at
                FROM patients WHERE id = ${id} AND user_id = ${userId} LIMIT 1
            `;
            if (!pr.length) {
                securityEvent("foreign_resource_attempt", req, { outcome: "404", route: "/api/patients/[id]", userId });
                return fail(res, 404, NOT_FOUND);
            }

            const versions = await sql`
                SELECT id, created_at, mode, output_language, result_text
                FROM activities
                WHERE patient_id = ${id} AND user_id = ${userId}
                  AND type = 'pflegeplanung'
                ORDER BY created_at DESC, id DESC
                LIMIT 50
            `;
            const current = versions[0]
                ? {
                      id: versions[0].id,
                      created_at: versions[0].created_at,
                      output_language: versions[0].output_language,
                      result_text: versions[0].result_text,
                  }
                : null;

            return json(res, 200, {
                patient: pr[0],
                current,
                versions: versions.map((v) => ({
                    id: v.id,
                    created_at: v.created_at,
                    output_language: v.output_language,
                    preview: preview(v.result_text),
                })),
            });
        }

        /* ----------------------------- PATCH ---------------------------- */
        if (req.method === "PATCH") {
            if (!requireVerified(auth, res)) return;
            if (!requireCsrf(req, res, auth.session)) return;
            if (await enforceRateLimit(res, `patient_update:user:${userId}`, 60, 3600, req)) return;

            let body;
            try {
                body = await readJson(req, { maxBytes: 16 * 1024 });
            } catch (e) {
                return fail(res, e.status || 400, e.message || "Ungültige Anfrage.");
            }

            let name = null;
            let note = null;
            let noteGiven = false;
            if (body.name !== undefined) {
                const n = requireText(body.name, MAX_NAME);
                if (!n.ok) return fail(res, 400, n.error);
                name = n.value;
            }
            if (body.note !== undefined) {
                const nt = optText(body.note, MAX_NOTE);
                if (!nt.ok) return fail(res, 400, nt.error);
                note = nt.value;
                noteGiven = true;
            }
            if (name === null && !noteGiven) return fail(res, 400, "Keine gültigen Felder angegeben.");

            const rows = await sql`
                UPDATE patients SET
                    name = COALESCE(${name}, name),
                    note = CASE WHEN ${noteGiven} THEN ${note} ELSE note END
                WHERE id = ${id} AND user_id = ${userId}
                RETURNING id, name, note, created_at, updated_at
            `;
            if (!rows.length) {
                securityEvent("foreign_resource_attempt", req, { outcome: "404", route: "/api/patients/[id]", userId });
                return fail(res, 404, NOT_FOUND);
            }
            return json(res, 200, { ok: true, patient: rows[0] });
        }

        /* ----------------------------- DELETE --------------------------- */
        if (!requireVerified(auth, res)) return;
        if (!requireCsrf(req, res, auth.session)) return;
        if (await enforceRateLimit(res, `patient_delete:user:${userId}`, 60, 3600, req)) return;

        const rows = await sql`
            DELETE FROM patients WHERE id = ${id} AND user_id = ${userId} RETURNING id
        `;
        if (!rows.length) {
            securityEvent("foreign_resource_attempt", req, { outcome: "404", route: "/api/patients/[id]", userId });
            return fail(res, 404, NOT_FOUND);
        }
        return json(res, 200, { ok: true, id: rows[0].id });
    } catch (err) {
        return fail(res, 500, "Aktion derzeit nicht möglich.", err);
    }
}
