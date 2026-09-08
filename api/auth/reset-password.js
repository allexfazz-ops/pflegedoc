/**
 * POST /api/auth/reset-password   { token, password }
 * -----------------------------------------------------------------------------
 * - public (tokenul brut e credențialul), rate limited pe IP
 * - consumă tokenul 'reset_password' (single-use, 1h)
 * - setează noua parolă (scrypt) + marchează e-mailul ca verificat
 *   (accesul la link dovedește controlul adresei)
 * - INVALIDEAZĂ toate sesiunile utilizatorului (practică standard la schimbare parolă)
 */

import { ensureSchema, sql } from "../../lib/db.mjs";
import { json, fail, methodNotAllowed, readJson, clientIp } from "../../lib/http.mjs";
import { enforceRateLimit } from "../../lib/ratelimit.mjs";
import { checkPassword } from "../../lib/validate.mjs";
import { consumeEmailToken } from "../../lib/tokens.mjs";
import { hashPassword, destroyAllSessions } from "../../lib/auth.mjs";

export default async function handler(req, res) {
    if (methodNotAllowed(req, res, ["POST"])) return;

    try {
        await ensureSchema();
        if (await enforceRateLimit(res, `reset:ip:${clientIp(req)}`, 20, 3600)) return;

        let body;
        try {
            body = await readJson(req, { maxBytes: 8 * 1024 });
        } catch (e) {
            return fail(res, e.status || 400, e.message || "Ungültige Anfrage.");
        }

        const pw = checkPassword(body.password);
        if (!pw.ok) return fail(res, 400, pw.error);

        const consumed = await consumeEmailToken(body.token, "reset_password");
        if (!consumed) {
            return fail(res, 400, "Der Link ist ungültig oder abgelaufen. Bitte fordere einen neuen an.");
        }

        const passwordHash = await hashPassword(body.password);
        await sql`
            UPDATE users
            SET password_hash = ${passwordHash},
                email_verified = true,
                email_verified_at = COALESCE(email_verified_at, now())
            WHERE id = ${consumed.userId}
        `;
        // Toate sesiunile vechi devin invalide.
        await destroyAllSessions(consumed.userId);

        return json(res, 200, { ok: true });
    } catch (err) {
        return fail(res, 500, "Zurücksetzen derzeit nicht möglich.", err);
    }
}
