# Mini Payments Platform

REST API for a wallet: JWT auth, idempotent transfers, double-entry ledger, transaction history.
Stack: Node.js, Express, PostgreSQL, Docker.

## Run
    docker compose up --build        # API on :3000, Postgres on :5432
    npm install && npm test          # integration tests (needs the db container running)

## Endpoints
| Method | Path | Notes |
|---|---|---|
| POST | /auth/register, /auth/login | returns JWT |
| GET | /accounts/me | balance |
| POST | /accounts/me/deposit | demo funding from system account; `Idempotency-Key` header |
| POST | /transfers | `Idempotency-Key` header; body `{to_email, amount_cents}` |
| GET | /transactions?limit=&offset= | ledger history, newest first |

## Design decisions
- **Money as integer cents** (BIGINT), never floats.
- **Double-entry ledger:** each transfer writes one DEBIT and one CREDIT of equal amount; balances are updated in the same DB transaction.
- **Idempotency:** `UNIQUE(from_account, idempotency_key)` + `ON CONFLICT DO NOTHING`; a retry returns the original result (200) and never charges twice. Reusing a key with a different payload returns 422.
- **Concurrency:** both accounts are locked `FOR UPDATE` in ascending id order, which prevents deadlocks between opposite transfers and prevents overspending; a test fires 30 parallel transfers to prove it.
