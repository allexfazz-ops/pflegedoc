/**
 * lib/securitylog.mjs — log de securitate minimal, DOAR metadate.
 * -----------------------------------------------------------------------------
 * Se scrie prin `console.log("[sec]", <json>)` -> ajunge în Vercel Function Logs
 * (fără platformă externă / cost). Fiecare linie e un obiect JSON stabil.
 *
 * REGULĂ ABSOLUTĂ — aici NU ajung NICIODATĂ:
 *   note de îngrijire, documentație generată, Pflegeplanung, nume/ID/note de
 *   pacient, prompt-uri sau ieșiri AI, parole, token-uri de sesiune/CSRF/reset/
 *   verificare, chei API, adrese de e-mail, corpuri de cerere.
 *
 * IP-ul NU se scrie brut: se scrie doar un HMAC-SHA256 trunchiat, cu o sare
 * server-side (SECURITY_LOG_SALT). Sarea nu e logată și nu e reversibilă fără ea.
 */

import { createHmac } from "node:crypto";
import { clientIp } from "./http.mjs";

// Sare pentru pseudonimizarea IP. Ideal: SECURITY_LOG_SALT dedicat.
// Fallback: alt secret server-side deja prezent (nu e expus nicăieri).
const IP_SALT =
    process.env.SECURITY_LOG_SALT ||
    process.env.ENGINE_TEST_SECRET ||
    process.env.RESEND_API_KEY ||
    "pflegedoc-dev-only-salt";

function hashIp(ip) {
    if (!ip || ip === "0.0.0.0" || ip === "::1" || ip === "127.0.0.1") return null;
    try {
        return createHmac("sha256", IP_SALT).update(String(ip)).digest("hex").slice(0, 16);
    } catch {
        return null;
    }
}

// Câmpuri interzise într-un `detail` — nu trebuie să conțină niciodată conținut.
// Acceptăm doar etichete scurte, tehnice (ex. "csrf", "email_unverified",
// "login:ip", "generate:user"). Tăiem la 60 și eliminăm ce arată a e-mail / uuid / IP.
function safeDetail(v) {
    if (v == null) return null;
    let s = String(v).slice(0, 60);
    if (/@/.test(s)) return "redacted";
    if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(s)) return "redacted";
    if (/\b\d{1,3}(\.\d{1,3}){3}\b/.test(s)) return "redacted";
    return s;
}

/**
 * Emite un eveniment de securitate. Nu aruncă niciodată.
 * @param {string} event  ex: "login_failure", "authorization_failure"
 * @param {object|null} req  cererea (pentru ip_hash + route); poate fi null
 * @param {{userId?:string|null, route?:string, outcome?:string, detail?:string}} [extra]
 */
export function securityEvent(event, req, extra = {}) {
    try {
        const rec = {
            ts: new Date().toISOString(),
            sec: true,
            event: String(event).slice(0, 40),
            outcome: extra.outcome ? String(extra.outcome).slice(0, 24) : null,
            route:
                extra.route ||
                (req && typeof req.url === "string" ? req.url.split("?")[0].slice(0, 80) : null),
            userId: extra.userId ? String(extra.userId).slice(0, 40) : null,
            ip_hash: req ? hashIp(clientIp(req)) : null,
            detail: safeDetail(extra.detail),
        };
        console.log("[sec]", JSON.stringify(rec));
    } catch {
        /* logarea de securitate NU trebuie să rupă vreodată cererea */
    }
}
