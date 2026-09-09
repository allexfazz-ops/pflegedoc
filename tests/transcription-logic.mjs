/**
 * tests/transcription-logic.mjs
 * -----------------------------------------------------------------------------
 * Teste unitare pentru LOGICA PURĂ din calea de dictare (Web Speech API) din
 * index.html. Fără browser, fără rețea, fără DB. Rulare:
 *
 *   node tests/transcription-logic.mjs
 *
 * Ce acoperă:
 *   - joinSmart()  — extras REAL din index.html (se rupe dacă funcția se schimbă)
 *   - acumularea rezultatelor finale + garda anti-dublare (recConsumedFinals)
 *   - decizia de flush a interimului la stop (finalizedInSession === finalizedAtStop)
 *   - garda de sesiune (recGen) care împiedică un callback vechi să scrie
 *
 * Reimplementările de mai jos oglindesc EXACT logica din index.html
 * (secțiunea „3. WEB SPEECH API" + generateDoc). Dacă modifici acea logică,
 * actualizează și acest fișier.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; console.log("  FAIL  " + name + (extra ? "  -> " + extra : "")); }
}
function section(t) { console.log("\n=== " + t + " ==="); }

/* ---- joinSmart: extras REAL din index.html ------------------------------- */
const jsMatch = html.match(/function joinSmart\(a, b\) \{[\s\S]*?\n\}/);
if (!jsMatch) { console.error("Nu am găsit joinSmart în index.html"); process.exit(2); }
// eslint-disable-next-line no-eval
const joinSmart = eval("(" + jsMatch[0].replace("function joinSmart", "function") + ")");

// processChunk cu voice-commands OFF (cazul implicit): doar trim.
const processChunk = (c) => String(c).trim();

/* ---- Model pur al acumulării de rezultate (oglindește recognition.onresult) */
function makeSession() {
    return { finalizedInSession: "", recConsumedFinals: 0, lastInterim: "" };
}
// event = { resultIndex, results: [{ isFinal, transcript }] }  (cumulativ, ca în spec)
function onResult(s, event) {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const chunk = res && res.transcript ? res.transcript : "";
        if (res && res.isFinal) {
            if (i < s.recConsumedFinals) continue;      // anti-dublare
            s.recConsumedFinals = i + 1;
            s.finalizedInSession = joinSmart(s.finalizedInSession, processChunk(chunk));
        } else {
            interim += chunk;
        }
    }
    s.lastInterim = interim;
}

/* ---- Model pur al deciziei de flush (oglindește stopAndFlush.finalize) ---- */
function flushConsolidate(s, baseText, finalizedAtStop, recGen, myGen, textareaNow) {
    if (recGen !== myGen) return textareaNow;            // sesiune nouă -> nu atinge textarea
    let tail = s.finalizedInSession.trim();
    if (s.lastInterim.trim() && s.finalizedInSession === finalizedAtStop) {
        tail = joinSmart(tail, processChunk(s.lastInterim));
    }
    return joinSmart(baseText, tail);
}

/* ======================================================================== */

section("joinSmart — fără pierdere de cuvinte la concatenare");
ok("două fraze finale se unesc cu un spațiu",
    joinSmart("Pacientul prezintă", "dureri abdominale") === "Pacientul prezintă dureri abdominale");
ok("punctuația inițială nu introduce spațiu",
    joinSmart("dureri abdominale", ". Tensiune 130/80") === "dureri abdominale. Tensiune 130/80");
ok("prefixul gol întoarce b", joinSmart("", "abc") === "abc");
ok("sufixul gol întoarce a", joinSmart("abc", "") === "abc");

section("Test A — user vorbește o frază și apasă Transcriere imediat");
{
    // baseText gol; două rezultate finale sosesc (a doua ca eveniment cumulativ)
    const s = makeSession();
    onResult(s, { resultIndex: 0, results: [{ isFinal: false, transcript: "Pacientul prezintă" }] });
    onResult(s, { resultIndex: 0, results: [{ isFinal: true, transcript: "Pacientul prezintă dureri abdominale" }] });
    // stop -> onend rezolvă flush; niciun interim rămas
    const finalizedAtStop = s.finalizedInSession;
    const out = flushConsolidate(s, "", finalizedAtStop, 5, 5, "");
    ok("toate cuvintele ajung în textul consolidat",
        out === "Pacientul prezintă dureri abdominale", JSON.stringify(out));
}

section("Test B — există interimResult când se apasă Stop (browser NU îl finalizează)");
{
    const s = makeSession();
    onResult(s, { resultIndex: 0, results: [{ isFinal: true, transcript: "Pacientul are febră" }] });
    // ultimul fragment rămâne interim (Safari nu-l promovează la final)
    onResult(s, { resultIndex: 1, results: [
        { isFinal: true, transcript: "Pacientul are febră" },
        { isFinal: false, transcript: "și tuse seacă" },
    ] });
    const finalizedAtStop = s.finalizedInSession;          // snapshot la stop()
    // niciun final nou după stop -> finalizedInSession === finalizedAtStop -> interimul se include
    const out = flushConsolidate(s, "", finalizedAtStop, 3, 3, "Pacientul are febră și tuse seacă");
    ok("interimul nu se pierde",
        out === "Pacientul are febră și tuse seacă", JSON.stringify(out));
}

section("Test C — onend înaintea unui final întârziat: nu se pierde, nu se dublează");
{
    const s = makeSession();
    onResult(s, { resultIndex: 0, results: [{ isFinal: false, transcript: "durere în piept" }] });
    const finalizedAtStop = s.finalizedInSession;          // "" — snapshot la stop()
    // final întârziat sosește DUPĂ stop (flushWaiters încă active -> onResult rulează)
    onResult(s, { resultIndex: 0, results: [{ isFinal: true, transcript: "durere în piept" }] });
    // finalizedInSession s-a schimbat față de snapshot -> NU re-adăugăm lastInterim
    const out = flushConsolidate(s, "", finalizedAtStop, 7, 7, "durere în piept");
    ok("finalul întârziat e păstrat", out === "durere în piept", JSON.stringify(out));
    ok("nu apare duplicat", (out.match(/durere în piept/g) || []).length === 1, JSON.stringify(out));

    // în plus: re-livrarea aceluiași index final NU dublează (garda recConsumedFinals)
    const before = s.finalizedInSession;
    onResult(s, { resultIndex: 0, results: [{ isFinal: true, transcript: "durere în piept" }] });
    ok("re-livrarea aceluiași final nu schimbă nimic", s.finalizedInSession === before);
}

section("Test D/E — sesiune nouă / Stop: un callback vechi nu scrie în textarea");
{
    const s = makeSession();
    onResult(s, { resultIndex: 0, results: [{ isFinal: true, transcript: "text vechi" }] });
    const finalizedAtStop = s.finalizedInSession;
    // între stop și rezolvarea flush-ului, utilizatorul a repornit dictarea -> recGen a crescut
    const myGen = 4, recGenNow = 5;
    const textareaNow = "text nou tastat de utilizator";
    const out = flushConsolidate(s, "", finalizedAtStop, recGenNow, myGen, textareaNow);
    ok("finalize() abandonează dacă recGen s-a schimbat", out === textareaNow, JSON.stringify(out));
}

section("Static — index.html conține noile mecanisme");
ok("recGen (ID de sesiune) există", /let recGen = 0;/.test(html));
ok("safeStart cu gardă gen + un singur start", /function safeStart\(gen\)[\s\S]*if \(recRunning \|\| recStartInFlight\) return;/.test(html));
ok("stopAndFlush() există și e Promise", /function stopAndFlush\(\) \{\s*return new Promise/.test(html));
ok("generateDoc așteaptă stopAndFlush înainte de a citi textul",
    /if \(recBusy\(\)\) \{\s*await stopAndFlush\(\);\s*\}\s*const userInput = userInputEl\.value\.trim\(\)/.test(html));
ok("onend: restart plafonat la REC_MAX_RESTARTS", /recRestartAttempts >= REC_MAX_RESTARTS/.test(html) && /const REC_MAX_RESTARTS = 8;/.test(html));
ok("onend: callback vechi blocat prin myGen !== recGen", /if \(myGen !== recGen \|\| !isRecording/.test(html));
ok("onerror not-allowed nu lasă isRecording=true", /err === 'not-allowed'[\s\S]*isRecording = false;/.test(html));
ok("hint Safari o singură dată per sesiune", /_safariHintShown/.test(html) && /if \(_isAppleWebKit && !_safariHintShown\)/.test(html));
ok("chei i18n noi în DE/EN/RO",
    (html.match(/'mic\.safariHint':/g) || []).length === 3 && (html.match(/'mic\.restartFailed':/g) || []).length === 3);
ok("dedup finale: gardă recConsumedFinals în onresult", /if \(i < recConsumedFinals\) continue;/.test(html));

console.log("\n----------------------------------------");
console.log(`TOTAL: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
