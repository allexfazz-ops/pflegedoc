/**
 * POST /api/auth/resend-verification
 * -----------------------------------------------------------------------------
 * - necesită sesiune + CSRF
 * - rate limited pe utilizator (3/oră) — anti email-bombing
 * - emite un token nou (invalidând cel vechi) și retrimite e-mailul
 * - dacă e-mailul e deja verificat: no-op { ok: true, alreadyVerified: true }
 */

import { ensureSchema, sql } from "../../lib/db.mjs";
import { json, fail, methodNotAllowed } from "../../lib/http.mjs";
import { requireAuth, requireCsrf } from "../../lib/auth.mjs";
import { enforceRateLimit } from "../../lib/ratelimit.mjs";
import { sendVerificationEmail } from "../../lib/tokens.mjs";
import { emailEnabled } from "../../lib/email.mjs";

export default async function handler(req, res) {
    if (methodNotAllowed(req, res, ["POST"])) return;

    try {
        await ensureSchema();
        const auth = await requireAuth(req, res);
        if (!auth) return;
        if (!requireCsrf(req, res, auth.session)) return;
        if (await enforceRateLimit(res, `resendverify:user:${auth.user.id}`, 3, 3600)) return;

        const rows = await sql`SELECT id, email, email_verified FROM users WHERE id = ${auth.user.id}`;
        const u = rows[0];
        if (!u) return fail(res, 404, "Konto nicht gefunden.");
        if (u.email_verified) return json(res, 200, { ok: true, alreadyVerified: true });

        let emailSent = false;
        let devVerifyUrl;
        let emailError;
        try {
            const r = await sendVerificationEmail(req, u);
            emailSent = !!r.delivered;
            if (!emailEnabled()) devVerifyUrl = r.url;
            // Diagnostic: motivul de la Resend (textul lor de eroare, fără secrete).
            if (!r.delivered && r.detail) emailError = r.detail;
        } catch (e) {
            console.error("[resend-verification]", e.message);
            emailError = e.message;
        }
        return json(res, 200, {
            ok: true, emailSent,
            ...(devVerifyUrl ? { devVerifyUrl } : {}),
            ...(emailError ? { emailError } : {}),
        });
    } catch (err) {
        return fail(res, 500, "E-Mail konnte nicht erneut gesendet werden.", err);
    }
}
