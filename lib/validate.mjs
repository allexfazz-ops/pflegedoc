/**
 * lib/validate.mjs — validare strictă SERVER-SIDE a tuturor input-urilor.
 * Frontend-ul NU este considerat de încredere.
 */

export const UI_LANGUAGES = ["de", "en", "fr", "es", "it", "pt", "pl", "tr", "ro", "ru", "uk", "ar"];
export const THEMES = ["system", "light", "dark"];
export const ACTIVITY_TYPES = ["dokumentation", "pflegeplanung", "korrigierung"];
export const MODES = ["formulieren", "korrigieren", "uebersetzen", "pflegeplanung"];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Un mic set de parole foarte comune, respinse explicit.
const COMMON_PASSWORDS = new Set([
    "12345678", "123456789", "1234567890", "password", "passwort", "qwert123",
    "qwertzuiop", "11111111", "00000000", "abcdefgh", "password1", "passwort1",
    "iloveyou", "welcome1", "admin123", "letmein1", "test1234", "pflege123",
]);

export function normEmail(v) {
    return typeof v === "string" ? v.trim().toLowerCase() : "";
}

export function isEmail(v) {
    const e = normEmail(v);
    return (
        e.length >= 3 &&
        e.length <= 254 &&
        EMAIL_RE.test(e) &&
        !/[\r\n\t]/.test(e)
    );
}

/** @returns {{ok:true}|{ok:false,error:string}} */
export function checkPassword(v) {
    if (typeof v !== "string") return { ok: false, error: "Passwort fehlt." };
    if (v.length < 8) return { ok: false, error: "Das Passwort muss mindestens 8 Zeichen haben." };
    if (v.length > 200) return { ok: false, error: "Das Passwort ist zu lang (max. 200 Zeichen)." };
    if (!v.trim()) return { ok: false, error: "Das Passwort darf nicht nur aus Leerzeichen bestehen." };
    if (COMMON_PASSWORDS.has(v.toLowerCase())) return { ok: false, error: "Dieses Passwort ist zu unsicher. Bitte ein anderes wählen." };
    return { ok: true };
}

export function isUuid(v) {
    return typeof v === "string" && UUID_RE.test(v);
}

export function inEnum(v, list) {
    return typeof v === "string" && list.includes(v);
}

/** Text obligatoriu, tăiat la `max`, cu lungime minimă 1 după trim. */
export function requireText(v, max) {
    if (typeof v !== "string") return { ok: false, error: "Text fehlt." };
    const t = v.trim();
    if (!t) return { ok: false, error: "Text darf nicht leer sein." };
    if (t.length > max) return { ok: false, error: `Text zu lang (max. ${max} Zeichen).` };
    return { ok: true, value: t };
}

/** Cod de limbă Speech opțional ('de-DE', 'ro-RO', …). */
export function optLangCode(v) {
    if (v == null || v === "") return { ok: true, value: null };
    if (typeof v === "string" && v.length <= 12 && /^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(v)) {
        return { ok: true, value: v };
    }
    return { ok: false, error: "Ungültiger Sprachcode." };
}

/** Cod de limbă UI opțional pentru ieșirea traducerii ('de','tr','ru', …) sau null. */
export function outLang(v) {
    if (v == null || v === "") return { ok: true, value: null };
    if (typeof v === "string" && UI_LANGUAGES.includes(v)) return { ok: true, value: v };
    return { ok: false, error: "Ungültige Ausgabesprache." };
}
