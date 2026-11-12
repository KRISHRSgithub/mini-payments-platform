const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('./db');

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const SYSTEM_ACCOUNT = 1;
const app = express();
app.use(express.json());

const httpErr = (status, error) => Object.assign(new Error(error), { status });
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
const sign = (uid, aid) => jwt.sign({ uid, aid }, SECRET, { expiresIn: '1h' });

function auth(req, res, next) {
  try {
    req.user = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'unauthorized' });
  }
}

// Atomic, idempotent, double-entry transfer.
async function transfer(fromId, toId, amount, key) {
  if (fromId === toId) throw httpErr(400, 'cannot transfer to the same account');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // Lock both accounts in a fixed (id) order so concurrent transfers cannot deadlock.
    await c.query('SELECT id FROM accounts WHERE id = ANY($1) ORDER BY id FOR UPDATE', [[fromId, toId]]);
    const ins = await c.query(
      `INSERT INTO transfers(from_account,to_account,amount_cents,idempotency_key)
       VALUES($1,$2,$3,$4) ON CONFLICT (from_account, idempotency_key) DO NOTHING RETURNING id`,
      [fromId, toId, amount, key]);
    if (!ins.rows.length) { // same key seen before: replay the original result, charge nothing
      await c.query('ROLLBACK');
      const { rows } = await pool.query(
        'SELECT id,to_account,amount_cents FROM transfers WHERE from_account=$1 AND idempotency_key=$2', [fromId, key]);
      if (Number(rows[0].amount_cents) !== amount || rows[0].to_account !== toId)
        throw httpErr(422, 'idempotency key reused with a different request');
      return { replay: true, transferId: rows[0].id };
    }
    const id = ins.rows[0].id;
    const { rows: [from] } = await c.query('SELECT balance_cents, is_system FROM accounts WHERE id=$1', [fromId]);
    if (!from.is_system && Number(from.balance_cents) < amount) throw httpErr(422, 'insufficient funds');
    await c.query(`INSERT INTO ledger_entries(transfer_id,account_id,direction,amount_cents) VALUES($1,$2,'DEBIT',$3)`, [id, fromId, amount]);
    await c.query(`INSERT INTO ledger_entries(transfer_id,account_id,direction,amount_cents) VALUES($1,$2,'CREDIT',$3)`, [id, toId, amount]);
    await c.query('UPDATE accounts SET balance_cents = balance_cents - $1 WHERE id=$2', [amount, fromId]);
    await c.query('UPDATE accounts SET balance_cents = balance_cents + $1 WHERE id=$2', [amount, toId]);
    await c.query('COMMIT');
    return { replay: false, transferId: id };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

function parseMoney(req) {
  const key = req.headers['idempotency-key'];
  const amount = req.body && req.body.amount_cents;
  if (!key) throw httpErr(400, 'Idempotency-Key header required');
  if (!Number.isInteger(amount) || amount <= 0) throw httpErr(400, 'amount_cents must be a positive integer');
  return { key, amount };
}

app.get('/', (req, res) => res.json({ status: 'ok', service: 'mini-payments-platform' }));

app.post('/auth/register', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password || password.length < 8) throw httpErr(400, 'email and a password of 8+ characters required');
  const hash = await bcrypt.hash(password, 10);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const u = await c.query('INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id', [email.toLowerCase(), hash]);
    const a = await c.query('INSERT INTO accounts(user_id) VALUES($1) RETURNING id', [u.rows[0].id]);
    await c.query('COMMIT');
    res.status(201).json({ token: sign(u.rows[0].id, a.rows[0].id) });
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e.code === '23505' ? httpErr(409, 'email already registered') : e;
  } finally {
    c.release();
  }
}));

app.post('/auth/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  const { rows } = await pool.query(
    'SELECT u.id uid, u.password_hash, a.id aid FROM users u JOIN accounts a ON a.user_id=u.id WHERE u.email=$1',
    [String(email || '').toLowerCase()]);
  if (!rows.length || !(await bcrypt.compare(String(password || ''), rows[0].password_hash)))
    throw httpErr(401, 'invalid credentials');
  res.json({ token: sign(rows[0].uid, rows[0].aid) });
}));

app.get('/accounts/me', auth, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT id, balance_cents FROM accounts WHERE id=$1', [req.user.aid]);
  res.json({ id: rows[0].id, balance_cents: Number(rows[0].balance_cents) });
}));

// Demo funding: money comes from the system "bank" account, so the ledger still balances.
app.post('/accounts/me/deposit', auth, wrap(async (req, res) => {
  const { key, amount } = parseMoney(req);
  const r = await transfer(SYSTEM_ACCOUNT, req.user.aid, amount, `${req.user.aid}:${key}`);
  res.status(r.replay ? 200 : 201).json(r);
}));

app.post('/transfers', auth, wrap(async (req, res) => {
  const { key, amount } = parseMoney(req);
  const { rows } = await pool.query(
    'SELECT a.id FROM accounts a JOIN users u ON u.id=a.user_id WHERE u.email=$1', [String(req.body.to_email || '').toLowerCase()]);
  if (!rows.length) throw httpErr(404, 'recipient not found');
  const r = await transfer(req.user.aid, rows[0].id, amount, key);
  res.status(r.replay ? 200 : 201).json(r);
}));

app.get('/transactions', auth, wrap(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const offset = parseInt(req.query.offset) || 0;
  const { rows } = await pool.query(
    `SELECT l.id, l.transfer_id, l.direction, l.amount_cents, l.created_at, t.from_account, t.to_account
     FROM ledger_entries l JOIN transfers t ON t.id=l.transfer_id
     WHERE l.account_id=$1 ORDER BY l.id DESC LIMIT $2 OFFSET $3`, [req.user.aid, limit, offset]);
  res.json({ items: rows.map((r) => ({ ...r, amount_cents: Number(r.amount_cents) })), limit, offset });
}));

app.use((err, req, res, next) => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'internal error' });
});

module.exports = app;
