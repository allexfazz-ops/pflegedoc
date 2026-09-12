/**
 * PflegeDoc — System-prompt fidelity guard (static)
 * -----------------------------------------------------------------------------
 * Verifică faptul că regulile de fidelitate din TREUE_REGELN (api/generate.js)
 * există și acoperă cazurile de „hallucinated clinical detail": invenție de
 * fapte / cauze / grade / localizări / asimetrii nespecificate.
 *
 * Static, fără rețea, fără execuția handler-ului. Stil identic cu
 * tests/security-suite.mjs (regex peste sursă).
 *   node tests/prompt-fidelity.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const gen = readFileSync(path.join(REPO, "api", "generate.js"), "utf8");

let pass = 0, fail = 0;
const ok = (name, cond) => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; console.log("  FAIL  " + name); }
};

// Blocul comun de fidelitate, folosit de toate modurile.
const treue = (gen.match(/const TREUE_REGELN = `([\s\S]*?)`;/) || [, ""])[1];
ok("TREUE_REGELN există", treue.length > 500);

// Reguli de bază care nu trebuie să dispară.
ok("interzice invenția generală (NIEMALS INFORMATIONEN ERFINDEN)", /NIEMALS INFORMATIONEN ERFINDEN/.test(treue));
ok("„Im Zweifel: NICHT raten”", /Im Zweifel:\s*NICHT raten/.test(treue));
ok("interzice adăugarea cauzei (Die Ursache NICHT ergänzen)", /Ursache NICHT ergänzen/.test(treue));
ok("interzice inventarea unei seitigkeit lipsă", /fehlende Seitigkeit erfinden/.test(treue));
ok("interzice vag -> valoare exactă (7\\/10 în exemplu)", /7\/10/.test(treue));
ok("păstrează incertitudinea (Verdacht bleibt Verdacht)", /Verdacht bleibt Verdacht/.test(treue));
ok("checklist final are „Nichts erfunden?”", /Nichts erfunden\?/.test(treue));

// Regula nouă: nu inventa diferențe de latură / grad / localizare unde inputul
// a fost uniform / bilateral / fără stea.
ok("bloc „KEINE UNTERSCHIEDE ERFINDEN” prezent", /KEINE UNTERSCHIEDE ERFINDEN/.test(treue));
ok("  -> păstrează „einheitlich / beidseitig / ohne genaue Stelle”",
    /einheitlich, beidseitig oder ohne genaue Stelle/.test(treue));
ok("  -> interzice diferențe de Seiten-/Grad-/Ortsunterschiede", /Seiten-, Grad- oder Ortsunterschiede/.test(treue));
ok("  -> interzice explicit „rechts stärker als links”", /rechts stärker als links/.test(treue));
ok("  -> interzice localizarea când doar un simptom fără stea a fost dat",
    /keine Lokalisation, wenn nur ein Symptom ohne Stelle genannt/.test(treue));

// Blocul se aplică tuturor modurilor rămase (TREUE_REGELN inclus peste tot).
ok("formulieren include TREUE_REGELN (prin schreibRahmen)", /function schreibRahmen\(\)[\s\S]*TREUE_REGELN/.test(gen));
ok("pflegeplanung include TREUE_REGELN (prin schreibRahmen)", /function promptPflegeplanung[\s\S]*schreibRahmen\(\)/.test(gen));

// Modulul „korrigieren" a fost eliminat definitiv (decizie funcțională) — nicio
// urmă nu trebuie să mai existe în backend.
ok("korrigieren eliminat din VALID_MODES", /const VALID_MODES = \["formulieren", "uebersetzen", "pflegeplanung"\];/.test(gen));
ok("PROMPT_KORRIGIEREN nu mai există", !/PROMPT_KORRIGIEREN/.test(gen));
ok("buildSystemPrompt nu mai are ramură pentru korrigieren", !/mode === "korrigieren"/.test(gen));
ok("nicio referință reziduală la „korrigieren” în api/generate.js", !/korrigieren/i.test(gen));

// Pflegeplanung klassisch (ABEDL): cere un Pflegeziel per AEDL-Bereich, DAR fără invenție.
const ppKlassisch = (gen.match(/DOKUMENTATIONSMODELL: KLASSISCHE PFLEGEPLANUNG NACH ABEDL[\s\S]*?entfällt Teil 2\.`/) || [, ""])[0];
ok("klassisch există și e localizat (ABEDL)", ppKlassisch.length > 500);
ok("klassisch: Pflegeziel e Pflichtangabe (obligatoriu, dar derivat)",
    /Pflegeziel:\s*\n<Pflichtangabe: der fachlich naheliegende/.test(ppKlassisch));
ok("klassisch: Pflegeziel se derivă din problema DEJA numită (fără fapte noi)",
    /direkt aus dem genannten Problem abgeleitet/.test(ppKlassisch) && /keine neuen Fakten/.test(ppKlassisch));
ok("klassisch: fără valori/termene/date inventate în Pflegeziel",
    /KEINE erfundenen Werte, Messgrößen, Fristen oder Termine/.test(ppKlassisch));
ok("klassisch: Pflegeziel poate lipsi dacă nu se poate deriva (nu forțează completare)",
    /Nur weglassen, wenn sich aus dem Problem kein sinnvolles Ziel ableiten lässt/.test(ppKlassisch));

// Cele 13 domenii AEDL (Krohwinkel) trebuie enumerate explicit, simetric cu SIS.
const ABEDL_DOMAINS = [
    "Kommunizieren können",
    "Sich bewegen können",
    "Vitale Funktionen des Lebens aufrechterhalten können",
    "Sich pflegen können",
    "Essen und trinken können",
    "Ausscheiden können",
    "Sich kleiden können",
    "Ruhen und schlafen können",
    "Sich beschäftigen können",
    "Sich als Mann oder Frau fühlen und verhalten können",
    "Für eine sichere und fördernde Umgebung sorgen können",
    "Soziale Bereiche des Lebens sichern können",
    "Mit existenziellen Erfahrungen des Lebens umgehen können",
];
ok("klassisch: toate cele 13 domenii ABEDL sunt enumerate în lista principală",
    ABEDL_DOMAINS.every((d) => ppKlassisch.includes(d)));
ok("klassisch: fiecare din cele 13 domenii apare și cu exemple tipice (secțiunea Noch zu erheben)",
    ABEDL_DOMAINS.every((d) => new RegExp(d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ":").test(ppKlassisch)));
ok("klassisch: structură TEIL 1 / TEIL 2, simetrică cu SIS",
    /TEIL 1 – GEPLANTE EINTRÄGE/.test(ppKlassisch) && /TEIL 2 – OFFENE AEDL-BEREICHE/.test(ppKlassisch));
ok("klassisch: domenii neacoperite -> „Noch zu erheben”, fără invenție de probleme/resurse",
    /Danach die Überschrift „Noch zu erheben:“ und darunter JEDEN AEDL-Bereich, zu dem KEINE Angaben vorliegen/.test(ppKlassisch) &&
    /als Beispiel, NICHT als Behauptung übernehmen/.test(ppKlassisch));
ok("klassisch: dacă toate cele 13 domenii sunt acoperite, Teil 2 se omite",
    /Sind zu ALLEN 13 AEDL-Bereichen Angaben vorhanden, entfällt Teil 2\./.test(ppKlassisch));

// SIS neatins (rămâne cu cele 6 Themenfelder, structură identică ca înainte).
const ppSis = (gen.match(/DOKUMENTATIONSMODELL: STRUKTURMODELL[\s\S]*?entfällt Teil 2\.`/) || [, ""])[0];
ok("SIS: cele 6 Themenfelder rămân neschimbate", /Kognition und Kommunikation; Mobilität und Bewegung/.test(ppSis));
ok("SIS: structură TEIL 1 / TEIL 2 neschimbată", /TEIL 1 – GEPLANTE EINTRÄGE/.test(ppSis) && /TEIL 2 – OFFENE THEMENFELDER/.test(ppSis));

ok("pflegeplanung: încă interzice invenția de probleme/resurse/măsuri/valori",
    /Erfinde KEINE Probleme, Ressourcen, Ziele, Maßnahmen, Fristen oder Messwerte/.test(gen));
ok("pflegeplanung: Ressourcen/Maßnahmen/Evaluation rămân „nur wenn genannt” (nu se inventează)",
    /Ressourcen:\s*\n<was die Person selbst kann[\s\S]*?nur wenn genannt/.test(gen) &&
    /Evaluation:\s*\n<nur wenn ein Überprüfungsdatum oder ein Ergebnis genannt wurde>/.test(gen));
ok("KEINE UNTERSCHIEDE ERFINDEN se aplică și lui pflegeplanung (prin TREUE_REGELN/schreibRahmen, nu duplicat local)",
    !/KEINE UNTERSCHIEDE ERFINDEN/.test(ppKlassisch) && !/KEINE UNTERSCHIEDE ERFINDEN/.test(ppSis) &&
    /KEINE UNTERSCHIEDE ERFINDEN/.test(treue));

/* ==== timeout diferențiat pentru pflegeplanung (buget mai mare, motivat de dimensiunea SIS/ABEDL) ==== */
ok("constantă nouă: timeout per-attempt mai mare pentru pflegeplanung (30000ms)",
    /const PFLEGEPLANUNG_PER_ATTEMPT_TIMEOUT_MS = 30000;/.test(gen));
ok("constantă nouă: buget global mai mare pentru pflegeplanung (48000ms)",
    /const PFLEGEPLANUNG_TOTAL_BUDGET_MS = 48000;/.test(gen));
ok("bugetul mai mare rămâne sub client (55000ms) și maxDuration (60000ms)",
    48000 < 55000 && 48000 < 60000);
ok("celelalte moduri rămân la valorile vechi (22000 / 44000)",
    /const PER_ATTEMPT_TIMEOUT_MS = 22000;/.test(gen) && /const TOTAL_BUDGET_MS = 44000;/.test(gen));
ok("selecția mode-aware există: perAttemptTimeoutMs / totalBudgetMs derivate din `mode`",
    /const perAttemptTimeoutMs = mode === "pflegeplanung" \? PFLEGEPLANUNG_PER_ATTEMPT_TIMEOUT_MS : PER_ATTEMPT_TIMEOUT_MS;/.test(gen) &&
    /const totalBudgetMs = mode === "pflegeplanung" \? PFLEGEPLANUNG_TOTAL_BUDGET_MS : TOTAL_BUDGET_MS;/.test(gen));
ok("deadline-ul K3-E+ folosește totalBudgetMs (nu mai e hard-codat TOTAL_BUDGET_MS)",
    /const deadline = startedAt \+ totalBudgetMs;/.test(gen));
ok("timerul per-attempt folosește perAttemptTimeoutMs (nu mai e hard-codat PER_ATTEMPT_TIMEOUT_MS)",
    /effectiveAttemptTimeout\(perAttemptTimeoutMs, remainingBudget\(\)\)/.test(gen));
ok("MAX_ATTEMPTS / RETRY_BACKOFF_MS / maxDuration rămân neschimbate (nu doar per mod)",
    /const MAX_ATTEMPTS = 3;/.test(gen) && /const RETRY_BACKOFF_MS = \[1200, 2600\];/.test(gen) && /export const maxDuration = 60;/.test(gen));

/* ==== mesaj diferențiat: cotă epuizată (429 RESOURCE_EXHAUSTED) vs supraîncărcare generică ==== */
ok("QUOTA_MSG (cotă epuizată) există și e distinct de OVERLOAD_MSG",
    /const QUOTA_MSG = "[^"]+";/.test(gen) && (gen.match(/const QUOTA_MSG = "([^"]+)";/) || [, ""])[1] !==
    (gen.match(/const OVERLOAD_MSG = "([^"]+)";/) || [, "x"])[1]);
ok("isQuotaExhausted (429 RESOURCE_EXHAUSTED / quota) -> QUOTA_MSG, nu OVERLOAD_MSG",
    /if \(quota\) \{[\s\S]{0,150}?return res\.status\(503\)\.json\(\{ error: QUOTA_MSG \}\);/.test(gen));
ok("retryDelay explicit fără cotă -> rămâne OVERLOAD_MSG (supraîncărcare generică)",
    /if \(retrySec !== null && retrySec >= 4\) \{[\s\S]{0,150}?return res\.status\(503\)\.json\(\{ error: OVERLOAD_MSG \}\);/.test(gen));
ok("fallback-urile existente (retry epuizat / !data) rămân pe OVERLOAD_MSG generic",
    (gen.match(/error: OVERLOAD_MSG/g) || []).length >= 3);

// Nimic din config-ul de generare nu s-a atins.
ok("generationConfig neschimbat (temp 0.1 / topP 0.85 / maxOutputTokens 8192)",
    /temperature:\s*0\.1/.test(gen) && /topP:\s*0\.85/.test(gen) && /maxOutputTokens:\s*8192/.test(gen));
ok("model implicit neschimbat (gemini-3.6-flash)", /DEFAULT_MODEL = "gemini-3\.6-flash"/.test(gen));

console.log("\n----------------------------------------");
console.log(`TOTAL: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
