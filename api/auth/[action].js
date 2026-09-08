/**
 * /api/auth/:action  — dispatcher unic pentru toate rutele de autentificare.
 * -----------------------------------------------------------------------------
 * Consolidat într-un singur fișier ca să rămânem sub limita de funcții
 * serverless a planului Vercel Hobby (12).
 *
 *   POST /api/auth/register              { email, password }
 *   POST /api/auth/login                 { email, password }
 *   POST /api/auth/logout                (cookie + CSRF)
 *   GET  /api/auth/me
 *   POST /api/auth/verify                { token }
 *   POST /api/auth/resend-verification   (cookie + CSRF)
 *   POST /api/auth/forgot-password       { email }
 *   POST /api/auth/reset-password        { token, password }
 *
 * Toată logica de securitate este în lib/ (parametrizat, scrypt, sesiuni
 * stateful, CSRF, rate limiting). Aici doar orchestrăm.
 */

import { ensureSchema, sql } from "../../lib/db.mjs";
import {
    json, fail, methodNotAllowed, readJson, clientIp, appendCookie,
} from "../../lib/http.mjs";
import { enforceRateLimit } from "../../lib/ratelimit.mjs";
import { isEmail, normEmail, checkPassword } from "../../lib/validate.mjs";
import {
    hashPassword, verifyPassword, dummyVerify,
    createSession, sessionCookie, clearSessionCookie,
    getAuth, checkCsrf, destroySession, destroyAllSessions,
    requireAuth, requireCsrf,
} from "../../lib/auth.mjs";
import {
    sendVerificationEmail, sendPasswordResetEmail, consumeEmailToken,
} from "../../lib/tokens.mjs";
import { emailEnabled, isProduction } from "../../lib/email.mjs";
import { securityEvent } from "../../lib/securitylog.mjs";

const GENERIC_LOGIN = "E-Mail oder Passwort ist falsch.";

// Link-uri/erori de e-mail cu potențial de token: DOAR în afara producției (F-04).
const allowDevEmailHints = () => !isProduction();

/* --------------------------------- register -------------------------------- */
async function register(req, res) {
    if (methodNotAllowed(req, res, ["POST"])) return;
    try {
        await ensureSchema();
        if (await enforceRateLimit(res, `register:ip:${clientIp(req)}`, 10, 3600, req)) return;

        let body;
        try { body = await readJson(req, { maxBytes: 8 * 1024 }); }
        catch (e) { return fail(res, e.status || 400, e.message || "Ungültige Anfrage."); }

        const email = normEmail(body.email);
        if (!isEmail(email)) return fail(res, 400, "Bitte eine gültige E-Mail-Adresse angeben.");
        const pw = checkPassword(body.password);
        if (!pw.ok) return fail(res, 400, pw.error);
        securityEvent("register_attempt", req, { outcome: "ok" });

        // Timing: hash-uim mereu, chiar dacă e-mailul există deja.
        const passwordHash = await hashPassword(body.password);

        const existing = await sql`SELECT 1 FROM users WHERE email = ${email} LIMIT 1`;
        if (existing.length) return json(res, 200, { ok: true, created: false });

        let userRows;
        try {
            userRows = await sql`
                INSERT INTO users (email, password_hash)
                VALUES (${email}, ${passwordHash})
                RETURNING id, email, ui_language, theme, created_at
            `;
        } catch (e) {
            if (String(e.message || "").includes("users_email_key") || e.code === "23505") {
                return json(res, 200, { ok: true, created: false });
            }
            throw e;
        }

        const user = userRows[0];
        const { token, csrf } = await createSession(user.id, req);
        appendCookie(res, sessionCookie(token, req));

        let emailSent = false, devVerifyUrl, emailError;
        try {
            const r = await sendVerificationEmail(req, user);
            emailSent = !!r.delivered;
            if (allowDevEmailHints() && (!emailEnabled() || !r.delivered)) devVerifyUrl = r.url;
        } catch (e) {
            console.error("[register] verification email:", e.name || "error");
            if (allowDevEmailHints()) emailError = String(e.message).slice(0, 200);
        }

        return json(res, 201, {
            ok: true, created: true,
            user: {
                id: user.id, email: user.email,
                ui_language: user.ui_language, theme: user.theme, email_verified: false,
                display_name: null,
            },
            csrfToken: csrf, emailSent,
            ...(devVerifyUrl ? { devVerifyUrl } : {}),
            ...(emailError ? { emailError } : {}),
        });
    } catch (err) {
        return fail(res, 500, "Registrierung derzeit nicht möglich.", err);
    }
}

/* ---------------------------------- login --------------------------------- */
async function login(req, res) {
    if (methodNotAllowed(req, res, ["POST"])) return;
    try {
        await ensureSchema();
        if (await enforceRateLimit(res, `login:ip:${clientIp(req)}`, 10, 900, req)) return;

        let body;
        try { body = await readJson(req, { maxBytes: 8 * 1024 }); }
        catch (e) { return fail(res, e.status || 400, e.message || "Ungültige Anfrage."); }

        const email = normEmail(body.email);
        const password = typeof body.password === "string" ? body.password : "";

        if (!isEmail(email) || !password || password.length > 200) {
            await dummyVerify(password || "x");
            securityEvent("login_failure", req, { outcome: "invalid_input" });
            return fail(res, 401, GENERIC_LOGIN);
        }
        if (await enforceRateLimit(res, `login:email:${email}`, 20, 900, req)) return;

        const rows = await sql`SELECT id, password_hash FROM users WHERE email = ${email} LIMIT 1`;
        if (!rows.length) {
            await dummyVerify(password);
            securityEvent("login_failure", req, { outcome: "bad_credentials" });
            return fail(res, 401, GENERIC_LOGIN);
        }

        const ok = await verifyPassword(password, rows[0].password_hash);
        if (!ok) {
            securityEvent("login_failure", req, { outcome: "bad_credentials", userId: rows[0].id });
            return fail(res, 401, GENERIC_LOGIN);
        }

        const { token, csrf } = await createSession(rows[0].id, req);
        appendCookie(res, sessionCookie(token, req));
        securityEvent("login_success", req, { outcome: "ok", userId: rows[0].id });

        const u = await sql`
            SELECT id, email, ui_language, theme, created_at, email_verified, display_name
            FROM users WHERE id = ${rows[0].id}
        `;
        return json(res, 200, {
            ok: true,
            user: {
                id: u[0].id, email: u[0].email,
                ui_language: u[0].ui_language, theme: u[0].theme, created_at: u[0].created_at,
                email_verified: u[0].email_verified === true,
                display_name: u[0].display_name ?? null,
            },
            csrfToken: csrf,
        });
    } catch (err) {
        return fail(res, 500, "Anmeldung derzeit nicht möglich.", err);
    }
}

/* ---------------------------------- logout -------------------------------- */
async function logout(req, res) {
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
        appendCookie(res, clearSessionCookie(req));
        return fail(res, 500, "Abmeldung teilweise fehlgeschlagen.", err);
    }
}

/* ------------------------------------ me --------------------------------- */
async function me(req, res) {
    if (methodNotAllowed(req, res, ["GET"])) return;
    try {
        await ensureSchema();
        const auth = await getAuth(req);
        if (!auth) return json(res, 200, { authenticated: false });
        return json(res, 200, {
            authenticated: true,
            user: {
                id: auth.user.id, email: auth.user.email,
                ui_language: auth.user.ui_language, theme: auth.user.theme,
                created_at: auth.user.created_at, email_verified: auth.user.email_verified,
                display_name: auth.user.display_name ?? null,
            },
            csrfToken: auth.session.csrf,
        });
    } catch (err) {
        return fail(res, 500, "Sitzungsprüfung fehlgeschlagen.", err);
    }
}

/* ---------------------------------- verify ------------------------------- */
async function verify(req, res) {
    if (methodNotAllowed(req, res, ["POST"])) return;
    try {
        await ensureSchema();
        if (await enforceRateLimit(res, `verify:ip:${clientIp(req)}`, 20, 3600, req)) return;

        let body;
        try { body = await readJson(req, { maxBytes: 4 * 1024 }); }
        catch (e) { return fail(res, e.status || 400, e.message || "Ungültige Anfrage."); }

        const consumed = await consumeEmailToken(body.token, "verify_email");
        if (!consumed) {
            securityEvent("verification_failure", req, { outcome: "bad_token" });
            return fail(res, 400, "Der Bestätigungslink ist ungültig oder abgelaufen.");
        }

        await sql`
            UPDATE users SET email_verified = true, email_verified_at = now()
            WHERE id = ${consumed.userId} AND email_verified = false
        `;
        securityEvent("verification_confirmed", req, { outcome: "ok", userId: consumed.userId });
        return json(res, 200, { ok: true });
    } catch (err) {
        return fail(res, 500, "Bestätigung derzeit nicht möglich.", err);
    }
}

/* -------------------------- resend-verification ------------------------- */
async function resendVerification(req, res) {
    if (methodNotAllowed(req, res, ["POST"])) return;
    try {
        await ensureSchema();
        const auth = await requireAuth(req, res);
        if (!auth) return;
        if (!requireCsrf(req, res, auth.session)) return;
        if (await enforceRateLimit(res, `resendverify:user:${auth.user.id}`, 3, 3600, req)) return;

        const rows = await sql`SELECT id, email, email_verified FROM users WHERE id = ${auth.user.id}`;
        const u = rows[0];
        if (!u) return fail(res, 404, "Konto nicht gefunden.");
        if (u.email_verified) return json(res, 200, { ok: true, alreadyVerified: true });

        securityEvent("verification_requested", req, { outcome: "ok", userId: u.id });

        let emailSent = false, devVerifyUrl, emailError;
        try {
            const r = await sendVerificationEmail(req, u);
            emailSent = !!r.delivered;
            if (allowDevEmailHints() && (!emailEnabled() || !r.delivered)) devVerifyUrl = r.url;
        } catch (e) {
            console.error("[resend-verification]", e.name || "error");
            if (allowDevEmailHints()) emailError = String(e.message).slice(0, 200);
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

/* --------------------------- forgot-password --------------------------- */
async function forgotPassword(req, res) {
    if (methodNotAllowed(req, res, ["POST"])) return;
    try {
        await ensureSchema();
        if (await enforceRateLimit(res, `forgot:ip:${clientIp(req)}`, 5, 3600, req)) return;

        let body;
        try { body = await readJson(req, { maxBytes: 4 * 1024 }); }
        catch (e) { return fail(res, e.status || 400, e.message || "Ungültige Anfrage."); }

        const email = normEmail(body.email);
        if (!isEmail(email)) return json(res, 200, { ok: true });
        if (await enforceRateLimit(res, `forgot:email:${email}`, 3, 3600, req)) return;

        securityEvent("password_reset_requested", req, { outcome: "ok" });

        const rows = await sql`SELECT id, email FROM users WHERE email = ${email} LIMIT 1`;
        let devResetUrl;
        if (rows.length) {
            try {
                const r = await sendPasswordResetEmail(req, rows[0]);
                if (allowDevEmailHints() && (!emailEnabled() || !r.delivered)) devResetUrl = r.url;
            } catch (e) {
                console.error("[forgot-password] email:", e.name || "error");
            }
        }
        // Răspuns identic indiferent dacă adresa există (anti-enumerare).
        return json(res, 200, { ok: true, ...(devResetUrl ? { devResetUrl } : {}) });
    } catch (err) {
        return fail(res, 500, "Anfrage derzeit nicht möglich.", err);
    }
}

/* ---------------------------- reset-password -------------------------- */
async function resetPassword(req, res) {
    if (methodNotAllowed(req, res, ["POST"])) return;
    try {
        await ensureSchema();
        if (await enforceRateLimit(res, `reset:ip:${clientIp(req)}`, 20, 3600, req)) return;

        let body;
        try { body = await readJson(req, { maxBytes: 8 * 1024 }); }
        catch (e) { return fail(res, e.status || 400, e.message || "Ungültige Anfrage."); }

        const pw = checkPassword(body.password);
        if (!pw.ok) return fail(res, 400, pw.error);

        const consumed = await consumeEmailToken(body.token, "reset_password");
        if (!consumed) {
            securityEvent("password_reset_failure", req, { outcome: "bad_token" });
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
        await destroyAllSessions(consumed.userId);
        securityEvent("password_reset_success", req, { outcome: "ok", userId: consumed.userId });
        return json(res, 200, { ok: true });
    } catch (err) {
        return fail(res, 500, "Zurücksetzen derzeit nicht möglich.", err);
    }
}

/* --------------------------- delete-account -------------------------- */
async function deleteAccount(req, res) {
    if (methodNotAllowed(req, res, ["POST"])) return;
    try {
        await ensureSchema();
        const auth = await requireAuth(req, res);
        if (!auth) return;
        if (!requireCsrf(req, res, auth.session)) return;
        if (await enforceRateLimit(res, `deleteacct:ip:${clientIp(req)}`, 5, 3600, req)) return;
        if (await enforceRateLimit(res, `deleteacct:user:${auth.user.id}`, 5, 3600, req)) return;

        let body;
        try { body = await readJson(req, { maxBytes: 4 * 1024 }); }
        catch (e) { return fail(res, e.status || 400, e.message || "Ungültige Anfrage."); }

        const password = typeof body.password === "string" ? body.password : "";
        if (!password) return fail(res, 400, "Bitte gib dein Passwort zur Bestätigung ein.");

        const rows = await sql`SELECT password_hash FROM users WHERE id = ${auth.user.id} LIMIT 1`;
        if (!rows.length) {
            appendCookie(res, clearSessionCookie(req));
            return json(res, 200, { ok: true });
        }
        const ok = await verifyPassword(password, rows[0].password_hash);
        if (!ok) {
            securityEvent("account_delete_failure", req, { outcome: "bad_password", userId: auth.user.id });
            return fail(res, 403, "Passwort ist falsch.");
        }

        // ON DELETE CASCADE șterge automat sessions, activities, email_tokens.
        await sql`DELETE FROM users WHERE id = ${auth.user.id}`;
        appendCookie(res, clearSessionCookie(req));
        securityEvent("account_deleted", req, { outcome: "ok", userId: auth.user.id });
        return json(res, 200, { ok: true });
    } catch (err) {
        return fail(res, 500, "Konto konnte nicht gelöscht werden.", err);
    }
}

/* -------------------------------- dispatch ------------------------------- */
const ACTIONS = {
    "register": register,
    "login": login,
    "logout": logout,
    "me": me,
    "verify": verify,
    "resend-verification": resendVerification,
    "forgot-password": forgotPassword,
    "reset-password": resetPassword,
    "delete-account": deleteAccount,
};

export default async function handler(req, res) {
    const action = req.query && req.query.action;
    const fn = ACTIONS[action];
    if (!fn) return json(res, 404, { error: "Nicht gefunden." });
    return fn(req, res);
}
