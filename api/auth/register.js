/**
 * POST /api/auth/register   { email, password }
 * -----------------------------------------------------------------------------
 * - public
 * - rate limited (IP)
 * - rezistent la account enumeration: răspunsul nu confirmă dacă e-mailul
 *   există deja; parola este mereu hash-uită (timing constant-ish).
 * - la succes: creează contul + sesiune (cookie HttpOnly) și întoarce csrfToken.
 */

import { ensureSchema, sql } from "../../lib/db.mjs";
import { json, fail, methodNotAllowed, readJson, clientIp, appendCookie } from "../../lib/http.mjs";
import { enforceRateLimit } from "../../lib/ratelimit.mjs";
import { isEmail, normEmail, checkPassword } from "../../lib/validate.mjs";
import { hashPassword, createSession, sessionCookie } from "../../lib/auth.mjs";
import { sendVerificationEmail } from "../../lib/tokens.mjs";
import { emailEnabled } from "../../lib/email.mjs";

export default async function handler(req, res) {
    if (methodNotAllowed(req, res, ["POST"])) return;

    try {
        await ensureSchema();

        const ip = clientIp(req);
        if (await enforceRateLimit(res, `register:ip:${ip}`, 10, 3600)) return;

        let body;
        try {
            body = await readJson(req, { maxBytes: 8 * 1024 });
        } catch (e) {
            return fail(res, e.status || 400, e.message || "Ungültige Anfrage.");
        }

        const email = normEmail(body.email);
        if (!isEmail(email)) return fail(res, 400, "Bitte eine gültige E-Mail-Adresse angeben.");

        const pw = checkPassword(body.password);
        if (!pw.ok) return fail(res, 400, pw.error);

        // Timing: hash-uim mereu, chiar dacă e-mailul există deja.
        const passwordHash = await hashPassword(body.password);

        const existing = await sql`SELECT 1 FROM users WHERE email = ${email} LIMIT 1`;
        if (existing.length) {
            // Nu confirmăm existența contului.
            return json(res, 200, { ok: true, created: false });
        }

        let userRows;
        try {
            userRows = await sql`
                INSERT INTO users (email, password_hash)
                VALUES (${email}, ${passwordHash})
                RETURNING id, email, ui_language, theme, created_at
            `;
        } catch (e) {
            // Race: alt request a creat același e-mail între SELECT și INSERT.
            if (String(e.message || "").includes("users_email_key") || e.code === "23505") {
                return json(res, 200, { ok: true, created: false });
            }
            throw e;
        }

        const user = userRows[0];
        const { token, csrf } = await createSession(user.id, req);
        appendCookie(res, sessionCookie(token, req));

        // Trimite e-mailul de verificare (nu blocăm dacă eșuează).
        let emailSent = false;
        let devVerifyUrl;
        try {
            const r = await sendVerificationEmail(req, user);
            emailSent = !!r.delivered;
            // Doar cât timp e-mailul e dezactivat pe server: returnăm link-ul
            // ca să poți testa fluxul fără provider.
            if (!emailEnabled()) devVerifyUrl = r.url;
        } catch (e) {
            console.error("[register] verification email:", e.message);
        }

        return json(res, 201, {
            ok: true,
            created: true,
            user: {
                id: user.id, email: user.email,
                ui_language: user.ui_language, theme: user.theme,
                email_verified: false,
            },
            csrfToken: csrf,
            emailSent,
            ...(devVerifyUrl ? { devVerifyUrl } : {}),
        });
    } catch (err) {
        return fail(res, 500, "Registrierung derzeit nicht möglich.", err);
    }
}
