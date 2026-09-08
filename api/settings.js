/**
 * /api/settings
 * -----------------------------------------------------------------------------
 * GET   — preferințele contului curent { ui_language, theme }.
 * PATCH — actualizează ui_language și/sau theme. Enum-uri validate server-side.
 *         Necesită sesiune + CSRF. user_id vine din sesiune.
 */

import { ensureSchema, sql } from "../lib/db.mjs";
import { json, fail, methodNotAllowed, readJson } from "../lib/http.mjs";
import { requireAuth, requireCsrf, requireVerified } from "../lib/auth.mjs";
import { enforceRateLimit } from "../lib/ratelimit.mjs";
import { UI_LANGUAGES, THEMES, inEnum, optText } from "../lib/validate.mjs";

const MAX_NAME = 80;

export default async function handler(req, res) {
    if (methodNotAllowed(req, res, ["GET", "PATCH"])) return;

    try {
        await ensureSchema();
        const auth = await requireAuth(req, res);
        if (!auth) return;
        const userId = auth.user.id;

        if (req.method === "GET") {
            const rows = await sql`SELECT ui_language, theme, display_name FROM users WHERE id = ${userId}`;
            return json(res, 200, { settings: rows[0] || null });
        }

        // PATCH
        if (!requireVerified(auth, res)) return;
        if (!requireCsrf(req, res, auth.session)) return;
        if (await enforceRateLimit(res, `settings:user:${userId}`, 60, 3600)) return;

        let body;
        try {
            body = await readJson(req, { maxBytes: 4 * 1024 });
        } catch (e) {
            return fail(res, e.status || 400, e.message || "Ungültige Anfrage.");
        }

        const next = {};
        let nameGiven = false;
        let nameValue = null;
        if (body.ui_language !== undefined) {
            if (!inEnum(body.ui_language, UI_LANGUAGES)) return fail(res, 400, "Ungültige Sprache.");
            next.ui_language = body.ui_language;
        }
        if (body.theme !== undefined) {
            if (!inEnum(body.theme, THEMES)) return fail(res, 400, "Ungültiges Theme.");
            next.theme = body.theme;
        }
        if (body.display_name !== undefined) {
            const n = optText(body.display_name, MAX_NAME);
            if (!n.ok) return fail(res, 400, n.error);
            nameGiven = true;
            nameValue = n.value; // string sau null (golire)
        }
        if (!Object.keys(next).length && !nameGiven) return fail(res, 400, "Keine gültigen Felder angegeben.");

        // Update parametrizat, doar câmpurile prezente. display_name poate fi golit (NULL).
        const rows = await sql`
            UPDATE users SET
                ui_language  = COALESCE(${next.ui_language ?? null}, ui_language),
                theme        = COALESCE(${next.theme ?? null}, theme),
                display_name = CASE WHEN ${nameGiven} THEN ${nameValue} ELSE display_name END
            WHERE id = ${userId}
            RETURNING ui_language, theme, display_name
        `;
        return json(res, 200, { ok: true, settings: rows[0] });
    } catch (err) {
        return fail(res, 500, "Einstellungen konnten nicht gespeichert werden.", err);
    }
}
