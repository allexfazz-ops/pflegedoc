/**
 * PflegeDoc — Documentation Engine Test Suite
 * -----------------------------------------------------------------------------
 * Rulează un set de teste împotriva endpoint-ului /api/generate și verifică
 * automat principiile: "Meaning > Style" și "Never invent information".
 *
 * Rulare:
 *   node tests/engine-suite.mjs
 *   PFLEGEDOC_API=https://<deploy>/api/generate node tests/engine-suite.mjs
 *   node tests/engine-suite.mjs --only=G,H         (doar categoriile G și H)
 *
 * Ieșiri:
 *   - raport în consolă (PASS/FAIL + motive + sumar pe categorii)
 *   - tests/last-run.json  (toate input-urile + output-urile brute)
 *
 * NU modifică aplicația. Este pur diagnostic.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API = process.env.PFLEGEDOC_API || "https://pflegedoc-snowy.vercel.app/api/generate";
// Gemini free tier are RPM mic -> secvențial, cu pauză generoasă între cereri.
const CONCURRENCY = Number(process.env.PFLEGEDOC_CONCURRENCY || 1);
const DELAY_MS = Number(process.env.PFLEGEDOC_DELAY_MS || 3000);
const RETRIES = 4;
const RETRY_BACKOFF_MS = 30000; // 30s, 60s, 90s, 120s

const onlyArg = (process.argv.find(a => a.startsWith("--only=")) || "").split("=")[1];
const ONLY = onlyArg ? onlyArg.split(",").map(s => s.trim().toUpperCase()) : null;

/* ============================ Helpers de aserție ============================ */

const rx = (s) => (s instanceof RegExp ? s : new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));

// Floskeln clinice interzise dacă NU apar deja în input.
const FILLER = [
    /keine Auffälligkeiten/i,
    /\bunauffällig\b/i,
    /gut toleriert/i, /gut vertragen/i, /problemlos toleriert/i,
    /keine (weiteren )?Komplikationen/i,
    /Zustand (war |blieb )?stabil/i, /war stabil\b/i, /kreislaufstabil/i,
    /Keine Vitalwerte dokumentiert/i,
    /beschwerdefrei/i,
    /\bschmerzfrei\b/i,
    /war (voll |zeitlich und örtlich )?orientiert/i,
    /keine Beschwerden geäußert/i,
];

// Verbe care marchează o afirmație raportată (nu un fapt stabilit).
const REPORTING_VERB = /(gab|gibt)\s+an|berichtet(e)?|klagt(e)?\s+über|äußert(e)?|schilderte|teilte mit|nach eigenen Angaben|gab .* an/i;

// Marcaje de incertitudine păstrată.
const HEDGE = /möglicherweise|vermutlich|offenbar|scheinbar|wirkte|schien|Eindruck|nahm .* wahr|eventuell|könnte|dürfte|Hinweise? (darauf|auf)|es ist unklar|zeigte sich .* als/i;

const DRUGS = /\b(Ibuprofen|Paracetamol|Novalgin|Metamizol|Metformin|Insulin(?!\s+nach\s+Schema)|ASS|Aspirin|Bisoprolol|Ramipril|Pantoprazol|Omeprazol|Marcumar|Torasemid|Furosemid|Amlodipin|Simvastatin|L-Thyroxin|Lorazepam|Tavor|Melperon|Pipamperon|Movicol|Macrogol)\b/i;

const SIS_HEADERS = {
    situation: /^\s*Situation\s*\/\s*Beobachtung\s*:/im,
    vital: /^\s*Vitalwerte\s*:/im,
    massnahmen: /^\s*Durchgeführte Ma[ßs]nahmen\s*:/im,
};

function checkContains(text, list) {
    const fails = [];
    for (const item of list || []) if (!rx(item).test(text)) fails.push("lipsește: " + String(item));
    return fails;
}
function checkAbsent(text, list) {
    const fails = [];
    for (const item of list || []) if (rx(item).test(text)) fails.push("apare (interzis): " + String(item));
    return fails;
}
function checkOrder(text, seq) {
    const fails = [];
    let last = -1, lastLabel = "start";
    for (const token of seq || []) {
        const idx = text.search(rx(token));
        if (idx === -1) { fails.push("ordine: lipsește reperul „" + token + "”"); continue; }
        if (idx < last) fails.push(`ordine: „${token}” apare înaintea lui „${lastLabel}”`);
        last = idx; lastLabel = token;
    }
    return fails;
}
function checkFiller(text, input) {
    const fails = [];
    for (const f of FILLER) {
        if (f.test(text) && !f.test(input)) fails.push("filler clinic: " + f);
    }
    return fails;
}

// „Nu inventa numere”: fiecare număr+unitate din output trebuie să fie în lista permisă.
function noExtraNumbers(allowed) {
    const allow = new Set((allowed || []).flatMap(a => [a, String(a).replace(",", "."), String(a).replace(".", ",")]));
    return (text) => {
        const bad = [];
        const unitRe = /(\d{1,4}(?:[.,]\d+)?)\s*(mmHg|\/min|%|°\s?C|mg\/dl|mmol\/l|mg|ml|kg|IE|Einheiten)/gi;
        let m;
        while ((m = unitRe.exec(text))) {
            const v = m[1];
            if (!allow.has(v) && !allow.has(v.replace(",", ".")) && !allow.has(m[0].replace(/\s+/g, ""))) bad.push(m[0].trim());
        }
        const bpRe = /\b(\d{2,3}\/\d{2,3})\b/g;
        while ((m = bpRe.exec(text))) if (!allow.has(m[1])) bad.push(m[1]);
        return bad.length ? ["număr neprovenit din input: " + [...new Set(bad)].join(", ")] : [];
    };
}

// Afirmație raportată nu devine fapt: dacă `symptom` apare, trebuie să fie lângă un verb de raportare.
function keepReported(symptom) {
    return (text) => {
        if (!rx(symptom).test(text)) return ["simptomul „" + symptom + "” lipsește din output"];
        if (REPORTING_VERB.test(text)) return [];
        return ["afirmația pacientului a devenit fapt (fără «gab an/berichtete/klagte»)"];
    };
}
// Incertitudine păstrată: `claim` nu poate apărea ca fapt plat fără hedge.
function keepUncertain(claim) {
    return (text) => {
        if (HEDGE.test(text)) return [];
        if (rx(claim).test(text)) return ["incertitudine transformată în certitudine (fără «möglicherweise/wirkte/…»)"];
        return ["reformularea incertitudinii lipsește (nici hedge, nici claim)"];
    };
}
function maxLen(n) {
    return (text) => (text.length > n ? [`prea lung pentru un input minimal (${text.length} > ${n} caractere)`] : []);
}
function noSIS() {
    return (text) => {
        const hit = Object.entries(SIS_HEADERS).filter(([, re]) => re.test(text)).map(([k]) => k);
        return hit.length ? ["structură SIS nejustificată (headere: " + hit.join(", ") + ")"] : [];
    };
}
function requireSIS(which) {
    return (text) => {
        const miss = (which || ["situation", "vital", "massnahmen"]).filter(k => !SIS_HEADERS[k].test(text));
        return miss.length ? ["lipsesc headerele SIS: " + miss.join(", ")] : [];
    };
}
function bothPresentOrFlag(a, b) {
    return (text) => {
        const flag = /widersprüchlich|widerspr(icht|echen)|nicht eindeutig|unklar|zu (über)?prüfen|abweichende Angaben|unterschiedliche Angaben/i;
        if (flag.test(text)) return [];
        const hasA = rx(a).test(text), hasB = rx(b).test(text);
        if (hasA && hasB) return [];
        return ["contradicția a fost rezolvată tacit (nu apar ambele variante și nici marcaj de verificat)"];
    };
}
function maxOccurrences(token, n) {
    return (text) => {
        const c = (text.match(new RegExp(token, "gi")) || []).length;
        return c > n ? [`repetiție: „${token}” apare de ${c} ori (max ${n})`] : [];
    };
}

/* ================================ TESTELE ================================ */

const T = [];
const add = (t) => T.push(t);

/* ---- A. Română → Germană (12 domenii) ---- */
add({ id: "A1", cat: "A", name: "Körperpflege", input: "Am ajutat-o pe doamna Ionescu la spălat și la îmbrăcat azi dimineață.",
  contains: [/Ionescu/, /Morgen/i, /Körperpflege|gewaschen|Waschen/i, /[AU]n(kleiden|ziehen)|angekleidet|angezogen|beim (An|Um)ziehen/i],
  absent: [/spălat|îmbrăc|imbrac|dimineat|ajutat/i] });
add({ id: "A2", cat: "A", name: "Mobilisation", input: "Domnul Pop a fost mobilizat din pat în scaunul cu rotile cu ajutorul a două persoane.",
  contains: [/Pop/, /mobilisiert|Mobilisation|Transfer/i, /Rollstuhl/i, /zwei(er)? (Person|Pflege|Mitarbeit)|2 Person/i],
  absent: [/mobilizat|scaun|rotile|ajutor/i] });
add({ id: "A3", cat: "A", name: "Ernährung", input: "Doamna Weber a mâncat doar jumătate din porția de la prânz.",
  contains: [/Weber/, /Mittag/i, /Hälfte|halbe|die Hälfte|50\s?%/i],
  absent: [/mâncat|mancat\b|jumăt|jumat|prânz|\bpranz\b/i] });
add({ id: "A4", cat: "A", name: "Flüssigkeitsaufnahme", input: "Pacientul a băut aproximativ 500 ml de apă în cursul dimineții.",
  contains: [/500\s?ml/, /Wasser/i, /(Vormittag|Morgen)/i],
  absent: [/băut|baut|apă|apa|dimineț|diminet/i], custom: [noExtraNumbers(["500"])] });
add({ id: "A5", cat: "A", name: "Ausscheidung", input: "Domnul Klein a avut scaun normal astăzi. La urinare nu au fost probleme.",
  contains: [/Klein/, /Stuhlgang/i, /Wasserlassen|Miktion|Urin/i],
  absent: [/scaun|urinare|astăzi|astazi|probleme/i] });
add({ id: "A6", cat: "A", name: "Schmerzen", input: "Doamna Fischer a acuzat dureri în șoldul stâng la mișcare.",
  contains: [/Fischer/, /link/i, /Hüfte/i, /Bewegung|beim Bewegen/i, REPORTING_VERB],
  absent: [/\brecht/i, /dureri|șold|sold|stâng|stang|mișcare|miscare/i, /stark|leicht|mäßig|\d\/10/i] });
add({ id: "A7", cat: "A", name: "Schlaf", input: "Pacienta a dormit neliniștit și s-a trezit de mai multe ori în timpul nopții.",
  contains: [/Nacht/i, /unruhig/i, /mehrfach|mehrmals|mehrere Male|wiederholt/i],
  absent: [/dormit|neliniștit|nelinistit|trezit|nopți|nopti/i] });
add({ id: "A8", cat: "A", name: "Verhalten", input: "Domnul Braun a fost agitat și confuz în această după-amiază.",
  contains: [/Braun/, /Nachmittag/i, /unruhig|agitiert/i, /verwirrt|desorientiert|verwirrt gewirkt/i],
  absent: [/agitat|confuz|după-amiaz|dupa-amiaz|amiaz/i, /aufgrund|wegen|infolge/i] });
add({ id: "A9", cat: "A", name: "Medikamente", input: "Doamna Schulz și-a primit medicamentele de dimineață.",
  contains: [/Schulz/, /Medikament|Medikation/i, /(Morgen|morgendlich)/i, /erhielt|erhalten|bekam/i],
  absent: [/primit|medicamentele|dimineață|dimineata/i, DRUGS, /\d+\s?mg/i, /\dx täglich/i] });
add({ id: "A10", cat: "A", name: "Wundversorgung", input: "Am schimbat pansamentul la rana de la piciorul drept al domnului Meyer.",
  contains: [/Meyer/, /recht/i, /(Fuß|Bein)/i, /Verband(wechsel)?|Wundversorgung/i],
  absent: [/\blink/i, /pansament|rana|rană|piciorul|drept/i] });
add({ id: "A11", cat: "A", name: "Vitalwerte", input: "Tensiune 140 cu 85, puls 76, temperatura 36,9 grade.",
  contains: [/140\/85/, /\b76\b/, /36,9/, /(RR|Blutdruck)/i],
  absent: [/tensiune|cu 85|grade/i, /SpO2|Sauerstoff|Blutzucker|\bBZ\b/i], custom: [noExtraNumbers(["140/85", "76", "36,9", "140", "85"])] });
add({ id: "A12", cat: "A", name: "Ereignis/Sturz", input: "Doamna Wagner a căzut în baie în jurul orei 14:30. Nu a avut răni vizibile. Medicul a fost informat.",
  contains: [/Wagner/, /14[:.]30/, /Bad/i, /(Sturz|gestürzt|gefallen)/i, /Arzt/i, /informiert/i],
  absent: [/căzut|cazut|baie|răni|rani|medicul/i],
  order: [/(Sturz|gestürzt|gefallen)/i, /(Verletzung|Wunde|Prellung)/i, /Arzt/i] });

/* ---- B. Germană cu greșeli ---- */
add({ id: "B1", cat: "B", name: "Gramatică", input: "Bewohner hat heute nicht gegessen weil ihm schlecht war und hat viel geschlafen.",
  contains: [/(Übelkeit|schlecht)/i, /geschlafen|Schlaf/i, /nicht gegessen|keine Nahrung|Nahrung.{0,20}(abgelehnt|verweigert)|nahm .{0,20}keine Nahrung|verzichtete auf|aß nicht/i],
  absent: [/\d+\s?ml/i] });
add({ id: "B2", cat: "B", name: "Ortografie", input: "Der Patinet hatte heute morgen starke schmerzen im rechten schulter.",
  contains: [/Patient/, /Morgen/i, /stark/i, /Schmerzen/i, /recht/i, /Schulter/i],
  absent: [/Patinet/, /\blink/i] });
add({ id: "B3", cat: "B", name: "Articole/topică", input: "Frau Müller heute Morgen gut gelaunt war und hat mit die Angehörige telefoniert.",
  contains: [/Müller/, /Morgen/i, /(gut gelaunt|guter Stimmung|gute Laune)/i, /Angehörig/i, /telefonier/i] });
add({ id: "B4", cat: "B", name: "Propoziții simple", input: "Patient müde. Wenig gegessen. Viel getrunken.",
  contains: [/müde/i, /(wenig|geringe? Menge).*(gegessen|Nahrung)/i, /(viel|reichlich).*(getrunken|Flüssigkeit)/i],
  absent: [/\d+\s?ml/i, /aufgrund|wegen/i], order: [/müde/i, /gegessen|Nahrung/i, /getrunken|Flüssigkeit/i] });
add({ id: "B5", cat: "B", name: "Non-nativ/colocvial", input: "Ich hab der Frau Koch geholfen beim Waschen, die war heut bisschen durcheinander aber sonst ok.",
  contains: [/Koch/, /(Körperpflege|Waschen|gewaschen)/i, /(durcheinander|verwirrt|desorientiert)/i],
  absent: [/\bhab\b|\bheut\b|bisschen|\bok\b/i] });
add({ id: "B6", cat: "B", name: "Colocvial", input: "Herr Lang wollte partout nicht aus dem Bett, hat den ganzen Vormittag rumgemeckert.",
  contains: [/Lang/, /Bett/i, /Vormittag/i],
  absent: [/\bpartout\b/i, /rumgemeckert|herumgemeckert|meckerte .{0,15}herum/i] });

/* ---- C. Observație vs. afirmația pacientului / incertitudine ---- */
add({ id: "C1", cat: "C", name: "sagt dass", input: "Patient sagt, dass er Kopfschmerzen hat.",
  contains: [/Kopfschmerzen/i], custom: [keepReported(/Kopfschmerzen/i)] });
add({ id: "C2", cat: "C", name: "berichtet", input: "Patient berichtet über Schwindel beim Aufstehen.",
  contains: [/Schwindel/i, /Aufstehen/i], custom: [keepReported(/Schwindel/i)] });
add({ id: "C3", cat: "C", name: "gibt an", input: "Patient gibt an, seit gestern Durchfall zu haben.",
  contains: [/(Durchfall|Diarrh)/i, /gestern|seit gestern/i], custom: [keepReported(/(Durchfall|Diarrh)/i)] });
add({ id: "C4", cat: "C", name: "Ich glaube", input: "Ich glaube, Frau Schmidt war heute etwas verwirrt.",
  custom: [keepUncertain(/Frau Schmidt (war|ist) (heute )?(etwas |leicht )?verwirrt/i)],
  absent: [/^\s*Frau Schmidt war heute verwirrt\.?\s*$/i] });
add({ id: "C5", cat: "C", name: "Es scheint", input: "Es scheint, als hätte der Patient Angst vor der Behandlung.",
  contains: [/Angst/i, /Behandlung/i], custom: [keepUncertain(/Der Patient hat Angst/i)] });
add({ id: "C6", cat: "C", name: "Vielleicht", input: "Vielleicht hat Herr Weber nicht genug getrunken.",
  custom: [keepUncertain(/Herr Weber (hat|hatte) (zu wenig|nicht genug) getrunken/i)] });

/* ---- D. Numere și date ---- */
add({ id: "D1", cat: "D", name: "RR/Puls/SpO2", input: "RR 125 zu 80, Puls 92, SpO2 96 Prozent.",
  contains: [/125\/80/, /\b92\b/, /96\s?%/], custom: [noExtraNumbers(["125/80", "92", "96", "125", "80"])] });
add({ id: "D2", cat: "D", name: "Temp/BZ", input: "Temperatur 37,8 Grad und Blutzucker 145 mg/dl.",
  contains: [/37,8\s?°?\s?C/, /145\s?mg\/dl/], absent: [/SpO2|Puls\s?\d|RR\s?\d/i], custom: [noExtraNumbers(["37,8", "145"])] });
add({ id: "D3", cat: "D", name: "Trinkmenge/Gewicht", input: "Trinkmenge heute 500 ml, Gewicht 72,5 kg.",
  contains: [/500\s?ml/, /72,5\s?kg/], custom: [noExtraNumbers(["500", "72,5"])] });
add({ id: "D4", cat: "D", name: "Dosis/Uhrzeit/Frequenz", input: "Tablette 400 mg um 07:30 Uhr, 2x täglich.",
  contains: [/400\s?mg/, /07:30/, /(2\s?x\s?täglich|zweimal täglich)/i], custom: [noExtraNumbers(["400", "07:30", "2", "30"])] });
add({ id: "D5", cat: "D", name: "Serie de valori", input: "Blutdruck 150/95, nach einer Stunde erneut gemessen: 138/88.",
  contains: [/150\/95/, /138\/88/, /Stunde/i], order: [/150\/95/, /138\/88/],
  custom: [noExtraNumbers(["150/95", "138/88"])] });

/* ---- E. Medikamente ---- */
add({ id: "E1", cat: "E", name: "generic „Medikamente”", input: "Herr Müller bekam seine Medikamente.",
  contains: [/Müller/, /Medikament/i, /erhielt|bekam|verabreicht/i],
  absent: [DRUGS, /\d+\s?mg/i, /Tablette\s?\d/i, /\dx täglich/i, /gegen (Schmerzen|Blutdruck)/i] });
add({ id: "E2", cat: "E", name: "medicament + doză date", input: "Ibuprofen 400 mg wurde verabreicht.",
  contains: [/Ibuprofen/, /400\s?mg/, /verabreicht|erhalten|gegeben/i] });
add({ id: "E3", cat: "E", name: "Bedarfsmedikation", input: "Frau Klein erhielt ihre Bedarfsmedikation gegen Schmerzen um 22 Uhr.",
  contains: [/Klein/, /Bedarfsmedikation/i, /Schmerzen/i, /22\s?Uhr/],
  absent: [DRUGS, /\d+\s?mg/i] });
add({ id: "E4", cat: "E", name: "Insulin nach Schema", input: "Insulin nach Schema gegeben, BZ vorher 210.",
  contains: [/Insulin/, /210/, /Schema/i], absent: [/\d+\s?(IE|Einheiten)/i], custom: [noExtraNumbers(["210"])] });

/* ---- F. Lateralitate / anatomie ---- */
add({ id: "F1", cat: "F", name: "rechter Unterschenkel", input: "Verband am rechten Unterschenkel gewechselt.",
  contains: [/recht/i, /Unterschenkel/i, /Verband/i], absent: [/\blink/i, /Oberschenkel/i] });
add({ id: "F2", cat: "F", name: "linkes Knie", input: "Patient klagt über Schmerzen im linken Knie.",
  contains: [/link/i, /Knie/i], absent: [/\brecht/i] });
add({ id: "F3", cat: "F", name: "rechter Arm + Hand", input: "Schwäche im rechten Arm und in der rechten Hand.",
  contains: [/recht/i, /Arm/i, /Hand/i], absent: [/\blink/i, /(Bein|Fuß)/i] });
add({ id: "F4", cat: "F", name: "linke Ferse", input: "Dekubitus an der linken Ferse, Größe unverändert.",
  contains: [/link/i, /Ferse/i, /Dekubitus/i, /unverändert/i], absent: [/\brecht/i, /(Steißbein|Sakral|Gesäß)/i] });
add({ id: "F5", cat: "F", name: "ambele părți diferit", input: "Bewegungseinschränkung linke Schulter, rechte Schulter frei beweglich.",
  contains: [/link/i, /recht/i, /Schulter/i, /frei beweglich|uneingeschränkt|ohne (Bewegungs)?einschränkung|frei beweg/i],
  order: [/link/i, /recht/i] });

/* ---- G. Anti-halucinație (input minimal) ---- */
const G_ABSENT = [/\bstark(e|en|er|es)?\b/i, /\bleicht(e|en|er|es)?\b/i, /\bmäßig/i, /\d\s?\/\s?10/, /\bVAS\b/i,
    /aufgrund|wegen|infolge|verursacht durch|zurückzuführen/i, DRUGS, /\d+\s?mg/i, /\d+\s?ml/i,
    /danach (ging es|besser)|anschließend besser|Zustand .* (gebessert|verbessert)/i, /keine Beschwerden/i];
add({ id: "G1", cat: "G", name: "„hatte Schmerzen”", input: "Patient hatte Schmerzen.",
  contains: [/Schmerzen/i], absent: [...G_ABSENT, /(Rücken|Kopf|Bauch|Brust|Knie|Bein|Arm|Hüfte)/i],
  custom: [maxLen(220), noSIS()] });
add({ id: "G2", cat: "G", name: "„war müde”", input: "Patient war müde.",
  contains: [/müde|Müdigkeit/i], absent: [...G_ABSENT, /schlecht geschlafen|Schlafmangel|erschöpft/i], custom: [maxLen(200), noSIS()] });
add({ id: "G3", cat: "G", name: "„war unruhig”", input: "Patient war unruhig.",
  contains: [/unruhig|Unruhe/i], absent: [...G_ABSENT, /verwirrt|desorientiert|ängstlich|aggressiv/i], custom: [maxLen(200), noSIS()] });
add({ id: "G4", cat: "G", name: "„bekam Medikamente”", input: "Bewohner bekam Medikamente.",
  contains: [/Medikament/i], absent: [...G_ABSENT, /gegen |zur Behandlung|morgendlich|abendlich|\dx/i], custom: [maxLen(200), noSIS()] });
add({ id: "G5", cat: "G", name: "„wollte nicht essen”", input: "Patient wollte nicht essen.",
  contains: [/(lehnte|verweigerte).{0,30}(Nahrung|Essen|Mahlzeit|Nahrungsaufnahme)|wollte nicht essen/i],
  absent: [...G_ABSENT, /Übelkeit|Appetitlosigkeit|keine Auffälligkeiten/i], custom: [maxLen(220), noSIS()] });
add({ id: "G6", cat: "G", name: "„wurde mobilisiert”", input: "Patient wurde mobilisiert.",
  contains: [/mobilisiert|Mobilisation/i],
  absent: [...G_ABSENT, /Rollstuhl|Bettrand|Sessel|zwei Personen|mit Hilfe|toleriert|Gehstrecke/i], custom: [maxLen(200), noSIS()] });

/* ---- H. Multi-aspect / fără secțiuni goale ---- */
add({ id: "H1", cat: "H", name: "toate aspectele → SIS complet",
  input: "Frau Groß, Zimmer 5: heute Morgen bei der Körperpflege unterstützt, hat das Frühstück komplett gegessen, klagte über Schmerzen im rechten Knie, war zeitweise verwirrt, RR 145/90, Puls 88, Bedarfsmedikation gegen Schmerzen erhalten.",
  contains: [/145\/90/, /\b88\b/, /recht/i, /Knie/i, /Frühstück/i, /verwirrt/i],
  absent: [/\blink/i, /SpO2|Temp/i, /Keine Vitalwerte/i], custom: [requireSIS()] });
add({ id: "H2", cat: "H", name: "două aspecte, fără vitale → fără secțiune Vitalwerte",
  input: "Herr Adam wurde in den Sessel mobilisiert und hat zu Mittag gut gegessen.",
  contains: [/Adam/, /Sessel/i, /Mittag/i], absent: [/Vitalwerte\s*:/i, /Keine Vitalwerte/i, /Schmerzen|Medikament/i] });
add({ id: "H3", cat: "H", name: "un singur aspect → fără structură",
  input: "Herr Bauer hat heute Mittag gut gegessen.",
  contains: [/Bauer/, /Mittag/i], custom: [noSIS()], absent: [/Keine Vitalwerte/i] });

/* ---- I. Cronologie ---- */
add({ id: "I1", cat: "I", name: "zuerst/danach/anschließend",
  input: "Zuerst hat der Patient über Übelkeit geklagt, danach wurde er zur Toilette begleitet, anschließend hat er gefrühstückt.",
  order: [/Übelkeit/i, /Toilette/i, /(gefrühstückt|Frühstück)/i] });
add({ id: "I2", cat: "I", name: "Morgen/Mittag/Nachmittag",
  input: "Am Morgen Blutdruck gemessen (150/95), am Mittag Medikamente gegeben, am Nachmittag Spaziergang im Garten.",
  contains: [/150\/95/], order: [/150\/95/, /Medikament/i, /(Garten|Spaziergang)/i] });
add({ id: "I3", cat: "I", name: "ore succesive",
  input: "Frau Held ist um 6 Uhr aufgewacht, hat um 8 Uhr gefrühstückt und ist um 10 Uhr wieder eingeschlafen.",
  contains: [/6\s?Uhr|06:00/, /8\s?Uhr|08:00/, /10\s?Uhr|10:00/],
  order: [/6\s?Uhr|06:00/, /8\s?Uhr|08:00/, /10\s?Uhr|10:00/] });

/* ---- J. Edge cases ---- */
add({ id: "J1", cat: "J", name: "input foarte scurt", input: "Sturz.",
  contains: [/Sturz|gestürzt|gefallen/i],
  absent: [/\d{1,2}[:.]\d{2}|Uhr/i, /(Bad|Zimmer|Flur|Garten)/i, /(Verletzung|Prellung|Wunde|Arzt informiert)/i],
  custom: [maxLen(160)] });
add({ id: "J2", cat: "J", name: "input foarte lung",
  input: "Herr Neumann hatte eine anstrengende Nacht, wachte gegen 2 Uhr auf, konnte nicht mehr einschlafen, klagte über Rückenschmerzen im unteren Bereich, bekam gegen 3 Uhr seine Bedarfsmedikation, schlief danach wieder ein, stand um 7 Uhr auf, wurde bei der Körperpflege komplett unterstützt, frühstückte nur wenig, trank etwa 200 ml Tee, wurde anschließend mit dem Rollstuhl in den Aufenthaltsraum gebracht, nahm dort an der Zeitungsrunde teil, wirkte am Nachmittag zunehmend müde, RR 138/82, Puls 74.",
  contains: [/Neumann/, /2\s?Uhr/, /Rückenschmerzen|Schmerzen.*Rücken/i, /200\s?ml/, /Rollstuhl/i, /138\/82/, /\b74\b/],
  absent: [/\d\/10/, /keine Auffälligkeiten/i], custom: [noExtraNumbers(["2", "3", "7", "200", "138/82", "74", "138", "82"])] });
add({ id: "J3", cat: "J", name: "propoziție incompletă", input: "Heute Morgen im Bad, dann...",
  absent: [/(gestürzt|gewaschen|Körperpflege|geduscht|angekleidet|Frühstück)/i] });
add({ id: "J4", cat: "J", name: "amestec RO + DE",
  input: "Domnul Ionescu hat heute schlecht geschlafen, s-a trezit de 3 ori, dimineața war er müde.",
  contains: [/Ionescu/, /(3\s?(mal|x)|dreimal)/i, /Morgen/i, /müde/i, /(Nacht|geschlafen)/i],
  absent: [/trezit|dimineața|dimineata|s-a/i] });
add({ id: "J5", cat: "J", name: "typos multiple", input: "Patinet hat heue nact schlehct geschalfen und war unruig.",
  contains: [/Patient/, /Nacht/i, /geschlafen/i, /unruhig/i],
  absent: [/Patinet|heue|\bnact\b|schlehct|geschalfen|unruig/i] });
add({ id: "J6", cat: "J", name: "informații contradictorii", input: "Der Patient hat gut gegessen. Er hat heute nichts gegessen.",
  custom: [bothPresentOrFlag(/(gut gegessen|vollständig gegessen|gute Nahrungsaufnahme)/i, /(nichts gegessen|keine Nahrung|nicht gegessen)/i)] });
add({ id: "J7", cat: "J", name: "informații repetitive", input: "Patient müde. Patient ist sehr müde. Der Patient wirkt müde und erschöpft.",
  contains: [/müde|erschöpft/i], custom: [maxOccurrences("müde", 2)] });

/* ============================== RUNNER ============================== */

function evaluate(test, text) {
    const reasons = [];
    reasons.push(...checkContains(text, test.contains));
    reasons.push(...checkAbsent(text, test.absent));
    reasons.push(...checkOrder(text, test.order));
    reasons.push(...checkFiller(text, test.input));
    for (const fn of test.custom || []) reasons.push(...fn(text));
    // globale
    if (!text || !text.trim()) reasons.push("output gol");
    if (/^\s*(Hier (ist|folgt|kommt)|Als (KI|Assistent)|```|Gerne|Natürlich[,:])/i.test(text)) reasons.push("preambul / meta-text în output");
    return reasons;
}

// /api/generate cere sesiune + e-mail confirmat. Pentru teste, setează
// ENGINE_TEST_SECRET pe server ȘI ca variabilă la rulare:
//   ENGINE_TEST_SECRET=... node tests/engine-suite.mjs
const ENGINE_TEST_SECRET = process.env.ENGINE_TEST_SECRET || "";

async function callApi(input, mode) {
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
        try {
            const headers = { "Content-Type": "application/json" };
            if (ENGINE_TEST_SECRET) headers["X-Engine-Test"] = ENGINE_TEST_SECRET;
            const r = await fetch(API, {
                method: "POST",
                headers,
                body: JSON.stringify(mode ? { input, mode } : { input }),
            });
            const data = await r.json().catch(() => ({}));
            if (r.ok && typeof data.text === "string") return { text: data.text };
            if ((r.status === 429 || r.status >= 500) && attempt < RETRIES) {
                await sleep(RETRY_BACKOFF_MS * (attempt + 1));
                continue;
            }
            return { error: data.error || `HTTP ${r.status}` };
        } catch (e) {
            if (attempt < RETRIES) { await sleep(RETRY_BACKOFF_MS * (attempt + 1)); continue; }
            return { error: e.message };
        }
    }
    return { error: "unreachable" };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const tests = T.filter((t) => !ONLY || ONLY.includes(t.cat));
    console.log(`\nPflegeDoc Engine Test Suite`);
    console.log(`Endpoint : ${API}`);
    console.log(`Teste    : ${tests.length}${ONLY ? " (filtrat: " + ONLY.join(",") + ")" : ""}`);
    console.log(`Concurrent: ${CONCURRENCY}\n`);

    const results = [];
    let idx = 0;
    async function worker() {
        while (idx < tests.length) {
            const my = idx++;
            const test = tests[my];
            const res = await callApi(test.input, test.mode);
            let status, reasons = [];
            if (res.error) { status = "ERROR"; reasons = [res.error]; }
            else {
                reasons = evaluate(test, res.text);
                status = reasons.length ? "FAIL" : "PASS";
            }
            results[my] = { ...test, output: res.text || "", status, reasons };
            const tag = status === "PASS" ? "PASS " : status === "FAIL" ? "FAIL " : "ERR  ";
            console.log(`[${tag}] ${test.id} (${test.cat}) ${test.name}`);
            if (reasons.length) reasons.forEach((r) => console.log(`        - ${r}`));
            await sleep(DELAY_MS);
        }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tests.length) }, worker));

    // sumar
    const byCat = {};
    for (const r of results) {
        byCat[r.cat] ||= { pass: 0, fail: 0, err: 0 };
        if (r.status === "PASS") byCat[r.cat].pass++;
        else if (r.status === "FAIL") byCat[r.cat].fail++;
        else byCat[r.cat].err++;
    }
    const pass = results.filter((r) => r.status === "PASS").length;
    const fail = results.filter((r) => r.status === "FAIL").length;
    const err = results.filter((r) => r.status === "ERROR").length;

    console.log(`\n──────────── SUMAR ────────────`);
    for (const [cat, s] of Object.entries(byCat).sort()) {
        console.log(`  ${cat}: ${s.pass} PASS / ${s.fail} FAIL / ${s.err} ERR`);
    }
    console.log(`  ─────`);
    console.log(`  TOTAL: ${results.length}  |  PASS: ${pass}  |  FAIL: ${fail}  |  ERROR: ${err}`);

    if (fail) {
        console.log(`\n──────────── FAIL DETALIAT ────────────`);
        for (const r of results.filter((x) => x.status === "FAIL")) {
            console.log(`\n### ${r.id} (${r.cat}) ${r.name}`);
            console.log(`IN : ${r.input}`);
            console.log(`OUT: ${r.output.replace(/\n/g, "\n     ")}`);
            console.log(`WHY: ${r.reasons.join(" | ")}`);
        }
    }

    const outPath = path.join(__dirname, "last-run.json");
    fs.writeFileSync(outPath, JSON.stringify({ api: API, when: new Date().toISOString(), pass, fail, err, results }, null, 2));
    console.log(`\nOutput brut salvat în ${outPath}\n`);

    process.exit(fail || err ? 1 : 0);
}

main();
