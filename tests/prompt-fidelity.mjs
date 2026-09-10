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

// Blocul se aplică tuturor modurilor (TREUE_REGELN inclus peste tot).
ok("formulieren include TREUE_REGELN (prin schreibRahmen)", /function schreibRahmen\(\)[\s\S]*TREUE_REGELN/.test(gen));
ok("korrigieren include TREUE_REGELN", /const PROMPT_KORRIGIEREN = `\$\{TREUE_REGELN\}/.test(gen));
ok("pflegeplanung include TREUE_REGELN (prin schreibRahmen)", /function promptPflegeplanung[\s\S]*schreibRahmen\(\)/.test(gen));

// Pflegeplanung klassisch: cere un Pflegeziel per problem, DAR fără invenție.
const ppKlassisch = (gen.match(/DOKUMENTATIONSMODELL: KLASSISCHE PFLEGEPLANUNG[\s\S]*?`\s*\n\s*:/) || [, ""])[0];
ok("klassisch: Pflegeziel e cerut pentru fiecare Pflegeproblem",
    /Pflegeziel:\s*\n<Pflichtangabe: zu jedem Pflegeproblem ein Pflegeziel/.test(ppKlassisch));
ok("klassisch: Pflegeziel se derivă din problema DEJA numită (fără fapte noi)",
    /direkt aus dem genannten Problem abgeleitet/.test(ppKlassisch) && /keine neuen Fakten/.test(ppKlassisch));
ok("klassisch: fără valori/termene/date inventate în Pflegeziel",
    /KEINE erfundenen Werte, Messgrößen, Fristen oder Termine/.test(ppKlassisch));
ok("klassisch: Pflegeziel poate lipsi dacă nu se poate deriva (nu forțează completare)",
    /Nur weglassen, wenn sich aus dem Problem kein sinnvolles Ziel ableiten lässt/.test(ppKlassisch));
ok("pflegeplanung: încă interzice invenția de probleme/resurse/măsuri/valori",
    /Erfinde KEINE Probleme, Ressourcen, Ziele, Maßnahmen, Fristen oder Messwerte/.test(gen));
ok("pflegeplanung: Ressourcen/Maßnahmen/Evaluation rămân „nur wenn genannt” (nu se inventează)",
    /Ressourcen:\s*\n<was die Person selbst kann[\s\S]*?nur wenn genannt/.test(gen) &&
    /Evaluation:\s*\n<nur wenn ein Überprüfungsdatum oder ein Ergebnis genannt wurde>/.test(gen));

// Nimic din config-ul de generare nu s-a atins.
ok("generationConfig neschimbat (temp 0.1 / topP 0.85 / maxOutputTokens 8192)",
    /temperature:\s*0\.1/.test(gen) && /topP:\s*0\.85/.test(gen) && /maxOutputTokens:\s*8192/.test(gen));
ok("model implicit neschimbat (gemini-3.6-flash)", /DEFAULT_MODEL = "gemini-3\.6-flash"/.test(gen));

console.log("\n----------------------------------------");
console.log(`TOTAL: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
