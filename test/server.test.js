'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlatform } = require('../src/server');

test('HTTP API: register, trade against simulated liquidity, cancel', async (t) => {
  const platform = createPlatform({ simulate: false });
  await new Promise((r) => platform.listen(0, r));
  t.after(() => new Promise((r) => platform.close(r)));
  platform.sim.tick(); // put quotes on the books
  const base = `http://127.0.0.1:${platform.server.address().port}/api`;

  const call = async (method, p, body, token) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  assert.equal((await call('GET', '/account')).status, 401);

  const reg = await call('POST', '/auth/register', { username: 'trader1', password: 'secret123' });
  assert.equal(reg.status, 200);
  assert.equal(reg.body.account.cash, 100000 * 100);
  const { token } = reg.body;

  assert.equal((await call('POST', '/auth/register', { username: 'trader1', password: 'x23456' })).status, 409);
  assert.equal((await call('POST', '/auth/login', { username: 'trader1', password: 'wrong!!' })).status, 401);
  assert.equal((await call('POST', '/auth/login', { username: 'trader1', password: 'secret123' })).status, 200);

  const syms = await call('GET', '/symbols');
  assert.ok(syms.body.length >= 3);
  const nova = syms.body.find((s) => s.symbol === 'NOVA');
  assert.ok(nova.ask > nova.bid, 'simulated market maker quotes a two-sided market');

  const book = await call('GET', '/markets/NOVA/book?depth=5');
  assert.equal(book.body.asks.length, 5);

  const buy = await call('POST', '/orders', { symbol: 'NOVA', side: 'buy', type: 'market', qty: 10 }, token);
  assert.equal(buy.status, 201);
  assert.equal(buy.body.status, 'filled');

  const acct = await call('GET', '/account', null, token);
  assert.equal(acct.body.positions[0].symbol, 'NOVA');
  assert.equal(acct.body.positions[0].qty, 10);

  const resting = await call('POST', '/orders', { symbol: 'NOVA', side: 'sell', type: 'limit', price: nova.ask * 2, qty: 5 }, token);
  assert.equal(resting.body.status, 'open');
  const cancelled = await call('DELETE', `/orders/${resting.body.id}`, null, token);
  assert.equal(cancelled.body.status, 'cancelled');

  const rejected = await call('POST', '/orders', { symbol: 'NOVA', side: 'sell', type: 'market', qty: 1000 }, token);
  assert.equal(rejected.status, 422);
  const bad = await call('POST', '/orders', { symbol: 'NOVA', side: 'buy', type: 'limit', price: 1.5, qty: 1 }, token);
  assert.equal(bad.status, 400);
});

test('simulator keeps markets two-sided and generates trades', () => {
  const platform = createPlatform({ simulate: false });
  for (let i = 0; i < 200; i++) platform.sim.tick();
  for (const s of platform.exchange.symbols()) {
    const tk = platform.exchange.ticker(s);
    assert.ok(tk.bid < tk.ask, `${s} spread is positive`);
    assert.ok(platform.exchange.market(s).trades.length > 0, `${s} has trades`);
  }
});
