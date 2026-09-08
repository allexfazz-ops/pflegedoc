/**
 * lib/tokens.mjs — token-uri single-use pentru e-mail (verificare, reset parolă).
 * Token brut 256-bit; în DB se ține doar sha256(token). TTL implicit 24h.
 */

import { randomBytes, createHash } from "node:crypto";
import { sql } from "./db.mjs";
import { sendEmail, appOrigin } from "./email.mjs";

const sha256hex = (s) => createHash("sha256").update(s).digest("hex");
const randToken = (n = 32) => randomBytes(n).toString("base64url");

const TTL_S = 60 * 60 * 24; // 24h

/** Emite un token nou; invalidează token-urile nefolosite anterioare de același tip. */
export async function issueEmailToken(userId, purpose = "verify_email", ttlS = TTL_S) {
    await sql`
        UPDATE email_tokens SET used_at = now()
        WHERE user_id = ${userId} AND purpose = ${purpose} AND used_at IS NULL
    `;
    const raw = randToken(32);
    await sql`
        INSERT INTO email_tokens (user_id, token_hash, purpose, expires_at)
        VALUES (${userId}, ${sha256hex(raw)}, ${purpose}, now() + ${`${ttlS} seconds`}::interval)
    `;
    // Curățare oportunistă.
    if (Math.random() < 0.05) {
        sql`DELETE FROM email_tokens WHERE expires_at < now() - interval '7 days'`.catch(() => {});
    }
    return raw;
}

/**
 * Consumă un token. @returns {Promise<{userId:string}|null>}
 * Marchează used_at doar dacă e valid, nefolosit și neexpirat.
 */
export async function consumeEmailToken(raw, purpose = "verify_email") {
    if (typeof raw !== "string" || raw.length < 20 || raw.length > 200) return null;
    const rows = await sql`
        UPDATE email_tokens
        SET used_at = now()
        WHERE token_hash = ${sha256hex(raw)}
          AND purpose = ${purpose}
          AND used_at IS NULL
          AND expires_at > now()
        RETURNING user_id
    `;
    return rows.length ? { userId: rows[0].user_id } : null;
}

/** Trimite e-mailul de resetare a parolei. Link: /?reset=<token>. TTL scurt (1h). */
export async function sendPasswordResetEmail(req, user) {
    const raw = await issueEmailToken(user.id, "reset_password", 60 * 60); // 1h
    const url = `${appOrigin(req)}/?reset=${encodeURIComponent(raw)}`;
    const subject = "PflegeDoc – Passwort zurücksetzen";
    const text =
        `Hallo,\n\n` +
        `du hast angefragt, dein PflegeDoc-Passwort zurückzusetzen. Öffne dazu diesen Link:\n\n${url}\n\n` +
        `Der Link ist 1 Stunde gültig. Wenn du das nicht warst, ignoriere diese E-Mail – dein Passwort bleibt unverändert.\n\n` +
        `— PflegeDoc`;
    const html =
        `<p>Hallo,</p>` +
        `<p>du hast angefragt, dein <strong>PflegeDoc</strong>-Passwort zurückzusetzen.</p>` +
        `<p><a href="${url}" style="display:inline-block;padding:10px 18px;background:#0e7490;color:#fff;border-radius:8px;text-decoration:none">Passwort zurücksetzen</a></p>` +
        `<p style="color:#555;font-size:13px">Oder öffne diesen Link: <br>${url}</p>` +
        `<p style="color:#555;font-size:13px">Der Link ist 1 Stunde gültig. Wenn du das nicht warst, ignoriere diese E-Mail.</p>`;
    const res = await sendEmail({ to: user.email, subject, text, html });
    return { ...res, url };
}

/** Trimite e-mailul de verificare. Link-ul deschide /?verify=<token> (ecran cu buton). */
export async function sendVerificationEmail(req, user) {
    const raw = await issueEmailToken(user.id, "verify_email");
    const url = `${appOrigin(req)}/?verify=${encodeURIComponent(raw)}`;
    const subject = "PflegeDoc – E-Mail bestätigen";
    const text =
        `Hallo,\n\n` +
        `bitte bestätige deine E-Mail-Adresse für PflegeDoc, indem du diesen Link öffnest:\n\n${url}\n\n` +
        `Der Link ist 24 Stunden gültig. Wenn du dich nicht registriert hast, ignoriere diese E-Mail.\n\n` +
        `— PflegeDoc`;
    const html =
        `<p>Hallo,</p>` +
        `<p>bitte bestätige deine E-Mail-Adresse für <strong>PflegeDoc</strong>:</p>` +
        `<p><a href="${url}" style="display:inline-block;padding:10px 18px;background:#0e7490;color:#fff;border-radius:8px;text-decoration:none">E-Mail bestätigen</a></p>` +
        `<p style="color:#555;font-size:13px">Oder öffne diesen Link: <br>${url}</p>` +
        `<p style="color:#555;font-size:13px">Der Link ist 24 Stunden gültig. Wenn du dich nicht registriert hast, ignoriere diese E-Mail.</p>`;
    const res = await sendEmail({ to: user.email, subject, text, html });
    return { ...res, url };
}
