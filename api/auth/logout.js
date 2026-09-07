/**
 * POST /api/auth/logout
 * -----------------------------------------------------------------------------
 * - șterge sesiunea server-side (invalidare reală) și cookie-ul
 * - dacă există sesiune, cere token CSRF valid (previne logout forțat CSRF)
 * - idempotent: fără sesiune -> curăță cookie-ul și întoarce ok
 */

import { ensureSchema } from "../../lib/db.mjs";
import { json, fail, methodNotAllowed, appendCookie } from "../../lib/http.mjs";
import { getAuth, checkCsrf, destroySession, clearSessionCookie } from "../../lib/auth.mjs";

export default async function handler(req, res) {
    if (methodNotAllowed(req, res, ["POST"])) return;

    try {
        await ensureSchema();
        const auth = await getAuth(req);

        if (auth) {
            if (!checkCsrf(req, auth.session)) {
                return fail(res, 403, "Ungültiges oder fehlendes CSRF-Token.");
            }
            await destroySession(req);
        }

        appendCookie(res, clearSessionCookie(req));
        return json(res, 200, { ok: true });
    } catch (err) {
        // Chiar și la eroare, curățăm cookie-ul.
        appendCookie(res, clearSessionCookie(req));
        return fail(res, 500, "Abmeldung teilweise fehlgeschlagen.", err);
    }
}
