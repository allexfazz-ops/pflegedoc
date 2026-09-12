/**
 * PflegeDoc — K3 LATENCY DIAGNOSTIC HARNESS  (READ-ONLY, ISOLATED)
 * =============================================================================
 * Measures Gemini latency for the CURRENT production configuration, in
 * isolation from the PflegeDoc application. It:
 *   - does NOT import or execute api/generate.js's request handler
 *   - does NOT touch the DB / Neon / Vercel / the deployed app
 *   - does NOT modify any file (not even .env.local)
 *   - talks ONLY to https://generativelanguage.googleapis.com
 *
 * It reuses the application's REAL system-prompt builder by extracting the pure
 * declaration section of api/generate.js in a `node:vm` sandbox (the handler
 * body is sliced off first). Prompts are therefore byte-identical to production.
 * generationConfig (temperature / topP / maxOutputTokens) and the model are read
 * from the same file — nothing is invented, nothing is changed.
 *
 * KEY: read from process.env.GEMINI_API_KEY, else from a `GEMINI_API_KEY=` line
 * in .env.local (git-ignored). Never printed, never written anywhere.
 *
 * USAGE
 *   node tests/k3-latency-harness.mjs --dry-run          # static proof, no network
 *   node tests/k3-latency-harness.mjs                     # full bounded run
 *   node tests/k3-latency-harness.mjs --categories=4,5    # just long pflegeplanung
 *   node tests/k3-latency-harness.mjs --mode=stream --samples=3
 *   node tests/k3-latency-harness.mjs --no-mirror-retry   # 1 attempt per sample
 *
 * FLAGS
 *   --dry-run              no API calls; prints prompt/input sizes + safety proof
 *   --categories=1,2,..    subset of 1..5 (default: all)
 *   --mode=nonstream|stream|both   (default: both)
 *   --samples=N            successful-sample target per (category,mode) (default 3)
 *   --spacing=MS           delay between every API call (default 6000)
 *   --mirror-retry         non-stream path mirrors the app retry loop (default ON)
 *   --no-mirror-retry      non-stream path does a single attempt per sample
 *   --max-calls=N          hard cap on total API calls (default 80)
 *
 * SAFETY: on ANY quota-429 (RESOURCE_EXHAUSTED / quota / retryDelay>=4) the run
 * aborts immediately and writes a partial report. No aggressive retrying.
 * =============================================================================
 */

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const GEN_PATH = path.join(REPO, "api", "generate.js");
const ENV_LOCAL = path.join(REPO, ".env.local");

/* ----------------------------- CLI ARGS ---------------------------------- */
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (name, dflt) => {
    const hit = args.find((a) => a.startsWith(name + "="));
    return hit ? hit.slice(name.length + 1) : dflt;
};
const DRY_RUN = has("--dry-run");
const MODE = String(val("--mode", "both")); // nonstream | stream | both
const SAMPLES = Math.max(1, parseInt(val("--samples", "3"), 10) || 3);
const SPACING_MS = Math.max(0, parseInt(val("--spacing", "6000"), 10) || 6000);
const MIRROR_RETRY = !has("--no-mirror-retry"); // default ON for non-stream
const MAX_CALLS = Math.max(1, parseInt(val("--max-calls", "80"), 10) || 80);
const CATS = String(val("--categories", "1,2,3,4,5"))
    .split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => n >= 1 && n <= 5);

const P95_MIN_N = 5; // below this, p95 is reported as insufficient — never fabricated

/* --------- app retry constants (mirror only; NOT changing the app) ------- */
const MIRROR = { MAX_ATTEMPTS: 3, PER_ATTEMPT_TIMEOUT_MS: 22000, TOTAL_BUDGET_MS: 44000, BACKOFF_MS: [1200, 2600] };
const CLIENT_BACKSTOP_MS = 55000; // matches CONFIG.TIMEOUT_MS; used for the streaming abort

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowMs = () => Number(process.hrtime.bigint() / 1000000n);

/* ============================================================================
   1. EXTRACT THE REAL PROMPT BUILDER FROM api/generate.js  (no handler exec)
   ========================================================================== */
function loadRealPromptModule() {
    const src = readFileSync(GEN_PATH, "utf8");
    const marker = "export default async function handler";
    const cut = src.indexOf(marker);
    if (cut < 0) throw new Error("handler marker not found in api/generate.js");

    let decls = src.slice(0, cut).replace(/^export\s+/gm, ""); // strip `export ` -> valid vm script

    // Hard safety asserts on the slice we are about to evaluate.
    if (/async function handler/.test(decls)) throw new Error("slice still contains handler");
    if (/^\s*import\s+/m.test(decls)) throw new Error("slice contains a static import");
    if (/\bimport\s*\(/.test(decls)) throw new Error("slice contains a dynamic import()");
    if (/\brequire\s*\(/.test(decls)) throw new Error("slice contains require()");
    if (/\bfetch\s*\(/.test(decls)) throw new Error("slice contains fetch()");
    if (/process\.env/.test(decls)) throw new Error("slice reads process.env");

    const epilogue = `
;globalThis.__K3_EXPORTS = {
    buildSystemPrompt,
    MAX_INPUT_CHARS: (typeof MAX_INPUT_CHARS !== "undefined" ? MAX_INPUT_CHARS : null),
    DEFAULT_MODEL: (typeof DEFAULT_MODEL !== "undefined" ? DEFAULT_MODEL : null),
    VALID_MODES: (typeof VALID_MODES !== "undefined" ? VALID_MODES : null),
};`;

    // Sandbox intentionally has NOTHING: no process, no require, no fetch, no timers.
    const sandbox = Object.create(null);
    vm.createContext(sandbox);
    vm.runInContext(decls + epilogue, sandbox, { filename: "generate.decls.vm.js", timeout: 3000 });
    const M = sandbox.__K3_EXPORTS;
    if (typeof M.buildSystemPrompt !== "function") throw new Error("buildSystemPrompt not extracted");

    // generationConfig + model: read (never modify) from the handler text.
    const handlerText = src.slice(cut);
    const num = (re, label) => {
        const m = handlerText.match(re);
        if (!m) throw new Error("could not read " + label + " from api/generate.js");
        return parseFloat(m[1]);
    };
    const generationConfig = {
        temperature: num(/temperature:\s*([\d.]+)/, "temperature"),
        topP: num(/topP:\s*([\d.]+)/, "topP"),
        maxOutputTokens: num(/maxOutputTokens:\s*(\d+)/, "maxOutputTokens"),
    };
    const modelMatch = handlerText.match(/process\.env\.GEMINI_MODEL\s*\|\|\s*DEFAULT_MODEL/);
    const model = process.env.GEMINI_MODEL || M.DEFAULT_MODEL;
    const endpointHost = "https://generativelanguage.googleapis.com";
    const endpointBase = `${endpointHost}/v1beta/models/${model}`;

    return {
        buildSystemPrompt: M.buildSystemPrompt,
        MAX_INPUT_CHARS: M.MAX_INPUT_CHARS,
        VALID_MODES: M.VALID_MODES,
        model,
        generationConfig,
        endpointHost,
        nonStreamUrl: `${endpointBase}:generateContent`,
        streamUrl: `${endpointBase}:streamGenerateContent?alt=sse`,
        usesEnvModelOverride: !!modelMatch,
    };
}

/* ============================================================================
   2. SYNTHETIC, NON-IDENTIFYING GERMAN CARE-DOCUMENTATION INPUTS
      (fictional placeholders only: "Frau K.", "Herr M." — no real data)
   ========================================================================== */
const SHORT_FORMULIEREN =
    "Frau K. heute Morgen mit zwei Personen mobilisiert, Frühstück selbstständig und vollständig gegessen, keine Schmerzen angegeben, Stimmung freundlich.";

const MEDIUM_FORMULIEREN = [
    "Frühdienst: Herr M. bei der Körperpflege am Waschbecken teilweise unterstützt, Oberkörper selbst gewaschen, Rücken und Beine übernommen.",
    "Transfer vom Bett in den Rollstuhl mit einer Person und Rutschbrett, kreislauf­stabil, kein Schwindel geäußert.",
    "Frühstück: eine Scheibe Brot, Kaffee, etwa 150 ml getrunken. Medikamente laut Plan gerichtet und verabreicht.",
    "Gegen 10:30 Uhr über ziehenden Schmerz im rechten Knie geklagt, Bewegungseinschränkung sichtbar. Information an die Wohnbereichsleitung weitergegeben.",
    "Vitalwerte: RR 138/84 mmHg, Puls 76/min, Temp 36,7 °C.",
].join(" ");

const PP_SIS = [
    "Frau K., 84 Jahre, lebt seit drei Monaten im Wohnbereich. Sie ist zeitlich nicht immer orientiert, erkennt Bezugspersonen, Hörgerät links vorhanden, Sehhilfe zum Lesen.",
    "Mobilität: geht mit Rollator kurze Strecken auf dem Flur, benötigt Begleitung wegen Sturzgefahr, nachts unsicher beim Aufstehen.",
    "Krankheitsbezogen: bekannte Herzinsuffizienz und Diabetes mellitus Typ 2, Blutzuckerkontrollen laut Anordnung, gelegentlich Wassereinlagerungen an den Unterschenkeln.",
    "Selbstversorgung: Oberkörper wäscht sie selbst, bei der Intimpflege und beim Ankleiden ist Unterstützung nötig, isst selbstständig, trinkt zu wenig.",
    "Soziale Beziehungen: die Tochter besucht zweimal pro Woche, nimmt an der Singgruppe teil, zieht sich abends eher zurück.",
    "Wohnen: Einzelzimmer, Rufanlage in Reichweite, persönliche Bilder aufgehängt.",
].join(" ");

const PP_KLASSISCH = [
    "Herr M., 79 Jahre, nach Sturz mit Oberschenkelhalsfraktur und operativer Versorgung zur Kurzzeitpflege aufgenommen.",
    "Er hat Angst, erneut zu stürzen, und vermeidet dadurch Bewegung. Beim Transfer und beim Gehen mit Gehstützen braucht er Anleitung und Sicherung durch eine Person.",
    "Die Wunde am rechten Oberschenkel ist reizlos, Verbandwechsel jeden zweiten Tag laut ärztlicher Anordnung.",
    "Schmerzen im Operationsgebiet gibt er bei Belastung mit etwa 4 von 10 an, Bedarfsmedikation ist angeordnet.",
    "Er möchte wieder allein zur Toilette gehen können. Ehefrau ist eingebunden und unterstützt bei den Mahlzeiten.",
].join(" ");

// Long formulieren near MAX_INPUT_CHARS: composed from realistic distinct shift
// blocks across three days, then trimmed to a safe length < MAX_INPUT_CHARS.
function buildLongFormulieren(maxChars) {
    const target = Math.min(7600, (maxChars || 8000) - 400);
    const blocks = [
        "Frühdienst Tag 1: Herr M. wach und ansprechbar, bei der Ganzkörperpflege im Bett vollständig übernommen, Hautzustand unauffällig bis auf trockene Haut an den Unterschenkeln, eingecremt. Mund- und Zahnpflege durchgeführt. Positionswechsel nach Plan alle zwei Stunden, Fersen freigelagert.",
        "Transfer mit Lifter in den Pflegerollstuhl, Sitzposition kontrolliert. Frühstück angereicht, etwa die Hälfte gegessen, 200 ml Tee getrunken. Medikamente laut Plan verabreicht, keine Auffälligkeiten beim Schlucken.",
        "Spätdienst Tag 1: nachmittags zunehmend unruhig, nestelte an der Bettdecke, rief wiederholt nach der Ehefrau. Nach Ansprache und Handmassage ruhiger. Vitalwerte: RR 142/88 mmHg, Puls 80/min, SpO2 95 Prozent, Temp 36,9 °C.",
        "Abendessen: Grießbrei, vollständig gegessen, gut getrunken. Intimpflege nach dem Toilettengang übernommen, kleine Rötung im Steißbereich, nicht wegdrückbar, Wohnbereichsleitung informiert, Positionierung angepasst und dokumentiert.",
        "Nachtdienst Tag 1: gegen 1:00 Uhr wach, Inkontinenzmaterial gewechselt, danach wieder eingeschlafen. Um 4:30 Uhr erneut wach, ruhig, nach kurzer Ansprache weitergeschlafen. Atmung regelmäßig, keine Schmerzäußerung.",
        "Frühdienst Tag 2: Haut im Steißbereich weiterhin gerötet, Kategorie-I-Verdacht, Freilagerung und zweistündliche Positionierung fortgeführt, ärztliche Visite angemeldet. Körperpflege im Bett, danach Transfer in den Rollstuhl mit Lifter.",
        "Frühstück fast vollständig, Trinkmenge bis Mittag etwa 500 ml. An der Bewegungsübung im Sitzen teilgenommen, führte die Armübungen mit, Beine nur mit Unterstützung.",
        "Spätdienst Tag 2: Besuch der Ehefrau, deutlich entspannter, lächelte, aß mit Unterstützung ein Stück Kuchen. Nach dem Besuch müde, kurzer Schlaf im Sessel. Bedarfsmedikation gegen Schmerzen nicht erforderlich.",
        "Abends Vitalwerte: RR 135/82 mmHg, Puls 74/min, Temp 36,6 °C. Abendessen vollständig, Mundpflege durchgeführt, zur Nacht gelagert, Rufanlage in Reichweite.",
        "Nachtdienst Tag 2: durchgehend geschlafen, einmal Inkontinenzmaterial gewechselt, Haut kontrolliert, Rötung im Steißbereich unverändert, keine neuen Druckstellen.",
        "Frühdienst Tag 3: ärztliche Visite erfolgt, Rötung als Dekubitus Kategorie I bestätigt, druckentlastende Maßnahmen weiterführen, Hautschutzcreme angeordnet und aufgetragen. Körperpflege teilweise selbst am Waschbecken im Sitzen möglich, Oberkörper eigenständig gewaschen.",
        "Frühstück selbstständig, gute Trinkmenge, Stimmung stabil. Physiotherapie am Vormittag: Stehübung an der Bettkante mit zwei Personen, etwa 30 Sekunden gestanden, danach erschöpft.",
        "Spätdienst Tag 3: ruhiger Nachmittag, hörte Radio, beteiligte sich an einem kurzen Gespräch über frühere Arbeit als Schreiner. Abendessen vollständig, Medikamente nach Plan.",
    ];
    let text = "";
    let i = 0;
    while (text.length < target) {
        text += (text ? " " : "") + blocks[i % blocks.length];
        i++;
        if (i > 400) break; // safety
    }
    return text.slice(0, target);
}

function categories(realMod) {
    const longText = buildLongFormulieren(realMod.MAX_INPUT_CHARS);
    return [
        { id: 1, label: "short formulieren",       mode: "formulieren",   variant: "-",        input: SHORT_FORMULIEREN },
        { id: 2, label: "medium formulieren",      mode: "formulieren",   variant: "-",        input: MEDIUM_FORMULIEREN },
        { id: 3, label: "long formulieren (~max)", mode: "formulieren",   variant: "-",        input: longText },
        { id: 4, label: "pflegeplanung + sis",     mode: "pflegeplanung", variant: "sis",      input: PP_SIS },
        { id: 5, label: "pflegeplanung + klassisch",mode: "pflegeplanung",variant: "klassisch",input: PP_KLASSISCH },
    ].filter((c) => CATS.includes(c.id));
}

/* ============================================================================
   3. KEY LOADING (never printed / written)
   ========================================================================== */
function loadKey() {
    let k = (process.env.GEMINI_API_KEY || "").trim();
    let source = k ? "process.env.GEMINI_API_KEY" : null;
    if (!k && existsSync(ENV_LOCAL)) {
        const line = readFileSync(ENV_LOCAL, "utf8")
            .split(/\r?\n/)
            .find((l) => /^\s*GEMINI_API_KEY\s*=/.test(l));
        if (line) {
            k = line.replace(/^\s*GEMINI_API_KEY\s*=\s*/, "").trim().replace(/^["']|["']$/g, "").trim();
            if (k) source = ".env.local (GEMINI_API_KEY)";
        }
    }
    const present = !!k && k.length >= 20;
    return { key: present ? k : null, present, source: present ? source : null };
}

/* ============================================================================
   4. STATS
   ========================================================================== */
function stats(arr) {
    const xs = arr.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
    const n = xs.length;
    if (!n) return { n: 0, min: null, max: null, mean: null, median: null, p95: null };
    const q = (p) => {
        if (n < P95_MIN_N && p === 95) return `insufficient (n=${n}, need >=${P95_MIN_N})`;
        const idx = Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1));
        return xs[idx];
    };
    return {
        n,
        min: xs[0],
        max: xs[n - 1],
        mean: Math.round(xs.reduce((s, v) => s + v, 0) / n),
        median: n % 2 ? xs[(n - 1) / 2] : Math.round((xs[n / 2 - 1] + xs[n / 2]) / 2),
        p95: q(95),
    };
}

/* ============================================================================
   5. FAILURE CLASSIFICATION
   ========================================================================== */
function classify({ httpStatus, body, threw, aborted, okText }) {
    if (aborted) return "client_timeout";
    if (threw) return "network";
    if (httpStatus === 429) {
        const st = body?.error?.status;
        const msg = body?.error?.message || "";
        const rd = retryDelaySec(body);
        if (st === "RESOURCE_EXHAUSTED" || /\bquota\b|exceeded/i.test(msg) || (rd != null && rd >= 4)) {
            return "quota_429";
        }
        return "transient_429";
    }
    if (httpStatus === 500 || httpStatus === 503) return "server_5xx";
    if (httpStatus && httpStatus >= 400) return "http_" + httpStatus;
    if (!okText) return "malformed";
    return "ok";
}
function retryDelaySec(body) {
    try {
        const details = body?.error?.details;
        if (Array.isArray(details)) {
            for (const d of details) {
                const rd = d?.retryDelay || d?.retryInfo?.retryDelay;
                const m = typeof rd === "string" ? rd.match(/^(\d+(?:\.\d+)?)s$/) : null;
                if (m) return Math.ceil(parseFloat(m[1]));
            }
        }
    } catch (_) {}
    return null;
}
function usageOf(body) {
    const u = body?.usageMetadata || {};
    return {
        promptTokenCount: u.promptTokenCount ?? null,
        candidatesTokenCount: u.candidatesTokenCount ?? null,
        thoughtsTokenCount: u.thoughtsTokenCount ?? null,
        totalTokenCount: u.totalTokenCount ?? null,
    };
}

/* ============================================================================
   6. ONE NON-STREAMING SAMPLE  (optionally mirrors the app retry loop)
   ========================================================================== */
let CALLS_MADE = 0;
let ABORT_RUN = false;
let ABORT_REASON = null;

async function callNonStream(url, payload, key) {
    const startedAt = nowMs();
    const deadline = startedAt + MIRROR.TOTAL_BUDGET_MS;
    const remaining = () => Math.max(0, deadline - nowMs());
    const maxAttempts = MIRROR_RETRY ? MIRROR.MAX_ATTEMPTS : 1;

    let retryCount = 0;
    const retryDelaysMs = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (CALLS_MADE >= MAX_CALLS) return { class: "skipped_max_calls", retryCount, retryDelaysMs };
        const perAttempt = MIRROR_RETRY
            ? Math.max(1, Math.min(MIRROR.PER_ATTEMPT_TIMEOUT_MS, remaining()))
            : CLIENT_BACKSTOP_MS;
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), perAttempt);
        const t0 = nowMs();
        let httpStatus = null, body = null, threw = false, aborted = false, tHeaders = null, tParsed = null;
        CALLS_MADE++;
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-goog-api-key": key },
                body: JSON.stringify(payload),
                signal: ac.signal,
            });
            tHeaders = nowMs();
            httpStatus = res.status;
            try { body = await res.json(); } catch (_) { body = null; }
            tParsed = nowMs();
        } catch (err) {
            aborted = err && err.name === "AbortError";
            threw = !aborted;
        } finally {
            clearTimeout(timer);
        }

        const okText = !!(body && body.candidates && body.candidates[0]
            && body.candidates[0].content && Array.isArray(body.candidates[0].content.parts)
            && body.candidates[0].content.parts.some((p) => p && typeof p.text === "string" && !p.thought && p.text.trim()));
        const cls = classify({ httpStatus, body, threw, aborted, okText });
        const retryAfter = null; // header not read from fetch Response here; body retryDelay used instead
        const rdSec = retryDelaySec(body);

        if (cls === "ok") {
            const parts = body.candidates[0].content.parts;
            let out = "";
            for (const p of parts) if (p && typeof p.text === "string" && !p.thought) out += p.text;
            return {
                class: "ok",
                httpStatus,
                totalMs: tParsed - startedAt,
                httpArrivalMs: tHeaders - t0,
                parseMs: tParsed - tHeaders,
                attemptMs: tParsed - t0,
                retryCount,
                retryDelaysMs,
                outChars: out.trim().length,
                finishReason: body.candidates[0].finishReason || null,
                usage: usageOf(body),
            };
        }

        if (cls === "quota_429") {
            ABORT_RUN = true;
            ABORT_REASON = "quota_429 (RESOURCE_EXHAUSTED / quota / retryDelay>=4s)";
            return { class: cls, httpStatus, retryCount, retryDelaysMs, retryDelaySec: rdSec, elapsedMs: nowMs() - startedAt };
        }

        const transient = cls === "transient_429" || cls === "server_5xx"
            || (aborted && MIRROR_RETRY);
        const canRetry = MIRROR_RETRY && transient && attempt < maxAttempts && remaining() > (MIRROR.BACKOFF_MS[attempt - 1] || 2600);
        if (canRetry) {
            const backoff = Math.min(MIRROR.BACKOFF_MS[attempt - 1] || 2600, remaining());
            retryCount++;
            retryDelaysMs.push(backoff);
            await sleep(backoff);
            continue;
        }

        return {
            class: cls === "client_timeout" && MIRROR_RETRY ? "per_attempt_timeout" : cls,
            httpStatus,
            retryCount,
            retryDelaysMs,
            retryDelaySec: rdSec,
            aborted,
            elapsedMs: nowMs() - startedAt,
            errStatus: body?.error?.status || null,
        };
    }
    return { class: "exhausted", retryCount, retryDelaysMs, elapsedMs: nowMs() - startedAt };
}

/* ============================================================================
   7. ONE STREAMING SAMPLE (single attempt, NO retry) — TTFT
   ========================================================================== */
async function callStream(url, payload, key) {
    if (CALLS_MADE >= MAX_CALLS) return { class: "skipped_max_calls" };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), CLIENT_BACKSTOP_MS);
    const t0 = nowMs();
    let httpArrivalMs = null, firstChunkMs = null, firstThoughtMs = null, firstContentMs = null, endMs = null;
    let httpStatus = null, chunks = 0, dataEvents = 0, threw = false, aborted = false;
    let lastUsage = null, errBody = null, sawContent = false;
    CALLS_MADE++;
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": key, "Accept": "text/event-stream" },
            body: JSON.stringify(payload),
            signal: ac.signal,
        });
        httpArrivalMs = nowMs() - t0;
        httpStatus = res.status;

        if (!res.ok || !res.body) {
            try { errBody = await res.json(); } catch (_) { errBody = null; }
        } else {
            let buf = "";
            const decoder = new TextDecoder();
            for await (const chunk of res.body) {
                if (firstChunkMs == null) firstChunkMs = nowMs() - t0;
                chunks++;
                buf += decoder.decode(chunk, { stream: true });
                let nl;
                while ((nl = buf.indexOf("\n")) >= 0) {
                    const line = buf.slice(0, nl).trim();
                    buf = buf.slice(nl + 1);
                    if (!line.startsWith("data:")) continue;
                    dataEvents++;
                    const jsonStr = line.slice(5).trim();
                    if (!jsonStr || jsonStr === "[DONE]") continue;
                    let ev = null;
                    try { ev = JSON.parse(jsonStr); } catch (_) { continue; }
                    if (ev.usageMetadata) lastUsage = ev.usageMetadata;
                    const parts = ev?.candidates?.[0]?.content?.parts || [];
                    for (const p of parts) {
                        if (!p || typeof p.text !== "string" || !p.text) continue;
                        if (p.thought) { if (firstThoughtMs == null) firstThoughtMs = nowMs() - t0; }
                        else { if (firstContentMs == null) { firstContentMs = nowMs() - t0; sawContent = true; } }
                    }
                }
            }
            endMs = nowMs() - t0;
        }
    } catch (err) {
        aborted = err && err.name === "AbortError";
        threw = !aborted;
    } finally {
        clearTimeout(timer);
    }

    if (aborted) return { class: "client_timeout", httpStatus, httpArrivalMs, firstChunkMs, firstContentMs, endMs, chunks };
    if (threw) return { class: "network", httpStatus, httpArrivalMs };
    if (httpStatus === 429) {
        const cls = classify({ httpStatus, body: errBody, threw: false, aborted: false, okText: false });
        if (cls === "quota_429") { ABORT_RUN = true; ABORT_REASON = "quota_429 (stream probe)"; }
        return { class: cls, httpStatus, httpArrivalMs, retryDelaySec: retryDelaySec(errBody), errStatus: errBody?.error?.status || null };
    }
    if (httpStatus === 500 || httpStatus === 503) return { class: "server_5xx", httpStatus, httpArrivalMs };
    if (httpStatus && httpStatus >= 400) return { class: "http_" + httpStatus, httpStatus, httpArrivalMs, errStatus: errBody?.error?.status || null };
    if (!sawContent) return { class: "malformed", httpStatus, httpArrivalMs, firstChunkMs, endMs, chunks };

    return {
        class: "ok",
        httpStatus,
        httpArrivalMs,
        firstChunkMs,
        firstThoughtMs,
        firstContentMs,
        endMs,
        chunks,
        dataEvents,
        usage: {
            promptTokenCount: lastUsage?.promptTokenCount ?? null,
            candidatesTokenCount: lastUsage?.candidatesTokenCount ?? null,
            thoughtsTokenCount: lastUsage?.thoughtsTokenCount ?? null,
            totalTokenCount: lastUsage?.totalTokenCount ?? null,
        },
    };
}

/* ============================================================================
   8. DRY-RUN  (no network — proves isolation)
   ========================================================================== */
function sha12(s) { return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 12); }
const estTok = (chars) => Math.round(chars / 4);

function dryRun(real) {
    const cats = categories(real);
    console.log("K3 LATENCY HARNESS — DRY RUN (no API calls)\n");
    console.log("Model               :", real.model, real.usesEnvModelOverride ? "(honors GEMINI_MODEL override, like the app)" : "");
    console.log("Non-stream endpoint :", real.nonStreamUrl.replace(/\?.*$/, ""));
    console.log("Stream endpoint     :", real.streamUrl);
    console.log("generationConfig    :", JSON.stringify(real.generationConfig), "  (read verbatim from api/generate.js — NOT modified)");
    console.log("MAX_INPUT_CHARS     :", real.MAX_INPUT_CHARS);
    console.log("VALID_MODES         :", JSON.stringify(real.VALID_MODES));
    console.log("");
    console.log("cat | mode+variant             | sysPrompt chars | ~sysTok | sha256/12    | input chars | ~inTok");
    console.log("----+--------------------------+-----------------+---------+--------------+-------------+-------");
    for (const c of cats) {
        const sp = real.buildSystemPrompt(c.mode, c.variant === "-" ? undefined : c.variant);
        const mv = (c.mode + (c.variant !== "-" ? "/" + c.variant : "")).padEnd(24);
        console.log(
            ` ${c.id}  | ${mv} | ${String(sp.length).padStart(15)} | ${String(estTok(sp.length)).padStart(7)} | ${sha12(sp)} | ${String(c.input.length).padStart(11)} | ${String(estTok(c.input.length)).padStart(5)}`
        );
    }
    console.log("");
    console.log("SECURITY / ISOLATION PROOF");
    console.log("  [ok] api/generate.js handler body is sliced off BEFORE evaluation");
    console.log("  [ok] declaration slice asserted free of: import / import() / require() / fetch() / process.env");
    console.log("  [ok] vm sandbox has no process, no require, no fetch, no timers (Object.create(null) context)");
    console.log("  [ok] no DB / Neon / Vercel module is imported anywhere in this harness");
    console.log("  [ok] network destinations limited to:", real.endpointHost);
    console.log("  [ok] .env.local is READ-ONLY here (key parse); this harness never writes any file except the report");
    console.log("  [ok] report path (only on live run): tests/k3-latency-report.<timestamp>.{json,md}  (untracked)");
    console.log("");
    const kd = loadKey();
    if (!kd.present) {
        console.log("KEY STATUS          : NOT PRESENT");
        console.log("");
        console.log("DIAGNOSTIC HARNESS READY — requires temporary quota-adequate Gemini key.");
    } else {
        console.log("KEY STATUS          : present via", kd.source, "(value not shown)");
        console.log("");
        console.log("DIAGNOSTIC HARNESS READY — run without --dry-run to measure.");
    }
}

/* ============================================================================
   9. LIVE RUN
   ========================================================================== */
async function liveRun(real, kd) {
    const cats = categories(real);
    const startedIso = new Date().toISOString();
    const modes = MODE === "both" ? ["nonstream", "stream"] : [MODE];
    const results = []; // { cat, mode, sample, ...metrics }
    let firstCall = true;

    outer:
    for (const c of cats) {
        const sp = real.buildSystemPrompt(c.mode, c.variant === "-" ? undefined : c.variant);
        const payload = {
            systemInstruction: { parts: [{ text: sp }] },
            contents: [{ role: "user", parts: [{ text: c.input }] }],
            generationConfig: real.generationConfig,
        };
        for (const m of modes) {
            let success = 0;
            for (let s = 1; s <= SAMPLES * 2 && success < SAMPLES; s++) {
                if (ABORT_RUN || CALLS_MADE >= MAX_CALLS) break outer;
                if (!firstCall) await sleep(SPACING_MS);
                firstCall = false;
                const r = m === "nonstream"
                    ? await callNonStream(real.nonStreamUrl, payload, kd.key)
                    : await callStream(real.streamUrl, payload, kd.key);
                results.push({ cat: c.id, catLabel: c.label, mode: m, sample: s, ...r });
                console.log(`  cat${c.id} ${m.padEnd(9)} #${s}: ${r.class}` +
                    (r.class === "ok"
                        ? (m === "nonstream"
                            ? `  total=${r.totalMs}ms httpArr=${r.httpArrivalMs}ms retries=${r.retryCount} out=${r.outChars} thoughts=${r.usage.thoughtsTokenCount}`
                            : `  httpArr=${r.httpArrivalMs}ms 1stChunk=${r.firstChunkMs}ms 1stContent=${r.firstContentMs}ms end=${r.endMs}ms chunks=${r.chunks} thoughts=${r.usage.thoughtsTokenCount}`)
                        : `  ${r.httpStatus ?? ""} ${r.errStatus ?? ""} ${r.retryDelaySec != null ? "retryDelay=" + r.retryDelaySec + "s" : ""}`));
                if (r.class === "ok") success++;
                if (r.class === "quota_429" || ABORT_RUN) break outer;
                if (r.class === "transient_429" || r.class === "server_5xx") await sleep(Math.max(SPACING_MS, 20000));
            }
        }
    }

    const report = buildReport({ real, startedIso, results });
    const base = path.join(__dirname, `k3-latency-report.${startedIso.replace(/[:.]/g, "-")}`);
    writeFileSync(base + ".json", JSON.stringify(report, null, 2), "utf8");
    writeFileSync(base + ".md", report.markdown, "utf8");
    console.log("\nReport written:");
    console.log("  " + path.relative(REPO, base + ".json"));
    console.log("  " + path.relative(REPO, base + ".md"));
    if (ABORT_RUN) console.log("\nRUN ABORTED EARLY:", ABORT_REASON);
    console.log("\nReminder: if you placed GEMINI_API_KEY in .env.local for this run, blank it now and re-check `git status`.");
}

/* ============================================================================
   10. REPORT BUILDER  (+ K3 conclusion with mandatory guardrails)
   ========================================================================== */
function buildReport({ real, startedIso, results }) {
    const byCatMode = {};
    for (const r of results) {
        const k = r.cat + "|" + r.mode;
        (byCatMode[k] ||= []).push(r);
    }
    const catStats = [];
    for (const c of categories(real)) {
        for (const mode of ["nonstream", "stream"]) {
            const rs = byCatMode[c.id + "|" + mode] || [];
            if (!rs.length) continue;
            const ok = rs.filter((r) => r.class === "ok");
            const fails = rs.filter((r) => r.class !== "ok");
            const failClasses = {};
            for (const f of fails) failClasses[f.class] = (failClasses[f.class] || 0) + 1;
            const row = {
                category: c.id, label: c.label, mode,
                nSuccess: ok.length, nFail: fails.length, failClasses,
                retryRate: rs.length ? +(rs.filter((r) => (r.retryCount || 0) > 0).length / rs.length).toFixed(2) : null,
                rate429: rs.length ? +(rs.filter((r) => r.class === "transient_429" || r.class === "quota_429").length / rs.length).toFixed(2) : null,
                timeoutRate: rs.length ? +(rs.filter((r) => r.class === "client_timeout" || r.class === "per_attempt_timeout").length / rs.length).toFixed(2) : null,
            };
            if (mode === "nonstream") {
                row.totalMs = stats(ok.map((r) => r.totalMs));
                row.httpArrivalMs = stats(ok.map((r) => r.httpArrivalMs));
                row.parseMs = stats(ok.map((r) => r.parseMs));
                row.thoughtsTok = stats(ok.map((r) => r.usage?.thoughtsTokenCount).filter((x) => x != null));
                row.promptTok = stats(ok.map((r) => r.usage?.promptTokenCount).filter((x) => x != null));
                row.candTok = stats(ok.map((r) => r.usage?.candidatesTokenCount).filter((x) => x != null));
                row.outChars = stats(ok.map((r) => r.outChars));
            } else {
                row.httpArrivalMs = stats(ok.map((r) => r.httpArrivalMs));
                row.firstChunkMs = stats(ok.map((r) => r.firstChunkMs));
                row.firstThoughtMs = stats(ok.map((r) => r.firstThoughtMs).filter((x) => x != null));
                row.firstContentMs = stats(ok.map((r) => r.firstContentMs));
                row.endMs = stats(ok.map((r) => r.endMs));
                row.chunks = stats(ok.map((r) => r.chunks));
                row.thoughtsTok = stats(ok.map((r) => r.usage?.thoughtsTokenCount).filter((x) => x != null));
            }
            catStats.push(row);
        }
    }

    // failure tally (global)
    const failTally = {};
    for (const r of results) failTally[r.class] = (failTally[r.class] || 0) + 1;

    // ---- K3 conclusion (guardrailed) --------------------------------------
    const nsOk = results.filter((r) => r.mode === "nonstream" && r.class === "ok");
    const longPP = nsOk.filter((r) => r.cat === 4 || r.cat === 5);
    const longForm = nsOk.filter((r) => r.cat === 3);
    const allTotals = nsOk.map((r) => r.totalMs);
    const overThresh = (t) => allTotals.filter((x) => x > t).length;
    const haveLong = longPP.length >= 1 && longForm.length >= 1;

    const k3 = {
        dataCoverage: {
            nonstreamOkSamples: nsOk.length,
            longPflegeplanungOkSamples: longPP.length,
            longFormulierenOkSamples: longForm.length,
            streamingOkSamples: results.filter((r) => r.mode === "stream" && r.class === "ok").length,
        },
        perAttemptTimeoutJustified:
            allTotals.length === 0
                ? "INSUFFICIENT DATA — no successful non-streaming samples."
                : `Observed non-stream total: min=${Math.min(...allTotals)}ms median=${stats(allTotals).median}ms max=${Math.max(...allTotals)}ms. ` +
                  `Samples exceeding 22000ms: ${overThresh(22000)}/${allTotals.length}. ` +
                  `PER_ATTEMPT_TIMEOUT_MS=22000 is ${overThresh(22000) === 0 ? "not yet shown to truncate any measured success" : "at risk — measured successes exceeded it"}.`,
        lowerTimeoutRisk:
            !haveLong
                ? "CANNOT RECOMMEND lowering PER_ATTEMPT_TIMEOUT_MS — mandatory long pflegeplanung (cat 4/5) AND long formulieren (cat 3) successful samples are missing. Re-run those categories with adequate quota."
                : {
                    exceed15000: overThresh(15000),
                    exceed12000: overThresh(12000),
                    exceed10000: overThresh(10000),
                    ofNSamples: allTotals.length,
                    longPPmax: Math.max(...longPP.map((r) => r.totalMs)),
                    longFormMax: Math.max(...longForm.map((r) => r.totalMs)),
                    note: "A candidate lower bound must sit safely above longPPmax and longFormMax with margin for a cold Gemini and one internal retry. Do not pick a value from short-formulieren data.",
                },
        slowCauseAttribution: attributeSlow(results),
        streamingUseful: streamingVerdict(results),
        ttftDistinguishesState: ttftVerdict(results),
        notes: [
            "This harness measures Gemini latency ONLY. It does NOT include PflegeDoc backend overhead (auth + DB + rate-limit; prior diagnostic: ~0.2-0.45s warm, up to ~1.7s cold) nor real device/network RTT from an iPhone/iPad.",
            "generationConfig, model, prompt and thinking behaviour are the current production values — nothing was changed.",
            "p95 is labelled 'insufficient' when n<" + P95_MIN_N + " and is never fabricated.",
        ],
    };

    const markdown = renderMarkdown({ real, startedIso, catStats, failTally, k3, results });
    return {
        timestamp: startedIso,
        model: real.model,
        endpoints: { nonstream: real.nonStreamUrl.replace(/\?.*$/, ""), stream: real.streamUrl },
        generationConfig: real.generationConfig,
        maxInputChars: real.MAX_INPUT_CHARS,
        mirrorRetry: MIRROR_RETRY,
        mirrorConstants: MIRROR,
        clientBackstopMs: CLIENT_BACKSTOP_MS,
        samplesTarget: SAMPLES,
        spacingMs: SPACING_MS,
        callsMade: CALLS_MADE,
        abortedEarly: ABORT_RUN ? ABORT_REASON : false,
        categoryStats: catStats,
        failureTally: failTally,
        rawResults: results,
        k3Conclusion: k3,
        markdown,
    };
}

function attributeSlow(results) {
    const ns = results.filter((r) => r.mode === "nonstream" && r.class === "ok");
    const slow = ns.filter((r) => r.totalMs > 12000);
    if (!ns.length) return "INSUFFICIENT DATA (no successful non-stream samples).";
    if (!slow.length) return "No non-stream success exceeded 12s in this batch — no slow cases to attribute.";
    const withRetry = slow.filter((r) => (r.retryCount || 0) > 0).length;
    const st = results.filter((r) => r.mode === "stream" && r.class === "ok");
    const hiThought = slow.filter((r) => (r.usage?.thoughtsTokenCount || 0) >= 800).length;
    return {
        slowSamples: slow.length,
        causedByRetry_C: withRetry,
        highThinking_D: hiThought,
        streamSamplesForAB: st.length,
        interpretation:
            withRetry === slow.length
                ? "C (transient failure + retry) dominates the slow cases."
                : st.length
                    ? "Mixed — compare stream firstContentMs vs endMs: high firstContentMs => A (slow first token); low firstContentMs but high endMs => B (slow total generation)."
                    : "Need streaming samples to separate A (slow first token) from B (slow total generation).",
    };
}
function streamingVerdict(results) {
    const st = results.filter((r) => r.mode === "stream" && r.class === "ok");
    if (!st.length) return "INSUFFICIENT DATA — no successful streaming samples.";
    const gap = st.map((r) => (r.endMs != null && r.firstContentMs != null) ? r.endMs - r.firstContentMs : null).filter((x) => x != null);
    const g = stats(gap);
    return {
        okStreamSamples: st.length,
        firstChunkMs: stats(st.map((r) => r.firstChunkMs)),
        firstContentMs: stats(st.map((r) => r.firstContentMs)),
        endMs: stats(st.map((r) => r.endMs)),
        generationSpanAfterFirstContentMs: g,
        verdict: g.median != null && g.median > 1500
            ? "USEFUL — meaningful generation time elapses AFTER first content, so a server-side stream aggregator could report progress and abort only on a true no-start."
            : "MARGINAL — first content arrives close to stream end; streaming would add complexity for little UX gain. Re-check with long pflegeplanung.",
    };
}
function ttftVerdict(results) {
    const st = results.filter((r) => r.mode === "stream" && r.class === "ok");
    if (!st.length) return "INSUFFICIENT DATA — no successful streaming samples.";
    const fc = stats(st.map((r) => r.firstChunkMs));
    const cc = stats(st.map((r) => r.firstContentMs));
    return {
        firstChunkMs: fc,
        firstContentMs: cc,
        verdict: (fc.median != null)
            ? "YES — a first-chunk deadline (~firstChunkMs p95 + margin) can distinguish 'model has not started' from 'model is actively generating'. Thought parts, when present, arrive as their own chunks and are visible separately (firstThoughtMs)."
            : "Cannot confirm — firstChunkMs not captured.",
    };
}

function fmt(s) {
    if (s == null) return "n/a";
    if (typeof s === "string") return s;
    if (typeof s !== "object") return String(s);
    const p95 = typeof s.p95 === "string" ? s.p95 : (s.p95 ?? "n/a");
    return `n=${s.n} min=${s.min ?? "n/a"} med=${s.median ?? "n/a"} mean=${s.mean ?? "n/a"} p95=${p95} max=${s.max ?? "n/a"}`;
}
function renderMarkdown({ real, startedIso, catStats, failTally, k3 }) {
    const L = [];
    L.push(`# PflegeDoc — K3 Gemini Latency Diagnostic`);
    L.push("");
    L.push(`- Timestamp: ${startedIso}`);
    L.push(`- Model: \`${real.model}\``);
    L.push(`- Non-stream endpoint: \`${real.nonStreamUrl.replace(/\?.*$/, "")}\``);
    L.push(`- Stream endpoint: \`${real.streamUrl}\``);
    L.push(`- generationConfig (verbatim, unchanged): \`${JSON.stringify(real.generationConfig)}\``);
    L.push(`- MAX_INPUT_CHARS: ${real.MAX_INPUT_CHARS}`);
    L.push(`- Mirror app retry loop (non-stream): ${MIRROR_RETRY} — ${JSON.stringify(MIRROR)}`);
    L.push(`- Client backstop (stream abort): ${CLIENT_BACKSTOP_MS} ms`);
    L.push(`- Samples target / spacing: ${SAMPLES} / ${SPACING_MS} ms`);
    L.push(`- Total API calls made: ${CALLS_MADE}`);
    L.push(`- Aborted early: ${ABORT_RUN ? ABORT_REASON : "no"}`);
    L.push("");
    L.push(`## Per-category statistics`);
    for (const r of catStats) {
        L.push("");
        L.push(`### cat ${r.category} — ${r.label} — ${r.mode}`);
        L.push(`- success/fail: ${r.nSuccess}/${r.nFail}  failClasses=${JSON.stringify(r.failClasses)}`);
        L.push(`- retryRate=${r.retryRate} rate429=${r.rate429} timeoutRate=${r.timeoutRate}`);
        if (r.mode === "nonstream") {
            L.push(`- total ms: ${fmt(r.totalMs)}`);
            L.push(`- http arrival ms: ${fmt(r.httpArrivalMs)}`);
            L.push(`- json parse ms: ${fmt(r.parseMs)}`);
            L.push(`- prompt tok: ${fmt(r.promptTok)}`);
            L.push(`- candidates tok: ${fmt(r.candTok)}`);
            L.push(`- thoughts tok: ${fmt(r.thoughtsTok)}`);
            L.push(`- output chars: ${fmt(r.outChars)}`);
        } else {
            L.push(`- http arrival ms: ${fmt(r.httpArrivalMs)}`);
            L.push(`- first SSE chunk ms: ${fmt(r.firstChunkMs)}`);
            L.push(`- first THOUGHT chunk ms: ${fmt(r.firstThoughtMs)}`);
            L.push(`- first CONTENT chunk ms: ${fmt(r.firstContentMs)}`);
            L.push(`- stream end ms: ${fmt(r.endMs)}`);
            L.push(`- chunks: ${fmt(r.chunks)}`);
            L.push(`- thoughts tok: ${fmt(r.thoughtsTok)}`);
        }
    }
    L.push("");
    L.push(`## Global failure tally`);
    L.push("```json"); L.push(JSON.stringify(failTally, null, 2)); L.push("```");
    L.push("");
    L.push(`## K3 conclusion`);
    L.push("```json"); L.push(JSON.stringify(k3, null, 2)); L.push("```");
    L.push("");
    L.push(`### Answers to the K3 questions`);
    L.push(`1. **PER_ATTEMPT_TIMEOUT_MS = 22000 justified?** ${typeof k3.perAttemptTimeoutJustified === "string" ? k3.perAttemptTimeoutJustified : JSON.stringify(k3.perAttemptTimeoutJustified)}`);
    L.push(`2. **Cause of slow requests (A/B/C/D/E/F):** ${JSON.stringify(k3.slowCauseAttribution)}`);
    L.push(`3. **Risk of lowering to 15s/12s/10s:** ${typeof k3.lowerTimeoutRisk === "string" ? k3.lowerTimeoutRisk : JSON.stringify(k3.lowerTimeoutRisk)}`);
    L.push(`4. **Is streaming useful?** ${JSON.stringify(k3.streamingUseful)}`);
    L.push(`5. **Can TTFT distinguish not-started vs generating?** ${JSON.stringify(k3.ttftDistinguishesState)}`);
    L.push("");
    L.push(`> ${k3.notes.join("\n> ")}`);
    L.push("");
    return L.join("\n");
}

/* ============================================================================
   MAIN
   ========================================================================== */
(async function main() {
    let real;
    try {
        real = loadRealPromptModule();
    } catch (e) {
        console.error("FATAL: could not extract the real prompt builder:", e.message);
        process.exit(2);
    }

    if (DRY_RUN) { dryRun(real); process.exit(0); }

    const kd = loadKey();
    if (!kd.present) {
        // Still print the dry-run proof so the state is fully visible.
        dryRun(real);
        process.exit(0);
    }

    console.log("K3 LATENCY HARNESS — LIVE RUN");
    console.log(`model=${real.model} categories=[${CATS.join(",")}] mode=${MODE} samples=${SAMPLES} spacing=${SPACING_MS}ms mirrorRetry=${MIRROR_RETRY} maxCalls=${MAX_CALLS}`);
    console.log(`key source: ${kd.source} (value not shown)\n`);
    await liveRun(real, kd);
})();
