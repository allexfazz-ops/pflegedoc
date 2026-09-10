/**
 * PflegeDoc — Generation UX (elapsed-time status + loading-panel scroll)
 * -----------------------------------------------------------------------------
 * Focused, framework-free checks for the two SAFE-NOW UX additions:
 *   1. truthful elapsed-time status in #processing
 *   2. scroll #processing into view when setLoading(true) runs
 *
 * Pure-logic assertions + static wiring assertions over index.html (same style
 * as tests/security-suite.mjs). No DOM, no network, no app execution.
 *   node tests/generation-ux.mjs
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

/* -------- 1. Pure logic: elapsed seconds + which message key at a given time -- */
const ELAPSED_LONG_THRESHOLD_S = 15; // must match index.html
function elapsedSecs(startedAt, now) { return Math.max(0, Math.floor((now - startedAt) / 1000)); }
function elapsedKey(secs) { return secs >= ELAPSED_LONG_THRESHOLD_S ? "proc.elapsed.long" : "proc.elapsed"; }

ok("elapsed: real wall-clock seconds (0s at start)", elapsedSecs(1000, 1000) === 0);
ok("elapsed: 5s after 5200ms", elapsedSecs(0, 5200) === 5);
ok("elapsed: never negative on clock skew", elapsedSecs(10000, 9000) === 0);
ok("key: < 15s -> proc.elapsed", elapsedKey(0) === "proc.elapsed" && elapsedKey(14) === "proc.elapsed");
ok("key: >= 15s -> proc.elapsed.long", elapsedKey(15) === "proc.elapsed.long" && elapsedKey(40) === "proc.elapsed.long");
ok("message text changes exactly once (at the threshold), not every second",
    ["proc.elapsed", "proc.elapsed"].every((k, i) => elapsedKey(i) === k) && elapsedKey(15) !== elapsedKey(14));

/* -------- 2. Static wiring in index.html ------------------------------------- */
// timer state + helpers exist
ok("elapsedTimer state declared", /let elapsedTimer = null;/.test(html));
ok("threshold constant declared and documented (15s)", /const ELAPSED_LONG_THRESHOLD_S = 15;/.test(html));
ok("stopElapsed() clears the interval and nulls it",
    /function stopElapsed\(\)\s*\{\s*if \(elapsedTimer\) \{ clearInterval\(elapsedTimer\); elapsedTimer = null; \}\s*\}/.test(html));

// started in setLoading(true), guarded against duplicates
const loadingBranch = (html.match(/if \(loading\) \{[\s\S]*?\} else \{[\s\S]*?\n    \}/) || [""])[0];
ok("setLoading(true): stopElapsed() BEFORE creating the interval (no duplicate intervals)",
    loadingBranch.indexOf("stopElapsed()") >= 0 &&
    loadingBranch.indexOf("stopElapsed()") < loadingBranch.indexOf("setInterval(renderElapsed, 1000)"));
ok("setLoading(true): elapsedStartedAt = Date.now() (real elapsed, not fake)",
    /elapsedStartedAt = Date\.now\(\);/.test(loadingBranch));
ok("setLoading(true): immediate render then 1s interval",
    /renderElapsed\(\);/.test(loadingBranch) &&
    /elapsedTimer = setInterval\(renderElapsed, 1000\);/.test(loadingBranch) &&
    loadingBranch.indexOf("renderElapsed();") < loadingBranch.indexOf("setInterval(renderElapsed, 1000)"));
ok("setLoading(true): #processing scrolled into view, block:'center'",
    /proc\.scrollIntoView\(\{ block: 'center' \}\)/.test(loadingBranch));
ok("setLoading(true): scroll does NOT use behavior:'smooth' (reduced-motion safe)",
    !/scrollIntoView\(\{[^}]*smooth/.test(loadingBranch));
ok("setLoading(true): aria-busy set on #processing", /proc\.setAttribute\('aria-busy', 'true'\)/.test(loadingBranch));

// stopped on BOTH success and failure: setLoading(false) is the only always-run point
const elseBranch = (html.match(/\} else \{\s*\n\s*stopElapsed\(\);[\s\S]*?\n    \}/) || [""])[0];
ok("setLoading(false): stopElapsed() runs (covers success AND failure via generateDoc finally)",
    /\} else \{\s*\n\s*stopElapsed\(\);/.test(html));
ok("setLoading(false): aria-busy removed", /proc\.removeAttribute\('aria-busy'\)/.test(elseBranch));
ok("finishProcessingSteps() also stops the timer (success path, promptly)",
    /function finishProcessingSteps\(\)\s*\{[\s\S]*?stopElapsed\(\);[\s\S]*?\}/.test(html));

// no unmatched interval anywhere new
const setIntervalCount = (html.match(/setInterval\(/g) || []).length;
const clearElapsedCount = (html.match(/clearInterval\(elapsedTimer\)/g) || []).length;
ok("exactly one setInterval added and it is the elapsed timer", setIntervalCount === 1);
ok("the elapsed interval has a clearInterval", clearElapsedCount >= 1);

/* -------- 3. Accessibility markup ------------------------------------------- */
ok("#procElapsedMsg present (announced via existing #processing aria-live=polite)",
    /<span id="procElapsedMsg"><\/span>/.test(html));
ok("#procElapsedNum present and aria-hidden (per-second churn NOT announced)",
    /<span id="procElapsedNum" aria-hidden="true"><\/span>/.test(html));
ok("#processing still has aria-live=\"polite\" (existing region reused, not replaced)",
    /id="processing"[^>]*aria-live="polite"/.test(html));
ok("no second competing live region added (no new role=\"status\"/aria-live in processing markup)",
    !/processing__elapsed[^>]*aria-live/.test(html) && !/procElapsed(Msg|Num)"[^>]*role="status"/.test(html));

/* -------- 4. i18n: EN / DE / RO complete, no accidental hardcoding --------- */
for (const [loc, prefix, longMsg] of [
    ["de", "KI verarbeitet", "Das dauert etwas länger als üblich"],
    ["en", "AI is processing", "This is taking a little longer than usual"],
    ["ro", "AI procesează", "Durează puțin mai mult decât de obicei"],
]) {
    ok(`i18n ${loc}: proc.elapsed present`, html.includes(`'proc.elapsed': '${prefix}'`));
    ok(`i18n ${loc}: proc.elapsed.long present`, html.includes(`'proc.elapsed.long': '${longMsg}'`));
}
ok("visible string is composed from t() + seconds (not a hardcoded language)",
    /t\(secs >= ELAPSED_LONG_THRESHOLD_S \? 'proc\.elapsed\.long' : 'proc\.elapsed'\)/.test(html) &&
    /numEl\.textContent = ' … ' \+ secs \+ ' s';/.test(html));

/* -------- 5. Safety: no generation/logic/timeout changes ------------------- */
ok("client timeout still 55000", /TIMEOUT_MS: 55000/.test(html));
ok("no fake percentage progress introduced", !/%\s*<\/|progress.*percent|Fortschritt.*%/i.test(html.match(/processing__elapsed[\s\S]{0,400}/)?.[0] || ""));
ok("K5 generating guard intact", /if \(generating\) return;\s*\n\s*generating = true;/.test(html));
ok("K1 intact (no client-side 503 retry re-introduced)", !/_retry\b/.test(html) && /K1: 503/.test(html));
ok("result still rendered only after callGemini resolves (finishProcessingSteps before output set)",
    html.indexOf("finishProcessingSteps();") < html.indexOf("outputDiv.textContent = text;"));

console.log("\n----------------------------------------");
console.log(`TOTAL: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
