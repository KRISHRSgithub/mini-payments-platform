CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE accounts (
  id SERIAL PRIMARY KEY,
  user_id INT UNIQUE REFERENCES users(id),
  is_system BOOLEAN NOT NULL DEFAULT false,
  balance_cents BIGINT NOT NULL DEFAULT 0,
  CHECK (is_system OR balance_cents >= 0)
);
CREATE TABLE transfers (
  id SERIAL PRIMARY KEY,
  from_account INT NOT NULL REFERENCES accounts(id),
  to_account INT NOT NULL REFERENCES accounts(id),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_account <> to_account),
  UNIQUE (from_account, idempotency_key)
);
-- Double-entry: every transfer has exactly one DEBIT and one CREDIT of equal amount.
CREATE TABLE ledger_entries (
  id SERIAL PRIMARY KEY,
  transfer_id INT NOT NULL REFERENCES transfers(id),
  account_id INT NOT NULL REFERENCES accounts(id),
  direction TEXT NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ledger_account ON ledger_entries(account_id, id DESC);
-- System "bank" account (id 1) funds demo deposits.
INSERT INTO accounts(id, is_system) VALUES (1, true);
SELECT setval(pg_get_serial_sequence('accounts','id'), 1);
