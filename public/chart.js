'use strict';

/**
 * Minimal dependency-free candlestick chart on <canvas>:
 * candles + volume, price/time axes, last-price marker,
 * open-order price lines and a hover crosshair with OHLC readout.
 */
class CandleChart {
  constructor(canvas, readout) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.readout = readout;
    this.candles = [];
    this.orderLines = [];
    this.hover = null;
    this.maxVisible = 110;
    this.colors = {
      up: '#22c55e', down: '#ef4444', grid: '#1b212b', text: '#8a94a6',
      bg: '#11151c', last: '#3b82f6', order: '#f59e0b',
    };
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    canvas.addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.hover = { x: e.clientX - r.left, y: e.clientY - r.top };
      this.draw();
    });
    canvas.addEventListener('mouseleave', () => { this.hover = null; this.draw(); });
    this.resize();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const { clientWidth: w, clientHeight: h } = this.canvas.parentElement;
    this.w = w;
    this.h = h;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  setCandles(candles) {
    this.candles = candles.slice();
    this.draw();
  }

  /** Merge a live candle: update in place when the bucket matches, else append. */
  update(c) {
    if (!c) return;
    const last = this.candles[this.candles.length - 1];
    if (last && last.time === c.time) Object.assign(last, c);
    else if (!last || c.time > last.time) this.candles.push({ ...c });
    if (this.candles.length > 600) this.candles.shift();
    this.draw();
  }

  setOrderLines(lines) {
    this.orderLines = lines;
    this.draw();
  }

  draw() {
    const { ctx, w, h, colors } = this;
    if (!w || !h) return;
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, w, h);
    const data = this.candles.slice(-this.maxVisible);
    if (!data.length) return;

    const axisW = 70;
    const axisH = 22;
    const plotW = w - axisW;
    const volH = (h - axisH) * 0.18;
    const priceH = h - axisH - volH - 10;
    const top = 28;

    let hi = -Infinity;
    let lo = Infinity;
    let vMax = 0;
    for (const c of data) {
      hi = Math.max(hi, c.high);
      lo = Math.min(lo, c.low);
      vMax = Math.max(vMax, c.volume);
    }
    for (const l of this.orderLines) {
      // Keep nearby orders on screen, but don't let a far-away one squash the chart.
      if (l.price < hi * 1.05 && l.price > lo * 0.95) {
        hi = Math.max(hi, l.price);
        lo = Math.min(lo, l.price);
      }
    }
    const pad = (hi - lo) * 0.08 || hi * 0.01 || 1;
    hi += pad;
    lo -= pad;
    const y = (p) => top + ((hi - p) / (hi - lo)) * (priceH - top);
    const step = plotW / this.maxVisible;
    const x0 = plotW - data.length * step;
    const cx = (i) => x0 + i * step + step / 2;
    const bodyW = Math.max(1, step * 0.64);

    // Grid + price axis
    ctx.font = '11px ui-monospace, Menlo, monospace';
    ctx.textBaseline = 'middle';
    const ticks = niceTicks(lo, hi, 6);
    for (const t of ticks) {
      const yy = Math.round(y(t)) + 0.5;
      ctx.strokeStyle = colors.grid;
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(plotW, yy); ctx.stroke();
      ctx.fillStyle = colors.text;
      ctx.fillText(fmt(t), plotW + 8, yy);
    }

    // Time axis
    ctx.textBaseline = 'alphabetic';
    const every = Math.max(1, Math.ceil(90 / step));
    for (let i = 0; i < data.length; i++) {
      if ((data.length - 1 - i) % every) continue;
      const xx = Math.round(cx(i)) + 0.5;
      ctx.strokeStyle = colors.grid;
      ctx.beginPath(); ctx.moveTo(xx, top); ctx.lineTo(xx, h - axisH); ctx.stroke();
      ctx.fillStyle = colors.text;
      const label = new Date(data[i].time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      ctx.fillText(label, xx - ctx.measureText(label).width / 2, h - 6);
    }

    // Volume
    const volBase = h - axisH;
    for (let i = 0; i < data.length; i++) {
      const c = data[i];
      const vh = vMax ? (c.volume / vMax) * volH : 0;
      ctx.fillStyle = (c.close >= c.open ? colors.up : colors.down) + '40';
      ctx.fillRect(cx(i) - bodyW / 2, volBase - vh, bodyW, vh);
    }

    // Candles
    for (let i = 0; i < data.length; i++) {
      const c = data[i];
      const col = c.close >= c.open ? colors.up : colors.down;
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      const xx = Math.round(cx(i)) + 0.5;
      ctx.beginPath(); ctx.moveTo(xx, y(c.high)); ctx.lineTo(xx, y(c.low)); ctx.stroke();
      const yo = y(c.open);
      const yc = y(c.close);
      ctx.fillRect(cx(i) - bodyW / 2, Math.min(yo, yc), bodyW, Math.max(1, Math.abs(yc - yo)));
    }

    // Open order lines
    for (const l of this.orderLines) {
      if (l.price > hi || l.price < lo) continue;
      const yy = Math.round(y(l.price)) + 0.5;
      ctx.strokeStyle = colors.order;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(plotW, yy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = colors.order;
      ctx.font = '10px system-ui';
      ctx.fillText(l.label, 6, yy - 4);
      ctx.font = '11px ui-monospace, Menlo, monospace';
    }

    // Last price marker
    const last = data[data.length - 1].close;
    this.tag(y(last), fmt(last), last >= data[data.length - 1].open ? colors.up : colors.down, plotW, axisW, true);

    // Crosshair
    const hv = this.hover;
    let shown = data[data.length - 1];
    if (hv && hv.x < plotW && hv.y > top && hv.y < h - axisH) {
      const idx = Math.floor((hv.x - x0) / step);
      if (data[idx]) shown = data[idx];
      ctx.strokeStyle = '#4b5565';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(0, hv.y + 0.5); ctx.lineTo(plotW, hv.y + 0.5);
      ctx.moveTo(hv.x + 0.5, top); ctx.lineTo(hv.x + 0.5, h - axisH);
      ctx.stroke();
      ctx.setLineDash([]);
      if (hv.y < priceH) {
        const p = hi - ((hv.y - top) / (priceH - top)) * (hi - lo);
        this.tag(hv.y, fmt(p), '#374151', plotW, axisW, false);
      }
    }
    if (this.readout && shown) {
      const chg = shown.close - shown.open;
      const cls = chg >= 0 ? 'up' : 'down';
      this.readout.innerHTML =
        `O <span class="${cls}">${fmt(shown.open)}</span> H <span class="${cls}">${fmt(shown.high)}</span> ` +
        `L <span class="${cls}">${fmt(shown.low)}</span> C <span class="${cls}">${fmt(shown.close)}</span> ` +
        `V ${shown.volume.toLocaleString()}`;
    }
  }

  tag(yy, text, color, plotW, axisW, line) {
    const { ctx } = this;
    if (line) {
      ctx.strokeStyle = color;
      ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(0, Math.round(yy) + 0.5); ctx.lineTo(plotW, Math.round(yy) + 0.5); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = color;
    ctx.fillRect(plotW + 1, yy - 9, axisW - 2, 18);
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, plotW + 8, yy);
  }
}

function fmt(cents) {
  return (cents / 100).toFixed(2);
}

function niceTicks(lo, hi, count) {
  const span = hi - lo;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) out.push(t);
  return out;
}

window.CandleChart = CandleChart;
