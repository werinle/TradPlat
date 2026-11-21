'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Exchange, OrderError } = require('../src/engine/Exchange');

function setup() {
  const ex = new Exchange({ symbols: [{ symbol: 'TEST', price: 10000 }] });
  ex.createAccount({ id: 'alice', cash: 1_000_000 }); // $10,000
  ex.createAccount({ id: 'bob', cash: 1_000_000 });
  ex.createAccount({ id: 'mm', unlimited: true });
  return ex;
}

const lim = (side, price, qty, extra = {}) => ({ symbol: 'TEST', side, type: 'limit', price, qty, ...extra });

test('resting orders sort by price then time', () => {
  const ex = setup();
  ex.placeOrder('mm', lim('buy', 9900, 1));
  ex.placeOrder('mm', lim('buy', 9950, 2));
  ex.placeOrder('mm', lim('buy', 9950, 3));
  ex.placeOrder('mm', lim('sell', 10100, 4));
  ex.placeOrder('mm', lim('sell', 10050, 5));
  const d = ex.depth('TEST');
  assert.deepEqual(d.bids, [{ price: 9950, qty: 5, orders: 2 }, { price: 9900, qty: 1, orders: 1 }]);
  assert.deepEqual(d.asks, [{ price: 10050, qty: 5, orders: 1 }, { price: 10100, qty: 4, orders: 1 }]);
  const book = ex.books.get('TEST');
  assert.equal(book.bids[0].qty, 2, 'older order at same price keeps priority');
});

test('aggressive limit buy walks the book at resting prices and settles balances', () => {
  const ex = setup();
  ex.placeOrder('mm', lim('sell', 10000, 5));
  ex.placeOrder('mm', lim('sell', 10010, 5));
  const o = ex.placeOrder('alice', lim('buy', 10010, 8));
  assert.equal(o.status, 'filled');
  assert.equal(o.filled, 8);
  assert.equal(o.avgPrice, (5 * 10000 + 3 * 10010) / 8);
  const a = ex.accountSnapshot('alice');
  assert.equal(a.cash, 1_000_000 - (5 * 10000 + 3 * 10010));
  assert.equal(a.reservedCash, 0, 'reservation fully released after fill');
  assert.equal(a.positions[0].qty, 8);
  assert.equal(ex.market('TEST').last, 10010);
  assert.equal(ex.depth('TEST').asks[0].qty, 2);
});

test('price improvement releases the unused reservation', () => {
  const ex = setup();
  ex.placeOrder('mm', lim('sell', 9000, 10));
  ex.placeOrder('alice', lim('buy', 10000, 10));
  const a = ex.accountSnapshot('alice');
  assert.equal(a.cash, 1_000_000 - 90_000);
  assert.equal(a.availableCash, a.cash);
});

test('partial fill rests remainder and reserves only for it', () => {
  const ex = setup();
  ex.placeOrder('mm', lim('sell', 10000, 3));
  const o = ex.placeOrder('alice', lim('buy', 10000, 10));
  assert.equal(o.status, 'partially_filled');
  const a = ex.accountSnapshot('alice');
  assert.equal(a.reservedCash, 7 * 10000);
  assert.equal(a.openOrders.length, 1);
  ex.cancelOrder('alice', o.id);
  assert.equal(ex.accountSnapshot('alice').reservedCash, 0);
  assert.equal(ex.orders.get(o.id).status, 'partially_filled_cancelled');
});

test('rejects buys beyond buying power and sells without shares', () => {
  const ex = setup();
  const big = ex.placeOrder('alice', lim('buy', 10000, 101)); // $10,100 > $10,000
  assert.equal(big.status, 'rejected');
  assert.match(big.reason, /buying power/);
  const short = ex.placeOrder('alice', lim('sell', 10000, 1));
  assert.equal(short.status, 'rejected');
  assert.match(short.reason, /Insufficient shares/);
});

test('reserved cash cannot be double spent', () => {
  const ex = setup();
  assert.equal(ex.placeOrder('alice', lim('buy', 5000, 150)).status, 'open'); // $7,500 reserved
  assert.equal(ex.placeOrder('alice', lim('buy', 5000, 60)).status, 'rejected'); // $3,000 > $2,500 left
});

test('market buy is capped by available cash', () => {
  const ex = setup();
  ex.placeOrder('mm', lim('sell', 30000, 100));
  const o = ex.placeOrder('alice', { symbol: 'TEST', side: 'buy', type: 'market', qty: 100 });
  assert.equal(o.filled, 33); // floor($10,000 / $300)
  assert.equal(o.status, 'partially_filled_cancelled');
  assert.ok(ex.accountSnapshot('alice').cash >= 0);
});

test('market order with no liquidity is cancelled', () => {
  const ex = setup();
  const o = ex.placeOrder('alice', { symbol: 'TEST', side: 'buy', type: 'market', qty: 5 });
  assert.equal(o.status, 'cancelled');
  assert.equal(o.filled, 0);
});

test('IOC limit cancels its unfilled remainder', () => {
  const ex = setup();
  ex.placeOrder('mm', lim('sell', 10000, 2));
  const o = ex.placeOrder('alice', lim('buy', 10000, 5, { tif: 'IOC' }));
  assert.equal(o.filled, 2);
  assert.equal(o.status, 'partially_filled_cancelled');
  assert.equal(ex.depth('TEST').bids.length, 0);
  assert.equal(ex.accountSnapshot('alice').reservedCash, 0);
});

test('selling realizes P&L against average cost', () => {
  const ex = setup();
  ex.placeOrder('mm', lim('sell', 10000, 10));
  ex.placeOrder('alice', lim('buy', 10000, 10));
  ex.placeOrder('mm', lim('sell', 12000, 10));
  ex.placeOrder('alice', lim('buy', 12000, 10));
  ex.placeOrder('mm', lim('buy', 13000, 5));
  ex.placeOrder('alice', lim('sell', 13000, 5));
  const a = ex.accountSnapshot('alice');
  assert.equal(a.positions[0].qty, 15);
  assert.equal(a.positions[0].avgCost, 11000);
  assert.equal(a.realizedPnl, 5 * (13000 - 11000));
});

test('trade between two users moves cash and shares both ways', () => {
  const ex = setup();
  ex.placeOrder('mm', lim('sell', 10000, 10));
  ex.placeOrder('alice', lim('buy', 10000, 10));
  ex.placeOrder('alice', lim('sell', 10500, 4));
  ex.placeOrder('bob', lim('buy', 10600, 4));
  const a = ex.accountSnapshot('alice');
  const b = ex.accountSnapshot('bob');
  assert.equal(a.positions[0].qty, 6);
  assert.equal(a.positions[0].reserved, 0);
  assert.equal(b.positions[0].qty, 4);
  assert.equal(b.cash, 1_000_000 - 4 * 10500, 'taker pays resting (maker) price');
  assert.equal(a.fills[0].liquidity, 'maker');
  assert.equal(b.fills[0].liquidity, 'taker');
});

test('self-trade prevention cancels the resting order', () => {
  const ex = setup();
  ex.placeOrder('mm', lim('sell', 10000, 10));
  ex.placeOrder('alice', lim('buy', 10000, 10));
  const rest = ex.placeOrder('alice', lim('sell', 10100, 5));
  ex.placeOrder('mm', lim('sell', 10200, 5));
  const buy = ex.placeOrder('alice', lim('buy', 10200, 5));
  assert.equal(ex.orders.get(rest.id).status, 'cancelled');
  assert.equal(buy.filled, 5);
  assert.equal(buy.avgPrice, 10200);
});

test('stop sell triggers when the last price falls through it', () => {
  const ex = setup();
  ex.placeOrder('mm', lim('sell', 10000, 10));
  ex.placeOrder('alice', lim('buy', 10000, 10));
  const stop = ex.placeOrder('alice', { symbol: 'TEST', side: 'sell', type: 'stop', stopPrice: 9500, qty: 10 });
  assert.equal(stop.status, 'pending');
  assert.equal(ex.accountSnapshot('alice').positions[0].reserved, 10);
  ex.placeOrder('mm', lim('buy', 9400, 50));
  ex.placeOrder('bob', lim('buy', 9600, 1)); // resting, no trade yet
  assert.equal(ex.orders.get(stop.id).status, 'pending');
  ex.placeOrder('mm', lim('sell', 9600, 1)); // trade at 9600: above stop
  assert.equal(ex.orders.get(stop.id).status, 'pending');
  // Bob sells into the 9400 bid -> last = 9400 <= 9500 -> stop fires
  ex.placeOrder('mm', lim('sell', 10000, 5));
  ex.placeOrder('bob', lim('buy', 10000, 5));
  ex.placeOrder('bob', { symbol: 'TEST', side: 'sell', type: 'market', qty: 1 });
  const s = ex.orders.get(stop.id);
  assert.equal(s.status, 'filled');
  assert.equal(s.filled, 10);
  assert.equal(ex.accountSnapshot('alice').positions.length, 0);
});

test('cancelling a pending stop releases its shares', () => {
  const ex = setup();
  ex.placeOrder('mm', lim('sell', 10000, 10));
  ex.placeOrder('alice', lim('buy', 10000, 10));
  const stop = ex.placeOrder('alice', { symbol: 'TEST', side: 'sell', type: 'stop', stopPrice: 9000, qty: 10 });
  ex.cancelOrder('alice', stop.id);
  assert.equal(ex.accountSnapshot('alice').positions[0].reserved, 0);
});

test('validation errors throw OrderError', () => {
  const ex = setup();
  assert.throws(() => ex.placeOrder('alice', lim('buy', 100.5, 1)), OrderError);
  assert.throws(() => ex.placeOrder('alice', lim('buy', 100, 0)), OrderError);
  assert.throws(() => ex.placeOrder('alice', lim('hold', 100, 1)), OrderError);
  assert.throws(() => ex.placeOrder('alice', { ...lim('buy', 100, 1), symbol: 'NOPE' }), OrderError);
  assert.throws(() => ex.cancelOrder('bob', 'O1'), OrderError);
});

test('trades build OHLCV candles', () => {
  let t = 1_000_000;
  const ex = new Exchange({ symbols: [{ symbol: 'TEST', price: 100 }], candleIntervalMs: 1000, now: () => t });
  ex.createAccount({ id: 'a', unlimited: true });
  ex.createAccount({ id: 'b', unlimited: true });
  const trade = (price, qty) => {
    ex.placeOrder('a', lim('sell', price, qty));
    ex.placeOrder('b', { symbol: 'TEST', side: 'buy', type: 'market', qty });
  };
  trade(100, 1);
  trade(105, 2);
  trade(98, 3);
  t += 1000;
  trade(101, 4);
  const c = ex.market('TEST').candles;
  assert.equal(c.length, 2);
  assert.deepEqual(
    { o: c[0].open, h: c[0].high, l: c[0].low, c: c[0].close, v: c[0].volume },
    { o: 100, h: 105, l: 98, c: 98, v: 6 },
  );
  assert.equal(c[1].open, 98);
  assert.equal(c[1].close, 101);
});

test('serialize/restore round-trips accounts, resting orders and stops', () => {
  const ex = setup();
  ex.placeOrder('mm', lim('sell', 10000, 10));
  ex.placeOrder('alice', lim('buy', 10000, 10));
  const restingBuy1 = ex.placeOrder('alice', lim('buy', 9000, 5));
  const restingBuy2 = ex.placeOrder('bob', lim('buy', 9000, 5)); // same price, later
  const restingSell = ex.placeOrder('alice', lim('sell', 11000, 4));
  const stop = ex.placeOrder('alice', { symbol: 'TEST', side: 'sell', type: 'stop', stopPrice: 8000, qty: 3 });

  const saved = JSON.parse(JSON.stringify(ex.serialize()));
  assert.ok(!saved.accounts.some((a) => a.id === 'mm'), 'bots are not persisted');

  const ex2 = new Exchange({ symbols: [{ symbol: 'TEST', price: 1 }] });
  ex2.createAccount({ id: 'mm', unlimited: true });
  ex2.restore(saved);

  const before = ex.accountSnapshot('alice');
  const after = ex2.accountSnapshot('alice');
  assert.deepEqual(after, before, 'account snapshot is identical after restore');
  assert.deepEqual(ex2.depth('TEST'), ex.depth('TEST'));
  assert.equal(ex2.market('TEST').last, 10000);
  assert.equal(ex2.stops.get('TEST').length, 1);

  // Time priority survives: alice's older 90.00 bid fills before bob's.
  ex2.placeOrder('mm', { symbol: 'TEST', side: 'sell', type: 'market', qty: 5 });
  assert.equal(ex2.orders.get(restingBuy1.id).status, 'filled');
  assert.equal(ex2.orders.get(restingBuy2.id).status, 'open');

  // New order ids continue after the restored sequence.
  const next = ex2.placeOrder('bob', lim('buy', 100, 1));
  assert.ok(Number(next.id.slice(1)) > Number(stop.id.slice(1)));

  // Restored orders are still cancellable and release their reservations.
  ex2.cancelOrder('alice', restingSell.id);
  ex2.cancelOrder('alice', stop.id);
  assert.equal(ex2.accountSnapshot('alice').positions[0].reserved, 0);
});

test('restore drops data for symbols that are no longer configured', () => {
  const ex = new Exchange({ symbols: [{ symbol: 'AAA', price: 100 }, { symbol: 'BBB', price: 100 }] });
  ex.createAccount({ id: 'u', cash: 100000 });
  ex.createAccount({ id: 'mm', unlimited: true });
  ex.placeOrder('mm', { symbol: 'BBB', side: 'sell', type: 'limit', price: 100, qty: 5 });
  ex.placeOrder('u', { symbol: 'BBB', side: 'buy', type: 'market', qty: 5 });
  ex.placeOrder('u', { symbol: 'AAA', side: 'buy', type: 'limit', price: 50, qty: 10 });
  const ex2 = new Exchange({ symbols: [{ symbol: 'AAA', price: 100 }] });
  ex2.restore(JSON.parse(JSON.stringify(ex.serialize())));
  const a = ex2.accountSnapshot('u');
  assert.equal(a.positions.length, 0);
  assert.equal(a.reservedCash, 500);
  assert.equal(a.openOrders.length, 1);
});
