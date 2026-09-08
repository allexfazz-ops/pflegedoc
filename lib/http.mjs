/**
 * lib/http.mjs — utilitare HTTP comune pentru funcțiile Vercel
 * -----------------------------------------------------------------------------
 * Fără framework. Doar helpers pentru: răspuns JSON, guard de metodă, parsare
 * body cu limită de mărime, extragere IP client, cookies, erori sanitizate.
 */

/** Trimite JSON cu status. */
export function json(res, status, obj) {
    res.status(status);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(obj));
}

/** Eroare publică generică + log intern (fără stack/SQL către client). */
export function fail(res, status, publicMessage, internalErr) {
    if (internalErr) {
        const msg = internalErr instanceof Error ? internalErr.stack || internalErr.message : String(internalErr);
        console.error(`[${status}] ${publicMessage} ::`, msg);
    }
    json(res, status, { error: publicMessage });
}

/** CORS minim (același origin în producție) + preflight. Return true dacă a răspuns deja. */
export function cors(req, res, methods = ["GET", "POST"]) {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", [...methods, "OPTIONS"].join(", "));
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-CSRF-Token");
    res.setHeader("Vary", "Origin");
    if (req.method === "OPTIONS") {
        res.status(204).end();
        return true;
    }
    return false;
}

/** Guard de metodă. Return true dacă a răspuns 405. */
export function methodNotAllowed(req, res, allowed) {
    if (allowed.includes(req.method)) return false;
    res.setHeader("Allow", allowed.join(", "));
    json(res, 405, { error: "Methode nicht erlaubt." });
    return true;
}

/** Parsează body JSON. Aruncă {status,message} la body invalid / prea mare. */
export async function readJson(req, { maxBytes = 100 * 1024 } = {}) {
    // Vercel poate pre-parsa deja req.body pentru application/json.
    if (req.body && typeof req.body === "object") return req.body;

    let raw = "";
    if (typeof req.body === "string") {
        raw = req.body;
    } else {
        raw = await new Promise((resolve, reject) => {
            let data = "";
            let size = 0;
            req.on("data", (chunk) => {
                size += chunk.length;
                if (size > maxBytes) {
                    reject({ status: 413, message: "Anfrage zu groß." });
                    req.destroy();
                    return;
                }
                data += chunk;
            });
            req.on("end", () => resolve(data));
            req.on("error", () => reject({ status: 400, message: "Ungültige Anfrage." }));
        });
    }
    if (Buffer.byteLength(raw) > maxBytes) throw { status: 413, message: "Anfrage zu groß." };
    if (!raw.trim()) return {};
    try {
        const obj = JSON.parse(raw);
        return obj && typeof obj === "object" ? obj : {};
    } catch {
        throw { status: 400, message: "Ungültiges JSON." };
    }
}

const IP_RE = /^[0-9a-fA-F:.]{3,45}$/;
function pickIp(v) {
    if (Array.isArray(v)) v = v[0];
    if (typeof v !== "string") return "";
    const s = v.split(",")[0].trim();
    return IP_RE.test(s) ? s : "";
}

/**
 * IP-ul clientului pentru rate limiting / evidența sesiunii.
 * -----------------------------------------------------------------------------
 * NU folosim prima valoare din `x-forwarded-for`: un client poate prepend-a
 * acolo un IP arbitrar (F-05) și astfel poate ocoli limitele pe IP.
 *
 * Prioritate (toate setate de infrastructura Vercel, care ELIMINĂ variantele
 * primite de la client, deci nu pot fi spoofuite trivial):
 *   1. x-real-ip                 — IP-ul conexiunii, setat de proxy-ul Vercel
 *   2. x-vercel-forwarded-for    — antet intern Vercel (`x-vercel-*` inbound e strip-uit)
 * Abia dacă niciunul nu e disponibil (dev local / alt runtime) folosim ULTIMA
 * valoare din `x-forwarded-for` (proxy-ul de încredere cel mai apropiat), apoi
 * adresa socket-ului. Prima valoare din XFF NU e folosită niciodată.
 */
export function clientIp(req) {
    const h = (req && req.headers) || {};
    const trusted = pickIp(h["x-real-ip"]) || pickIp(h["x-vercel-forwarded-for"]);
    if (trusted) return trusted;

    const xff = typeof h["x-forwarded-for"] === "string" ? h["x-forwarded-for"] : "";
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    const last = parts.length ? parts[parts.length - 1] : "";
    if (IP_RE.test(last)) return last;

    return (req && req.socket && req.socket.remoteAddress) || "0.0.0.0";
}

/** Parsează header-ul Cookie într-un obiect. Robust la valori malformate. */
export function parseCookies(req) {
    const header = req.headers.cookie;
    const out = {};
    if (!header) return out;
    for (const part of header.split(";")) {
        const i = part.indexOf("=");
        if (i < 0) continue;
        const k = part.slice(0, i).trim();
        const raw = part.slice(i + 1).trim();
        if (!k) continue;
        let v = raw;
        try { v = decodeURIComponent(raw); } catch { /* păstrăm valoarea brută */ }
        out[k] = v;
    }
    return out;
}

/** Construiește un string Set-Cookie. */
export function serializeCookie(name, value, opts = {}) {
    const p = [`${name}=${encodeURIComponent(value)}`];
    if (opts.maxAge != null) p.push(`Max-Age=${Math.floor(opts.maxAge)}`);
    p.push(`Path=${opts.path || "/"}`);
    if (opts.httpOnly !== false) p.push("HttpOnly");
    if (opts.secure !== false) p.push("Secure");
    p.push(`SameSite=${opts.sameSite || "Lax"}`);
    return p.join("; ");
}

/** Adaugă unul sau mai multe Set-Cookie fără a le suprascrie. */
export function appendCookie(res, cookieStr) {
    const prev = res.getHeader("Set-Cookie");
    if (!prev) res.setHeader("Set-Cookie", cookieStr);
    else res.setHeader("Set-Cookie", Array.isArray(prev) ? [...prev, cookieStr] : [prev, cookieStr]);
}

/** Host local? (pentru a nu marca cookie-ul Secure în dev pe http). */
export function isLocalHost(req) {
    const h = String(req.headers.host || "");
    return h.startsWith("localhost") || h.startsWith("127.0.0.1") || h.startsWith("[::1]");
}
