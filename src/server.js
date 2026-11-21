'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Exchange, OrderError } = require('./engine/Exchange');
const { Simulator } = require('./engine/Simulator');
const { SYMBOLS, STARTING_CASH } = require('./config');
const { loadSnapshot, createSaver } = require('./persistence');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * @param {object} opts
 * @param {string|null} opts.dataFile  JSON file to persist state to; null keeps everything in memory.
 */
function createPlatform({ simulate = true, tickMs = 800, pushMs = 400, dataFile = null } = {}) {
  const exchange = new Exchange({ symbols: SYMBOLS });
  const sim = new Simulator(exchange, { symbols: SYMBOLS });

  // ------------------------------------------------------------ auth store
  const users = new Map(); // username -> { salt, hash, accountId }
  const sessions = new Map(); // sha256(token) -> accountId. Raw tokens are never stored.
  const tokenKey = (token) => crypto.createHash('sha256').update(token).digest('hex');

  // ----------------------------------------------------------- persistence
  const snapshot = dataFile ? loadSnapshot(dataFile) : null;
  if (snapshot) {
    exchange.restore(snapshot.exchange);
    for (const [name, u] of snapshot.users || []) users.set(name, u);
    for (const [key, id] of snapshot.sessions || []) if (exchange.accounts.has(id)) sessions.set(key, id);
    // Resume quoting where trading left off.
    for (const [symbol, st] of sim.state) st.fair = exchange.market(symbol).last;
    console.log(`Restored ${users.size} user(s) from ${dataFile}`);
  } else {
    sim.seedHistory();
  }
  const saver = dataFile
    ? createSaver(dataFile, () => ({
      version: 1,
      exchange: exchange.serialize(),
      users: [...users],
      sessions: [...sessions],
    }))
    : null;
  const requestSave = () => saver && saver.requestSave();
  exchange.on('account', (id) => {
    if (!exchange.accounts.get(id)?.unlimited) requestSave();
  });

  function register(username, password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 32).toString('hex');
    const accountId = `U-${username}`;
    exchange.createAccount({ id: accountId, name: username, cash: STARTING_CASH });
    users.set(username, { salt, hash, accountId });
    requestSave();
    return accountId;
  }

  function login(username, password) {
    const u = users.get(username);
    if (!u) return null;
    const hash = crypto.scryptSync(password, u.salt, 32);
    if (!crypto.timingSafeEqual(hash, Buffer.from(u.hash, 'hex'))) return null;
    return u.accountId;
  }

  function issueToken(accountId) {
    const token = crypto.randomBytes(24).toString('base64url');
    sessions.set(tokenKey(token), accountId);
    requestSave();
    return token;
  }

  function authFrom(req, url) {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token');
    return token ? sessions.get(tokenKey(token)) || null : null;
  }

  // -------------------------------------------------- live streaming (SSE)
  const clients = new Set(); // { res, accountId }
  let pendingTrades = [];
  exchange.on('trade', (t) => pendingTrades.push(t));

  function send(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function marketSnapshot() {
    const syms = exchange.symbols();
    return {
      time: Date.now(),
      tickers: syms.map((s) => exchange.ticker(s)),
      books: Object.fromEntries(syms.map((s) => [s, exchange.depth(s, 14)])),
      candles: Object.fromEntries(syms.map((s) => {
        const c = exchange.market(s).candles;
        return [s, c[c.length - 1]];
      })),
    };
  }

  function push() {
    if (!clients.size) {
      pendingTrades = [];
      return;
    }
    const snap = marketSnapshot();
    snap.trades = pendingTrades.slice(-300);
    pendingTrades = [];
    // Positions are marked to market, so every user account changes as prices move.
    for (const c of clients) {
      send(c.res, 'market', snap);
      if (c.accountId) send(c.res, 'account', exchange.accountSnapshot(c.accountId));
    }
  }

  // ---------------------------------------------------------------- routes
  async function handleApi(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop 'api'
    const method = req.method;
    const accountId = authFrom(req, url);
    const requireAuth = () => {
      if (!accountId) throw httpError(401, 'Please log in');
      return accountId;
    };

    if (method === 'POST' && parts[0] === 'auth' && (parts[1] === 'login' || parts[1] === 'register')) {
      const body = await readJson(req);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!/^[A-Za-z0-9_.-]{3,24}$/.test(username)) {
        throw httpError(400, 'Username must be 3-24 letters, numbers, dot, dash or underscore');
      }
      if (password.length < 6) throw httpError(400, 'Password must be at least 6 characters');
      let id;
      if (parts[1] === 'register') {
        if (users.has(username)) throw httpError(409, 'Username already taken');
        id = register(username, password);
      } else {
        id = login(username, password);
        if (!id) throw httpError(401, 'Invalid username or password');
      }
      return json(res, 200, { token: issueToken(id), account: exchange.accountSnapshot(id) });
    }

    if (method === 'POST' && parts[0] === 'auth' && parts[1] === 'logout') {
      const h = req.headers.authorization || '';
      sessions.delete(tokenKey(h.replace(/^Bearer /, '')));
      requestSave();
      return json(res, 200, { ok: true });
    }

    if (method === 'GET' && parts[0] === 'symbols') {
      return json(res, 200, exchange.symbols().map((s) => exchange.ticker(s)));
    }

    if (method === 'GET' && parts[0] === 'markets' && parts[1]) {
      const symbol = parts[1].toUpperCase();
      const m = exchange.market(symbol);
      if (parts[2] === 'book') {
        const levels = clamp(Number(url.searchParams.get('depth')) || 14, 1, 50);
        return json(res, 200, exchange.depth(symbol, levels));
      }
      if (parts[2] === 'candles') return json(res, 200, m.candles);
      if (parts[2] === 'trades') return json(res, 200, m.trades.slice(0, 100));
      if (!parts[2]) return json(res, 200, exchange.ticker(symbol));
    }

    if (method === 'GET' && parts[0] === 'account') {
      return json(res, 200, exchange.accountSnapshot(requireAuth()));
    }

    if (method === 'POST' && parts[0] === 'orders' && !parts[1]) {
      const id = requireAuth();
      const order = exchange.placeOrder(id, await readJson(req));
      return json(res, order.status === 'rejected' ? 422 : 201, order);
    }

    if (method === 'DELETE' && parts[0] === 'orders') {
      const id = requireAuth();
      if (parts[1]) return json(res, 200, exchange.cancelOrder(id, parts[1]));
      const symbol = url.searchParams.get('symbol');
      return json(res, 200, { cancelled: exchange.cancelAll(id, symbol ? symbol.toUpperCase() : null) });
    }

    if (method === 'GET' && parts[0] === 'stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      const client = { res, accountId };
      clients.add(client);
      const snap = marketSnapshot();
      snap.trades = [];
      send(res, 'market', snap);
      if (accountId) send(res, 'account', exchange.accountSnapshot(accountId));
      req.on('close', () => clients.delete(client));
      return undefined;
    }

    throw httpError(404, 'Not found');
  }

  function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return json(res, 403, { error: 'Forbidden' });
    fs.readFile(file, (err, data) => {
      if (err) return json(res, 404, { error: 'Not found' });
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
      return undefined;
    });
    return undefined;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else if (req.method === 'GET') serveStatic(req, res, url);
      else json(res, 405, { error: 'Method not allowed' });
    } catch (err) {
      if (err instanceof OrderError) return json(res, 400, { error: err.message });
      if (err.status) return json(res, err.status, { error: err.message });
      console.error(err);
      return json(res, 500, { error: 'Internal server error' });
    }
    return undefined;
  });

  let pushTimer = null;
  return {
    exchange,
    sim,
    server,
    listen(port, cb) {
      if (simulate) sim.start(tickMs);
      pushTimer = setInterval(push, pushMs);
      return server.listen(port, cb);
    },
    /** Write state to disk immediately (no-op without a dataFile). */
    save() {
      if (saver) saver.saveNow();
    },
    close(cb) {
      sim.stop();
      clearInterval(pushTimer);
      if (saver) {
        saver.saveNow();
        saver.stop();
      }
      for (const c of clients) c.res.end();
      server.close(cb);
    },
  };
}

// ------------------------------------------------------------------ helpers

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) {
        reject(httpError(413, 'Request body too large'));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return resolve(v && typeof v === 'object' ? v : {});
      } catch {
        return reject(httpError(400, 'Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const dataFile = process.env.DATA_FILE === ''
    ? null
    : path.resolve(process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'tradplat.json'));
  const platform = createPlatform({ dataFile });
  platform.listen(port, () => {
    console.log(`TradPlat running at http://localhost:${port}`);
    console.log(dataFile ? `Saving state to ${dataFile}` : 'Persistence disabled (DATA_FILE is empty)');
  });
  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received, saving state…`);
    platform.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref(); // don't hang on open connections
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createPlatform };
