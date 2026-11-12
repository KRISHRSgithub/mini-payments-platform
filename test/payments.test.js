const { test, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../src/app');
const { pool } = require('../src/db');

after(() => pool.end());
const uniq = () => `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
async function user(tag) {
  const email = `${tag}${uniq()}@test.com`;
  const r = await request(app).post('/auth/register').send({ email, password: 'password123' });
  assert.strictEqual(r.status, 201);
  return { email, auth: { Authorization: `Bearer ${r.body.token}` } };
}
const fund = (u, amt) =>
  request(app).post('/accounts/me/deposit').set(u.auth).set('Idempotency-Key', uniq()).send({ amount_cents: amt });
const balance = async (u) => (await request(app).get('/accounts/me').set(u.auth)).body.balance_cents;

test('requires authentication', async () => {
  assert.strictEqual((await request(app).get('/accounts/me')).status, 401);
});

test('retrying a transfer with the same idempotency key charges once', async () => {
  const a = await user('a'), b = await user('b');
  await fund(a, 10000);
  const send = () => request(app).post('/transfers').set(a.auth).set('Idempotency-Key', 'k1')
    .send({ to_email: b.email, amount_cents: 2500 });
  const first = await send(), retry = await send();
  assert.strictEqual(first.status, 201);
  assert.strictEqual(retry.status, 200);
  assert.strictEqual(retry.body.transferId, first.body.transferId);
  assert.strictEqual(await balance(a), 7500);
  assert.strictEqual(await balance(b), 2500);
});

test('rejects insufficient funds and reused key with different amount', async () => {
  const a = await user('a'), b = await user('b');
  await fund(a, 1000);
  const t = (key, amt) => request(app).post('/transfers').set(a.auth).set('Idempotency-Key', key)
    .send({ to_email: b.email, amount_cents: amt });
  assert.strictEqual((await t('x', 5000)).status, 422);
  assert.strictEqual((await t('y', 400)).status, 201);
  assert.strictEqual((await t('y', 900)).status, 422);
});

test('30 parallel transfers: no overspend, no deadlock, ledger balanced', async () => {
  const a = await user('a'), b = await user('b');
  await fund(a, 10000);
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) =>
    request(app).post('/transfers').set(a.auth).set('Idempotency-Key', `p${i}`)
      .send({ to_email: b.email, amount_cents: 500 })));
  assert.strictEqual(results.filter((r) => r.status === 201).length, 20);
  assert.strictEqual(results.filter((r) => r.status === 422).length, 10);
  assert.strictEqual(await balance(a), 0);
  assert.strictEqual(await balance(b), 10000);
  const { rows } = await pool.query(
    `SELECT direction, SUM(amount_cents) s FROM ledger_entries WHERE transfer_id IN
     (SELECT id FROM transfers WHERE to_account=(SELECT id FROM accounts WHERE user_id=(SELECT id FROM users WHERE email=$1)))
     GROUP BY direction`, [b.email]);
  const sums = Object.fromEntries(rows.map((r) => [r.direction, Number(r.s)]));
  assert.strictEqual(sums.DEBIT, sums.CREDIT);
});

test('transaction history lists ledger entries newest first', async () => {
  const a = await user('a');
  await fund(a, 300);
  await fund(a, 200);
  const r = await request(app).get('/transactions').set(a.auth);
  assert.strictEqual(r.body.items.length, 2);
  assert.strictEqual(r.body.items[0].amount_cents, 200);
  assert.strictEqual(r.body.items[0].direction, 'CREDIT');
});
