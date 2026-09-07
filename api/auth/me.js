/**
 * GET /api/auth/me
 * -----------------------------------------------------------------------------
 * Probă de sesiune pentru frontend la încărcarea aplicației.
 *   - neautentificat -> 200 { authenticated: false }
 *   - autentificat   -> 200 { authenticated: true, user, csrfToken }
 * Nu returnează niciodată password_hash sau alte câmpuri interne.
 */

import { ensureSchema } from "../../lib/db.mjs";
import { json, fail, methodNotAllowed } from "../../lib/http.mjs";
import { getAuth } from "../../lib/auth.mjs";

export default async function handler(req, res) {
    if (methodNotAllowed(req, res, ["GET"])) return;

    try {
        await ensureSchema();
        const auth = await getAuth(req);
        if (!auth) return json(res, 200, { authenticated: false });

        return json(res, 200, {
            authenticated: true,
            user: {
                id: auth.user.id,
                email: auth.user.email,
                ui_language: auth.user.ui_language,
                theme: auth.user.theme,
                created_at: auth.user.created_at,
            },
            csrfToken: auth.session.csrf,
        });
    } catch (err) {
        return fail(res, 500, "Sitzungsprüfung fehlgeschlagen.", err);
    }
}
