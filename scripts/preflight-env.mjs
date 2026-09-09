/**
 * scripts/preflight-env.mjs — verificare read-only a variabilelor de mediu.
 * -----------------------------------------------------------------------------
 * NU citește baza de date. NU face niciun request de rețea. NU afișează
 * NICIODATĂ valoarea unei variabile — doar SET / MISSING (+ lungimea, ca
 * indiciu grosier că nu e un string gol accidental).
 *
 * Rulare:
 *   Local:   node --env-file=.env.local scripts/preflight-env.mjs
 *   Vercel:  vercel env pull .env.production.local && \
 *            node --env-file=.env.production.local scripts/preflight-env.mjs
 *
 * Cod de ieșire: 0 dacă toate variabilele OBLIGATORII sunt setate, altfel 1.
 */

const has = (name) => {
    const v = process.env[name];
    return typeof v === "string" && v.trim().length > 0;
};
const mark = (ok) => (ok ? "SET    " : "MISSING");
const len = (name) => (has(name) ? `(${process.env[name].trim().length} chars)` : "");

// VERCEL_ENV: "production" | "preview" | "development" | (local: undefined)
const vercelEnv = process.env.VERCEL_ENV || "(local / not on Vercel)";
const isProd =
    process.env.NODE_ENV === "production" && process.env.VERCEL_ENV === "production";

console.log("PflegeDoc — preflight environment check");
console.log("=======================================");
console.log(`VERCEL_ENV                       : ${vercelEnv}`);
console.log(`NODE_ENV                         : ${process.env.NODE_ENV || "(unset)"}`);
console.log(
    `VERCEL_PROJECT_PRODUCTION_URL    : ${mark(has("VERCEL_PROJECT_PRODUCTION_URL"))}  (platform-set; APP_ORIGIN fallback)`
);
console.log("");

/* --- Obligatorii pentru orice deploy funcțional ------------------------- */
const REQUIRED = [
    ["GEMINI_API_KEY", "Fără el /api/generate răspunde 500. Generarea nu funcționează."],
    ["APP_ORIGIN", "Link-uri de verificare/resetare. Fallback: VERCEL_PROJECT_PRODUCTION_URL. Dacă lipsesc AMBELE -> eroare la trimiterea e-mailului."],
];
// DATABASE_URL sau oricare alias acceptat de lib/db.mjs.
const DB_ALIASES = [
    "DATABASE_URL",
    "DATABASE_POSTGRES_URL",
    "POSTGRES_URL",
    "POSTGRES_PRISMA_URL",
];

console.log("OBLIGATORII");
console.log("-----------");
let missingRequired = 0;

for (const [name, note] of REQUIRED) {
    const ok = has(name);
    if (!ok) missingRequired++;
    console.log(`  ${name.padEnd(30)}: ${mark(ok)} ${len(name)}`);
    if (!ok) console.log(`      ! ${note}`);
}

const dbHit = DB_ALIASES.find(has);
if (!dbHit) missingRequired++;
console.log(
    `  ${"DATABASE_URL".padEnd(30)}: ${mark(Boolean(dbHit))} ${
        dbHit ? `(via ${dbHit})` : ""
    }`
);
if (!dbHit) {
    console.log(
        "      ! Fără DB: login/istoric/pacienți nu funcționează; /api/generate -> 503."
    );
}

/* --- Recomandate (nu blochează, dar importante în producție) ----------- */
console.log("");
console.log("RECOMANDATE");
console.log("----------");
const RECOMMENDED = [
    ["SECURITY_LOG_SALT", "Pseudonimizarea IP în logul de securitate. Fără el se cade pe RESEND_API_KEY; dacă nici acela nu există, ip_hash = null (fără pseudonim)."],
    ["RESEND_API_KEY", "Trimiterea reală a e-mailurilor. Fără el, în producție verificarea prin e-mail nu poate fi finalizată de utilizator."],
];
for (const [name, note] of RECOMMENDED) {
    const ok = has(name);
    console.log(`  ${name.padEnd(30)}: ${mark(ok)} ${len(name)}`);
    if (!ok) console.log(`      ~ ${note}`);
}

/* --- Opționale -------------------------------------------------------- */
console.log("");
console.log("OPȚIONALE");
console.log("---------");
for (const name of ["GEMINI_MODEL", "EMAIL_FROM", "DEV_APP_ORIGIN"]) {
    console.log(`  ${name.padEnd(30)}: ${mark(has(name))} ${len(name)}`);
}

/* --- Trebuie să LIPSEASCĂ în producție -------------------------------- */
console.log("");
console.log("NU TREBUIE SETAT ÎN PRODUCȚIE");
console.log("----------------------------");
const engineTestSet = has("ENGINE_TEST_SECRET");
console.log(`  ${"ENGINE_TEST_SECRET".padEnd(30)}: ${engineTestSet ? "SET" : "MISSING"}`);
if (engineTestSet && isProd) {
    console.log(
        "      ! Setat în producție. Bypass-ul e refuzat structural (NODE_ENV/VERCEL_ENV=production),"
    );
    console.log(
        "        deci nu creează o gaură de securitate, dar nu are niciun rost aici — elimină-l."
    );
} else if (engineTestSet) {
    console.log("      ~ OK doar dacă acesta este un mediu de dezvoltare / `vercel dev`.");
}

console.log("");
if (missingRequired > 0) {
    console.log(`REZULTAT: ${missingRequired} variabil(e) OBLIGATORII lipsesc — BLOCAT.`);
    process.exit(1);
}
console.log("REZULTAT: toate variabilele obligatorii sunt setate.");
process.exit(0);
