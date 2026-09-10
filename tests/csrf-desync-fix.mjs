/**
 * PflegeDoc — CSRF desync fix (Fix 1 + Fix 2) — static guard
 * -----------------------------------------------------------------------------
 * Fix 1: refreshAuth() nu mai tratează un 200 {authenticated:false} neașteptat
 *        ca logout definitiv — o singură reîncercare (800 ms) dacă eram
 *        autentificați; abia apoi reset real. Fără loop.
 * Fix 2: callGemini() nu trimite NICIODATĂ un POST /api/generate fără
 *        X-CSRF-Token: dacă lipsește tokenul, forțează ensureAuthFresh(true)
 *        înainte de fetch și aruncă session.desync dacă nu poate restaura.
 *
 * Static (regex peste index.html), stil identic cu tests/security-suite.mjs.
 *   node tests/csrf-desync-fix.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(path.join(REPO, "index.html"), "utf8");

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; console.log("  FAIL  " + name + (extra ? "  -> " + extra : "")); }
};

/* ---- izolează callGemini ---- */
const cg = (html.match(/async function callGemini\([\s\S]*?\n\}\n/) || [""])[0];
ok("callGemini localizat", cg.length > 400);

/* ==== FIX 2 — niciun POST /api/generate fără X-CSRF-Token ==== */
const guardIdx = cg.search(/if \(useBackend && !authState\.csrfToken\) \{/);
const fetchIdx = cg.search(/response = await fetch\(url, reqInit\);/);
ok("Fix2: guard-ul pre-POST există: `if (useBackend && !authState.csrfToken)`",
    guardIdx >= 0);
ok("Fix2: guard-ul NU mai cere authState.authenticated === true (rulează indiferent de flag)",
    guardIdx >= 0 && !/if \(useBackend && authState\.authenticated === true && !authState\.csrfToken\)/.test(cg));
ok("Fix2: guard-ul forțează revalidarea — ensureAuthFresh(true)",
    /if \(useBackend && !authState\.csrfToken\) \{\s*\n\s*const okAuth = await ensureAuthFresh\(true\);/.test(cg));
ok("Fix2: dacă nu se poate restaura tokenul -> throw session.desync (fără request)",
    /if \(useBackend && !authState\.csrfToken\) \{[\s\S]{0,220}?if \(!okAuth\) \{[\s\S]{0,120}?t\('session\.desync'\)[\s\S]{0,60}?sessionDesync = true;[\s\S]{0,40}?throw e;/.test(cg));
ok("Fix2: guard-ul rulează ÎNAINTE de fetch(url, reqInit)",
    guardIdx >= 0 && fetchIdx >= 0 && guardIdx < fetchIdx);

/* construcția header-ului CSRF rămâne neschimbată */
ok("header CSRF neschimbat: reqHeaders['X-CSRF-Token'] = authState.csrfToken",
    /reqHeaders\['X-CSRF-Token'\] = authState\.csrfToken;/.test(cg));
ok("POST-ul păstrează credentials: 'same-origin'", /reqInit\.credentials = 'same-origin';/.test(cg));

/* recovery-ul 403 existent rămâne neschimbat */
ok("recovery 403 existent intact: isAuthRecoverable + _authRetry o singură dată",
    /if \(isAuthRecoverable\(response\.status, data\)\) \{\s*\n\s*if \(!opts\._authRetry\) \{[\s\S]*?_authRetry: 1[\s\S]*?\}/.test(cg));

/* ==== FIX 1 — refreshAuth() nu mai wipe-uiește pe un 200 {authenticated:false} neașteptat ==== */
const ra = (html.match(/async function refreshAuth\(_attempt = 0\) \{[\s\S]*?\n\}\n/) || [""])[0];
ok("refreshAuth localizat", ra.length > 300);
ok("Fix1: ramură nouă `else if (authState.authenticated === true && _attempt < 1)`",
    /\} else if \(authState\.authenticated === true && _attempt < 1\) \{/.test(ra));
{
    const elseIf = (ra.match(/\} else if \(authState\.authenticated === true && _attempt < 1\) \{([\s\S]*?)\n        \} else \{/) || [, ""])[1];
    ok("Fix1: reîncearcă o singură dată după 800 ms",
        /setTimeout\(res, 800\)/.test(elseIf) &&
        /return refreshAuth\(_attempt \+ 1\);/.test(elseIf) &&
        elseIf.indexOf("setTimeout(res, 800)") < elseIf.indexOf("return refreshAuth(_attempt + 1)"));
}
ok("Fix1: fără loop infinit — retry plafonat la _attempt < 1 (o singură dată)",
    (ra.match(/_attempt < 1/g) || []).length >= 1 &&
    (ra.match(/return refreshAuth\(_attempt \+ 1\);/g) || []).length === 2); // 1x catch (existent) + 1x else-if (nou)
ok("Fix1: logout real doar dacă retry a confirmat / nu ne credeam autentificați (else final)",
    /\} else \{\s*\n\s*\/\/[\s\S]{0,140}?authState\.authenticated = false; authState\.user = null; authState\.csrfToken = null;\s*\n\s*\}/.test(ra));
ok("Fix1: comportamentul pentru sesiune real neautentificată e păstrat (reset în else final)",
    /authState\.authenticated = false; authState\.user = null; authState\.csrfToken = null;/.test(ra));

/* retry-ul existent pentru erori ARUNCATE (rețea / 5xx / cold start) rămâne intact */
ok("Fix1: catch (throw/network) păstrează retry 800 ms + reset după",
    /\} catch \(e\) \{[\s\S]{0,400}?if \(_attempt < 1\) \{[\s\S]{0,120}?setTimeout\(res, 800\)[\s\S]{0,80}?return refreshAuth\(_attempt \+ 1\);[\s\S]{0,120}?\}\s*\n\s*authState\.authenticated = false; authState\.user = null; authState\.csrfToken = null;/.test(ra));

/* ==== securitate CSRF neschimbată ==== */
ok("CSRF NU e pus în localStorage/sessionStorage", !/(local|session)Storage\.[gs]etItem\([^)]*csrf/i.test(html));
ok("checkCsrf/X-CSRF-Token rămân mecanismul unic (fără al doilea sistem)",
    (html.match(/X-CSRF-Token/g) || []).length >= 2 && !/X-CSRF2|csrf2|_csrf\b/i.test(html));
ok("apiFetch încă atașează X-CSRF-Token pentru metode ≠ GET",
    /if \(method !== 'GET' && authState\.csrfToken\) opts\.headers\['X-CSRF-Token'\] = authState\.csrfToken;/.test(html));

/* ==== K1/K5 + UX generare neatinse ==== */
ok("K1 intact (fără retry client 503, fără _retry)", /K1: 503/.test(html) && !/_retry\b/.test(html));
ok("K5 intact (garda generating)", /if \(generating\) return;\s*\n\s*generating = true;/.test(html));
ok("client timeout neschimbat (55000)", /TIMEOUT_MS: 55000/.test(html));

console.log("\n----------------------------------------");
console.log(`TOTAL: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
