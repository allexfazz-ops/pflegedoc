# PflegeDoc AI

MVP web (single-page) care preia note vocale sau scrise în mai multe limbi
(română, germană simplă, engleză, spaniolă) și le convertește într-o
documentație medicală germană oficială (Pflegedokumentation / Pflegefachsprache / SIS),
folosind Google Gemini API și Web Speech API.

## Structură

```
.
├── index.html          # Frontend complet (UI + JS). Nu are build step.
├── api/
│   └── generate.js     # Vercel Serverless Function — proxy securizat spre Gemini
├── package.json        # "type": "module" (necesar pentru ESM în /api)
├── .env.example        # Șablon variabile de mediu
└── .gitignore
```

## Cum funcționează generarea

Frontendul apelează **`POST /api/generate`** cu `{ "input": "<notele>" }`.
Funcția serverless adaugă cheia (`GEMINI_API_KEY`) și `SYSTEM_PROMPT`-ul, cheamă
Gemini și întoarce `{ "text": "..." }` sau `{ "error": "..." }`.

Cheia API **nu ajunge niciodată în browser**.

### Mod fallback (fără backend)

În `index.html`, secțiunea „⚙️ Cheie API proprie (opțional)" permite introducerea
unei chei direct în browser. Dacă e completată, aplicația apelează Gemini direct
(util pentru testare rapidă fără `vercel dev`). Dacă e goală, se folosește
`/api/generate`. Regula în `callGemini()`: `useBackend = BACKEND_ENDPOINT && !apiKey`.

## Dezvoltare locală

Necesită [Vercel CLI](https://vercel.com/docs/cli): `npm i -g vercel`

```bash
# 1. Variabile de mediu
cp .env.example .env.local
#   editează .env.local și pune GEMINI_API_KEY

# 2. Pornește serverul local (frontend + /api)
vercel dev
#   deschide http://localhost:3000
```

> Web Speech API (microfonul) merge doar pe `http://localhost` sau `https://`,
> niciodată din `file://`.

## Deploy pe Vercel

1. Push repo pe GitHub (`pflegedoc`).
2. Pe [vercel.com](https://vercel.com) → **New Project** → importă repo-ul.
3. **Settings → Environment Variables**, adaugă:
   - `GEMINI_API_KEY` = cheia ta
   - `GEMINI_MODEL` = `gemini-3.6-flash` (opțional)
4. Deploy. Fiecare push pe `main` va publica automat.

Framework preset: **Other** (nu are build; Vercel servește `index.html` static
și rulează `api/generate.js` ca function).

## Model Gemini

Implicit `gemini-3.6-flash` (v1beta `:generateContent`). Dacă apare eroare 404,
mesajul API indică modelul corect — schimbă `GEMINI_MODEL` în Vercel (fără redeploy
de cod) sau `CONFIG.GEMINI_MODEL` în `index.html` pentru modul fallback.

## Pași următori (roadmap)

- [ ] Rate limit / cotă gratuită per vizitator
- [ ] Stripe (abonament) + webhook
- [ ] Autentificare utilizatori
- [ ] Istoric documente generate + export
- [ ] PWA (instalare pe telefon)
