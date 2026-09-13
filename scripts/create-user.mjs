/**
 * scripts/create-user.mjs — creează un cont direct în baza de date (invite-only).
 * -----------------------------------------------------------------------------
 * Folosit când REGISTRATION_MODE=invite_only — administratorul creează conturile,
 * userii nu se pot înregistra singuri prin /api/auth/register.
 *
 * Parola e hash-uită cu EXACT același `hashPassword` (scrypt) din lib/auth.mjs,
 * ca formatul stocat să fie compatibil cu login-ul normal. Contul e creat cu
 * email_verified = true (nu mai trecem prin flow-ul de verificare prin e-mail).
 *
 * Rulare (local, cu variabilele din .env.local):
 *   node --env-file=.env.local scripts/create-user.mjs --email pacient1@exemplu.de
 *   node --env-file=.env.local scripts/create-user.mjs --email x@y.de --password "ParolaMea123"
 *
 * Dacă --password lipsește, se generează automat o parolă temporară aleatoare,
 * afișată o singură dată în consolă (nu e salvată nicăieri altundeva).
 */

import { randomBytes } from "node:crypto";
import { ensureSchema, sql, hasDatabase } from "../lib/db.mjs";
import { hashPassword } from "../lib/auth.mjs";
import { isEmail, normEmail, checkPassword } from "../lib/validate.mjs";

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--email") out.email = argv[++i];
        else if (a === "--password") out.password = argv[++i];
    }
    return out;
}

function generateTempPassword() {
    // 16 caractere, alfabet fără caractere ambigue (0/O, 1/l/I).
    const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    const bytes = randomBytes(16);
    let out = "";
    for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
}

async function main() {
    const { email: rawEmail, password: rawPassword } = parseArgs(process.argv.slice(2));

    if (!hasDatabase()) {
        console.error("Nicio DATABASE_URL în mediu. Rulează cu: node --env-file=.env.local scripts/create-user.mjs ...");
        process.exit(1);
    }
    if (!rawEmail) {
        console.error("Lipsește --email. Exemplu: node --env-file=.env.local scripts/create-user.mjs --email x@y.de");
        process.exit(1);
    }

    const email = normEmail(rawEmail);
    if (!isEmail(email)) {
        console.error("E-mail invalid:", rawEmail);
        process.exit(1);
    }

    const generated = !rawPassword;
    const password = rawPassword || generateTempPassword();
    const pw = checkPassword(password);
    if (!pw.ok) {
        console.error("Parolă invalidă:", pw.error);
        process.exit(1);
    }

    await ensureSchema();

    const existing = await sql`SELECT id FROM users WHERE email = ${email} LIMIT 1`;
    if (existing.length) {
        console.error(`Există deja un cont cu adresa ${email} (id ${existing[0].id}). Nimic creat.`);
        process.exit(1);
    }

    const passwordHash = await hashPassword(password);
    const rows = await sql`
        INSERT INTO users (email, password_hash, email_verified, email_verified_at)
        VALUES (${email}, ${passwordHash}, true, now())
        RETURNING id, email, created_at
    `;
    const user = rows[0];

    console.log("Cont creat cu succes:");
    console.log("  ID:        ", user.id);
    console.log("  E-mail:    ", user.email);
    console.log("  Creat la:  ", user.created_at);
    if (generated) {
        console.log("  Parolă temporară (afișată o singură dată, notează-o acum):");
        console.log("   ", password);
    } else {
        console.log("  Parolă:     (cea furnizată prin --password)");
    }
    process.exit(0);
}

main().catch((err) => {
    console.error("Eșec la crearea contului:", err.message);
    process.exit(1);
});
