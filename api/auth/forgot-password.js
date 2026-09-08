/**
 * POST /api/auth/forgot-password   { email }
 * -----------------------------------------------------------------------------
 * - public, rate limited (IP + e-mail)
 * - rezistent la account enumeration: răspunde MEREU generic
 *   { ok: true } indiferent dacă adresa există sau nu
 * - dacă adresa există: emite token 'reset_password' (1h) și trimite e-mail
 * - plasă de siguranță: dacă e-mailul eșuează, întoarce devResetUrl (dispare
 *   când e-mailul funcționează)
 */

import { ensureSchema, sql } from "../../lib/db.mjs";
import { json, fail, methodNotAllowed, readJson, clientIp } from "../../lib/http.mjs";
import { enforceRateLimit } from "../../lib/ratelimit.mjs";
import { isEmail, normEmail } from "../../lib/validate.mjs";
import { sendPasswordResetEmail } from "../../lib/tokens.mjs";
import { emailEnabled } from "../../lib/email.mjs";

export default async function handler(req, res) {
    if (methodNotAllowed(req, res, ["POST"])) return;

    try {
        await ensureSchema();
        const ip = clientIp(req);
        if (await enforceRateLimit(res, `forgot:ip:${ip}`, 5, 3600)) return;

        let body;
        try {
            body = await readJson(req, { maxBytes: 4 * 1024 });
        } catch (e) {
            return fail(res, e.status || 400, e.message || "Ungültige Anfrage.");
        }

        const email = normEmail(body.email);
        // Chiar și pe input invalid răspundem generic (fără a dezvălui nimic).
        if (!isEmail(email)) return json(res, 200, { ok: true });

        if (await enforceRateLimit(res, `forgot:email:${email}`, 3, 3600)) return;

        const rows = await sql`SELECT id, email FROM users WHERE email = ${email} LIMIT 1`;

        let devResetUrl;
        if (rows.length) {
            try {
                const r = await sendPasswordResetEmail(req, rows[0]);
                if (!emailEnabled() || !r.delivered) devResetUrl = r.url;
            } catch (e) {
                console.error("[forgot-password] email:", e.message);
            }
        }

        return json(res, 200, { ok: true, ...(devResetUrl ? { devResetUrl } : {}) });
    } catch (err) {
        return fail(res, 500, "Anfrage derzeit nicht möglich.", err);
    }
}
