-- =============================================================================
-- PflegeDoc — Database Schema  (PostgreSQL / Neon)
-- -----------------------------------------------------------------------------
-- Idempotent: se poate rula de câte ori (toate obiectele au IF NOT EXISTS).
-- Aplicat automat de db/migrate.mjs (și lazy de lib/db.mjs la primul request).
-- Fără date de utilizator hardcodate. Toate query-urile aplicației sunt
-- parametrizate — acest fișier este SINGURUL loc cu SQL literal.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- email case-insensitive

-- Evidența versiunilor de schemă aplicate.
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     text        PRIMARY KEY,
    applied_at  timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- users — contul de bază + preferințe UI (limbă, temă)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    email          citext      NOT NULL UNIQUE,
    -- Format: scrypt$<N>$<r>$<p>$<saltB64>$<hashB64>. Niciodată plain text.
    password_hash  text        NOT NULL,
    ui_language    text        NOT NULL DEFAULT 'de',
    theme          text        NOT NULL DEFAULT 'system',
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT users_email_len   CHECK (char_length(email) BETWEEN 3 AND 254),
    CONSTRAINT users_ui_language CHECK (ui_language IN
        ('de','en','fr','es','it','pt','pl','tr','ro','ru','uk','ar')),
    CONSTRAINT users_theme       CHECK (theme IN ('system','light','dark'))
);

-- Verificare e-mail (adăugate ulterior — ADD COLUMN IF NOT EXISTS e idempotent).
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified    boolean     NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

-- -----------------------------------------------------------------------------
-- email_tokens — token-uri single-use pentru acțiuni pe e-mail.
-- purpose: 'verify_email' acum; 'reset_password' pregătit pentru viitor.
-- Se stochează DOAR sha256(token brut).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_tokens (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  text        NOT NULL UNIQUE,
    purpose     text        NOT NULL DEFAULT 'verify_email',
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz,
    CONSTRAINT email_tokens_purpose CHECK (purpose IN ('verify_email', 'reset_password'))
);
CREATE INDEX IF NOT EXISTS email_tokens_user_idx    ON email_tokens (user_id);
CREATE INDEX IF NOT EXISTS email_tokens_expires_idx ON email_tokens (expires_at);

-- -----------------------------------------------------------------------------
-- sessions — sesiuni server-side (stateful), invalidabile la logout
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Se stochează DOAR sha256(token brut) în hex. Tokenul brut trăiește
    -- exclusiv în cookie-ul HttpOnly al clientului.
    token_hash    text        NOT NULL UNIQUE,
    -- Token CSRF per-sesiune (double-submit): trimis clientului prin /api/auth/me,
    -- cerut ca header X-CSRF-Token la toate operațiile de scriere.
    csrf_token    text        NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL,
    user_agent    text,
    ip            inet
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

-- -----------------------------------------------------------------------------
-- activities — istoricul personal (Dokumentation + Pflegeplanung)
-- Un singur tabel pentru ambele tipuri de activitate.
-- ON DELETE CASCADE => ștergerea contului șterge tot istoricul.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activities (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type            text        NOT NULL,
    input_text      text        NOT NULL,
    input_language  text,                       -- cod Speech ('de-DE', 'ro-RO', …) sau NULL
    mode            text,                       -- 'formulieren' | 'korrigieren' | 'uebersetzen' | NULL
    result_text     text        NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT activities_type CHECK (type IN ('dokumentation','pflegeplanung','korrigierung')),
    CONSTRAINT activities_mode CHECK (mode IS NULL OR mode IN
        ('formulieren','korrigieren','uebersetzen','pflegeplanung')),
    CONSTRAINT activities_input_len  CHECK (char_length(input_text)  BETWEEN 1 AND 20000),
    CONSTRAINT activities_result_len CHECK (char_length(result_text) BETWEEN 1 AND 40000),
    CONSTRAINT activities_lang_len   CHECK (input_language IS NULL OR char_length(input_language) <= 12)
);
-- Index pentru listare paginată: cele mai noi întâi, per utilizator.
CREATE INDEX IF NOT EXISTS activities_user_created_idx
    ON activities (user_id, created_at DESC, id DESC);

-- Migrare 2026-09-08-02: tip 'korrigierung' + limba de ieșire (traducere în Dokumentation).
-- Blocuri idempotente (DROP IF EXISTS + ADD) — se pot rula de câte ori.
ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_type;
ALTER TABLE activities ADD  CONSTRAINT activities_type
    CHECK (type IN ('dokumentation','pflegeplanung','korrigierung'));
ALTER TABLE activities ADD COLUMN IF NOT EXISTS output_language text;  -- cod UI ('tr','ru', …) sau NULL
ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_output_lang_len;
ALTER TABLE activities ADD  CONSTRAINT activities_output_lang_len
    CHECK (output_language IS NULL OR char_length(output_language) <= 12);

-- Migrare 2026-09-08-03: modul 'pflegeplanung' (al doilea motor pe ecranul Dokumentation).
ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_mode;
ALTER TABLE activities ADD  CONSTRAINT activities_mode
    CHECK (mode IS NULL OR mode IN ('formulieren','korrigieren','uebersetzen','pflegeplanung'));

-- -----------------------------------------------------------------------------
-- patients — proiecte de Pflegeplanung, unul per pacient/Klient (per utilizator).
-- Recomandat: nume scurt / inițiale (date medicale, DSGVO). ON DELETE CASCADE
-- pe user și pe activities => ștergerea pacientului șterge planurile lui.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS patients (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        text        NOT NULL,
    note        text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT patients_name_len CHECK (char_length(name) BETWEEN 1 AND 120),
    CONSTRAINT patients_note_len CHECK (note IS NULL OR char_length(note) <= 2000)
);
CREATE INDEX IF NOT EXISTS patients_user_idx ON patients (user_id, updated_at DESC, id DESC);

-- Legătura Pflegeplanung -> pacient. NULL pentru dokumentation / korrigierung.
ALTER TABLE activities ADD COLUMN IF NOT EXISTS patient_id uuid
    REFERENCES patients(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS activities_patient_idx
    ON activities (patient_id, created_at DESC, id DESC);

-- -----------------------------------------------------------------------------
-- rate_limits — contoare fixed-window pentru endpoint-uri sensibile
-- bucket ex: 'login:ip:203.0.113.7', 'register:ip:…', 'delete:user:<uuid>'
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_limits (
    bucket        text        NOT NULL,
    window_start  timestamptz NOT NULL,
    count         integer     NOT NULL DEFAULT 0,
    PRIMARY KEY (bucket, window_start)
);
CREATE INDEX IF NOT EXISTS rate_limits_window_idx ON rate_limits (window_start);

-- -----------------------------------------------------------------------------
-- updated_at automat pentru users
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_set_updated_at ON users;
CREATE TRIGGER users_set_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS patients_set_updated_at ON patients;
CREATE TRIGGER patients_set_updated_at
    BEFORE UPDATE ON patients
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
