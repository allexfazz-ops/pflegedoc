/**
 * /api/history
 * -----------------------------------------------------------------------------
 * GET  — lista paginată a activităților utilizatorului curent (keyset pagination).
 *        Returnează DOAR câmpuri minime + preview; nu textele complete.
 * POST — creează o activitate (Dokumentation / Pflegeplanung). user_id vine
 *        EXCLUSIV din sesiune; nu se acceptă din body. Necesită CSRF.
 *
 * Toate query-urile sunt parametrizate. Autorizare + ownership server-side.
 */

import { ensureSchema, sql } from "../../lib/db.mjs";
import { json, fail, methodNotAllowed, readJson } from "../../lib/http.mjs";
import { requireAuth, requireCsrf, requireVerified } from "../../lib/auth.mjs";
import { enforceRateLimit } from "../../lib/ratelimit.mjs";
import { ACTIVITY_TYPES, MODES, inEnum, isUuid, requireText, optLangCode, outLang } from "../../lib/validate.mjs";

const MAX_INPUT = 20000;
const MAX_RESULT = 40000;

function encodeCursor(row) {
    return Buffer.from(JSON.stringify([row.created_at, row.id]), "utf8").toString("base64url");
}
function decodeCursor(c) {
    try {
        const [ts, id] = JSON.parse(Buffer.from(String(c), "base64url").toString("utf8"));
        if (typeof ts !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return null;
        if (Number.isNaN(Date.parse(ts))) return null;
        return { ts, id };
    } catch {
        return null;
    }
}
function preview(text) {
    return String(text || "").replace(/\s+/g, " ").trim().slice(0, 140);
}

export default async function handler(req, res) {
    if (methodNotAllowed(req, res, ["GET", "POST"])) return;

    try {
        await ensureSchema();
        const auth = await requireAuth(req, res);
        if (!auth) return;
        const userId = auth.user.id;

        /* ------------------------------- GET ------------------------------- */
        if (req.method === "GET") {
            const url = new URL(req.url, "http://x");
            let limit = parseInt(url.searchParams.get("limit") || "20", 10);
            if (!Number.isFinite(limit) || limit < 1) limit = 20;
            if (limit > 50) limit = 50;

            const cursorRaw = url.searchParams.get("cursor");
            const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;
            if (cursorRaw && !cursor) return fail(res, 400, "Ungültiger Cursor.");

            // Verlauf = doar Dokumentation + Korrektur. Pflegeplanung trăiește
            // în proiectele de pacient (/api/patients), nu aici.
            const rows = cursor
                ? await sql`
                    SELECT id, type, output_language, created_at, result_text
                    FROM activities
                    WHERE user_id = ${userId}
                      AND type <> 'pflegeplanung'
                      AND (created_at, id) < (${cursor.ts}::timestamptz, ${cursor.id}::uuid)
                    ORDER BY created_at DESC, id DESC
                    LIMIT ${limit + 1}
                  `
                : await sql`
                    SELECT id, type, output_language, created_at, result_text
                    FROM activities
                    WHERE user_id = ${userId}
                      AND type <> 'pflegeplanung'
                    ORDER BY created_at DESC, id DESC
                    LIMIT ${limit + 1}
                  `;

            const hasMore = rows.length > limit;
            const page = rows.slice(0, limit);
            return json(res, 200, {
                items: page.map((r) => ({
                    id: r.id,
                    type: r.type,
                    output_language: r.output_language,
                    created_at: r.created_at,
                    preview: preview(r.result_text),
                })),
                nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
            });
        }

        /* ------------------------------ POST ------------------------------ */
        if (!requireVerified(auth, res)) return;
        if (!requireCsrf(req, res, auth.session)) return;
        if (await enforceRateLimit(res, `history_create:user:${userId}`, 120, 3600, req)) return;

        let body;
        try {
            body = await readJson(req, { maxBytes: 128 * 1024 });
        } catch (e) {
            return fail(res, e.status || 400, e.message || "Ungültige Anfrage.");
        }

        if (!inEnum(body.type, ACTIVITY_TYPES)) return fail(res, 400, "Ungültiger Aktivitätstyp.");
        const inp = requireText(body.input_text, MAX_INPUT);
        if (!inp.ok) return fail(res, 400, inp.error);
        const out = requireText(body.result_text, MAX_RESULT);
        if (!out.ok) return fail(res, 400, out.error);

        let mode = null;
        if (body.mode != null && body.mode !== "") {
            if (!inEnum(body.mode, MODES)) return fail(res, 400, "Ungültiger Modus.");
            mode = body.mode;
        }
        const lang = optLangCode(body.input_language);
        if (!lang.ok) return fail(res, 400, lang.error);
        const oLang = outLang(body.output_language);
        if (!oLang.ok) return fail(res, 400, oLang.error);

        // patient_id: obligatoriu pentru pflegeplanung, ignorat (NULL) altfel.
        // Ownership verificat înainte de insert.
        let patientId = null;
        if (body.type === "pflegeplanung") {
            if (!isUuid(body.patient_id)) return fail(res, 400, "Patient fehlt.");
            const own = await sql`
                SELECT 1 FROM patients WHERE id = ${body.patient_id} AND user_id = ${userId} LIMIT 1
            `;
            if (!own.length) return fail(res, 404, "Patient nicht gefunden.");
            patientId = body.patient_id;
        }

        const rows = await sql`
            INSERT INTO activities (user_id, type, input_text, input_language, mode, result_text, output_language, patient_id)
            VALUES (${userId}, ${body.type}, ${inp.value}, ${lang.value}, ${mode}, ${out.value}, ${oLang.value}, ${patientId})
            RETURNING id, created_at
        `;
        if (patientId) {
            await sql`UPDATE patients SET updated_at = now() WHERE id = ${patientId} AND user_id = ${userId}`;
        }
        return json(res, 201, { ok: true, id: rows[0].id, created_at: rows[0].created_at });
    } catch (err) {
        return fail(res, 500, "Verlauf derzeit nicht verfügbar.", err);
    }
}
