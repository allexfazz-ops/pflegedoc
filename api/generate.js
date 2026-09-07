/**
 * Vercel Serverless Function — /api/generate
 * ------------------------------------------------------------------
 * Proxy securizat între frontend și Google Gemini.
 * Cheia API NU ajunge niciodată în browser: trăiește doar în
 * variabila de mediu GEMINI_API_KEY, setată în dashboard-ul Vercel
 * (Project → Settings → Environment Variables) sau în `.env.local`
 * pentru rulare locală cu `vercel dev`.
 *
 * Request  (POST, JSON):  { "input": "note brute ale utilizatorului" }
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

/**
 * System prompt (Pflegefachsprache / SIS).
 * Ținut pe server ca să nu poată fi ocolit din client.
 */
const SYSTEM_PROMPT = `Du bist eine erfahrene deutsche Pflegefachkraft und Experte für Pflegedokumentation nach dem Strukturmodell (SIS) und Pflegefachsprache.

AUFGABE:
Nimm die rohen Notizen des Nutzers entgegen (gesprochen oder geschrieben, auf Rumänisch, einfachem Deutsch, Spanisch oder Englisch) und wandle sie in eine fachlich einwandfreie, sachliche deutsche Pflegedokumentation um.

REGELN:
1. Schreibe ausschließlich auf Deutsch, in professioneller Pflegefachsprache.
2. Korrigiere automatisch Rechtschreib- und Grammatikfehler aus dem Eingabetext.
3. Bleibe streng sachlich und wertfrei. Erfinde KEINE Informationen. Was nicht genannt wurde, wird weggelassen.
4. Verwende Fachbegriffe (z. B. "Mobilisation", "Dekubitusprophylaxe", "Vitalzeichenkontrolle", "Kontinenzversorgung").
5. Strukturiere die Ausgabe exakt in diese Abschnitte (Überschriften genau so schreiben):

Situation / Beobachtung:
<Beschreibung des Zustands, Verhaltens und der Beobachtungen>

Vitalwerte:
<Nur wenn genannt. Format: RR: <Wert> mmHg | Puls: <Wert>/min | SpO2: <Wert> % | BZ: <Wert> mg/dl | Temp: <Wert> °C. Nicht genannte Werte weglassen. Wenn gar keine Vitalwerte genannt wurden, schreibe: "Keine Vitalwerte dokumentiert.">

Durchgeführte Maßnahmen:
<Aufzählung der durchgeführten pflegerischen Maßnahmen, jeweils mit "- " am Zeilenanfang>

6. Gib NUR diesen strukturierten Text zurück, ohne Einleitung, ohne Kommentar, bereit zum Kopieren in die Pflegesoftware.`;

export default async function handler(req, res) {
    // --- CORS (permite doar POST/OPTIONS; același origin în producție) ---
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
        return res.status(204).end();
    }
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Metodă neacceptată. Folosește POST." });
    }

    // --- Cheia API din mediu ---
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return res.status(500).json({
            error: "Serverul nu are cheia configurată (GEMINI_API_KEY). Setează-o în Vercel."
        });
    }

    // --- Validare input ---
    let body = req.body;
    if (typeof body === "string") {
        try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    const input = body && typeof body.input === "string" ? body.input.trim() : "";

    if (!input) {
        return res.status(400).json({ error: "Lipsește textul (câmpul 'input')." });
    }
    if (input.length > MAX_INPUT_CHARS) {
        return res.status(413).json({
            error: `Text prea lung (${input.length} caractere). Maxim ${MAX_INPUT_CHARS}.`
        });
    }

    const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const payload = {
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: input }] }],
        generationConfig: {
            temperature: 0.2,
            topP: 0.9,
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
            return res.status(504).json({ error: "Gemini nu a răspuns la timp. Reîncearcă." });
        }
        return res.status(502).json({ error: "Nu s-a putut contacta serverul Gemini." });
    }
    clearTimeout(timer);

    let data;
    try {
        data = await upstream.json();
    } catch (e) {
        return res.status(502).json({ error: `Răspuns invalid de la Gemini (HTTP ${upstream.status}).` });
    }

    // --- Erori de la Gemini ---
    if (!upstream.ok) {
        const apiMsg = data && data.error && data.error.message
            ? data.error.message
            : `HTTP ${upstream.status}`;

        if (upstream.status === 400 && /API key not valid/i.test(apiMsg)) {
            return res.status(500).json({ error: "Cheia GEMINI_API_KEY de pe server nu este validă." });
        }
        if (upstream.status === 403) {
            return res.status(500).json({ error: "Acces refuzat de Gemini (403). Verifică activarea API-ului." });
        }
        if (upstream.status === 404) {
            return res.status(500).json({ error: `Model indisponibil (404): ${apiMsg}. Schimbă GEMINI_MODEL.` });
        }
        if (upstream.status === 429) {
            return res.status(429).json({ error: "Prea multe cereri (429). Așteaptă puțin și reîncearcă." });
        }
        return res.status(502).json({ error: `Eroare Gemini: ${apiMsg}` });
    }

    // --- Blocaje de siguranță pe prompt ---
    if (data.promptFeedback && data.promptFeedback.blockReason) {
        return res.status(422).json({
            error: `Cerere blocată de filtrul de siguranță: ${data.promptFeedback.blockReason}`
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
            return res.status(502).json({ error: "Răspuns tăiat (MAX_TOKENS). Scurtează notele." });
        }
        if (reason === "SAFETY" || reason === "RECITATION") {
            return res.status(422).json({ error: `Răspuns blocat de model (${reason}).` });
        }
        return res.status(502).json({ error: `Răspuns gol de la model (finishReason: ${reason}).` });
    }

    // Fără cache — fiecare cerere e nouă.
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ text });
}
