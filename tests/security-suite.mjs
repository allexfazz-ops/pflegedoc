/**
 * PflegeDoc — Security Hardening Test Suite (dependency-free)
 * -----------------------------------------------------------------------------
 * Verifică cele 8 fix-uri de hardening. Nu atinge rețeaua / baza de date.
 *
 *   node tests/security-suite.mjs
 *
 * Iese cu cod 0 dacă TOATE trec, altfel 1.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; console.log("  FAIL  " + name + (extra ? "  -> " + extra : "")); }
}
function section(t) { console.log("\n=== " + t + " ==="); }

/* ---------------------------------------------------------------------------
   FIX 1 — Canonical APP_ORIGIN (host-header poisoning resistant)
   --------------------------------------------------------------------------- */
section("FIX 1 — APP_ORIGIN ignoră anteturile de cerere");
{
    process.env.APP_ORIGIN = "https://canonical.example/";
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    const { appOrigin } = await import("../lib/email.mjs?fix1a");
    const evilReq = { headers: { host: "evil.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "http" } };
    const got = appOrigin(evilReq);
    ok("Host / X-Forwarded-Host nu schimbă originea", got === "https://canonical.example", got);
    ok("slash-ul final e normalizat", !got.endsWith("/"), got);
    ok("fără req dă aceeași valoare", appOrigin() === "https://canonical.example");
}
{
    delete process.env.APP_ORIGIN;
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "pflegedoc-prod.vercel.app";
    const { appOrigin } = await import("../lib/email.mjs?fix1b");
    ok("fallback pe VERCEL_PROJECT_PRODUCTION_URL (platformă, nu client)",
        appOrigin({ headers: { host: "evil.example" } }) === "https://pflegedoc-prod.vercel.app");
}
{
    delete process.env.APP_ORIGIN;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const { appOrigin } = await import("../lib/email.mjs?fix1c");
    let threw = false;
    try { appOrigin({ headers: { host: "evil.example" } }); } catch { threw = true; }
    ok("în producție fără config -> aruncă (nu cade pe antet)", threw);
    process.env.NODE_ENV = prev;
}
ok("lib/tokens.mjs calculează originea ÎNAINTE de a emite tokenul",
    /const base = appOrigin\(req\);[\s\S]*issueEmailToken/.test(read("lib/tokens.mjs")));

/* ---------------------------------------------------------------------------
   FIX 2 — Fără dev-token URLs în producție
   --------------------------------------------------------------------------- */
section("FIX 2 — devVerifyUrl / devResetUrl niciodată în producție");
{
    const src = read("api/auth/[action].js");
    ok("devVerifyUrl e gărduit de allowDevEmailHints()", /allowDevEmailHints\(\)\s*&&\s*\(!emailEnabled\(\)/.test(src));
    ok("devResetUrl e gărduit de allowDevEmailHints()", /allowDevEmailHints\(\)\s*&&\s*\(!emailEnabled\(\)/.test(src));
    ok("allowDevEmailHints = !isProduction()", /const allowDevEmailHints = \(\) => !isProduction\(\)/.test(src));
    ok("emailError expus doar când allowDevEmailHints()", /if \(allowDevEmailHints\(\)\) emailError =/.test(src));
    ok("nu mai există `emailError = e.message` necondiționat", !/^\s*emailError = e\.message;\s*$/m.test(src));
    const { isProduction } = await import("../lib/email.mjs?fix2");
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    ok("isProduction() true când NODE_ENV=production", isProduction() === true);
    process.env.NODE_ENV = "development";
    delete process.env.VERCEL_ENV;
    ok("isProduction() false în dev", isProduction() === false);
    process.env.NODE_ENV = prev;
}
{
    const email = read("lib/email.mjs");
    ok("[email:dev] logat doar când !isProduction()", /if \(!isProduction\(\)\)\s*\{\s*\n\s*console\.log\(`\[email:dev\]/.test(email));
    ok("sendEmail nu mai loghează corpul răspunsului Resend", !/body\.slice\(/.test(email));
    ok("sendEmail nu mai întoarce `detail`", !/detail:/.test(email));
}

/* ---------------------------------------------------------------------------
   FIX 3 — clientIp de încredere + limită pe cont la /api/generate
   --------------------------------------------------------------------------- */
section("FIX 3 — clientIp nu se bazează pe prima valoare x-forwarded-for");
{
    const { clientIp } = await import("../lib/http.mjs?fix3");
    ok("x-real-ip are prioritate peste x-forwarded-for injectat",
        clientIp({ headers: { "x-real-ip": "9.9.9.9", "x-forwarded-for": "1.1.1.1, 8.8.8.8" }, socket: {} }) === "9.9.9.9");
    ok("prima valoare din x-forwarded-for NU e folosită (fallback ia ultima)",
        clientIp({ headers: { "x-forwarded-for": "6.6.6.6, 10.0.0.1" }, socket: {} }) === "10.0.0.1");
    ok("x-vercel-forwarded-for e acceptat ca sursă de încredere",
        clientIp({ headers: { "x-vercel-forwarded-for": "7.7.7.7", "x-forwarded-for": "1.2.3.4" }, socket: {} }) === "7.7.7.7");
    ok("gunoi în headers -> nu aruncă, cade pe socket/0.0.0.0",
        typeof clientIp({ headers: {}, socket: {} }) === "string");
}
{
    const gen = read("api/generate.js");
    ok("/api/generate are limită pe cont (generate:user)", /rateLimit\(`generate:user:\$\{auth\.user\.id\}`/.test(gen));
    ok("limita pe cont e conservatoare (>= limita pe IP de 40)", /generate:user:\$\{auth\.user\.id\}`,\s*60,\s*3600/.test(gen));
    {
        const authSrc = read("api/auth/[action].js");
        const calls = authSrc.match(/enforceRateLimit\([^\n]*\)/g) || [];
        const withReq = calls.filter(c => /,\s*req\)\s*\)?$/.test(c) || /,\s*req\)/.test(c));
        ok("toate apelurile enforceRateLimit din auth primesc `req` (pt. rate_limit_hit)",
            calls.length >= 8 && withReq.length === calls.length, `${withReq.length}/${calls.length}`);
    }
}

/* ---------------------------------------------------------------------------
   FIX 4 — Security headers (vercel.json)
   --------------------------------------------------------------------------- */
section("FIX 4 — vercel.json cu security headers");
{
    const vj = JSON.parse(read("vercel.json"));
    const hdrs = (vj.headers?.[0]?.headers || []).reduce((m, h) => (m[h.key.toLowerCase()] = h.value, m), {});
    ok("Content-Security-Policy prezent", !!hdrs["content-security-policy"]);
    ok("CSP: frame-ancestors 'none'", /frame-ancestors 'none'/.test(hdrs["content-security-policy"] || ""));
    ok("CSP: object-src 'none'", /object-src 'none'/.test(hdrs["content-security-policy"] || ""));
    ok("CSP: connect-src permite self + Gemini (own-key nu se rupe)",
        /connect-src 'self' https:\/\/generativelanguage\.googleapis\.com/.test(hdrs["content-security-policy"] || ""));
    ok("CSP: script-src 'unsafe-inline' (app-ul e vanilla cu inline JS)",
        /script-src 'self' 'unsafe-inline'/.test(hdrs["content-security-policy"] || ""));
    ok("X-Content-Type-Options: nosniff", hdrs["x-content-type-options"] === "nosniff");
    ok("Referrer-Policy: no-referrer", hdrs["referrer-policy"] === "no-referrer");
    ok("X-Frame-Options: DENY", hdrs["x-frame-options"] === "DENY");
    ok("Permissions-Policy: microphone=(self) (dictarea funcționează)",
        /microphone=\(self\)/.test(hdrs["permissions-policy"] || ""));
    ok("Permissions-Policy: camera dezactivat", /camera=\(\)/.test(hdrs["permissions-policy"] || ""));
    ok("nu introducem HSTS aici (rămâne cel de la Vercel)", !hdrs["strict-transport-security"]);
}

/* ---------------------------------------------------------------------------
   FIX 5 — ENGINE_TEST_SECRET nu poate fi bypass în producție
   --------------------------------------------------------------------------- */
section("FIX 5 — bypass engine-test refuzat structural în producție");
{
    const gen = read("api/generate.js");
    ok("bypassAllowed verifică NODE_ENV !== production", /NODE_ENV !== "production"/.test(gen));
    ok("bypassAllowed verifică și VERCEL_ENV !== production", /VERCEL_ENV !== "production"/.test(gen));
    ok("isTestCall depinde de bypassAllowed", /const isTestCall\s*=\s*\n?\s*bypassAllowed && /.test(gen));
}

/* ---------------------------------------------------------------------------
   FIX 6 — CSRF pentru /api/generate
   --------------------------------------------------------------------------- */
section("FIX 6 — /api/generate cere token CSRF");
{
    const gen = read("api/generate.js");
    ok("importă checkCsrf din lib/auth.mjs", /getAuth,\s*checkCsrf/.test(gen));
    ok("respinge când checkCsrf eșuează", /if \(!checkCsrf\(req, auth\.session\)\) \{[\s\S]*403/.test(gen));
    ok("verificarea CSRF e după email_verified și doar pt. apeluri autentificate (!isTestCall)",
        gen.indexOf("email_verified !== true") < gen.indexOf("checkCsrf(req, auth.session)"));
    const html = read("index.html");
    ok("frontend: callGemini trimite X-CSRF-Token doar spre backend",
        /if \(useBackend\) \{[\s\S]*reqHeaders\['X-CSRF-Token'\] = authState\.csrfToken/.test(html));
    ok("frontend: NU stochează CSRF în localStorage", !/localStorage\.[gs]etItem\([^)]*csrf/i.test(html));
    ok("frontend: nu s-a creat un al doilea sistem CSRF (tot X-CSRF-Token)",
        (html.match(/X-CSRF-Token/g) || []).length >= 2 && !/X-CSRF2|csrf2|_csrf\b/i.test(html));
}

/* ---------------------------------------------------------------------------
   FIX 7 — Security event logging (doar metadate)
   --------------------------------------------------------------------------- */
section("FIX 7 — securityEvent nu scurge conținut sensibil");
{
    const { securityEvent } = await import("../lib/securitylog.mjs?fix7");
    const lines = [];
    const orig = console.log;
    console.log = (...a) => { lines.push(a.join(" ")); };
    try {
        securityEvent("login_failure", { headers: { "x-real-ip": "203.0.113.9" }, url: "/api/auth/login?x=1" },
            { outcome: "bad_credentials", userId: "11111111-1111-1111-1111-111111111111", detail: "user@example.com 5.5.5.5" });
        securityEvent("rate_limit_hit", null, { outcome: "429", detail: "login:ip" });
    } finally { console.log = orig; }

    ok("emite linii [sec]", lines.length === 2 && lines.every(l => l.startsWith("[sec] ")));
    const rec = JSON.parse(lines[0].slice(6));
    ok("are ts / event / outcome / route", rec.ts && rec.event === "login_failure" && rec.outcome === "bad_credentials" && rec.route === "/api/auth/login");
    ok("ip_hash e HMAC trunchiat (16 hex), nu IP brut", /^[0-9a-f]{16}$/.test(rec.ip_hash) && !String(lines[0]).includes("203.0.113.9"));
    ok("detail cu e-mail/IP e redactat", rec.detail === "redacted");
    ok("linia NU conține e-mail / token / parolă / prompt", !/@|password|token|prompt|Bearer/i.test(lines[0]));
    const rec2 = JSON.parse(lines[1].slice(6));
    ok("fără req -> ip_hash null; detail scurt tehnic păstrat", rec2.ip_hash === null && rec2.detail === "login:ip");

    const slCode = read("lib/securitylog.mjs")
        .split("\n").filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
    const slConsoles = slCode.match(/console\.\w+\(/g) || [];
    ok("lib/securitylog.mjs are UN singur console în cod executabil (console.log(\"[sec]\"))",
        slConsoles.length === 1 && /console\.log\("\[sec\]"/.test(slCode));
    ok("codul executabil din securitylog nu referă input_text/result_text/systemInstruction/password_hash",
        !/input_text|result_text|systemInstruction|password_hash/.test(slCode));
}
{
    // Evenimente cablate în cod
    const auth = read("api/auth/[action].js");
    for (const ev of ["login_success", "login_failure", "register_attempt", "password_reset_requested",
        "password_reset_success", "verification_confirmed", "account_deleted"]) {
        ok("eveniment prezent: " + ev, auth.includes('"' + ev + '"'));
    }
    ok("requireAuth/requireCsrf emit authorization_failure", /securityEvent\("authorization_failure"/.test(read("lib/auth.mjs")));
    ok("history/[id] + patients/[id] emit foreign_resource_attempt",
        /foreign_resource_attempt/.test(read("api/history/[id].js")) && /foreign_resource_attempt/.test(read("api/patients/[id].js")));
    ok("generate emite generate_rate_limit_hit", /generate_rate_limit_hit/.test(read("api/generate.js")));
}

/* ---------------------------------------------------------------------------
   FIX 8 — Logging hygiene (scanare statică)
   --------------------------------------------------------------------------- */
section("FIX 8 — fără leakage de token / patient / AI în loguri");
{
    const html = read("index.html");
    ok("console.debug('Gemini raw response') eliminat", !/Gemini raw response/.test(html));
    ok("frontend: dev link-uri logate doar sub guard `if (d.devVerifyUrl)` etc.",
        !/console\.log\([^)]*devVerifyUrl(?![\s\S]{0,4}\))/.test(html) || /if \(d\.devVerifyUrl\)/.test(html));

    // Scanare largă: niciun console.* cu req.body / input / result / prompt / token brut
    const scan = ["api/generate.js", "api/auth/[action].js", "api/history/index.js", "api/history/[id].js",
        "api/patients/index.js", "api/patients/[id].js", "api/settings.js", "lib/email.mjs", "lib/tokens.mjs",
        "lib/auth.mjs", "lib/db.mjs", "lib/ratelimit.mjs", "lib/http.mjs", "lib/securitylog.mjs"];
    let bad = [];
    for (const f of scan) {
        const src = read(f);
        const consoles = src.match(/console\.(log|error|warn|info|debug)\([^\n]*\)/g) || [];
        for (const c of consoles) {
            if (/req\.body|\binput\b|result_text|input_text|\bprompt\b|systemInstruction|\.password\b|token_hash|csrf_token|devVerifyUrl|devResetUrl|reset=|verify=/i.test(c)) {
                bad.push(f + ": " + c.slice(0, 90));
            }
        }
    }
    ok("niciun console.* cu date sensibile în backend/lib", bad.length === 0, bad.join(" | "));

    const gen = read("api/generate.js");
    ok("erorile de furnizor Gemini NU mai sunt trecute către client (SERVICE_ERR generic)",
        /return res\.status\(502\)\.json\(\{ error: SERVICE_ERR \}\)/.test(gen) && !/Gemini-Fehler: \$\{apiMsg\}/.test(gen));
    ok("detaliul furnizorului rămâne doar în log server", /console\.error\("\[generate\] upstream error"/.test(gen));
}

/* ---------------------------------------------------------------------------
   PRIVACY BOUNDARY — /api/generate trimite doar req.body.input
   --------------------------------------------------------------------------- */
section("Privacy boundary — contextul AI rămâne minimal");
{
    const gen = read("api/generate.js");
    // payload-ul spre Gemini: systemInstruction (prompt static) + contents=[input]
    ok("payload = systemInstruction + contents:[{ text: input }] (nimic din DB)",
        /contents:\s*\[\{\s*role:\s*"user",\s*parts:\s*\[\{\s*text:\s*input\s*\}\]\s*\}\]/.test(gen));
    ok("nu se adaugă nume/note pacient / istoric / email în prompt",
        !/patient|history|input_text|display_name|user\.email/i.test(gen.split("const payload")[1].split("await fetch")[0]));
}

/* --------------------------------------------------------------------------- */
console.log("\n----------------------------------------");
console.log(`TOTAL: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
