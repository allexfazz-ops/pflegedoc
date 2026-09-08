/**
 * lib/ratelimit.mjs — rate limiting fixed-window, stocat în Postgres.
 * -----------------------------------------------------------------------------
 * Fără serviciu extern. Un rând per (bucket, fereastră). Incrementare atomică
 * cu INSERT ... ON CONFLICT DO UPDATE. Suficient pentru protecție brute-force
 * la scara actuală. Query 100% parametrizat.
 */

import { sql } from "./db.mjs";
import { json } from "./http.mjs";

/**
 * @param {string} bucket  ex: "login:ip:1.2.3.4"
 * @param {number} limit   nr. maxim de cereri în fereastră
 * @param {number} windowSeconds  mărimea ferestrei
 * @returns {Promise<{allowed:boolean, count:number, limit:number, retryAfter:number}>}
 */
export async function rateLimit(bucket, limit, windowSeconds) {
    const nowMs = Date.now();
    const winMs = windowSeconds * 1000;
    const windowStart = new Date(Math.floor(nowMs / winMs) * winMs);

    let count = 1;
    try {
        const rows = await sql`
            INSERT INTO rate_limits (bucket, window_start, count)
            VALUES (${bucket}, ${windowStart.toISOString()}, 1)
            ON CONFLICT (bucket, window_start)
            DO UPDATE SET count = rate_limits.count + 1
            RETURNING count
        `;
        count = rows[0]?.count ?? 1;
    } catch (err) {
        // La eroare de DB nu blocăm utilizatorul legitim (fail-open), dar logăm.
        console.error("[ratelimit] DB error:", err.message);
        return { allowed: true, count: 0, limit, retryAfter: 0 };
    }

    // Curățare oportunistă (probabilistică) a ferestrelor vechi.
    if (Math.random() < 0.02) {
        sql`DELETE FROM rate_limits WHERE window_start < now() - interval '2 hours'`.catch(() => {});
    }

    const resetMs = windowStart.getTime() + winMs;
    return {
        allowed: count <= limit,
        count,
        limit,
        retryAfter: Math.max(1, Math.ceil((resetMs - nowMs) / 1000)),
    };
}

/**
 * Verifică și, dacă e depășit, trimite 429 și returnează true (=> handler-ul se oprește).
 */
export async function enforceRateLimit(res, bucket, limit, windowSeconds) {
    const r = await rateLimit(bucket, limit, windowSeconds);
    if (!r.allowed) {
        res.setHeader("Retry-After", String(r.retryAfter));
        json(res, 429, { error: "Zu viele Versuche. Bitte später erneut versuchen." });
        return true;
    }
    return false;
}
