/**
 * Vercel Serverless Function — /api/generate
 * ------------------------------------------------------------------
 * Proxy securizat între frontend și Google Gemini.
 * Cheia API NU ajunge niciodată în browser: trăiește doar în
 * variabila de mediu GEMINI_API_KEY, setată în dashboard-ul Vercel
 * (Project → Settings → Environment Variables) sau în `.env.local`
 * pentru rulare locală cu `vercel dev`.
 *
 * Request  (POST, JSON):  { "input": "...", "mode"?: "formulieren" | "korrigieren" | "uebersetzen" }
 *   - mode implicit: "formulieren" (übersetzen + professionell formulieren)
 * Response (JSON):
 *   200 -> { "text": "documentația în germană" }
 *   4xx/5xx -> { "error": "mesaj lizibil pentru UI" }
 * ------------------------------------------------------------------
 */

// Model implicit. Poate fi suprascris din env fără redeploy de cod.
const DEFAULT_MODEL = "gemini-3.6-flash";

// Limită de siguranță pentru input (caractere). Protejează de abuz/costuri.
const MAX_INPUT_CHARS = 6000;

// Timp maxim de așteptare pentru răspunsul Gemini.
const UPSTREAM_TIMEOUT_MS = 55000;

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

// MODE: formulieren / uebersetzen (implicit) — traducere + formulare profesională.
const PROMPT_FORMULIEREN = `${TREUE_REGELN}

MODUS: ÜBERSETZEN & PROFESSIONELL FORMULIEREN
Überführe die Angaben in eine professionelle deutsche Pflegedokumentation. Wenn die Eingabe mehrere Aspekte umfasst, gliedere nach dem Strukturmodell (SIS) – Überschriften genau so:

Situation / Beobachtung:
<Zustand, Verhalten, Beobachtungen; berichtete Aussagen als solche kennzeichnen>

Vitalwerte:
<NUR wenn Vitalwerte genannt wurden. Format je Wert: RR: <Wert> mmHg | Puls: <Wert>/min | SpO2: <Wert> % | BZ: <Wert> mg/dl | Temp: <Wert> °C. Nicht genannte Werte weglassen. Wurden GAR KEINE Vitalwerte genannt, entfällt dieser Abschnitt vollständig – KEIN Platzhaltertext.>

Durchgeführte Maßnahmen:
<NUR wenn Maßnahmen genannt wurden. Je Zeile mit "- ". Sonst entfällt der Abschnitt.>

Bei einer einzelnen kurzen Beobachtung ist EIN sachlicher Satz OHNE Überschriften vorzuziehen.

AUSGABEFORMAT
Gib NUR den fertigen Dokumentationstext zurück. Keine Einleitung („Hier ist …“), keine Erklärung, kein medizinischer Rat, kein Disclaimer im Text.`;

// MODE: korrigieren — doar corectură lingvistică, păstrează formularea.
const PROMPT_KORRIGIEREN = `${TREUE_REGELN}

MODUS: KORRIGIEREN
Korrigiere NUR Rechtschreibung, Grammatik, Zeichensetzung und offensichtliche sprachliche Fehler. Behalte die Wortwahl und den Aufbau der Pflegekraft so weit wie möglich bei. KEINE inhaltliche oder stilistische Umformulierung, keine Umstrukturierung, keine Fachbegriff-Ersetzungen über das Nötige hinaus. Ist die Eingabe nicht auf Deutsch, übertrage sie so wörtlich wie möglich ins korrekte Deutsche.

AUSGABEFORMAT
Gib NUR den korrigierten Text zurück – ohne Einleitung, ohne Kommentar.`;

const PROMPTS = {
    formulieren: PROMPT_FORMULIEREN,
    uebersetzen: PROMPT_FORMULIEREN,
    korrigieren: PROMPT_KORRIGIEREN
};
const VALID_MODES = Object.keys(PROMPTS);

export default async function handler(req, res) {
    // --- CORS (permite doar POST/OPTIONS; același origin în producție) ---
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
        return res.status(204).end();
    }
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Methode nicht erlaubt. Bitte POST verwenden." });
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

    // Mod de lucru: formulieren (implicit) | korrigieren | uebersetzen
    const mode = VALID_MODES.includes(body && body.mode) ? body.mode : "formulieren";
    const systemPrompt = PROMPTS[mode];

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

    // --- Apel Gemini cu timeout ---
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

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
        if (err.name === "AbortError") {
            return res.status(504).json({ error: "Gemini hat nicht rechtzeitig geantwortet. Bitte erneut versuchen." });
        }
        return res.status(502).json({ error: "Der Gemini-Server konnte nicht erreicht werden." });
    }
    clearTimeout(timer);

    let data;
    try {
        data = await upstream.json();
    } catch (e) {
        return res.status(502).json({ error: `Ungültige Antwort von Gemini (HTTP ${upstream.status}).` });
    }

    // --- Erori de la Gemini ---
    if (!upstream.ok) {
        const apiMsg = data && data.error && data.error.message
            ? data.error.message
            : `HTTP ${upstream.status}`;

        if (upstream.status === 400 && /API key not valid/i.test(apiMsg)) {
            return res.status(500).json({ error: "Der GEMINI_API_KEY auf dem Server ist ungültig." });
        }
        if (upstream.status === 403) {
            return res.status(500).json({ error: "Zugriff von Gemini verweigert (403). Bitte API-Aktivierung prüfen." });
        }
        if (upstream.status === 404) {
            return res.status(500).json({ error: `Modell nicht verfügbar (404): ${apiMsg}. Bitte GEMINI_MODEL ändern.` });
        }
        if (upstream.status === 429) {
            return res.status(429).json({ error: "Zu viele Anfragen (429). Bitte kurz warten und erneut versuchen." });
        }
        return res.status(502).json({ error: `Gemini-Fehler: ${apiMsg}` });
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
