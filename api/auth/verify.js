/**
 * POST /api/auth/verify   { token }
 * -----------------------------------------------------------------------------
 * - public (tokenul brut este credențialul)
 * - rate limited pe IP
 * - single-use: consumă tokenul și marchează users.email_verified = true
 * - mesaj generic la token invalid/expirat/folosit (fără a dezvălui care)
 */

import { ensureSchema, sql } from "../../lib/db.mjs";
import { json, fail, methodNotAllowed, readJson, clientIp } from "../../lib/http.mjs";
import { enforceRateLimit } from "../../lib/ratelimit.mjs";
import { consumeEmailToken } from "../../lib/tokens.mjs";

export default async function handler(req, res) {
    if (methodNotAllowed(req, res, ["POST"])) return;

    try {
        await ensureSchema();
        if (await enforceRateLimit(res, `verify:ip:${clientIp(req)}`, 20, 3600)) return;

        let body;
        try {
            body = await readJson(req, { maxBytes: 4 * 1024 });
        } catch (e) {
            return fail(res, e.status || 400, e.message || "Ungültige Anfrage.");
        }

        const consumed = await consumeEmailToken(body.token, "verify_email");
        if (!consumed) {
            return fail(res, 400, "Der Bestätigungslink ist ungültig oder abgelaufen.");
        }

        await sql`
            UPDATE users
            SET email_verified = true, email_verified_at = now()
            WHERE id = ${consumed.userId} AND email_verified = false
        `;
        return json(res, 200, { ok: true });
    } catch (err) {
        return fail(res, 500, "Bestätigung derzeit nicht möglich.", err);
    }
}
