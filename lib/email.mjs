/**
 * lib/email.mjs — trimitere e-mail (Resend) cu degradare grațioasă.
 * -----------------------------------------------------------------------------
 * - Dacă RESEND_API_KEY nu e setat  -> „dev mode": logăm mesajul, NU trimitem.
 *   Aplicația funcționează, iar link-ul de verificare e disponibil din
 *   răspunsul /api/auth/register (doar cât timp e-mailul e dezactivat).
 * - Dacă RESEND_API_KEY e setat     -> trimitem real, fără schimbare de cod.
 *
 * Variabile de mediu:
 *   RESEND_API_KEY   cheia de la https://resend.com/api-keys
 *   EMAIL_FROM       ex: "PflegeDoc <noreply@domeniul-tau.de>"
 *                    (necesită un domeniu verificat în Resend; pentru un test
 *                     rapid poți folosi "onboarding@resend.dev", care livrează
 *                     doar către adresa contului tău Resend)
 */

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const EMAIL_FROM = process.env.EMAIL_FROM || "PflegeDoc <onboarding@resend.dev>";

export const emailEnabled = () => Boolean(RESEND_API_KEY);

/**
 * @param {{to:string, subject:string, text:string, html?:string}} msg
 * @returns {Promise<{delivered:boolean, dev?:boolean, error?:string}>}
 */
export async function sendEmail({ to, subject, text, html }) {
    if (!RESEND_API_KEY) {
        console.log(
            `[email:dev] (RESEND_API_KEY nesetat — nu se trimite)\n  to: ${to}\n  subject: ${subject}\n  ${text}`
        );
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
        const body = await r.text().catch(() => "");
        if (!r.ok) {
            console.error("[email] Resend HTTP", r.status, body.slice(0, 400));
            return { delivered: false, error: `HTTP ${r.status}`, detail: body.slice(0, 300) };
        }
        console.log("[email] sent ok:", body.slice(0, 160));
        return { delivered: true, detail: body.slice(0, 160) };
    } catch (err) {
        console.error("[email] send failed:", err.message);
        return { delivered: false, error: "network" };
    }
}

/** Construiește originea aplicației din antetele cererii (fără env suplimentar). */
export function appOrigin(req) {
    const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
    const host = req.headers["x-forwarded-host"] || req.headers.host || "pflegedoc-snowy.vercel.app";
    return `${proto}://${host}`;
}
