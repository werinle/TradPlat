'use strict';

/**
 * Simulated market participants that give the exchange live liquidity:
 *
 *  - A market maker per symbol quotes a ladder of bids/asks around a
 *    "fair value" that follows a random walk and is pulled toward the last
 *    traded price, so real user order flow moves the market.
 *  - Noise traders send small market orders against those quotes, which
 *    produces a steady tape of trades and candles.
 *
 * Everything trades through the normal Exchange API; bots just use
 * accounts flagged `unlimited` so they never run out of cash or shares.
 */
class Simulator {
  constructor(exchange, { symbols, random = Math.random, levels = 10 } = {}) {
    this.ex = exchange;
    this.random = random;
    this.levels = levels;
    this.timer = null;
    this.state = new Map();
    for (const s of symbols) {
      this.state.set(s.symbol, {
        fair: s.price,
        vol: s.vol ?? 0.0015, // per-tick volatility
        activity: s.activity ?? 0.6, // chance of a noise trade per tick
        mmOrders: [],
      });
    }
    this.mm = exchange.createAccount({ id: 'sim-market-maker', name: 'Market Maker', unlimited: true });
    this.noise = exchange.createAccount({ id: 'sim-noise', name: 'Noise Trader', unlimited: true });
  }

  gauss() {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.random();
    while (v === 0) v = this.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Build plausible candle history ending at each symbol's current price. */
  seedHistory(count = 160) {
    const interval = this.ex.candleIntervalMs;
    const end = Math.floor(this.ex.now() / interval) * interval;
    for (const [symbol, st] of this.state) {
      // Walk backwards from the current price so the chart ends where trading starts.
      const closes = [st.fair];
      for (let i = 1; i < count; i++) {
        closes.unshift(closes[0] * Math.exp(-st.vol * 1.4 * this.gauss()));
      }
      const candles = [];
      let open = closes[0] * Math.exp(st.vol * this.gauss());
      for (let i = 0; i < count; i++) {
        const close = closes[i];
        const wick = Math.abs(this.gauss()) * st.vol * close;
        candles.push({
          time: end - (count - i) * interval,
          open: Math.round(open),
          high: Math.round(Math.max(open, close) + wick),
          low: Math.max(1, Math.round(Math.min(open, close) - wick)),
          close: Math.round(close),
          volume: Math.round(200 + this.random() * 1800),
        });
        open = close;
      }
      this.ex.seedCandles(symbol, candles);
    }
  }

  tick() {
    for (const [symbol, st] of this.state) {
      const last = this.ex.market(symbol).last;
      // Random walk, mean-reverting toward the tape so user flow has impact.
      st.fair = st.fair * Math.exp(st.vol * this.gauss());
      st.fair = 0.8 * st.fair + 0.2 * last;
      st.fair = Math.max(100, st.fair);
      this.requote(symbol, st);
      if (this.random() < st.activity) this.noiseTrade(symbol);
    }
  }

  requote(symbol, st) {
    for (const id of st.mmOrders) {
      try {
        this.ex.cancelOrder(this.mm.id, id);
      } catch {
        // Already filled.
      }
    }
    st.mmOrders = [];
    const fair = st.fair;
    const tick = Math.max(1, Math.round(fair * 0.0004));
    const half = Math.max(1, Math.round(fair * 0.00035));
    const bid0 = Math.round(fair) - half;
    const ask0 = Math.round(fair) + half;
    for (let i = 0; i < this.levels; i++) {
      const size = () => Math.round((40 + this.random() * 260) * (1 + i * 0.35));
      const bid = bid0 - i * tick;
      const ask = ask0 + i * tick;
      if (bid > 0) {
        st.mmOrders.push(this.ex.placeOrder(this.mm.id, { symbol, side: 'buy', type: 'limit', price: bid, qty: size() }).id);
      }
      st.mmOrders.push(this.ex.placeOrder(this.mm.id, { symbol, side: 'sell', type: 'limit', price: ask, qty: size() }).id);
    }
  }

  noiseTrade(symbol) {
    const side = this.random() < 0.5 ? 'buy' : 'sell';
    const qty = Math.max(1, Math.round(Math.abs(this.gauss()) * 60));
    this.ex.placeOrder(this.noise.id, { symbol, side, type: 'market', qty });
  }

  start(intervalMs = 800) {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { Simulator };
