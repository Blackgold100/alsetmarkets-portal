-- AlsetMarkets Client Portal schema. Safe to run on every start.

CREATE TABLE IF NOT EXISTS users (
  id                   SERIAL PRIMARY KEY,
  role                 TEXT NOT NULL DEFAULT 'client' CHECK (role IN ('admin','client')),
  email                TEXT NOT NULL UNIQUE,
  password_hash        TEXT NOT NULL,
  full_name            TEXT NOT NULL,
  phone                TEXT,
  country              TEXT,
  account_no           TEXT UNIQUE,
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending','active','suspended','closed')),
  tier                 TEXT NOT NULL DEFAULT 'Standard',
  kyc_status           TEXT NOT NULL DEFAULT 'pending' CHECK (kyc_status IN ('not_submitted','pending','verified','rejected')),
  kyc_verified_on      DATE,
  risk_profile         TEXT,
  plan_name            TEXT,
  account_manager      TEXT,
  base_currency        TEXT NOT NULL DEFAULT 'USD',
  opened_on            DATE NOT NULL DEFAULT CURRENT_DATE,
  must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
  failed_logins        INTEGER NOT NULL DEFAULT 0,
  locked_until         TIMESTAMPTZ,
  last_login_at        TIMESTAMPTZ,
  last_login_ip        TEXT,
  -- Upgrade notice (per client, set by admin)
  upgrade_active       BOOLEAN NOT NULL DEFAULT FALSE,
  upgrade_target_tier  TEXT,
  upgrade_title        TEXT,
  upgrade_message      TEXT,
  upgrade_cta_label    TEXT,
  upgrade_cta_url      TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transactions (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('deposit','withdrawal','profit','loss','fee')),
  amount      NUMERIC(16,2) NOT NULL CHECK (amount > 0),
  status      TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending','completed','rejected')),
  tx_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  reference   TEXT,
  description TEXT,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS transactions_user_date ON transactions(user_id, tx_date);

CREATE TABLE IF NOT EXISTS holdings (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  asset_class   TEXT NOT NULL,
  amount_in     NUMERIC(16,2) NOT NULL DEFAULT 0,
  current_value NUMERIC(16,2) NOT NULL DEFAULT 0,
  notes         TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS documents (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  url        TEXT NOT NULL,
  issued_on  DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notices (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE, -- NULL = all clients
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  level      TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info','warning','success')),
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id             SERIAL PRIMARY KEY,
  actor_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_email    TEXT,
  action         TEXT NOT NULL,
  target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  details        JSONB,
  ip             TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS audit_created ON audit_log(created_at DESC);

-- ---------- Crypto wallets ----------
-- Company deposit addresses. user_id NULL = shown to every client; set = that client only.
CREATE TABLE IF NOT EXISTS firm_wallets (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  asset      TEXT NOT NULL,
  network    TEXT NOT NULL,
  address    TEXT NOT NULL,
  memo       TEXT,
  label      TEXT,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Client withdrawal addresses (must be approved by an admin before use)
CREATE TABLE IF NOT EXISTS client_wallets (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label       TEXT,
  asset       TEXT NOT NULL,
  network     TEXT NOT NULL,
  address     TEXT NOT NULL,
  memo        TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, network, address)
);

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS asset        TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS network      TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS wallet_address TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS wallet_memo  TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS tx_hash      TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS client_requested BOOLEAN NOT NULL DEFAULT FALSE;

-- ---------- Live support chat ----------
-- One conversation per client; admins reply from the Support inbox.
CREATE TABLE IF NOT EXISTS chat_threads (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  assigned_to     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS chat_threads_last ON chat_threads(last_message_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id          SERIAL PRIMARY KEY,
  thread_id   INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  sender_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sender_role TEXT NOT NULL CHECK (sender_role IN ('client','admin','system')),
  body        TEXT NOT NULL,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS chat_messages_thread ON chat_messages(thread_id, id);

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
