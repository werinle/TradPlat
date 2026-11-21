'use strict';

/**
 * A single-symbol limit order book with price-time priority.
 *
 * Each side is an array of resting orders kept sorted best-first:
 *   bids: highest price first, then oldest first
 *   asks: lowest price first, then oldest first
 * Prices are integer ticks (cents) so there is no floating point drift.
 */
class OrderBook {
  constructor(symbol) {
    this.symbol = symbol;
    this.bids = [];
    this.asks = [];
  }

  side(side) {
    return side === 'buy' ? this.bids : this.asks;
  }

  opposite(side) {
    return side === 'buy' ? this.asks : this.bids;
  }

  /** Insert a resting order behind every order with equal or better price. */
  add(order) {
    const arr = this.side(order.side);
    const worse = order.side === 'buy'
      ? (o) => o.price < order.price
      : (o) => o.price > order.price;
    // Binary search for the first strictly-worse price level.
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (worse(arr[mid])) hi = mid;
      else lo = mid + 1;
    }
    arr.splice(lo, 0, order);
  }

  remove(order) {
    const arr = this.side(order.side);
    const i = arr.indexOf(order);
    if (i === -1) return false;
    arr.splice(i, 1);
    return true;
  }

  bestBid() {
    return this.bids[0] || null;
  }

  bestAsk() {
    return this.asks[0] || null;
  }

  /** Aggregated depth: [{ price, qty, orders }] per side, best first. */
  depth(levels = 10) {
    const agg = (arr) => {
      const out = [];
      for (const o of arr) {
        const rem = o.qty - o.filled;
        const last = out[out.length - 1];
        if (last && last.price === o.price) {
          last.qty += rem;
          last.orders += 1;
        } else {
          if (out.length === levels) break;
          out.push({ price: o.price, qty: rem, orders: 1 });
        }
      }
      return out;
    };
    return { bids: agg(this.bids), asks: agg(this.asks) };
  }
}

module.exports = { OrderBook };
