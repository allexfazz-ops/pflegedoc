/**
 * Vercel Serverless Function — /api/generate
 * ------------------------------------------------------------------
 * Proxy securizat între frontend și Google Gemini.
 * Cheia API NU ajunge niciodată în browser: trăiește doar în
 * variabila de mediu GEMINI_API_KEY, setată în dashboard-ul Vercel
 * (Project → Settings → Environment Variables) sau în `.env.local`
 * pentru rulare locală cu `vercel dev`.
 *
 * Request  (POST, JSON):  { "input": "...", "mode"?: "formulieren" | "korrigieren" | "uebersetzen",
 *                           "targetLang"?: "de" | "en" | "tr" | ... }
 *   - mode implicit: "formulieren" (übersetzen + professionell formulieren)
 *   - targetLang: doar pentru "formulieren". Absent / "de" -> ieșire germană (comportament clasic).
 *                 Alt cod -> documentația e redată în acea limbă (fidelitate neschimbată).
 * Response (JSON):
 *   200 -> { "text": "documentația (germană sau limba țintă)" }
 *   4xx/5xx -> { "error": "mesaj lizibil pentru UI" }
 * ------------------------------------------------------------------
 */

// Vercel Hobby permite până la 60s per funcție; implicit ar fi ~10s, iar o
// documentație completă pe flash depășește des 10s => „pare blocat". Setăm explicit.
export const maxDuration = 60;

// Model implicit. Poate fi suprascris din env fără redeploy de cod.
const DEFAULT_MODEL = "gemini-3.6-flash";

// Reîncercări pe erori tranzitorii de capacitate Gemini (429 / 503 / „overloaded").
// Buget calibrat sub maxDuration (60s): 2 încercări de 22s + backoff ≈ 46s max.
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [1200, 2600];
const PER_ATTEMPT_TIMEOUT_MS = 22000;
const TOTAL_BUDGET_MS = 44000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function isTransientUpstream(status, msg) {
    if (status === 429 || status === 503 || status === 500) return true;
    return /overload|high demand|unavailable|temporarily|try again later|RESOURCE_EXHAUSTED|UNAVAILABLE|INTERNAL/i.test(msg || "");
}

/* ================================================================
   K3 (E+) — HARD GLOBAL DEADLINE pentru bucla de retry
   ----------------------------------------------------------------
   O singură sursă de adevăr: `deadline = startedAt + TOTAL_BUDGET_MS`.
   `remainingBudget()` (= max(0, deadline - now)) mărginește TOT:
     • timeout-ul AbortController al fiecărui attempt;
     • pornirea unui nou attempt;
     • backoff-ul dintre attempts.
   Un attempt pornit târziu NU mai poate rula încă PER_ATTEMPT_TIMEOUT_MS
   peste buget — timeout-ul lui efectiv scade la cât a mai rămas.
   Funcțiile de mai jos sunt PURE (fără timere, fără I/O) și exportate
   exclusiv pentru testare unitară; bucla de retry le folosește direct,
   deci nu există logică duplicată care se poate desincroniza.
   ================================================================ */

// Timeout efectiv al unui attempt = min(limita per-attempt, restul bugetului global).
// Minim 1 ms ca setTimeout să nu primească 0 / negativ.
export function effectiveAttemptTimeout(perAttemptMs, remainingMs) {
    return Math.max(1, Math.min(perAttemptMs, Math.max(0, remainingMs)));
}

// Mai putem porni un fetch Gemini? Doar dacă deadline-ul global nu a fost atins.
export function canStartAttempt(remainingMs) {
    return remainingMs > 0;
}

// Decide backoff + retry în interiorul deadline-ului global.
// retry doar dacă (a) mai avem attempts și (b) DUPĂ backoff rămâne timp real de
// rulare (remainingMs > backoffMs). Altfel: fără sleep inutil, fără attempt nou.
// sleepMs e mereu clamp-at la restul bugetului (robustețe suplimentară).
export function planBackoff(attempt, maxAttempts, backoffMs, remainingMs) {
    if (attempt >= maxAttempts) return { retry: false, sleepMs: 0 };
    if (remainingMs <= backoffMs) return { retry: false, sleepMs: 0 };
    return { retry: true, sleepMs: Math.min(backoffMs, remainingMs) };
}

// K2: extrage un „retry delay" (secunde) din răspunsul Gemini, dacă îl semnalează
// explicit. Surse (robuste la forme lipsă): header HTTP `Retry-After` (secunde) sau
// `error.details[].retryDelay` de tip "41s" / "1.5s" (google.rpc.RetryInfo).
// Întoarce un întreg de secunde sau null. NU expune niciun text din eroare.
function parseRetryDelaySec(upstream, data) {
    try {
        const h = upstream && upstream.headers && typeof upstream.headers.get === "function"
            ? upstream.headers.get("retry-after") : null;
        if (h && /^\d+$/.test(String(h).trim())) return parseInt(String(h).trim(), 10);
        const details = data && data.error && Array.isArray(data.error.details) ? data.error.details : [];
        for (const d of details) {
            const rd = d && (d.retryDelay || (d.retryInfo && d.retryInfo.retryDelay));
            const m = typeof rd === "string" ? rd.match(/^(\d+(?:\.\d+)?)s$/) : null;
            if (m) return Math.max(1, Math.ceil(parseFloat(m[1])));
        }
    } catch (_) { /* formă neașteptată -> null */ }
    return null;
}

// K2: 429 care indică epuizare de cotă (nu doar rate-limit de moment). Pentru
// acest caz un retry rapid e garantat inutil -> întoarcem repede 503.
function isQuotaExhausted(upstream, data) {
    if (!upstream || upstream.status !== 429) return false;
    const st = data && data.error && data.error.status;
    const msg = data && data.error && data.error.message ? String(data.error.message) : "";
    return st === "RESOURCE_EXHAUSTED" || /\bquota\b|exceeded/i.test(msg);
}

// Limită de siguranță pentru input (caractere). Protejează de abuz/costuri.
// 8000: o documentație existentă de tradus poate fi mai lungă decât o notiță brută.
const MAX_INPUT_CHARS = 8000;

// Coduri UI -> denumire germană a limbii (pentru instrucțiunea de limbă țintă).
const LANG_NAMES = {
    de: "Deutsch", en: "Englisch", fr: "Französisch", es: "Spanisch",
    it: "Italienisch", pt: "Portugiesisch", pl: "Polnisch", tr: "Türkisch",
    ro: "Rumänisch", ru: "Russisch", uk: "Ukrainisch", ar: "Arabisch"
};


/* ================================================================
   SYSTEM PROMPTS — "Professional Pflegedokumentation Engine"
   Ținute pe server ca să nu poată fi ocolite din client.
   Principiu central: NICIODATĂ nu inventa informații. Sens > stil.
   ================================================================ */

// Reguli comune de fidelitate (folosite de toate modurile).
const TREUE_REGELN = `ROLLE
Du bist ein Dokumentations- und Sprachassistent in einer deutschen Pflege-Dokumentations-App. Deine EINZIGE Aufgabe ist es, die eigenen Angaben der Pflegekraft in eine klare, grammatikalisch korrekte, professionelle deutsche Pflegedokumentation zu überführen. Die Pflegekraft bleibt voll verantwortlich und prüft das Ergebnis.
Du bist KEIN Arzt, keine Diagnostik, kein Entscheidungssystem, kein Ersatz für eine Pflegefachkraft. Du triffst KEINE medizinischen Entscheidungen und ergänzt KEINE klinischen Schlussfolgerungen, die nicht genannt wurden.

GRUNDPRINZIP: NIEMALS INFORMATIONEN ERFINDEN
Die Dokumentation enthält AUSSCHLIESSLICH Informationen, die die Pflegekraft ausdrücklich genannt hat oder die bedeutungserhaltend umformuliert werden können. Im Zweifel: NICHT raten.

BEDEUTUNG VOR STIL
Verbessern DARFST du: Grammatik, Rechtschreibung, Zeichensetzung, Satzbau, Terminologie, Lesbarkeit, Prägnanz, Chronologie.
NICHT verändern darfst du: Fakten, Mengen, Messwerte, Zeiten, Daten, Symptome, Beobachtungen, Medikamente, Namen, Körperteile, Seitigkeit (links/rechts), Häufigkeit, Schweregrad, durchgeführte Handlungen, Aussagen des Patienten/Bewohners.

KEIN FÜLLMATERIAL
Ergänze NIEMALS Standardfloskeln wie „keine Schmerzen“, „keine Auffälligkeiten“, „Patient war stabil“, „orientiert“, „Vitalwerte unauffällig“, „tolerierte die Maßnahme gut“, „Mobilität uneingeschränkt“, „keine Komplikationen“, „kooperativ“ – es sei denn, die Pflegekraft hat genau das gesagt. Eine kürzere, faktentreue Dokumentation ist IMMER besser als eine längere erfundene.

BEOBACHTUNG vs. AUSSAGE
Erhalte, WER die Information geliefert hat.
„Herr Müller sagt, dass sein Bauch weh tut.“ -> „Herr Müller gab Bauchschmerzen an.“ (NICHT: „Herr Müller hatte Bauchschmerzen.“)
Eine berichtete Aussage darf nicht als objektiv festgestellter Befund dargestellt werden.

UNSICHERHEIT ERHALTEN
Verdacht bleibt Verdacht, Annahme bleibt Annahme, Möglichkeit bleibt Möglichkeit.
„Ich glaube, Frau Schmidt war heute verwirrt.“ -> NICHT „Frau Schmidt war verwirrt.“, sondern z. B. „Die Pflegekraft nahm Frau Schmidt heute als möglicherweise verändert wahr.“ – nur wenn dies die Aussage korrekt wiedergibt.

CHRONOLOGIE
Reihenfolge der Ereignisse exakt beibehalten. Nur umstellen, wenn es die Grammatik zwingend verlangt und die Bedeutung gleich bleibt.

ZAHLEN & MESSWERTE
NIE verändern: Temperatur, Blutdruck, Puls, Sauerstoffsättigung, Blutzucker, Gewicht, Einfuhr/Ausfuhr, Dosierung, Uhrzeit, Datum, Dauer, Häufigkeit, Prozentwerte.
Formatvereinheitlichung erlaubt: „125 zu 80“ -> „125/80 mmHg“. Keine Einheit erfinden, außer der Kontext ist völlig eindeutig.

MEDIKAMENTE
Keine Namen, Dosen, Zeiten, Indikationen, Wirkungen oder Nebenwirkungen erfinden.
„Herr Müller hat seine Medikamente bekommen.“ -> „Herr Müller erhielt seine Medikamente.“ (ohne Präparat/Dosis)
Genannte Angaben („Ibuprofen 400 mg wurde verabreicht“) exakt erhalten.

KÖRPERTEILE & SEITIGKEIT
Anatomie exakt übernehmen. Niemals rechts/links tauschen, Arm/Hand, Bein/Fuß, Schulter/Ellenbogen verwechseln oder eine fehlende Seitigkeit erfinden.

KEINE UNTERSCHIEDE ERFINDEN
Was einheitlich, beidseitig oder ohne genaue Stelle genannt wurde, bleibt einheitlich, beidseitig und ohne genaue Stelle. Füge KEINE Seiten-, Grad- oder Ortsunterschiede hinzu, die nicht genannt wurden – kein „rechts stärker als links“, kein „vor allem am …“, keine Lokalisation, wenn nur ein Symptom ohne Stelle genannt wurde. „Beide Unterschenkel etwas gerötet“ bleibt „beide Unterschenkel etwas gerötet“.

BEOBACHTUNG vs. INTERPRETATION
„Patient war sehr unruhig.“ -> „Der Patient zeigte sich deutlich unruhig.“ Die Ursache NICHT ergänzen (z. B. „aufgrund von Angst“), außer sie wurde genannt.

ZU VAGE EINGABE
Keine spezifischere Version halluzinieren. „Patient hatte Schmerzen.“ -> „Der Patient gab Schmerzen an.“ NICHT „starke Rückenschmerzen 7/10“.

FEHLENDE ANGABEN
Nicht für jedes Detail nachfragen. Wenn die Angaben für eine nützliche, faktentreue Dokumentation ausreichen, erstelle sie. Nur dann auf Unklarheit hinweisen, wenn ein fehlendes Detail die Dokumentation irreführend oder wesentlich mehrdeutig machen würde.

SPRACHE
Die Eingabe kann in beliebiger Sprache sein (u. a. Rumänisch, Deutsch, Türkisch, Polnisch, Arabisch, Englisch, Russisch, Ukrainisch). Die Ausgabe ist IMMER Deutsch. Sinngemäß übersetzen, niemals wörtlich, wenn das unnatürliches Deutsch ergäbe. Kein nicht-deutsches Wort im Ergebnis – Ausnahme: Eigennamen von Personen sowie Zahlen-/Messwerte.

PROFESSIONELLES DEUTSCH
Natürliches, prägnantes Pflege-Deutsch. Kein Slang, keine Umgangssprache, keine wörtliche Maschinenübersetzung, keine übertriebene oder akademische Fachterminologie. Ziel: klar + sachlich + professionell + verständlich für eine andere Pflegekraft. Keine unnötigen Adjektive, keine emotionale Sprache, keine Spekulation, keine Wiederholung, keine Füllsätze. Die einfache Wortwahl der Pflegekraft darf beibehalten werden; nur dort verbessern, wo es Klarheit, Korrektheit, Professionalität oder Lesbarkeit erhöht. Detailgrad beibehalten.

INTERNE ENDKONTROLLE (nicht ausgeben)
Nichts erfunden? Nichts Wichtiges entfernt? Bedeutung unverändert? Zahl / Medikament / Körperteil / Seitigkeit / handelnde Person unverändert? Unsicherheit nicht zu Gewissheit gemacht? Chronologie erhalten? Deutsch korrekt und natürlich? Prägnant? Würde die Pflegekraft ihre eigenen Angaben wiedererkennen? Bei Zweifel überarbeiten.

ABSOLUTE REGEL
Zwischen einer beeindruckender klingenden und einer einfacheren, vollständig treuen Dokumentation IMMER die einfachere, treue wählen. Aufgabe: „Aus den Informationen der Pflegekraft eine klare, korrekte und professionelle Dokumentation machen.“ NICHT: „Eine möglichst vollständige Dokumentation erfinden.“`;

/* ----------------------------------------------------------------------------
   Pflegefachsprache + cadru regional. Injectate în modurile de SCRIERE
   (formulieren / pflegeplanung), NU în korrigieren.
   Regionalizare viitoare: adaugă o intrare în STANDARDS și expune un selector;
   momentan un singur set — Deutschland / Nordrhein-Westfalen.
   ---------------------------------------------------------------------------- */
const PFLEGEFACHSPRACHE = `PFLEGEFACHSPRACHE UND DOKUMENTATIONSGRUNDSÄTZE
Objektiv, sachlich, wertfrei. Beschreibe beobachtbares Verhalten statt Bewertungen oder Etiketten: nicht „unkooperativ“, „aggressiv“, „verwirrt“, „schwierig“, sondern das konkrete Verhalten (was war zu sehen bzw. zu hören).
Aktiv und konkret formulieren, nachvollziehbar für Dritte, die die Situation nicht miterlebt haben. Die handelnde Person benennen (Pflegekraft, Bewohner/in, Angehörige, Arzt/Ärztin).
Keine Diagnosen stellen; von der Pflegekraft genannte ärztliche Diagnosen dürfen wörtlich übernommen werden. Ist-Zustand und Fremdaussage strikt trennen.`;

const STANDARDS = {
    "de-nrw": `REGIONALER RAHMEN: DEUTSCHLAND / NORDRHEIN-WESTFALEN
Die Dokumentation muss den in Deutschland üblichen pflegefachlichen Anforderungen genügen und für die Heimaufsicht (WTG NRW, stationär) bzw. den Landesrahmenvertrag nach § 75 SGB XI (ambulant) sowie die Qualitätsprüfung des Medizinischen Dienstes nachvollziehbar sein: vollständig, sachlich, zeitnah und widerspruchsfrei.
Fachbegriffe der Nationalen Expertenstandards (DNQP) korrekt verwenden – NUR wenn die Pflegekraft den Sachverhalt genannt hat, niemals ergänzend: Dekubitusprophylaxe, Sturzprophylaxe, Schmerzmanagement, Förderung der Harnkontinenz, Ernährungsmanagement, Erhaltung und Förderung der Mobilität, Pflege von Menschen mit chronischen Wunden, Beziehungsgestaltung bei Demenz, Entlassungsmanagement.
Assessment-Instrumente und Skalen nur mit genannten Werten und korrekter Benennung: Braden- bzw. Norton-Skala; Dekubitus-Kategorie I–IV (EPUAP/NPIAP); Schmerz per NRS, VAS oder VRS bzw. BESD/ZOPA bei Demenz; BMI, Mini Nutritional Assessment oder PEMU; Miktionsprotokoll und Kontinenzprofile; Pflegegrad und Module des Begutachtungsinstruments. Werte, Kategorien oder Skalenwerte NIEMALS erfinden oder schätzen.
Keine nicht standardisierten Abkürzungen. Datum, Uhrzeit und Handzeichen nur übernehmen, wenn genannt. Keine zusätzlichen personenbezogenen Daten ergänzen (Schweigepflicht, DSGVO).`,
};
const DEFAULT_REGION = "de-nrw";

// Modele de documentație selectabile din UI.
const DOC_MODELS = ["sis", "klassisch"];
const DEFAULT_DOC_MODEL = "sis";

// Cadru comun pentru modurile de scriere.
function schreibRahmen() {
    return `${TREUE_REGELN}\n\n${PFLEGEFACHSPRACHE}\n\n${STANDARDS[DEFAULT_REGION]}`;
}

// MODE: formulieren / uebersetzen — notiță -> Pflege-Verlaufsbericht (pe tură/ore).
// Documentația de tură: CE s-a făcut cu persoana și CE s-a observat, în ordine
// cronologică, profesional. Fără alegere de model (SIS/clasic e doar pt Planung).
function promptFormulieren() {
    return `${schreibRahmen()}

MODUS: PFLEGEDOKUMENTATION (VERLAUFSBERICHT)
Formuliere die Angaben als professionellen deutschen Pflege-Verlaufseintrag: sachlich, chronologisch, in vollständigen Sätzen. Dokumentiert wird, WAS mit der pflegebedürftigen Person getan wurde und WAS beobachtet wurde – einschließlich ihrer eigenen Aussagen (als solche gekennzeichnet).

ZEITLICHE GLIEDERUNG
Umfassen die Angaben mehrere Tageszeiten oder Schichten, gliedere nach den GENANNTEN Zeiten/Schichten, jeweils als vorangestellte Zeile: „Morgens:“ / „Mittags:“ / „Nachmittags:“ / „Abends:“ / „Nachts:“ / „Bei Bedarf:“ (bzw. „Frühdienst:“ / „Spätdienst:“ / „Nachtdienst:“, wenn so genannt). Konkrete Uhrzeiten nur übernehmen, wenn sie genannt wurden – niemals erfinden. Betrifft alles denselben Zeitpunkt oder ist es ein einzelnes Ereignis, genügt EIN sachlicher Satz bzw. Absatz ohne Zeit-Zwischenzeilen.

INHALT
Durchgeführte Maßnahmen (Körperpflege, An-/Auskleiden, Mobilisation/Transfer, Ernährung und Flüssigkeit, Ausscheidung/Kontinenzversorgung, Lagerung, Prophylaxen, Medikamentengabe, Arzt-/Angehörigenkontakt – NUR wie genannt), dazu Beobachtungen, Reaktionen und Befinden der Person. Vitalwerte, falls genannt, im Format: RR <Wert> mmHg | Puls <Wert>/min | SpO2 <Wert> % | BZ <Wert> mg/dl | Temp <Wert> °C. Keine Wiederholung der Regelversorgung ohne Abweichung, kein Füllmaterial.

AUSGABEFORMAT
Gib NUR den fertigen Dokumentationstext zurück. Keine Einleitung („Hier ist …“), keine Erklärung, kein medizinischer Rat, kein Disclaimer im Text.`;
}

// MODE: pflegeplanung — descriere liberă -> plan structurat.
function promptPflegeplanung(docModel) {
    const koerper = docModel === "klassisch"
        ? `DOKUMENTATIONSMODELL: KLASSISCHE PFLEGEPLANUNG (nach AEDL/ABEDL)
Struktur je Pflegeproblem – Überschriften genau so:

Pflegeproblem:
<kurz und konkret; wenn die Angaben es hergeben im Format „Problem – beeinflussende Faktoren – Zeichen/Symptome“ (PES), sonst nur das Genannte>

Ressourcen:
<was die Person selbst kann oder was sie unterstützt – nur wenn genannt>

Pflegeziel:
<Pflichtangabe: zu jedem Pflegeproblem ein Pflegeziel – der fachlich naheliegende, positiv formulierte Sollzustand, direkt aus dem genannten Problem abgeleitet (Problem „Gangunsicherheit“ -> Ziel „sicheres Gehen, Sturzrisiko verringert“). Nah- und Fernziel trennen, wenn möglich. KEINE erfundenen Werte, Messgrößen, Fristen oder Termine und keine neuen Fakten; ein aus dem Problem abgeleitetes Ziel gilt nicht als Erfindung. Nur weglassen, wenn sich aus dem Problem kein sinnvolles Ziel ableiten lässt.>

Pflegemaßnahmen:
- <konkrete Maßnahme, je Zeile eine; Häufigkeit/Zeitpunkt nur wenn genannt>

Evaluation:
<nur wenn ein Überprüfungsdatum oder ein Ergebnis genannt wurde>`
        : `DOKUMENTATIONSMODELL: STRUKTURMODELL – MASSNAHMENPLAN
Die sechs SIS-Themenfelder: Kognition und Kommunikation; Mobilität und Bewegung; Krankheitsbezogene Anforderungen und Belastungen; Selbstversorgung; Leben in sozialen Beziehungen; Wohnen bzw. Haushaltsführung.

TEIL 1 – GEPLANTE EINTRÄGE
Für jedes Themenfeld, zu dem die Pflegekraft Angaben gemacht hat, ein Block – Überschriften genau so:

Themenfeld: <Name des Themenfelds>
Fähigkeiten / Bedarf:
<was die Person kann und wobei sie Unterstützung braucht – nur Genanntes>
Maßnahmen:
- <konkrete Maßnahme, je Zeile eine; Häufigkeit/Zeitpunkt nur wenn genannt>
Angestrebtes Ergebnis:
<nur wenn genannt; überprüfbar, ohne erfundene Werte oder Fristen>
Evaluation:
<nur wenn ein Termin oder Ergebnis genannt wurde>

TEIL 2 – OFFENE THEMENFELDER
Danach die Überschrift „Noch zu erheben:“ und darunter JEDES Themenfeld, zu dem KEINE Angaben vorliegen, als eigene Zeile im Format:
- <Themenfeld>: keine Angaben – z. B. <ein bis zwei typische Informationen für dieses Themenfeld>
Typische Informationen je Themenfeld (als Beispiel, NICHT als Behauptung übernehmen):
Kognition und Kommunikation: Orientierung, Gedächtnis, Verständigung, Seh-/Hörhilfen.
Mobilität und Bewegung: Gehstrecke, Transfer, Sturzrisiko, Hilfsmittel, Lagerung.
Krankheitsbezogene Anforderungen und Belastungen: Erkrankungen, Medikamente, Schmerz, Wunden, Vitalzeichen, Prophylaxen, Arzttermine.
Selbstversorgung: Körperpflege, Kleiden, Essen und Trinken, Ausscheidung/Kontinenz.
Leben in sozialen Beziehungen: Kontakte, Besuche, Tagesstruktur, Stimmung, Beschäftigung.
Wohnen bzw. Haushaltsführung: Wohn-/Zimmersituation, Hilfsmittel im Umfeld, Einkauf, Haushalt.
Sind zu ALLEN sechs Themenfeldern Angaben vorhanden, entfällt Teil 2.`;

    return `${schreibRahmen()}

MODUS: PFLEGEPLANUNG STRUKTURIEREN
Wandle die Angaben der Pflegekraft in eine strukturierte Planung um. Verwende AUSSCHLIESSLICH genannte Informationen. Erfinde KEINE Probleme, Ressourcen, Ziele, Maßnahmen, Fristen oder Messwerte. Nicht belegte Abschnitte ersatzlos weglassen (kein Platzhaltertext).

${koerper}

Mehrere Einträge bzw. Pflegeprobleme durch eine Leerzeile trennen, in der von der Pflegekraft genannten Reihenfolge.

AUSGABEFORMAT
Gib NUR die Planung zurück. Keine Einleitung, keine Erklärung, kein Disclaimer im Text.`;
}

// MODE: korrigieren — doar corectură lingvistică (fără cadru regional / structură).
const PROMPT_KORRIGIEREN = `${TREUE_REGELN}

MODUS: KORRIGIEREN
Korrigiere NUR Rechtschreibung, Grammatik, Zeichensetzung und offensichtliche sprachliche Fehler. Behalte die Wortwahl und den Aufbau der Pflegekraft so weit wie möglich bei. KEINE inhaltliche oder stilistische Umformulierung, keine Umstrukturierung, keine Fachbegriff-Ersetzungen über das Nötige hinaus. Ist die Eingabe nicht auf Deutsch, übertrage sie so wörtlich wie möglich ins korrekte Deutsche.

AUSGABEFORMAT
Gib NUR den korrigierten Text zurück – ohne Einleitung, ohne Kommentar.`;

const VALID_MODES = ["formulieren", "uebersetzen", "korrigieren", "pflegeplanung"];

// Asamblează promptul de sistem. docModel e relevant DOAR pentru pflegeplanung
// (Maßnahmenplan vs. clasic); Dokumentation e mereu Verlaufsbericht pe tură.
function buildSystemPrompt(mode, docModel) {
    if (mode === "korrigieren") return PROMPT_KORRIGIEREN;
    if (mode === "pflegeplanung") return promptPflegeplanung(docModel);
    return promptFormulieren(); // formulieren + uebersetzen
}

export default async function handler(req, res) {
    // Same-origin: frontend-ul apelează /api/generate de pe același domeniu,
    // deci NU trimitem Access-Control-Allow-Origin (evită abuzul prin embed
    // cross-origin în browser). Cererile server-to-server ignoră oricum CORS.
    res.setHeader("Vary", "Origin");

    if (req.method === "OPTIONS") {
        return res.status(204).end();
    }
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Methode nicht erlaubt. Bitte POST verwenden." });
    }

    // Respinge rapid corpurile evident supradimensionate ÎNAINTE de orice lucru
    // (DB / auth / rate limit). Input-ul util e <= 8000 caractere (~<= 24 KB JSON);
    // 64 KB e cu marjă generoasă. Nu incomodează utilizarea normală.
    const contentLength = Number(req.headers["content-length"] || 0);
    if (contentLength > 64 * 1024) {
        return res.status(413).json({ error: "Anfrage zu groß." });
    }

    // --- Guard: cont autentificat + e-mail confirmat + CSRF + rate limit (IP & cont).
    //     NU atinge logica engine-ului (prompt / Gemini / parsare).
    //
    //     Bypass pentru test suite (header X-Engine-Test = ENGINE_TEST_SECRET):
    //     REFUZAT STRUCTURAL în producție (F-08) — indiferent dacă ENGINE_TEST_SECRET
    //     e setat. Permis doar când NODE_ENV/VERCEL_ENV nu sunt "production"
    //     (adică `vercel dev` local).
    const bypassAllowed =
        process.env.NODE_ENV !== "production" && process.env.VERCEL_ENV !== "production";
    const testSecret = process.env.ENGINE_TEST_SECRET;
    const isTestCall =
        bypassAllowed && !!testSecret && req.headers["x-engine-test"] === testSecret;

    try {
        const { hasDatabase, ensureSchema } = await import("../lib/db.mjs");
        if (hasDatabase()) {
            await ensureSchema();
            const { rateLimit } = await import("../lib/ratelimit.mjs");
            const { clientIp } = await import("../lib/http.mjs");
            const { securityEvent } = await import("../lib/securitylog.mjs");
            const rl = await rateLimit(`generate:ip:${clientIp(req)}`, 40, 3600);
            if (!rl.allowed) {
                res.setHeader("Retry-After", String(rl.retryAfter));
                securityEvent("generate_rate_limit_hit", req, { outcome: "429", detail: "generate:ip" });
                return res.status(429).json({
                    error: "Zu viele Anfragen. Bitte in einer Stunde erneut versuchen."
                });
            }

            if (!isTestCall) {
                const { getAuth, checkCsrf } = await import("../lib/auth.mjs");
                const auth = await getAuth(req);
                if (!auth) {
                    securityEvent("authorization_failure", req, { outcome: "401", route: "/api/generate" });
                    return res.status(401).json({ error: "Anmeldung erforderlich." });
                }
                if (auth.user.email_verified !== true) {
                    securityEvent("authorization_failure", req, { outcome: "email_unverified", route: "/api/generate", userId: auth.user.id });
                    return res.status(403).json({
                        error: "Bitte bestätige zuerst deine E-Mail-Adresse.",
                        code: "email_unverified",
                    });
                }
                // CSRF: aceeași apărare defense-in-depth ca celelalte endpoint-uri
                // autentificate (F-17). Token-ul din sesiune, trimis ca X-CSRF-Token.
                if (!checkCsrf(req, auth.session)) {
                    securityEvent("authorization_failure", req, { outcome: "csrf", route: "/api/generate", userId: auth.user.id });
                    return res.status(403).json({ error: "Ungültiges oder fehlendes CSRF-Token." });
                }
                // Limită pe CONT (nu doar pe IP): un cont care rotește IP-uri nu poate
                // depăși ~60/oră. Peste limita clasică pe IP (40/oră) -> nu incomodează
                // utilizarea normală (o documentație/minut, o oră la rând).
                const rlUser = await rateLimit(`generate:user:${auth.user.id}`, 60, 3600);
                if (!rlUser.allowed) {
                    res.setHeader("Retry-After", String(rlUser.retryAfter));
                    securityEvent("generate_rate_limit_hit", req, { outcome: "429", detail: "generate:user", userId: auth.user.id });
                    return res.status(429).json({
                        error: "Zu viele Anfragen. Bitte in einer Stunde erneut versuchen."
                    });
                }
            }
        } else if (!isTestCall) {
            // Fără bază de date nu putem verifica sesiunea -> blocăm (fail-closed).
            return res.status(503).json({ error: "Dienst vorübergehend nicht verfügbar." });
        }
    } catch (e) {
        console.error("[generate] guard error:", e.name || "error");
        return res.status(503).json({ error: "Dienst vorübergehend nicht verfügbar." });
    }

    // --- Cheia API din mediu ---
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return res.status(500).json({
            error: "Auf dem Server ist kein Schlüssel hinterlegt (GEMINI_API_KEY). Bitte in Vercel setzen."
        });
    }

    // --- Validare input ---
    let body = req.body;
    if (typeof body === "string") {
        try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    const input = body && typeof body.input === "string" ? body.input.trim() : "";

    if (!input) {
        return res.status(400).json({ error: "Es fehlt der Text (Feld 'input')." });
    }
    if (input.length > MAX_INPUT_CHARS) {
        return res.status(413).json({
            error: `Text zu lang (${input.length} Zeichen). Maximal ${MAX_INPUT_CHARS}.`
        });
    }

    // Mod de lucru: formulieren (implicit) | korrigieren | uebersetzen | pflegeplanung
    const mode = VALID_MODES.includes(body && body.mode) ? body.mode : "formulieren";
    // Model de documentație: sis (implicit) | klassisch — relevant pt formulieren + pflegeplanung.
    const docModel = DOC_MODELS.includes(body && body.docModel) ? body.docModel : DEFAULT_DOC_MODEL;
    let systemPrompt = buildSystemPrompt(mode, docModel);

    // Limbă țintă: doar pentru "formulieren". Cod valid și ≠ "de" -> instrucțiune
    // adăugată DUPĂ regulile de fidelitate (le are prioritate doar pe cea de limbă).
    const targetLang =
        (mode === "formulieren" || mode === "pflegeplanung") &&
        body && typeof body.targetLang === "string"
            ? body.targetLang
            : "";
    if (targetLang && targetLang !== "de" && LANG_NAMES[targetLang]) {
        systemPrompt += `

AUSGABESPRACHE (Vorrang vor der SPRACHE-Regel oben)
Gib die gesamte Dokumentation AUSSCHLIESSLICH auf ${LANG_NAMES[targetLang]} aus, inklusive der Abschnitts-Überschriften. Alle Fakten, Zahlen, Messwerte, Eigennamen und Seitigkeit (links/rechts) bleiben unverändert. Keine Erfindungen, keine Erklärungen, kein zusätzlicher Text.`;
    }

    const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const payload = {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: input }] }],
        generationConfig: {
            // Fidelitate maximă: temperatură foarte joasă, fără „creativitate".
            temperature: 0.1,
            topP: 0.85,
            maxOutputTokens: 8192
        }
    };

    // --- Apel Gemini: până la MAX_ATTEMPTS încercări, cu backoff pe erori tranzitorii ---
    const OVERLOAD_MSG = "Gemini ist zurzeit überlastet (hohe Nachfrage). Bitte in einigen Sekunden erneut versuchen.";
    // Mesaj generic pentru clienți la erori de furnizor (detaliile rămân în log server).
    const SERVICE_ERR = "Der Dokumentationsdienst ist derzeit nicht verfügbar. Bitte später erneut versuchen.";
    const startedAt = Date.now();
    // K3 (E+): deadline global HARD. Nimic din bucla de retry (fetch, timeout
    // per-attempt, backoff, pornirea unui nou attempt) nu are voie să depășească
    // acest moment. `remainingBudget()` e singura sursă de adevăr.
    const deadline = startedAt + TOTAL_BUDGET_MS;
    const remainingBudget = () => Math.max(0, deadline - Date.now());
    let data = null;

    // K4: dacă browserul închide requestul /api/generate, oprim retry-urile și
    // abortăm apelul Gemini în curs — best-effort. Runtime Vercel Node: propagarea
    // disconnect-ului NU e garantată de platformă; dacă `res.once` nu există sau
    // evenimentul nu vine, blocul e un no-op inofensiv (listener `once`, fără leak).
    let clientGone = false;
    let activeUpstreamController = null;
    if (typeof res.once === "function") {
        res.once("close", () => {
            if (res.writableFinished) return; // răspunsul a fost deja trimis
            clientGone = true;
            try { activeUpstreamController && activeUpstreamController.abort(); } catch (_) {}
        });
        // Nu lăsa un `res.end()` pe un socket deja închis să devină excepție necaptată.
        if (typeof res.on === "function") res.on("error", () => {});
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (clientGone) { try { res.end(); } catch (_) {} return; } // clientul a plecat
        // K3 (E+): deadline global atins -> nu mai porni niciun fetch Gemini.
        if (!canStartAttempt(remainingBudget())) break;
        const controller = new AbortController();
        activeUpstreamController = controller;
        // Timeout efectiv = min(limita per-attempt, cât a mai rămas din bugetul global).
        const timer = setTimeout(
            () => controller.abort(),
            effectiveAttemptTimeout(PER_ATTEMPT_TIMEOUT_MS, remainingBudget())
        );

        let upstream;
        try {
            upstream = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
        } catch (err) {
            clearTimeout(timer);
            if (clientGone) { try { res.end(); } catch (_) {} return; }
            const aborted = err.name === "AbortError";
            // K3 (E+): retry doar dacă backoff-ul + un attempt nou încap în deadline.
            const plan = planBackoff(attempt, MAX_ATTEMPTS, RETRY_BACKOFF_MS[attempt - 1] || 2600, remainingBudget());
            if (plan.retry) {
                await sleep(plan.sleepMs);
                if (clientGone) { try { res.end(); } catch (_) {} return; }
                if (!canStartAttempt(remainingBudget())) break; // deadline atins în timpul backoff-ului
                continue;
            }
            return res.status(aborted ? 504 : 502).json({
                error: aborted
                    ? "Gemini hat nicht rechtzeitig geantwortet. Bitte erneut versuchen."
                    : "Der Gemini-Server konnte nicht erreicht werden."
            });
        }
        clearTimeout(timer);

        try {
            data = await upstream.json();
        } catch (e) {
            console.error("[generate] upstream non-JSON, HTTP", upstream.status);
            return res.status(502).json({ error: SERVICE_ERR });
        }

        if (upstream.ok) break;

        const apiMsg = data && data.error && data.error.message ? data.error.message : `HTTP ${upstream.status}`;
        // Detaliile furnizorului rămân DOAR în log-ul serverului (F-19 / hygiene).
        console.error("[generate] upstream error", upstream.status, String(apiMsg).slice(0, 200));

        // Erori permanente -> fără reîncercare. Mesaj generic către client.
        if (
            (upstream.status === 400 && /API key not valid/i.test(apiMsg)) ||
            upstream.status === 403 ||
            upstream.status === 404
        ) {
            return res.status(502).json({ error: SERVICE_ERR });
        }

        // K2: semnal explicit de retry îndepărtat / cotă epuizată -> NU retry rapid
        // cu 1200/2600 ms (garantat inutil). Întoarcem repede 503, cu un Retry-After
        // derivat din semnalul furnizorului (doar un întreg de secunde, fără text).
        const retrySec = parseRetryDelaySec(upstream, data);
        const quota = isQuotaExhausted(upstream, data);
        if ((retrySec !== null && retrySec >= 4) || quota) {
            res.setHeader("Retry-After", String(Math.min(retrySec || 30, 120)));
            return res.status(503).json({ error: OVERLOAD_MSG });
        }

        // Tranzitorie fără semnal utilizabil -> backoff bounded + retry cât timp
        // încape în deadline-ul global (MAX_ATTEMPTS oricum plafonează; fără loop infinit).
        if (isTransientUpstream(upstream.status, apiMsg)) {
            const plan = planBackoff(attempt, MAX_ATTEMPTS, RETRY_BACKOFF_MS[attempt - 1] || 2600, remainingBudget());
            if (plan.retry) {
                data = null;
                await sleep(plan.sleepMs);
                if (clientGone) { try { res.end(); } catch (_) {} return; }
                if (!canStartAttempt(remainingBudget())) break; // deadline atins în timpul backoff-ului
                continue;
            }
        }

        if (upstream.status === 429 || isTransientUpstream(upstream.status, apiMsg)) {
            res.setHeader("Retry-After", retrySec ? String(Math.min(retrySec, 120)) : "20");
            return res.status(503).json({ error: OVERLOAD_MSG });
        }
        return res.status(502).json({ error: SERVICE_ERR });
    }

    if (!data) {
        res.setHeader("Retry-After", "20");
        return res.status(503).json({ error: OVERLOAD_MSG });
    }

    // --- Blocaje de siguranță pe prompt ---
    if (data.promptFeedback && data.promptFeedback.blockReason) {
        return res.status(422).json({
            error: `Anfrage vom Sicherheitsfilter blockiert: ${data.promptFeedback.blockReason}`
        });
    }

    // --- Extragere text (concatenăm toate părțile, ignorăm 'thought') ---
    const candidate = data.candidates && data.candidates[0];
    let text = "";
    if (candidate && candidate.content && Array.isArray(candidate.content.parts)) {
        for (const p of candidate.content.parts) {
            if (p && typeof p.text === "string" && !p.thought) text += p.text;
        }
    }
    text = text.trim();

    if (!text) {
        const reason = (candidate && candidate.finishReason) || "necunoscut";
        if (reason === "MAX_TOKENS") {
            return res.status(502).json({ error: "Antwort abgeschnitten (MAX_TOKENS). Bitte die Notiz kürzen." });
        }
        if (reason === "SAFETY" || reason === "RECITATION") {
            return res.status(422).json({ error: `Antwort vom Modell blockiert (${reason}).` });
        }
        return res.status(502).json({ error: `Leere Antwort vom Modell (finishReason: ${reason}).` });
    }

    // Fără cache — fiecare cerere e nouă.
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ text });
}
