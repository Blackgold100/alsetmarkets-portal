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

-- ---------- Investment plans ----------
-- Returns are posted by an admin from each plan's ACTUAL results, then distributed
-- pro-rata to every open position. Nothing is credited on a fixed schedule.
CREATE TABLE IF NOT EXISTS plans (
  id          SERIAL PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  summary     TEXT,
  description TEXT,
  risk_level  TEXT NOT NULL DEFAULT 'Medium',
  min_amount  NUMERIC(16,2) NOT NULL DEFAULT 100,
  lock_days   INTEGER NOT NULL DEFAULT 30 CHECK (lock_days >= 0 AND lock_days <= 3650),
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS plan_positions (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id     INTEGER NOT NULL REFERENCES plans(id),
  principal   NUMERIC(16,2) NOT NULL CHECK (principal > 0),
  value       NUMERIC(16,2) NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  started_on  DATE NOT NULL DEFAULT CURRENT_DATE,
  unlocks_on  DATE NOT NULL,
  closed_at   TIMESTAMPTZ,
  closed_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS plan_positions_user ON plan_positions(user_id, status);
CREATE INDEX IF NOT EXISTS plan_positions_plan ON plan_positions(plan_id, status);

CREATE TABLE IF NOT EXISTS plan_results (
  id           SERIAL PRIMARY KEY,
  plan_id      INTEGER NOT NULL REFERENCES plans(id),
  period_start DATE NOT NULL,
  period_end   DATE NOT NULL CHECK (period_end >= period_start),
  return_pct   NUMERIC(8,4) NOT NULL,
  note         TEXT,
  positions    INTEGER NOT NULL DEFAULT 0,
  total_pnl    NUMERIC(16,2) NOT NULL DEFAULT 0,
  posted_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (plan_id, period_start)
);

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS plan_id        INTEGER REFERENCES plans(id);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS position_id    INTEGER REFERENCES plan_positions(id) ON DELETE SET NULL;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS plan_result_id INTEGER REFERENCES plan_results(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS transactions_result_position ON transactions(plan_result_id, position_id) WHERE plan_result_id IS NOT NULL;

-- Default plans (only inserted once; edit them from Admin → Plans)
INSERT INTO plans (slug, name, summary, description, risk_level, min_amount, lock_days, sort) VALUES
 ('mining', 'Mining', 'Pooled exposure to cryptocurrency mining operations.',
  'Capital is allocated to cryptocurrency mining capacity. Weekly results depend on coin prices, network difficulty, equipment uptime and energy costs, and can be negative.',
  'High', 500, 90, 1),
 ('stocks', 'Stocks', 'A managed portfolio of listed equities.',
  'Capital is invested in a diversified basket of listed company shares and equity funds. Weekly results follow market movements, dividends and trading costs, and can be negative.',
  'Medium', 250, 30, 2),
 ('crypto-trading', 'Crypto Trading', 'Active trading of major cryptocurrencies.',
  'Capital is actively traded across major cryptocurrency pairs. Results are highly volatile: weeks with large gains or losses are both possible.',
  'High', 250, 30, 3)
ON CONFLICT (slug) DO NOTHING;

-- ---------- Account tiers & upgrades ----------
-- The upgrade amount is a deposit into the client's OWN balance (it stays theirs and
-- remains withdrawable). The tier changes once an admin approves that deposit.
CREATE TABLE IF NOT EXISTS tiers (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  rank           INTEGER NOT NULL,
  upgrade_amount NUMERIC(16,2),
  benefits       TEXT,
  offered        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO tiers (name, rank, upgrade_amount, benefits, offered) VALUES
 ('Starter', 1, NULL, NULL, FALSE),
 ('Standard', 2, NULL, NULL, FALSE),
 ('Professional', 3, 5000, E'A dedicated account manager\nPriority processing of deposits and withdrawals\nMonthly performance summary call', TRUE),
 ('VIP', 4, 25000, E'A senior relationship manager, reachable by phone\nSame-day withdrawal processing\nQuarterly portfolio review\nEarly access to new investment plans', TRUE)
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS upgrade_requests (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tier_id      INTEGER NOT NULL REFERENCES tiers(id),
  from_tier    TEXT,
  target_tier  TEXT NOT NULL,
  amount       NUMERIC(16,2) NOT NULL,
  status       TEXT NOT NULL DEFAULT 'awaiting_deposit'
               CHECK (status IN ('awaiting_deposit','deposit_submitted','completed','cancelled')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS upgrade_requests_user ON upgrade_requests(user_id, status);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS upgrade_request_id INTEGER REFERENCES upgrade_requests(id) ON DELETE SET NULL;
