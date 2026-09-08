/**
 * POST /api/auth/login   { email, password }
 * -----------------------------------------------------------------------------
 * - public
 * - rate limited (per IP și per e-mail)
 * - mesaj generic identic pentru „e-mail inexistent" și „parolă greșită"
 * - timing egalizat (dummyVerify pentru e-mail inexistent)
 */

import { ensureSchema, sql } from "../../lib/db.mjs";
import { json, fail, methodNotAllowed, readJson, clientIp, appendCookie } from "../../lib/http.mjs";
import { enforceRateLimit } from "../../lib/ratelimit.mjs";
import { isEmail, normEmail } from "../../lib/validate.mjs";
import { verifyPassword, dummyVerify, createSession, sessionCookie } from "../../lib/auth.mjs";

const GENERIC = "E-Mail oder Passwort ist falsch.";

export default async function handler(req, res) {
    if (methodNotAllowed(req, res, ["POST"])) return;

    try {
        await ensureSchema();

        const ip = clientIp(req);
        if (await enforceRateLimit(res, `login:ip:${ip}`, 10, 900)) return;

        let body;
        try {
            body = await readJson(req, { maxBytes: 8 * 1024 });
        } catch (e) {
            return fail(res, e.status || 400, e.message || "Ungültige Anfrage.");
        }

        const email = normEmail(body.email);
        const password = typeof body.password === "string" ? body.password : "";

        // Validare formală minimă (nu dezvăluim reguli de parolă la login).
        if (!isEmail(email) || !password || password.length > 200) {
            await dummyVerify(password || "x");
            return fail(res, 401, GENERIC);
        }

        if (await enforceRateLimit(res, `login:email:${email}`, 20, 900)) return;

        const rows = await sql`SELECT id, password_hash FROM users WHERE email = ${email} LIMIT 1`;
        if (!rows.length) {
            await dummyVerify(password);
            return fail(res, 401, GENERIC);
        }

        const ok = await verifyPassword(password, rows[0].password_hash);
        if (!ok) return fail(res, 401, GENERIC);

        const { token, csrf } = await createSession(rows[0].id, req);
        appendCookie(res, sessionCookie(token, req));

        const u = await sql`
            SELECT id, email, ui_language, theme, created_at, email_verified
            FROM users WHERE id = ${rows[0].id}
        `;
        return json(res, 200, {
            ok: true,
            user: {
                id: u[0].id, email: u[0].email,
                ui_language: u[0].ui_language, theme: u[0].theme, created_at: u[0].created_at,
                email_verified: u[0].email_verified === true,
            },
            csrfToken: csrf,
        });
    } catch (err) {
        return fail(res, 500, "Anmeldung derzeit nicht möglich.", err);
    }
}
