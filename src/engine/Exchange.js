'use strict';

const { EventEmitter } = require('events');
const { OrderBook } = require('./OrderBook');

const SIDES = new Set(['buy', 'sell']);
const TYPES = new Set(['limit', 'market', 'stop', 'stop_limit']);
const TIFS = new Set(['GTC', 'IOC']);

class OrderError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OrderError';
  }
}

/**
 * The exchange: owns order books, accounts, risk checks, matching and settlement.
 *
 * Units: prices and cash are integer cents, quantities are integer shares.
 *
 * Emits:
 *   'trade'   (trade)
 *   'order'   (order)        whenever an order changes state
 *   'account' (accountId)    whenever an account's balances change
 */
class Exchange extends EventEmitter {
  constructor({ symbols = [], candleIntervalMs = 15000, now = () => Date.now() } = {}) {
    super();
    this.now = now;
    this.candleIntervalMs = candleIntervalMs;
    this.books = new Map();
    this.markets = new Map();
    this.accounts = new Map();
    this.orders = new Map();
    this.stops = new Map(); // symbol -> pending stop orders
    this.seq = 0;
    this.tradeSeq = 0;
    for (const s of symbols) this.addSymbol(s);
  }

  // ---------------------------------------------------------------- symbols

  addSymbol({ symbol, name = symbol, price }) {
    if (this.books.has(symbol)) throw new Error(`Duplicate symbol ${symbol}`);
    this.books.set(symbol, new OrderBook(symbol));
    this.stops.set(symbol, []);
    this.markets.set(symbol, {
      symbol,
      name,
      last: price,
      refPrice: price, // reference ("previous close") for % change
      high: price,
      low: price,
      volume: 0,
      trades: [], // most recent first, capped
      candles: [], // oldest first, capped
    });
  }

  symbols() {
    return [...this.markets.keys()];
  }

  /** Replace a symbol's candle history (used to seed a chart at startup). */
  seedCandles(symbol, candles) {
    const m = this.market(symbol);
    m.candles = candles.slice(-500);
    if (candles.length) {
      m.refPrice = candles[0].open;
      m.last = candles[candles.length - 1].close;
      m.high = Math.max(...candles.map((c) => c.high));
      m.low = Math.min(...candles.map((c) => c.low));
    }
  }

  market(symbol) {
    const m = this.markets.get(symbol);
    if (!m) throw new OrderError(`Unknown symbol ${symbol}`);
    return m;
  }

  ticker(symbol) {
    const m = this.market(symbol);
    const book = this.books.get(symbol);
    const bid = book.bestBid();
    const ask = book.bestAsk();
    return {
      symbol,
      name: m.name,
      last: m.last,
      change: m.last - m.refPrice,
      changePct: m.refPrice ? ((m.last - m.refPrice) / m.refPrice) * 100 : 0,
      high: m.high,
      low: m.low,
      volume: m.volume,
      bid: bid ? bid.price : null,
      ask: ask ? ask.price : null,
    };
  }

  depth(symbol, levels = 10) {
    this.market(symbol);
    return this.books.get(symbol).depth(levels);
  }

  // --------------------------------------------------------------- accounts

  createAccount({ id, name = id, cash = 0, unlimited = false }) {
    if (this.accounts.has(id)) throw new Error(`Duplicate account ${id}`);
    const acct = {
      id,
      name,
      cash,
      reservedCash: 0,
      realizedPnl: 0,
      unlimited, // simulation bots skip balance checks
      positions: new Map(), // symbol -> { qty, reserved, avgCost }
      fills: [], // most recent first, capped
      orderIds: [],
      createdAt: this.now(),
    };
    this.accounts.set(id, acct);
    return acct;
  }

  account(id) {
    const a = this.accounts.get(id);
    if (!a) throw new OrderError(`Unknown account ${id}`);
    return a;
  }

  position(acct, symbol) {
    let p = acct.positions.get(symbol);
    if (!p) {
      p = { qty: 0, reserved: 0, avgCost: 0 };
      acct.positions.set(symbol, p);
    }
    return p;
  }

  availableCash(acct) {
    return acct.cash - acct.reservedCash;
  }

  /** A JSON-friendly view of an account, marked to the last traded price. */
  accountSnapshot(id) {
    const a = this.account(id);
    const positions = [];
    let marketValue = 0;
    let unrealized = 0;
    for (const [symbol, p] of a.positions) {
      if (p.qty === 0) continue;
      const last = this.markets.get(symbol).last;
      const value = last * p.qty;
      const pnl = (last - p.avgCost) * p.qty;
      marketValue += value;
      unrealized += pnl;
      positions.push({
        symbol,
        qty: p.qty,
        reserved: p.reserved,
        avgCost: p.avgCost,
        last,
        marketValue: value,
        unrealizedPnl: pnl,
        unrealizedPct: p.avgCost ? ((last - p.avgCost) / p.avgCost) * 100 : 0,
      });
    }
    positions.sort((x, y) => x.symbol.localeCompare(y.symbol));
    const orders = a.orderIds.map((oid) => this.orders.get(oid)).filter(Boolean);
    return {
      id: a.id,
      name: a.name,
      cash: a.cash,
      reservedCash: a.reservedCash,
      availableCash: this.availableCash(a),
      marketValue,
      equity: a.cash + marketValue,
      realizedPnl: a.realizedPnl,
      unrealizedPnl: unrealized,
      positions,
      openOrders: orders.filter((o) => isOpen(o)).map(publicOrder),
      orderHistory: orders.filter((o) => !isOpen(o)).slice(-100).reverse().map(publicOrder),
      fills: a.fills.slice(0, 100),
    };
  }

  // ----------------------------------------------------------------- orders

  /**
   * Validate, risk-check and submit an order. Returns the order (public view).
   * Throws OrderError on validation failure; risk failures produce a
   * 'rejected' order so the client gets a record of it.
   */
  placeOrder(accountId, params) {
    const acct = this.account(accountId);
    const order = this._buildOrder(acct, params);
    this.orders.set(order.id, order);
    acct.orderIds.push(order.id);
    if (acct.orderIds.length > 2000) this._pruneOrders(acct);

    const reason = this._riskCheck(acct, order);
    if (reason) {
      order.status = 'rejected';
      order.reason = reason;
      this.emit('order', order);
      return publicOrder(order);
    }
    this._reserve(acct, order);

    if (order.type === 'stop' || order.type === 'stop_limit') {
      const last = this.markets.get(order.symbol).last;
      if (stopTriggered(order, last)) {
        this._activateStop(order);
      } else {
        order.status = 'pending';
        this.stops.get(order.symbol).push(order);
        this.emit('order', order);
      }
    } else {
      this._execute(order);
    }
    this._processStops(order.symbol);
    this.emit('account', acct.id);
    return publicOrder(order);
  }

  cancelOrder(accountId, orderId) {
    const order = this.orders.get(orderId);
    if (!order || order.accountId !== accountId) throw new OrderError('Order not found');
    if (!isOpen(order)) throw new OrderError(`Order is already ${order.status}`);
    this._cancel(order, 'user');
    this.emit('account', accountId);
    return publicOrder(order);
  }

  cancelAll(accountId, symbol) {
    const acct = this.account(accountId);
    let n = 0;
    for (const oid of acct.orderIds) {
      const o = this.orders.get(oid);
      if (o && isOpen(o) && (!symbol || o.symbol === symbol)) {
        this._cancel(o, 'user');
        n += 1;
      }
    }
    if (n) this.emit('account', accountId);
    return n;
  }

  _buildOrder(acct, p) {
    const symbol = String(p.symbol || '').toUpperCase();
    this.market(symbol);
    const side = String(p.side || '').toLowerCase();
    const type = String(p.type || 'limit').toLowerCase();
    const tif = String(p.tif || 'GTC').toUpperCase();
    if (!SIDES.has(side)) throw new OrderError('side must be buy or sell');
    if (!TYPES.has(type)) throw new OrderError('type must be limit, market, stop or stop_limit');
    if (!TIFS.has(tif)) throw new OrderError('tif must be GTC or IOC');
    const qty = Number(p.qty);
    if (!Number.isInteger(qty) || qty <= 0 || qty > 1e7) {
      throw new OrderError('qty must be a positive whole number of shares');
    }
    const needsPrice = type === 'limit' || type === 'stop_limit';
    const needsStop = type === 'stop' || type === 'stop_limit';
    const price = needsPrice ? toTicks(p.price, 'price') : null;
    const stopPrice = needsStop ? toTicks(p.stopPrice, 'stopPrice') : null;
    return {
      id: `O${++this.seq}`,
      seq: this.seq,
      accountId: acct.id,
      symbol,
      side,
      type,
      tif,
      price,
      stopPrice,
      qty,
      filled: 0,
      notional: 0, // sum of price*qty over fills
      status: 'new',
      reason: null,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
  }

  _riskCheck(acct, order) {
    if (acct.unlimited) return null;
    if (order.side === 'sell') {
      const p = this.position(acct, order.symbol);
      const avail = p.qty - p.reserved;
      if (order.qty > avail) {
        return `Insufficient shares: ${avail} available (short selling is not supported)`;
      }
      return null;
    }
    // Buys: limit-priced orders reserve worst-case cost up front.
    if (order.price !== null) {
      const cost = order.price * order.qty;
      if (cost > this.availableCash(acct)) return 'Insufficient buying power';
    } else if (this.availableCash(acct) <= 0) {
      return 'Insufficient buying power';
    }
    return null;
  }

  /** Lock funds/shares so the same balance cannot back two orders. */
  _reserve(acct, order) {
    if (acct.unlimited) return;
    if (order.side === 'sell') {
      this.position(acct, order.symbol).reserved += order.qty;
    } else if (order.price !== null) {
      acct.reservedCash += order.price * order.qty;
    }
  }

  _release(acct, order, qty) {
    if (acct.unlimited || qty <= 0) return;
    if (order.side === 'sell') {
      this.position(acct, order.symbol).reserved -= qty;
    } else if (order.price !== null) {
      acct.reservedCash -= order.price * qty;
    }
  }

  _activateStop(order) {
    const list = this.stops.get(order.symbol);
    const i = list.indexOf(order);
    if (i !== -1) list.splice(i, 1);
    order.triggeredAt = this.now();
    this._execute(order);
  }

  /** Repeatedly trigger stops until the last price stops moving them. */
  _processStops(symbol) {
    if (this._inStops) return;
    this._inStops = true;
    try {
      for (let guard = 0; guard < 10000; guard++) {
        const last = this.markets.get(symbol).last;
        const list = this.stops.get(symbol);
        const next = list.find((o) => stopTriggered(o, last));
        if (!next) break;
        this._activateStop(next);
        this.emit('account', next.accountId);
      }
    } finally {
      this._inStops = false;
    }
  }

  /** Match an incoming order against the book, then rest or cancel any remainder. */
  _execute(order) {
    const book = this.books.get(order.symbol);
    const opp = book.opposite(order.side);
    const acct = this.accounts.get(order.accountId);
    const isBuy = order.side === 'buy';
    order.status = 'open';

    while (order.filled < order.qty && opp.length) {
      const resting = opp[0];
      if (order.price !== null && (isBuy ? resting.price > order.price : resting.price < order.price)) {
        break;
      }
      // Self-trade prevention: cancel the older resting order.
      if (resting.accountId === order.accountId) {
        this._cancel(resting, 'self-trade prevention');
        continue;
      }
      let q = Math.min(order.qty - order.filled, resting.qty - resting.filled);
      if (isBuy && order.price === null && !acct.unlimited) {
        // Market buy: never spend more than the available cash.
        q = Math.min(q, Math.floor(this.availableCash(acct) / resting.price));
        if (q <= 0) {
          order.reason = 'Insufficient buying power for remaining quantity';
          break;
        }
      }
      this._fill(order, resting, resting.price, q);
    }

    const remaining = order.qty - order.filled;
    if (remaining === 0) {
      order.status = 'filled';
    } else if (order.price !== null && order.tif === 'GTC') {
      book.add(order);
      order.status = order.filled > 0 ? 'partially_filled' : 'open';
    } else {
      this._release(acct, order, remaining);
      order.status = order.filled > 0 ? 'partially_filled_cancelled' : 'cancelled';
      if (!order.reason) {
        order.reason = order.price === null ? 'No more liquidity' : 'IOC remainder cancelled';
      }
    }
    order.updatedAt = this.now();
    this.emit('order', order);
  }

  _fill(taker, maker, price, qty) {
    const buyOrder = taker.side === 'buy' ? taker : maker;
    const sellOrder = taker.side === 'buy' ? maker : taker;
    const buyer = this.accounts.get(buyOrder.accountId);
    const seller = this.accounts.get(sellOrder.accountId);
    const notional = price * qty;
    const now = this.now();

    for (const o of [taker, maker]) {
      o.filled += qty;
      o.notional += notional;
      o.updatedAt = now;
    }

    // Buyer: pay cash, release the reservation made at the limit price.
    buyer.cash -= notional;
    this._release(buyer, buyOrder, qty);
    const bp = this.position(buyer, buyOrder.symbol);
    if (bp.qty >= 0) {
      const newQty = bp.qty + qty;
      bp.avgCost = (bp.avgCost * bp.qty + notional) / newQty;
      bp.qty = newQty;
    } else {
      // Covering a short (bots only).
      buyer.realizedPnl += (bp.avgCost - price) * Math.min(qty, -bp.qty);
      bp.qty += qty;
      if (bp.qty > 0) bp.avgCost = price;
    }
    if (bp.qty === 0) bp.avgCost = 0;

    // Seller: receive cash, deliver shares.
    seller.cash += notional;
    this._release(seller, sellOrder, qty);
    const sp = this.position(seller, sellOrder.symbol);
    if (sp.qty > 0) {
      const closing = Math.min(qty, sp.qty);
      seller.realizedPnl += (price - sp.avgCost) * closing;
      sp.qty -= qty;
      if (sp.qty < 0) sp.avgCost = price;
    } else {
      sp.avgCost = (sp.avgCost * -sp.qty + notional) / (-sp.qty + qty);
      sp.qty -= qty;
    }
    if (sp.qty === 0) sp.avgCost = 0;

    const book = this.books.get(maker.symbol);
    if (maker.filled === maker.qty) {
      book.remove(maker);
      maker.status = 'filled';
    } else {
      maker.status = 'partially_filled';
    }

    const trade = {
      id: `T${++this.tradeSeq}`,
      symbol: taker.symbol,
      price,
      qty,
      side: taker.side, // aggressor side
      time: now,
      buyOrderId: buyOrder.id,
      sellOrderId: sellOrder.id,
    };
    this._recordTrade(trade);
    for (const [acct, o] of [[buyer, buyOrder], [seller, sellOrder]]) {
      if (acct.unlimited) continue;
      acct.fills.unshift({
        tradeId: trade.id,
        orderId: o.id,
        symbol: trade.symbol,
        side: o.side,
        price,
        qty,
        liquidity: o === taker ? 'taker' : 'maker',
        time: now,
      });
      if (acct.fills.length > 500) acct.fills.length = 500;
    }
    this.emit('order', maker);
    this.emit('trade', trade);
    if (maker.accountId !== taker.accountId) this.emit('account', maker.accountId);
  }

  _recordTrade(trade) {
    const m = this.markets.get(trade.symbol);
    m.last = trade.price;
    m.high = Math.max(m.high, trade.price);
    m.low = Math.min(m.low, trade.price);
    m.volume += trade.qty;
    m.trades.unshift(trade);
    if (m.trades.length > 200) m.trades.length = 200;

    const bucket = Math.floor(trade.time / this.candleIntervalMs) * this.candleIntervalMs;
    const c = m.candles[m.candles.length - 1];
    if (c && c.time === bucket) {
      c.high = Math.max(c.high, trade.price);
      c.low = Math.min(c.low, trade.price);
      c.close = trade.price;
      c.volume += trade.qty;
    } else {
      const open = c ? c.close : trade.price;
      m.candles.push({
        time: bucket,
        open,
        high: Math.max(open, trade.price),
        low: Math.min(open, trade.price),
        close: trade.price,
        volume: trade.qty,
      });
      if (m.candles.length > 500) m.candles.shift();
    }
  }

  _cancel(order, reason) {
    const acct = this.accounts.get(order.accountId);
    if (order.status === 'pending') {
      const list = this.stops.get(order.symbol);
      const i = list.indexOf(order);
      if (i !== -1) list.splice(i, 1);
    } else {
      this.books.get(order.symbol).remove(order);
    }
    this._release(acct, order, order.qty - order.filled);
    order.status = order.filled > 0 ? 'partially_filled_cancelled' : 'cancelled';
    order.reason = reason;
    order.updatedAt = this.now();
    this.emit('order', order);
    if (reason !== 'user') this.emit('account', acct.id);
  }

  // ------------------------------------------------------------ persistence

  /**
   * Plain-JSON state for every non-bot account, its orders, and market history.
   * Simulation bots are excluded: they requote from scratch on startup.
   */
  serialize() {
    const accounts = [];
    const orders = [];
    for (const a of this.accounts.values()) {
      if (a.unlimited) continue;
      accounts.push({
        id: a.id,
        name: a.name,
        cash: a.cash,
        realizedPnl: a.realizedPnl,
        positions: [...a.positions].filter(([, p]) => p.qty !== 0).map(([s, p]) => [s, { qty: p.qty, avgCost: p.avgCost }]),
        fills: a.fills,
        orderIds: a.orderIds,
        createdAt: a.createdAt,
      });
      for (const oid of a.orderIds) {
        const o = this.orders.get(oid);
        if (o) orders.push(o);
      }
    }
    const markets = [...this.markets.values()].map((m) => ({
      symbol: m.symbol,
      last: m.last,
      refPrice: m.refPrice,
      high: m.high,
      low: m.low,
      volume: m.volume,
      trades: m.trades,
      candles: m.candles,
    }));
    return { version: 1, savedAt: this.now(), seq: this.seq, tradeSeq: this.tradeSeq, markets, accounts, orders };
  }

  /**
   * Load state produced by serialize(). Call before any orders are placed.
   * Reservations are recomputed from open orders rather than trusted from disk,
   * and anything referring to a symbol no longer configured is dropped.
   */
  restore(data) {
    if (!data || data.version !== 1) throw new Error('Unsupported snapshot version');
    this.seq = Math.max(this.seq, data.seq || 0);
    this.tradeSeq = Math.max(this.tradeSeq, data.tradeSeq || 0);
    for (const m of data.markets || []) {
      const cur = this.markets.get(m.symbol);
      if (!cur) continue;
      Object.assign(cur, {
        last: m.last, refPrice: m.refPrice, high: m.high, low: m.low,
        volume: m.volume, trades: m.trades || [], candles: m.candles || [],
      });
    }
    for (const a of data.accounts || []) {
      if (this.accounts.has(a.id)) continue;
      const acct = this.createAccount({ id: a.id, name: a.name, cash: a.cash });
      acct.realizedPnl = a.realizedPnl || 0;
      acct.fills = (a.fills || []).filter((f) => this.markets.has(f.symbol));
      acct.createdAt = a.createdAt;
      for (const [symbol, p] of a.positions || []) {
        if (this.markets.has(symbol)) acct.positions.set(symbol, { qty: p.qty, reserved: 0, avgCost: p.avgCost });
      }
    }
    // Re-insert open orders in original sequence so time priority is preserved.
    const orders = (data.orders || [])
      .filter((o) => this.accounts.has(o.accountId) && this.markets.has(o.symbol))
      .sort((x, y) => x.seq - y.seq);
    for (const o of orders) {
      const acct = this.accounts.get(o.accountId);
      this.orders.set(o.id, o);
      acct.orderIds.push(o.id);
      if (!isOpen(o)) continue;
      const remaining = o.qty - o.filled;
      // Re-reserve exactly as placeOrder would have for the unfilled part.
      if (o.side === 'sell') {
        const p = this.position(acct, o.symbol);
        if (p.qty - p.reserved < remaining) {
          o.status = o.filled ? 'partially_filled_cancelled' : 'cancelled';
          o.reason = 'Cancelled on restore: shares no longer available';
          continue;
        }
        p.reserved += remaining;
      } else if (o.price !== null) {
        acct.reservedCash += o.price * remaining;
      }
      if (o.status === 'pending') this.stops.get(o.symbol).push(o);
      else this.books.get(o.symbol).add(o);
    }
  }

  /** Drop closed orders from very long histories to bound memory. */
  _pruneOrders(acct) {
    const keep = [];
    const closed = [];
    for (const oid of acct.orderIds) {
      const o = this.orders.get(oid);
      if (!o) continue;
      (isOpen(o) ? keep : closed).push(oid);
    }
    for (const oid of closed.slice(0, closed.length - 200)) this.orders.delete(oid);
    acct.orderIds = [...keep, ...closed.slice(-200)].sort(
      (a, b) => Number(a.slice(1)) - Number(b.slice(1)),
    );
  }
}

// ------------------------------------------------------------------ helpers

function isOpen(o) {
  return o.status === 'open' || o.status === 'partially_filled' || o.status === 'pending';
}

function stopTriggered(o, last) {
  return o.side === 'buy' ? last >= o.stopPrice : last <= o.stopPrice;
}

function toTicks(v, field) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 1e9) {
    throw new OrderError(`${field} must be a positive integer number of cents`);
  }
  return n;
}

function publicOrder(o) {
  return {
    id: o.id,
    symbol: o.symbol,
    side: o.side,
    type: o.type,
    tif: o.tif,
    price: o.price,
    stopPrice: o.stopPrice,
    qty: o.qty,
    filled: o.filled,
    avgPrice: o.filled ? o.notional / o.filled : null,
    status: o.status,
    reason: o.reason,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

module.exports = { Exchange, OrderError, publicOrder, isOpen };
