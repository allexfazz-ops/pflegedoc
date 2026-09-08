# PflegeDoc AI

Aplicație web (single-page, fără build) care preia note vocale sau scrise în mai
multe limbi (inclusiv text mixt) și le convertește într-o documentație medicală
germană profesională (Pflegedokumentation / Pflegefachsprache / SIS), folosind
Google Gemini API și Web Speech API. Include conturi de utilizator, istoric
personal server-side, i18n (12 limbi) și temă light/dark.

## Structură

```
.
├── index.html            # Frontend complet (UI + JS + i18n). Fără build step.
├── api/
│   ├── generate.js        # Proxy securizat spre Gemini (engine documentație) + rate limit
│   ├── health.js          # GET /api/health -> { ok, ready, schemaVersion, tableCount }
│   ├── auth/
│   │   ├── register.js    # POST — cont nou (rezistent la account enumeration)
│   │   ├── login.js       # POST — mesaj generic, timing egalizat
│   │   ├── logout.js      # POST — invalidare sesiune server-side (+ CSRF)
│   │   └── me.js          # GET  — probă sesiune { authenticated, user, csrfToken }
│   ├── history/
│   │   ├── index.js       # GET listă paginată (keyset) / POST creează
│   │   └── [id].js        # GET / DELETE — ownership WHERE user_id=<sesiune>
│   └── settings.js        # GET / PATCH — ui_language, theme
├── lib/
│   ├── db.mjs             # Neon: `sql` parametrizat, getPool(), ensureSchema() (migrare lazy)
│   ├── auth.mjs           # scrypt, sesiuni stateful, CSRF, guard-uri
│   ├── http.mjs           # JSON, cookies, IP client, body limit
│   ├── validate.mjs       # validare server-side (email, parolă, UUID, enum-uri)
│   └── ratelimit.mjs      # rate limiting fixed-window în Postgres
├── db/
│   ├── schema.sql         # DDL idempotent (users, sessions, activities, rate_limits)
│   └── migrate.mjs        # runner manual opțional
├── i18n/*.json            # 9 limbi (fr,es,it,pt,pl,tr,ru,uk,ar), "_reviewed": false
├── scripts/build-i18n.mjs # generator al fișierelor de mai sus
├── tests/engine-suite.mjs # test suite pentru fidelitatea engine-ului de documentație
└── package.json           # "type": "module"; dep: @neondatabase/serverless
```

## Arhitectură

- **Frontend**: vanilla JS, hash-router, fără framework. Stare în variabile de
  modul + `localStorage` (preferințe locale) sau contul de utilizator (când e logat).
- **Backend**: funcții Vercel serverless (Node ESM). Fără server persistent.
- **Bază de date**: Neon Postgres (integrarea Vercel Storage → `DATABASE_URL`).
  Migrare automată la primul request (`ensureSchema`, advisory-locked).
- **Autentificare**: parole `scrypt` (N=32768, salt per user), sesiuni stateful
  (în DB se ține doar `sha256(token)`), cookie `pd_session`
  `HttpOnly; Secure; SameSite=Lax`. CSRF: token per-sesiune cerut ca
  `X-CSRF-Token` la toate operațiile de scriere.
- **Autorizare**: fiecare resursă privată e filtrată server-side prin
  `WHERE user_id = <din sesiune>`. Frontend-ul nu e de încredere.

## Endpoint-uri

| Endpoint | Metode | Auth | Note |
|---|---|---|---|
| `/api/generate` | POST | da (sesiune + e-mail confirmat) | proxy Gemini; rate limit 40/h/IP; body `{ input, mode?, targetLang? }` — `mode`: `formulieren` (implicit) / `korrigieren`; `targetLang` (doar `formulieren`): cod UI ≠ `de` ⇒ documentația e redată în acea limbă |
| `/api/health` | GET | nu | doar stare schemă, fără detalii sensibile |
| `/api/auth/*` | — | — | toate rutele de mai jos merg prin **un singur** fișier `api/auth/[action].js` (limită Vercel Hobby: 12 funcții) |
| `/api/auth/register` | POST | nu | rate limit IP; nu confirmă existența e-mailului; trimite e-mail de verificare |
| `/api/auth/login` | POST | nu | rate limit IP+e-mail; mesaj generic |
| `/api/auth/logout` | POST | da (cookie) | CSRF obligatoriu; șterge rândul sesiunii |
| `/api/auth/me` | GET | opțional | `{ authenticated, user (+email_verified), csrfToken }` |
| `/api/auth/verify` | POST | nu | `{ token }` — single-use, rate limit IP |
| `/api/auth/resend-verification` | POST | da | CSRF; 3/oră/user |
| `/api/auth/forgot-password` | POST | nu | `{ email }` — răspuns mereu generic; rate limit IP+e-mail |
| `/api/auth/reset-password` | POST | nu | `{ token, password }` — single-use 1h; scrypt nou; invalidează toate sesiunile; setează `email_verified` |
| `/api/history` | GET / POST | da | GET paginat (preview); POST creează (CSRF) |
| `/api/history/:id` | GET / DELETE | da | ownership; 404 (nu 403) la miss; CSRF la DELETE |
| `/api/settings` | GET / PATCH | da | `ui_language`, `theme` (enum-uri validate; CSRF) |

## Bază de date (schema)

```
users(id, email UNIQUE, password_hash, email_verified, email_verified_at,
      ui_language, theme, created_at, updated_at)
sessions(id, user_id →users ON DELETE CASCADE, token_hash UNIQUE, csrf_token,
         created_at, last_seen_at, expires_at, user_agent, ip)
activities(id, user_id →users ON DELETE CASCADE, type, input_text, input_language,
           mode, result_text, output_language, created_at)   -- index (user_id, created_at DESC)
           -- type: 'dokumentation' | 'pflegeplanung' | 'korrigierung'
           -- output_language: cod UI ('tr','ru',…) când documentația a fost tradusă, altfel NULL
email_tokens(id, user_id →users ON DELETE CASCADE, token_hash UNIQUE, purpose,
             created_at, expires_at, used_at)          -- purpose: verify_email | reset_password
rate_limits(bucket, window_start, count)              -- PK (bucket, window_start)
```

Toate query-urile aplicației sunt parametrizate (tagged-template Neon). Singurul
SQL literal e în `db/schema.sql`. `ON DELETE CASCADE` pregătește ștergerea
contului / a tuturor datelor.

## i18n

- `data-i18n` / `data-i18n-ph` pe elementele HTML; `t(key)` pentru textele din JS.
- DE = sursă (fallback). EN + RO complete, inline în `index.html`.
- Celelalte 9 limbi: `/i18n/<code>.json`, încărcate la cerere (`loadLocale`),
  marcate `"_reviewed": false` — **de verificat de vorbitori nativi înainte de lansare**.
- Regenerare schelet: `node scripts/build-i18n.mjs`.
- Selectorul controlează DOAR limba interfeței; limba textului introdus în
  documentație e separată (`#inputLanguage`).

## Temă

Light / Dark / System. Preferința → `localStorage` (neautentificat) sau contul
de utilizator (`PATCH /api/settings`, aplicat și la login pe alt dispozitiv).

## Dezvoltare locală

```bash
npm i -g vercel
vercel link                 # o singură dată
vercel env pull .env.local  # aduce DATABASE_URL, GEMINI_API_KEY etc.
vercel dev                  # http://localhost:3000
```

> Web Speech API (microfonul) merge doar pe `http://localhost` sau `https://`.

Migrarea rulează automat; manual: `node --env-file=.env.local db/migrate.mjs`.

## Verificare e-mail

- La înregistrare se trimite un e-mail cu link `/?verify=<token>` (ecran cu buton
  → `POST /api/auth/verify`). Token single-use, valabil 24h (`email_tokens`).
- Contul e **utilizabil imediat**; cât timp e neconfirmat apare un banner cu
  „Trimite din nou". Verificarea devine obligatorie când se adaugă resetarea
  parolei (un singur switch de config).
- **Provider**: [Resend](https://resend.com). Fără `RESEND_API_KEY` setat →
  „dev mode": link-ul e returnat de `/api/auth/register` și logat pe server
  (util pentru test). Cu cheia setată → e-mailuri reale, zero schimbare de cod.
- Pentru e-mailuri reale: cont Resend → verifică un domeniu (DNS SPF/DKIM) →
  setează în Vercel `RESEND_API_KEY` și `EMAIL_FROM`
  (ex. `PflegeDoc <noreply@domeniul-tau.de>`).

## Deploy

Push pe `main` → Vercel publică automat. Variabile de mediu în Vercel:
`GEMINI_API_KEY` (obligatoriu), `GEMINI_MODEL` (opțional, implicit
`gemini-3.6-flash`), `DATABASE_URL` (setat automat de integrarea Neon),
`RESEND_API_KEY` + `EMAIL_FROM` (opțional — pentru e-mailuri de verificare reale).

## Test suite (engine de documentație)

```bash
node tests/engine-suite.mjs            # rulează pe deploy-ul live
PFLEGEDOC_API=<url>/api/generate node tests/engine-suite.mjs
```

Verifică automat „Meaning > Style" și „Never invent information": cifre,
medicamente, lateralitate, cronologie, observație vs. afirmația pacientului,
incertitudine, absența filler-ului clinic.

## Securitate — status

Practici moderne aplicate: hashing parole (scrypt), sesiuni stateful invalidabile,
CSRF (token per-sesiune), autorizare + ownership server-side, query-uri
parametrizate, validare input server-side, rate limiting, rendering sigur în DOM
(textContent / escaping), fără secrete în frontend, erori generice către client.

Riscuri reziduale cunoscute (Low): rate limiting „fail-open" dacă baza de date
nu răspunde; `register` nu e 100% opac la enumeration (`created: true/false`);
fereastră fixă la rate limiting; `/api/health` public. Detalii în raportul de
security review. **Nicio aplicație nu poate garanta securitate absolută.**

## Roadmap

- [ ] Verificare traduceri de către vorbitori nativi (9 limbi `_reviewed: false`)
- [ ] Ștergere Dokumentation / cont / toate datele (schema deja pregătită)
- [x] Korrigieren / Übersetzen — Korrigieren = mod pe ecranul Dokumentation;
      Übersetzen = selectorul „Ausgabesprache" (limba de ieșire) pe același ecran
- [ ] Stripe (abonament) + webhook
- [ ] Export (PDF / text)
- [ ] PWA (instalare pe telefon)
