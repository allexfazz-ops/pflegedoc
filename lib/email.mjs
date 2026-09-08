/**
 * lib/email.mjs — trimitere e-mail (Resend) cu degradare grațioasă.
 * -----------------------------------------------------------------------------
 * - Dacă RESEND_API_KEY nu e setat  -> „dev mode": logăm mesajul DOAR în afara
 *   producției (NODE_ENV !== "production"), NU trimitem.
 * - Dacă RESEND_API_KEY e setat     -> trimitem real, fără schimbare de cod.
 *
 * Variabile de mediu:
 *   RESEND_API_KEY   cheia de la https://resend.com/api-keys
 *   EMAIL_FROM       ex: "PflegeDoc <noreply@domeniul-tau.de>"
 *   APP_ORIGIN       originea canonică pentru link-urile de securitate
 *                    (verificare / resetare). Ex: https://pflegedoc-snowy.vercel.app
 *                    NU se citește niciodată din anteturi de cerere (F-03).
 *                    Dacă lipsește, se folosește VERCEL_PROJECT_PRODUCTION_URL
 *                    (setată de platformă, nu de client).
 *   DEV_APP_ORIGIN   opțional, pentru rulare locală pe alt port.
 */

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const EMAIL_FROM = process.env.EMAIL_FROM || "PflegeDoc <onboarding@resend.dev>";

export const emailEnabled = () => Boolean(RESEND_API_KEY);

/** true doar în producție (Vercel setează NODE_ENV=production la orice deploy). */
export function isProduction() {
    return process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";
}

/**
 * @param {{to:string, subject:string, text:string, html?:string}} msg
 * @returns {Promise<{delivered:boolean, dev?:boolean, error?:string}>}
 */
export async function sendEmail({ to, subject, text, html }) {
    if (!RESEND_API_KEY) {
        // Fără provider configurat: în afara producției afișăm mesajul pentru
        // testare locală; în producție NU logăm nimic cu token.
        if (!isProduction()) {
            console.log(`[email:dev] (RESEND_API_KEY nesetat)\n  to: ${to}\n  subject: ${subject}\n  ${text}`);
        } else {
            console.error("[email] RESEND_API_KEY fehlt in Produktion — E-Mail nicht gesendet.");
        }
        return { delivered: false, dev: true };
    }
    try {
        const r = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${RESEND_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, text, html: html || undefined }),
        });
        if (!r.ok) {
            // NU logăm corpul răspunsului (poate conține adresa destinatarului).
            console.error("[email] Resend delivery failed, HTTP", r.status);
            return { delivered: false, error: `HTTP ${r.status}` };
        }
        console.log("[email] delivered");
        return { delivered: true };
    } catch (err) {
        console.error("[email] send failed:", err.name || "error");
        return { delivered: false, error: "network" };
    }
}

/**
 * Originea canonică a aplicației pentru link-urile de securitate.
 * Sursă: APP_ORIGIN -> VERCEL_PROJECT_PRODUCTION_URL (platformă) -> dev fallback.
 * NICIODATĂ din anteturi de cerere (F-03). Aruncă dacă e neconfigurată în prod.
 * Parametrul `req` e ignorat intenționat (păstrat pt. compatibilitatea apelurilor).
 */
export function appOrigin(_req) {
    let raw = process.env.APP_ORIGIN || "";
    if (!raw && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
        raw = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
    }
    if (!raw && !isProduction()) {
        raw = process.env.DEV_APP_ORIGIN || "http://localhost:3000";
    }
    raw = String(raw).trim().replace(/\/+$/, "");
    if (!raw) {
        throw new Error(
            "APP_ORIGIN ist nicht konfiguriert (weder APP_ORIGIN noch VERCEL_PROJECT_PRODUCTION_URL gesetzt)."
        );
    }
    let u;
    try {
        u = new URL(raw);
    } catch {
        throw new Error("APP_ORIGIN ist keine gültige URL.");
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") {
        throw new Error("APP_ORIGIN: nur http/https erlaubt.");
    }
    if (isProduction() && u.protocol !== "https:") {
        throw new Error("APP_ORIGIN muss in Produktion https sein.");
    }
    return u.origin; // normalizat: schemă + host, fără slash final, fără path
}
