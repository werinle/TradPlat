'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const usd = (c) => (c == null ? '—' : (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' }));
  const px = (c) => (c == null ? '—' : (c / 100).toFixed(2));
  const signed = (c) => (c > 0 ? '+' : '') + usd(c);
  const pct = (p) => (p > 0 ? '+' : '') + p.toFixed(2) + '%';
  const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const time = (t) => new Date(t).toLocaleTimeString([], { hour12: false });

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
  };

  const state = {
    token: store.get('tp_token'),
    symbol: store.get('tp_symbol') || null,
    side: 'buy',
    tab: 'positions',
    tickers: new Map(),
    books: {},
    account: null,
    seenFills: null,
    es: null,
  };

  const chart = new CandleChart($('chart'), $('ohlc'));

  // ------------------------------------------------------------------ api
  async function api(method, path, body) {
    const res = await fetch('/api' + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/auth/login') {
      logout();
      throw new Error(data.error || 'Please log in');
    }
    if (!res.ok && res.status !== 422) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // --------------------------------------------------------------- auth
  let loginMode = 'login';
  document.querySelectorAll('#loginForm [data-mode]').forEach((b) => {
    b.addEventListener('click', () => { loginMode = b.dataset.mode; });
  });
  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('loginMsg');
    msg.textContent = '';
    try {
      const res = await api('POST', `/auth/${loginMode}`, { username: $('lUser').value.trim(), password: $('lPass').value });
      state.token = res.token;
      store.set('tp_token', res.token);
      $('lPass').value = '';
      onAccount(res.account);
      showLogin(false);
      connect();
    } catch (err) {
      msg.className = 'form-msg err';
      msg.textContent = err.message;
    }
  });

  function showLogin(show) {
    $('loginModal').classList.toggle('hidden', !show);
    if (show) setTimeout(() => $('lUser').focus(), 0);
  }

  function logout() {
    if (state.token) fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${state.token}` } });
    state.token = null;
    state.account = null;
    state.seenFills = null;
    store.del('tp_token');
    showLogin(true);
    connect();
  }
  $('logoutBtn').addEventListener('click', logout);

  // --------------------------------------------------------- live stream
  function connect() {
    if (state.es) state.es.close();
    const qs = state.token ? `?token=${encodeURIComponent(state.token)}` : '';
    const es = new EventSource('/api/stream' + qs);
    state.es = es;
    const conn = $('conn');
    es.onopen = () => { conn.className = 'conn live'; conn.lastChild.textContent = 'Live'; };
    es.onerror = () => { conn.className = 'conn down'; conn.lastChild.textContent = 'Reconnecting…'; };
    es.addEventListener('market', (e) => onMarket(JSON.parse(e.data)));
    es.addEventListener('account', (e) => onAccount(JSON.parse(e.data)));
  }

  function onMarket(m) {
    for (const t of m.tickers) state.tickers.set(t.symbol, t);
    state.books = m.books;
    if (!state.symbol || !state.tickers.has(state.symbol)) selectSymbol(m.tickers[0].symbol);
    else if (state.loadedSymbol !== state.symbol) selectSymbol(state.symbol);
    renderWatchlist();
    renderTape();
    renderHeader();
    renderBook();
    chart.update(m.candles[state.symbol]);
    const mine = m.trades.filter((t) => t.symbol === state.symbol);
    if (mine.length) addTrades(mine.reverse(), true);
    updateEstimate();
  }

  function onAccount(a) {
    // Toast new fills (skip everything already present on first load).
    if (state.seenFills) {
      for (const f of [...a.fills].reverse()) {
        if (state.seenFills.has(f.tradeId + f.orderId)) continue;
        toast(`${f.side === 'buy' ? 'Bought' : 'Sold'} ${f.qty} ${esc(f.symbol)} @ ${px(f.price)}`, f.side);
      }
    }
    state.seenFills = new Set(a.fills.map((f) => f.tradeId + f.orderId));
    state.account = a;
    $('userName').textContent = a.name;
    renderSummary();
    renderTab();
    chart.setOrderLines(a.openOrders.filter((o) => o.symbol === state.symbol).map((o) => ({
      price: o.type === 'stop' ? o.stopPrice : o.price,
      label: `${o.side.toUpperCase()} ${o.qty - o.filled} ${o.type === 'stop' ? 'STOP' : o.type === 'stop_limit' && o.status === 'pending' ? 'STOP LMT' : 'LMT'} ${px(o.type === 'stop' ? o.stopPrice : o.price)}`,
    })));
    updateEstimate();
  }

  // ------------------------------------------------------------ symbols
  async function selectSymbol(sym) {
    const changed = sym !== state.symbol || state.loadedSymbol !== sym;
    state.symbol = sym;
    state.loadedSymbol = sym;
    store.set('tp_symbol', sym);
    renderWatchlist();
    renderHeader();
    if (changed) {
      const t = state.tickers.get(sym);
      if (t) $('fPrice').value = px(t.last);
      $('fStop').value = '';
      $('trades').innerHTML = '';
      lastTradePrice = null;
      const [candles, trades] = await Promise.all([
        api('GET', `/markets/${sym}/candles`),
        api('GET', `/markets/${sym}/trades`),
      ]);
      if (state.symbol !== sym) return;
      chart.setCandles(candles);
      addTrades(trades.slice(0, 60).reverse(), false);
      if (state.account) onAccount(state.account);
    }
  }

  function renderWatchlist() {
    $('watchlist').innerHTML = [...state.tickers.values()].map((t) => `
      <tr data-sym="${esc(t.symbol)}" class="${t.symbol === state.symbol ? 'sel' : ''}">
        <td><b>${esc(t.symbol)}</b><span class="name">${esc(t.name)}</span></td>
        <td class="r num">${px(t.last)}</td>
        <td class="r num ${cls(t.change)}">${pct(t.changePct)}</td>
      </tr>`).join('');
  }
  $('watchlist').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-sym]');
    if (tr) selectSymbol(tr.dataset.sym);
  });

  function renderTape() {
    $('tape').innerHTML = [...state.tickers.values()].map((t) =>
      `<span data-sym="${esc(t.symbol)}"><b>${esc(t.symbol)}</b><span class="num">${px(t.last)}</span> <span class="num ${cls(t.change)}">${pct(t.changePct)}</span></span>`).join('');
  }
  $('tape').addEventListener('click', (e) => {
    const s = e.target.closest('[data-sym]');
    if (s) selectSymbol(s.dataset.sym);
  });

  function renderHeader() {
    const t = state.tickers.get(state.symbol);
    if (!t) return;
    document.title = `${t.symbol} ${px(t.last)} · TradPlat`;
    $('chartSym').textContent = t.symbol;
    $('chartName').textContent = t.name;
    $('chartLast').textContent = px(t.last);
    $('chartLast').className = 'big-last ' + cls(t.change);
    $('chartChg').innerHTML = `<span class="${cls(t.change)}">${(t.change > 0 ? '+' : '') + px(t.change)} (${pct(t.changePct)})</span>`;
    $('chartHigh').textContent = px(t.high);
    $('chartLow').textContent = px(t.low);
    $('chartVol').textContent = t.volume.toLocaleString();
    $('chartSpread').textContent = t.bid && t.ask ? px(t.ask - t.bid) : '—';
  }

  // ----------------------------------------------------- book & trades
  function renderBook() {
    const book = state.books[state.symbol];
    if (!book) return;
    const myPrices = new Set((state.account?.openOrders || [])
      .filter((o) => o.symbol === state.symbol && o.status !== 'pending').map((o) => `${o.side}:${o.price}`));
    const rows = (levels) => {
      let cum = 0;
      const withCum = levels.map((l) => ({ ...l, cum: (cum += l.qty) }));
      return { withCum, total: cum };
    };
    const a = rows(book.asks);
    const b = rows(book.bids);
    const max = Math.max(a.total, b.total, 1);
    const html = (l, kind) => `
      <div class="lvl ${kind}${myPrices.has(`${kind === 'bid' ? 'buy' : 'sell'}:${l.price}`) ? ' mine' : ''}" data-price="${l.price}">
        <div class="bar" style="width:${(l.cum / max) * 100}%"></div>
        <span class="p">${px(l.price)}</span><span class="r">${l.qty.toLocaleString()}</span><span class="r muted">${l.cum.toLocaleString()}</span>
      </div>`;
    $('asks').innerHTML = a.withCum.slice().reverse().map((l) => html(l, 'ask')).join('');
    $('bids').innerHTML = b.withCum.map((l) => html(l, 'bid')).join('');
    const bid = book.bids[0]?.price;
    const ask = book.asks[0]?.price;
    const t = state.tickers.get(state.symbol);
    $('spreadRow').innerHTML = `<span class="${cls(t?.change)}">${px(t?.last)}</span>` +
      (bid && ask ? `<small>spread ${px(ask - bid)} · ${(((ask - bid) / ask) * 10000).toFixed(1)} bps</small>` : '');
  }
  for (const id of ['asks', 'bids']) {
    $(id).addEventListener('click', (e) => {
      const lvl = e.target.closest('[data-price]');
      if (!lvl) return;
      if ($('fType').value === 'market') { $('fType').value = 'limit'; syncType(); }
      $('fPrice').value = px(Number(lvl.dataset.price));
      updateEstimate();
    });
  }

  let lastTradePrice = null;
  function addTrades(trades, flash) {
    const box = $('trades');
    const frag = document.createDocumentFragment();
    for (const t of trades) {
      const dir = lastTradePrice == null ? (t.side === 'buy' ? 1 : -1) : Math.sign(t.price - lastTradePrice) || (t.side === 'buy' ? 1 : -1);
      lastTradePrice = t.price;
      const row = document.createElement('div');
      row.className = 'row' + (flash ? ' flash' : '');
      row.innerHTML = `<span class="${dir > 0 ? 'up' : 'down'}">${px(t.price)}</span><span class="r">${t.qty}</span><span class="r muted">${time(t.time)}</span>`;
      frag.prepend(row);
    }
    box.prepend(frag);
    while (box.children.length > 60) box.lastChild.remove();
  }

  // -------------------------------------------------------- order ticket
  document.querySelectorAll('.side-toggle button').forEach((b) => {
    b.addEventListener('click', () => setSide(b.dataset.side));
  });
  function setSide(side) {
    state.side = side;
    document.querySelectorAll('.side-toggle button').forEach((b) => b.classList.toggle('active', b.dataset.side === side));
    const btn = $('submitBtn');
    btn.className = `submit ${side}`;
    btn.textContent = side === 'buy' ? 'Buy' : 'Sell';
    $('availLabel').textContent = side === 'buy' ? 'Buying power' : 'Shares available';
    updateEstimate();
  }

  function syncType() {
    const type = $('fType').value;
    document.querySelector('[data-for="price"]').classList.toggle('hidden', type === 'market' || type === 'stop');
    document.querySelector('[data-for="stop"]').classList.toggle('hidden', !type.startsWith('stop'));
    document.querySelector('[data-for="tif"]').classList.toggle('hidden', type === 'market' || type === 'stop');
    updateEstimate();
  }
  $('fType').addEventListener('change', syncType);
  for (const id of ['fPrice', 'fQty', 'fStop']) $(id).addEventListener('input', updateEstimate);

  const toCents = (v) => Math.round(Number(v) * 100);

  function refPrice() {
    const type = $('fType').value;
    const t = state.tickers.get(state.symbol);
    if (type === 'limit' || type === 'stop_limit') return toCents($('fPrice').value) || null;
    if (type === 'stop') return toCents($('fStop').value) || null;
    return t ? (state.side === 'buy' ? t.ask : t.bid) || t.last : null;
  }

  function availShares() {
    const p = state.account?.positions.find((x) => x.symbol === state.symbol);
    return p ? p.qty - p.reserved : 0;
  }

  function updateEstimate() {
    const qty = Number($('fQty').value) || 0;
    const ref = refPrice();
    $('estCost').textContent = ref && qty ? usd(ref * qty) : '—';
    if (!state.account) { $('estAvail').textContent = '—'; return; }
    $('estAvail').textContent = state.side === 'buy' ? usd(state.account.availableCash) : `${availShares().toLocaleString()} ${state.symbol || ''}`;
  }

  $('qtyChips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pct]');
    if (!b || !state.account) return;
    const f = Number(b.dataset.pct);
    let max;
    if (state.side === 'sell') max = availShares();
    else {
      const ref = refPrice();
      max = ref ? Math.floor(state.account.availableCash / ref) : 0;
    }
    $('fQty').value = Math.max(f === 1 ? max : Math.floor(max * f), max ? 1 : 0);
    updateEstimate();
  });

  $('orderForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('formMsg');
    const type = $('fType').value;
    const body = { symbol: state.symbol, side: state.side, type, qty: Number($('fQty').value) };
    if (type === 'limit' || type === 'stop_limit') { body.price = toCents($('fPrice').value); body.tif = $('fTif').value; }
    if (type.startsWith('stop')) body.stopPrice = toCents($('fStop').value);
    const btn = $('submitBtn');
    btn.disabled = true;
    msg.textContent = '';
    try {
      const o = await api('POST', '/orders', body);
      if (o.status === 'rejected') {
        msg.className = 'form-msg err';
        msg.textContent = o.reason;
      } else {
        msg.className = 'form-msg ok';
        msg.textContent = `${o.id} ${o.status.replace(/_/g, ' ')}` + (o.filled ? ` — ${o.filled}/${o.qty} @ ${px(o.avgPrice)}` : '');
        refreshAccount();
      }
    } catch (err) {
      msg.className = 'form-msg err';
      msg.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  async function refreshAccount() {
    try { onAccount(await api('GET', '/account')); } catch { /* stream will catch up */ }
  }

  // ------------------------------------------------------ account views
  function renderSummary() {
    const a = state.account;
    $('sumEquity').textContent = usd(a.equity);
    $('sumCash').textContent = usd(a.availableCash);
    const total = a.realizedPnl + a.unrealizedPnl;
    $('sumPnl').textContent = signed(total);
    $('sumPnl').className = cls(total);
    $('cntPos').textContent = a.positions.length ? `(${a.positions.length})` : '';
    $('cntOpen').textContent = a.openOrders.length ? `(${a.openOrders.length})` : '';
  }

  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    state.tab = b.dataset.tab;
    document.querySelectorAll('#tabs [data-tab]').forEach((x) => x.classList.toggle('active', x === b));
    renderTab();
  });

  const sidePill = (s) => `<span class="pill ${s}">${s}</span>`;
  const typeLabel = (o) => ({ limit: 'Limit', market: 'Market', stop: 'Stop', stop_limit: 'Stop limit' }[o.type]) + (o.type === 'limit' || o.type === 'stop_limit' ? ` ${o.tif}` : '');
  const status = (o) => `<span class="pill">${o.status.replace(/_/g, ' ')}</span>`;
  const symLink = (s) => `<span class="link" data-sym="${esc(s)}">${esc(s)}</span>`;
  const table = (head, rows, empty) => rows.length
    ? `<table><thead><tr>${head.map(([h, r]) => `<th class="${r ? 'r' : ''}">${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`
    : `<div class="empty">${empty}</div>`;

  function renderTab() {
    const a = state.account;
    const body = $('tabBody');
    if (!a) { body.innerHTML = '<div class="empty">Log in to trade.</div>'; return; }
    if (state.tab === 'positions') {
      body.innerHTML = table(
        [['Symbol'], ['Qty', 1], ['Avg cost', 1], ['Last', 1], ['Market value', 1], ['Unrealized P&L', 1], ['', 1]],
        a.positions.map((p) => `<tr>
          <td>${symLink(p.symbol)}</td><td class="r">${p.qty.toLocaleString()}${p.reserved ? ` <span class="muted">(${p.reserved} held)</span>` : ''}</td>
          <td class="r">${px(p.avgCost)}</td><td class="r">${px(p.last)}</td><td class="r">${usd(p.marketValue)}</td>
          <td class="r ${cls(p.unrealizedPnl)}">${signed(p.unrealizedPnl)} (${pct(p.unrealizedPct)})</td>
          <td class="r"><button class="x" data-close="${esc(p.symbol)}" ${p.qty - p.reserved <= 0 ? 'disabled' : ''}>Close</button></td></tr>`),
        `No positions yet. Pick a market and place an order. Realized P&amp;L: <span class="${cls(a.realizedPnl)}">${signed(a.realizedPnl)}</span>`,
      ) + (a.positions.length ? `<div class="empty" style="padding:10px">Cash ${usd(a.cash)} · Realized P&amp;L <span class="${cls(a.realizedPnl)}">${signed(a.realizedPnl)}</span></div>` : '');
    } else if (state.tab === 'open') {
      body.innerHTML = table(
        [['Time'], ['Symbol'], ['Side'], ['Type'], ['Price', 1], ['Stop', 1], ['Filled', 1], ['Status'], ['', 1]],
        a.openOrders.slice().reverse().map((o) => `<tr>
          <td>${time(o.createdAt)}</td><td>${symLink(o.symbol)}</td><td>${sidePill(o.side)}</td><td>${typeLabel(o)}</td>
          <td class="r">${o.price ? px(o.price) : 'MKT'}</td><td class="r">${o.stopPrice ? px(o.stopPrice) : '—'}</td>
          <td class="r">${o.filled}/${o.qty}</td><td>${status(o)}</td>
          <td class="r"><button class="x" data-cancel="${esc(o.id)}">Cancel</button></td></tr>`),
        'No open orders.',
      );
    } else if (state.tab === 'history') {
      body.innerHTML = table(
        [['Time'], ['Symbol'], ['Side'], ['Type'], ['Price', 1], ['Filled', 1], ['Avg fill', 1], ['Status'], ['Note']],
        a.orderHistory.map((o) => `<tr>
          <td>${time(o.updatedAt)}</td><td>${symLink(o.symbol)}</td><td>${sidePill(o.side)}</td><td>${typeLabel(o)}</td>
          <td class="r">${o.price ? px(o.price) : 'MKT'}</td><td class="r">${o.filled}/${o.qty}</td>
          <td class="r">${o.avgPrice ? px(o.avgPrice) : '—'}</td><td>${status(o)}</td><td class="muted">${esc(o.reason || '')}</td></tr>`),
        'No completed orders yet.',
      );
    } else {
      body.innerHTML = table(
        [['Time'], ['Symbol'], ['Side'], ['Price', 1], ['Qty', 1], ['Value', 1], ['Liquidity'], ['Order']],
        a.fills.map((f) => `<tr>
          <td>${time(f.time)}</td><td>${symLink(f.symbol)}</td><td>${sidePill(f.side)}</td><td class="r">${px(f.price)}</td>
          <td class="r">${f.qty}</td><td class="r">${usd(f.price * f.qty)}</td><td class="muted">${f.liquidity}</td><td class="muted">${esc(f.orderId)}</td></tr>`),
        'No fills yet.',
      );
    }
  }

  $('tabBody').addEventListener('click', async (e) => {
    const t = e.target;
    try {
      if (t.dataset.cancel) {
        await api('DELETE', `/orders/${t.dataset.cancel}`);
        refreshAccount();
      } else if (t.dataset.close) {
        const p = state.account.positions.find((x) => x.symbol === t.dataset.close);
        const qty = p.qty - p.reserved;
        const o = await api('POST', '/orders', { symbol: p.symbol, side: 'sell', type: 'market', qty });
        if (o.status === 'rejected') toast(o.reason, 'err');
        refreshAccount();
      } else if (t.dataset.sym) {
        selectSymbol(t.dataset.sym);
      }
    } catch (err) {
      toast(esc(err.message), 'err');
    }
  });

  $('cancelAll').addEventListener('click', async () => {
    try {
      const r = await api('DELETE', '/orders');
      toast(`Cancelled ${r.cancelled} order${r.cancelled === 1 ? '' : 's'}`);
      refreshAccount();
    } catch (err) {
      toast(esc(err.message), 'err');
    }
  });

  // --------------------------------------------------------------- misc
  function toast(html, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.innerHTML = html;
    $('toasts').append(el);
    setTimeout(() => el.remove(), 4000);
  }

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select')) return;
    if (e.key === 'b') setSide('buy');
    if (e.key === 's') setSide('sell');
  });

  // --------------------------------------------------------------- boot
  syncType();
  setSide('buy');
  renderTab();
  if (state.token) {
    api('GET', '/account').then((a) => { onAccount(a); showLogin(false); connect(); }).catch(() => {});
  } else {
    showLogin(true);
  }
  if (!state.token) connect();
})();
