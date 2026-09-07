/**
 * /api/history/:id
 * -----------------------------------------------------------------------------
 * GET    — conținutul complet al unei activități. Ownership OBLIGATORIU:
 *          WHERE id = $1 AND user_id = <din sesiune>. Dacă nu aparține
 *          utilizatorului -> 404 (nu 403), ca să nu confirme existența.
 * DELETE — șterge o activitate proprie. Necesită CSRF + rate limit.
 *
 * :id este validat ca UUID înainte de orice query (anti-IDOR / anti-injection).
 */

import { ensureSchema, sql } from "../../lib/db.mjs";
import { json, fail, methodNotAllowed } from "../../lib/http.mjs";
import { requireAuth, requireCsrf } from "../../lib/auth.mjs";
import { enforceRateLimit } from "../../lib/ratelimit.mjs";
import { isUuid } from "../../lib/validate.mjs";

const NOT_FOUND = "Eintrag nicht gefunden.";

export default async function handler(req, res) {
    if (methodNotAllowed(req, res, ["GET", "DELETE"])) return;

    try {
        await ensureSchema();
        const auth = await requireAuth(req, res);
        if (!auth) return;
        const userId = auth.user.id;

        // id din path (Vercel: req.query.id) — validat strict.
        const id = req.query?.id;
        if (!isUuid(id)) return fail(res, 404, NOT_FOUND);

        /* ------------------------------ GET ------------------------------ */
        if (req.method === "GET") {
            const rows = await sql`
                SELECT id, type, input_text, input_language, mode, result_text, created_at
                FROM activities
                WHERE id = ${id} AND user_id = ${userId}
                LIMIT 1
            `;
            if (!rows.length) return fail(res, 404, NOT_FOUND);
            return json(res, 200, { item: rows[0] });
        }

        /* ----------------------------- DELETE ---------------------------- */
        if (!requireCsrf(req, res, auth.session)) return;
        if (await enforceRateLimit(res, `history_delete:user:${userId}`, 120, 3600)) return;

        const rows = await sql`
            DELETE FROM activities
            WHERE id = ${id} AND user_id = ${userId}
            RETURNING id
        `;
        if (!rows.length) return fail(res, 404, NOT_FOUND);
        return json(res, 200, { ok: true, id: rows[0].id });
    } catch (err) {
        return fail(res, 500, "Aktion derzeit nicht möglich.", err);
    }
}
