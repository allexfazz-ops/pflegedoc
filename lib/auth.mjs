/**
 * lib/auth.mjs — parole (scrypt), sesiuni stateful, CSRF.
 * -----------------------------------------------------------------------------
 * - Parole: crypto.scrypt (KDF built-in Node), salt per user, comparare
 *   timing-safe. Niciodată plain text, niciodată returnate/loguite.
 * - Sesiuni: token opac de 32B în cookie HttpOnly/Secure/SameSite=Lax.
 *   În DB se ține DOAR sha256(token). Logout = ștergerea rândului.
 * - CSRF: token per-sesiune (double-submit) cerut ca header X-CSRF-Token
 *   la toate operațiile de scriere.
 */

import { randomBytes, createHash, scrypt as _scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { sql } from "./db.mjs";
import { parseCookies, serializeCookie, isLocalHost, clientIp } from "./http.mjs";

const scrypt = promisify(_scrypt);

const SESSION_COOKIE = "pd_session";
export const SESSION_TTL_S = 60 * 60 * 24 * 30; // 30 zile
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32, maxmem: 96 * 1024 * 1024 };

/* ----------------------------- parole ----------------------------- */

export async function hashPassword(password) {
    const salt = randomBytes(16);
    const dk = await scrypt(password, salt, SCRYPT.keylen, {
        N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem,
    });
    return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${Buffer.from(dk).toString("base64")}`;
}

export async function verifyPassword(password, stored) {
    try {
        const [scheme, N, r, p, saltB64, hashB64] = String(stored).split("$");
        if (scheme !== "scrypt") return false;
        const salt = Buffer.from(saltB64, "base64");
        const expected = Buffer.from(hashB64, "base64");
        const dk = await scrypt(password, salt, expected.length, {
            N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
        });
        return dk.length === expected.length && timingSafeEqual(dk, expected);
    } catch {
        return false;
    }
}

// Hash „momeală" ca login-ul pentru un email inexistent să dureze la fel
// (anti timing enumeration). Generat o dată per proces.
let _dummyHash = null;
export async function dummyVerify(password) {
    if (!_dummyHash) _dummyHash = await hashPassword(randomBytes(12).toString("hex"));
    await verifyPassword(password, _dummyHash);
    return false;
}

/* ---------------------------- sesiuni ---------------------------- */

const sha256hex = (s) => createHash("sha256").update(s).digest("hex");
const randToken = (n = 32) => randomBytes(n).toString("base64url");

/** Creează o sesiune pentru user și returnează tokenul brut + csrf. */
export async function createSession(userId, req) {
    const token = randToken(32);
    const csrf = randToken(24);
    const ua = String(req.headers["user-agent"] || "").slice(0, 400) || null;
    const ip = clientIp(req);
    await sql`
        INSERT INTO sessions (user_id, token_hash, csrf_token, expires_at, user_agent, ip)
        VALUES (${userId}, ${sha256hex(token)}, ${csrf},
                now() + ${`${SESSION_TTL_S} seconds`}::interval, ${ua}, ${ip}::inet)
    `;
    return { token, csrf };
}

/** Șterge sesiunea după tokenul brut din cookie. */
export async function destroySession(req) {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) {
        try { await sql`DELETE FROM sessions WHERE token_hash = ${sha256hex(token)}`; }
        catch (e) { console.error("[auth] destroySession:", e.message); }
    }
}

/** Șterge toate sesiunile unui user (ex. „logout peste tot"). */
export async function destroyAllSessions(userId) {
    await sql`DELETE FROM sessions WHERE user_id = ${userId}`;
}

/**
 * Citește sesiunea curentă din cookie și returnează { user, session } sau null.
 * NU trimite răspuns. Reîmprospătează last_seen_at cel mult o dată/oră.
 */
export async function getAuth(req) {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (!token || token.length < 20) return null;
    let rows;
    try {
        rows = await sql`
            SELECT s.id AS session_id, s.csrf_token, s.expires_at, s.last_seen_at,
                   u.id AS user_id, u.email, u.ui_language, u.theme, u.created_at
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = ${sha256hex(token)}
              AND s.expires_at > now()
            LIMIT 1
        `;
    } catch (e) {
        console.error("[auth] getAuth:", e.message);
        return null;
    }
    if (!rows.length) return null;
    const row = rows[0];

    // last_seen_at throttled (evită un write per request).
    if (Date.now() - new Date(row.last_seen_at).getTime() > 3600_000) {
        sql`UPDATE sessions SET last_seen_at = now() WHERE id = ${row.session_id}`.catch(() => {});
    }

    return {
        user: {
            id: row.user_id,
            email: row.email,
            ui_language: row.ui_language,
            theme: row.theme,
            created_at: row.created_at,
        },
        session: { id: row.session_id, csrf: row.csrf_token, expires_at: row.expires_at },
    };
}

/** Verifică tokenul CSRF din header contra celui din sesiune (timing-safe). */
export function checkCsrf(req, session) {
    const header = req.headers["x-csrf-token"];
    if (typeof header !== "string" || !session?.csrf) return false;
    const a = Buffer.from(header);
    const b = Buffer.from(session.csrf);
    return a.length === b.length && timingSafeEqual(a, b);
}

/* ---------------------------- cookies ---------------------------- */

export function sessionCookie(token, req) {
    return serializeCookie(SESSION_COOKIE, token, {
        maxAge: SESSION_TTL_S,
        httpOnly: true,
        secure: !isLocalHost(req),
        sameSite: "Lax",
        path: "/",
    });
}

export function clearSessionCookie(req) {
    return serializeCookie(SESSION_COOKIE, "", {
        maxAge: 0,
        httpOnly: true,
        secure: !isLocalHost(req),
        sameSite: "Lax",
        path: "/",
    });
}

export { SESSION_COOKIE };
