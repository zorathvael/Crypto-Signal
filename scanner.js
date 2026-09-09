
/**
 * Strict Core Scanner v2.5.0
 * v2.5.0 pullback entry · structure SL · 1H+15M+4H · Square card
 * Note: levels on OKX SWAP — treat as zone if trading another venue
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const OKX = "https://www.okx.com";
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BINANCE_SQUARE_KEY = process.env.BINANCE_SQUARE_OPENAPI_KEY;
const MIN_PROB_VALID = 75;
const MIN_PROB_SNIPER = 82;
const MIN_RR = 1.8;
const CANDIDATE_LIMIT = 48;
const SQUARE_POST_COUNT = 3;

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function formatPrice(v) {
  if (!Number.isFinite(v)) return "—";
  if (v < 0.000001) return v.toFixed(10);
  if (v < 0.001) return v.toFixed(8);
  if (v < 1) return v.toFixed(5);
  return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "StrictCore/2.5.0" },
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

function sma(values, period) {
  return values.map((_, i) => (i + 1 < period ? null : mean(values.slice(i + 1 - period, i + 1))));
}
function ema(values, period) {
  const out = Array(values.length).fill(null);
  if (values.length < period) return out;
  let prev = mean(values.slice(0, period));
  out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    prev = (values[i] - prev) * k + prev;
    out[i] = prev;
  }
  return out;
}
function stdDev(values) {
  const avg = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - avg) ** 2)));
}
function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper = Array(closes.length).fill(null);
  const lower = Array(closes.length).fill(null);
  const width = Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const win = closes.slice(i + 1 - period, i + 1);
    const dev = stdDev(win);
    upper[i] = mid[i] + mult * dev;
    lower[i] = mid[i] - mult * dev;
    width[i] = mid[i] ? ((upper[i] - lower[i]) / mid[i]) * 100 : null;
  }
  return { middle: mid, upper, lower, width };
}
function rsi(values, period = 14) {
  const out = Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const ch = values[i] - values[i - 1];
    gains += Math.max(ch, 0);
    losses += Math.max(-ch, 0);
  }
  let avgG = gains / period, avgL = losses / period;
  out[period] = avgL ? 100 - 100 / (1 + avgG / avgL) : 100;
  for (let i = period + 1; i < values.length; i++) {
    const ch = values[i] - values[i - 1];
    avgG = (avgG * (period - 1) + Math.max(ch, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-ch, 0)) / period;
    out[i] = avgL ? 100 - 100 / (1 + avgG / avgL) : 100;
  }
  return out;
}
function macdHist(closes, fast = 12, slow = 26, signal = 9) {
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const line = closes.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  const valid = line.map((v) => (v == null ? 0 : v));
  const sig = ema(valid, signal);
  return line.map((v, i) => (v != null && sig[i] != null ? v - sig[i] : null));
}
function atr(candles, period = 14) {
  const ranges = candles.map((c, i) => {
    if (!i) return c.high - c.low;
    const p = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - p), Math.abs(c.low - p));
  });
  if (ranges.length < period) return null;
  let v = mean(ranges.slice(0, period));
  for (let i = period; i < ranges.length; i++) v = (v * (period - 1) + ranges[i]) / period;
  return v;
}
function adx(candles, period = 14) {
  if (!candles || candles.length < period + 2) return null;
  const tr = [], plusDM = [], minusDM = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low;
    const ph = candles[i - 1].high, pl = candles[i - 1].low, pc = candles[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up = h - ph, down = pl - l;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  }
  let atrS = mean(tr.slice(0, period));
  let pDM = mean(plusDM.slice(0, period));
  let mDM = mean(minusDM.slice(0, period));
  const dxArr = [];
  for (let i = period; i < tr.length; i++) {
    atrS = (atrS * (period - 1) + tr[i]) / period;
    pDM = (pDM * (period - 1) + plusDM[i]) / period;
    mDM = (mDM * (period - 1) + minusDM[i]) / period;
    const pDI = atrS ? (100 * pDM) / atrS : 0;
    const mDI = atrS ? (100 * mDM) / atrS : 0;
    const sum = pDI + mDI;
    dxArr.push(sum ? (100 * Math.abs(pDI - mDI)) / sum : 0);
  }
  if (dxArr.length < period) return dxArr.length ? mean(dxArr) : null;
  let adxV = mean(dxArr.slice(0, period));
  for (let i = period; i < dxArr.length; i++) adxV = (adxV * (period - 1) + dxArr[i]) / period;
  return adxV;
}
function volumeAnalysis(candles) {
  const cur = candles.at(-1);
  const recent = candles.slice(-12);
  const base = mean(candles.slice(-30, -1).map((c) => c.volume)) || 1;
  const buy = recent.reduce((s, c) => s + (c.close > c.open ? c.volume : 0), 0);
  const sell = recent.reduce((s, c) => s + (c.close <= c.open ? c.volume : 0), 0);
  const pressure = ((buy - sell) / (buy + sell || 1)) * 100;
  const recentAvg = mean(recent.slice(-4).map((c) => c.volume));
  const spike = cur.volume >= base * 1.35 || recentAvg >= base * 1.25;
  return { pressure, spike, side: pressure > 8 ? "BUY" : pressure < -8 ? "SELL" : "BALANCED", base };
}
function detectReversal(candles) {
  const last = candles.at(-1);
  const prev = candles.at(-2);
  if (!last || !prev) return { bias: "neutral", quality: 0, name: "None" };
  const body = Math.abs(last.close - last.open);
  const range = Math.max(last.high - last.low, 1e-12);
  const uw = last.high - Math.max(last.open, last.close);
  const lw = Math.min(last.open, last.close) - last.low;
  if (prev.close < prev.open && last.close > last.open && last.open <= prev.close && last.close >= prev.open)
    return { bias: "bullish", quality: 0.95, name: "Bullish Engulfing" };
  if (prev.close > prev.open && last.close < last.open && last.open >= prev.close && last.close <= prev.open)
    return { bias: "bearish", quality: 0.95, name: "Bearish Engulfing" };
  if (lw >= body * 2.0 && uw <= body * 0.75 && last.close >= last.open)
    return { bias: "bullish", quality: 0.85, name: "Hammer" };
  if (uw >= body * 2.0 && lw <= body * 0.75 && last.close <= last.open)
    return { bias: "bearish", quality: 0.85, name: "Shooting Star" };
  if (lw >= range * 0.58 && last.close >= last.open) return { bias: "bullish", quality: 0.8, name: "Pin Bar" };
  if (uw >= range * 0.58 && last.close <= last.open) return { bias: "bearish", quality: 0.8, name: "Pin Bar" };
  return { bias: "neutral", quality: 0, name: "None" };
}
function marketStructure(candles) {
  if (candles.length < 30) return { trend: "chop" };
  const leg = candles.slice(-20);
  const mid = Math.floor(leg.length / 2);
  const first = leg.slice(0, mid);
  const second = leg.slice(mid);
  const hi1 = Math.max(...first.map((c) => c.high));
  const hi2 = Math.max(...second.map((c) => c.high));
  const lo1 = Math.min(...first.map((c) => c.low));
  const lo2 = Math.min(...second.map((c) => c.low));
  if (hi2 > hi1 && lo2 > lo1) return { trend: "up" };
  if (lo2 < lo1 && hi2 < hi1) return { trend: "down" };
  return { trend: "chop" };
}
function analyzeTF(candles, label) {
  if (!candles || candles.length < 60) return null;
  const closes = candles.map((c) => c.close);
  const bands = bollinger(closes, 20, 2);
  const rsiV = rsi(closes, 14);
  const hist = macdHist(closes);
  const adxV = adx(candles, 14);
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const idx = candles.length - 1;
  const last = candles[idx];
  const mid = bands.middle[idx], up = bands.upper[idx], lo = bands.lower[idx], w = bands.width[idx];
  const widths = bands.width.filter((v) => v != null);
  const recentW = widths.slice(-20);
  const sortedW = [...widths.slice(-60)].sort((a, b) => a - b);
  const sqThresh = sortedW[Math.floor(sortedW.length * 0.25)] || w;
  const squeeze = (w != null && w <= sqThresh) || (recentW.length >= 15 && w <= Math.min(...recentW) * 1.05);
  const pos = clamp(((last.close - lo) / Math.max(up - lo, 1e-12)) * 100, 0, 100);
  const e9 = ema9[idx], e21 = ema21[idx], e50 = ema50[idx];
  const emaBull = e9 > e21 && (e50 == null || e21 > e50 * 0.998);
  const emaBear = e9 < e21 && (e50 == null || e21 < e50 * 1.002);
  const vol = volumeAnalysis(candles);
  const rev = detectReversal(candles);
  const ms = marketStructure(candles);
  const macdNow = hist[idx];
  const macdPrev = hist[idx - 1];
  const macdUp = macdNow != null && macdPrev != null && macdNow > macdPrev;
  const macdDown = macdNow != null && macdPrev != null && macdNow < macdPrev;
  const touchLo = last.low <= lo * 1.003 || last.close <= lo * 1.005;
  const touchUp = last.high >= up * 0.997 || last.close >= up * 0.995;
  let biasScore = 0;
  if (emaBull) biasScore += 25;
  if (emaBear) biasScore -= 25;
  if (ms.trend === "up") biasScore += 20;
  if (ms.trend === "down") biasScore -= 20;
  if (last.close > mid) biasScore += 10;
  if (last.close < mid) biasScore -= 10;
  if (macdNow > 0) biasScore += 8;
  if (macdNow < 0) biasScore -= 8;
  if (macdUp) biasScore += 7;
  if (macdDown) biasScore -= 7;
  if (rsiV[idx] > 55) biasScore += 5;
  if (rsiV[idx] < 45) biasScore -= 5;
  if (vol.pressure > 12) biasScore += 8;
  if (vol.pressure < -12) biasScore -= 8;
  biasScore = clamp(biasScore, -100, 100);
  const bias = biasScore >= 18 ? "bullish" : biasScore <= -18 ? "bearish" : "neutral";
  const structure = squeeze ? "SQUEEZE" : pos <= 12 ? "NEAR LOWER" : pos >= 88 ? "NEAR UPPER" : "RANGE";
  // Price slope (%): positive = rising, negative = falling — hard direction anchor
  const slope = (n) => {
    if (idx < n) return 0;
    const a = closes[idx - n], b = closes[idx];
    return a ? ((b - a) / a) * 100 : 0;
  };
  const slope6 = slope(6);
  const slope12 = slope(12);
  return {
    label, middle: mid, upper: up, lower: lo, width: w, position: pos, squeeze, bias, biasScore, structure,
    emaBull, emaBear, rsi: rsiV[idx], volume: vol, reversal: rev, ms, macdUp, macdDown,
    meanLong: touchLo && pos <= 18 && rev.bias === "bullish" && rev.quality >= 0.75 && rsiV[idx] < 38,
    meanShort: touchUp && pos >= 82 && rev.bias === "bearish" && rev.quality >= 0.75 && rsiV[idx] > 62,
    adx: adxV,
    slope6, slope12,
    close: last.close,
    ema21: e21,
  };
}
function tfTrend(tf) {
  if (!tf) return "neutral";
  // Majority vote — needs ≥2 bullish or ≥2 bearish votes (anti-flip)
  let votes = 0;
  if (tf.emaBull) votes += 1;
  if (tf.emaBear) votes -= 1;
  if (tf.ms.trend === "up") votes += 1;
  if (tf.ms.trend === "down") votes -= 1;
  if (tf.bias === "bullish" && tf.biasScore >= 22) votes += 1;
  if (tf.bias === "bearish" && tf.biasScore <= -22) votes -= 1;
  if (tf.slope12 != null) {
    if (tf.slope12 > 0.12) votes += 1;
    if (tf.slope12 < -0.12) votes -= 1;
  }
  // Price vs EMA21 as structural anchor
  if (tf.close != null && tf.ema21 != null) {
    if (tf.close > tf.ema21) votes += 1;
    if (tf.close < tf.ema21) votes -= 1;
  }
  if (votes >= 2) return "bullish";
  if (votes <= -2) return "bearish";
  return "neutral";
}
function scoreSignal(h1, m15, m5, h4, funding, btcBias) {
  if (!h1 || !m15 || !m5) return null;

  const t1 = tfTrend(h1);
  const t15 = tfTrend(m15);
  const t4 = tfTrend(h4);
  const adxMax = Math.max(h1.adx != null ? h1.adx : 0, m15.adx != null ? m15.adx : 0);

  // --- HARD slope lock (block only when slope fights the signal) ---
  const h1Up = (h1.slope12 ?? 0) > 0.08;
  const h1Down = (h1.slope12 ?? 0) < -0.08;
  const m15Up = (m15.slope6 ?? 0) > 0.05;
  const m15Down = (m15.slope6 ?? 0) < -0.05;
  const h1StrongUp = (h1.slope12 ?? 0) > 0.9;
  const h1StrongDown = (h1.slope12 ?? 0) < -0.9;

  let action = null;
  let path = null;

  // TREND: 1H + 15M same direction + 4H not opposing + slope not fighting
  if (t1 === "bullish" && t15 === "bullish" && t4 !== "bearish" && !h1Down) {
    action = "LONG";
    path = "TREND";
  } else if (t1 === "bearish" && t15 === "bearish" && t4 !== "bullish" && !h1Up) {
    action = "SHORT";
    path = "TREND";
  }

  // MEAN_REV: only with HTF permission AND slope not fighting hard
  if (!action) {
    if (
      m5.meanLong &&
      t1 !== "bearish" &&
      t4 !== "bearish" &&
      !h1Down &&
      (h1.slope12 ?? 0) > -0.8
    ) {
      action = "LONG";
      path = "MEAN_REV";
    } else if (
      m5.meanShort &&
      t1 !== "bullish" &&
      t4 !== "bullish" &&
      !h1Up &&
      (h1.slope12 ?? 0) < 0.8
    ) {
      action = "SHORT";
      path = "MEAN_REV";
    }
  }

  // SQUEEZE: volume + macd + no HTF fight
  if (!action && m5.squeeze && m5.volume.spike && Math.abs(m5.volume.pressure) >= 14) {
    if (
      m5.volume.pressure >= 14 &&
      m5.macdUp &&
      t1 !== "bearish" &&
      t15 !== "bearish" &&
      t4 !== "bearish" &&
      !h1Down
    ) {
      action = "LONG";
      path = "SQUEEZE";
    } else if (
      m5.volume.pressure <= -14 &&
      m5.macdDown &&
      t1 !== "bullish" &&
      t15 !== "bullish" &&
      t4 !== "bullish" &&
      !h1Up
    ) {
      action = "SHORT";
      path = "SQUEEZE";
    }
  }

  if (!action) return null;


  // --- Anti-chase + pullback-only TREND (all coins) ---
  const pos5 = m5.position != null ? m5.position : 50;
  const pos15 = m15.position != null ? m15.position : 50;
  // TREND: only enter on pullback zone inside the trend (not at extremes)
  // LONG pullback = mid/lower half of BB; SHORT pullback = mid/upper half
  if (path === "TREND") {
    if (action === "LONG" && pos5 >= 72) return null;   // too high → wait pullback
    if (action === "SHORT" && pos5 <= 28) return null;  // too low → wait pullback
    if (action === "LONG" && pos15 >= 78) return null;
    if (action === "SHORT" && pos15 <= 22) return null;
  }
  // Extreme chase hard block (any path)
  if (action === "LONG" && (pos5 >= 90 || (pos5 >= 85 && (m5.rsi ?? 50) > 68))) return null;
  if (action === "SHORT" && (pos5 <= 10 || (pos5 <= 15 && (m5.rsi ?? 50) < 32))) return null;
  let chasePen = 0;
  if (action === "LONG" && pos5 >= 65) chasePen -= 6;
  if (action === "SHORT" && pos5 <= 35) chasePen -= 6;
  if (path === "MEAN_REV") {
    if (action === "LONG" && pos5 > 32) return null;
    if (action === "SHORT" && pos5 < 68) return null;
  }
  // RSI extreme against direction
  if (action === "LONG" && (m5.rsi ?? 50) > 72) return null;
  if (action === "SHORT" && (m5.rsi ?? 50) < 28) return null;

  // --- Final anti-invert gates (absolute) ---
  if (action === "LONG" && (t1 === "bearish" || t15 === "bearish")) return null;
  if (action === "SHORT" && (t1 === "bullish" || t15 === "bullish")) return null;
  if (action === "LONG" && h1Down && path === "TREND") return null;
  if (action === "SHORT" && h1Up && path === "TREND") return null;
  // 15m mild opposite is ok if 1H locked; only block strong 15m fight
  if (action === "LONG" && m15Down && (m15.slope6 ?? 0) < -0.55 && path === "TREND") return null;
  if (action === "SHORT" && m15Up && (m15.slope6 ?? 0) > 0.55 && path === "TREND") return null;
  if (action === "LONG" && h1StrongDown) return null; // strong dump → no long
  if (action === "SHORT" && h1StrongUp) return null; // strong pump → no short
  if (action === "LONG" && m5.bias === "bearish" && m5.biasScore < -40) return null;
  if (action === "SHORT" && m5.bias === "bullish" && m5.biasScore > 40) return null;
  if (action === "LONG" && m5.volume.pressure < -28) return null;
  if (action === "SHORT" && m5.volume.pressure > 28) return null;
  if (path === "TREND" && adxMax < 14 && !m5.volume.spike) return null;
  if (path === "SQUEEZE" && adxMax > 38) return null;

  let btcAdj = 0;
  if (btcBias && Math.abs(btcBias.score) >= 25) {
    if (btcBias.bias === "bullish") btcAdj = action === "LONG" ? 3 : -6;
    if (btcBias.bias === "bearish") btcAdj = action === "SHORT" ? 3 : -6;
  }

  let conf = 50;
  // Direction-aligned structure only (never reward fighting the move)
  if (action === "LONG") {
    if (t1 === "bullish") conf += 12;
    if (t15 === "bullish") conf += 10;
    if (t4 === "bullish") conf += 8;
    else if (t4 === "neutral") conf += 2;
    if (h1.emaBull) conf += 6;
    if (m15.emaBull) conf += 5;
    if (h1.ms.trend === "up") conf += 5;
    if (m15.ms.trend === "up") conf += 4;
    if (h1Up) conf += 6;
    if (m15Up) conf += 4;
    conf += Math.max(0, h1.biasScore) * 0.12;
    conf += Math.max(0, m15.biasScore) * 0.1;
  } else {
    if (t1 === "bearish") conf += 12;
    if (t15 === "bearish") conf += 10;
    if (t4 === "bearish") conf += 8;
    else if (t4 === "neutral") conf += 2;
    if (h1.emaBear) conf += 6;
    if (m15.emaBear) conf += 5;
    if (h1.ms.trend === "down") conf += 5;
    if (m15.ms.trend === "down") conf += 4;
    if (h1Down) conf += 6;
    if (m15Down) conf += 4;
    conf += Math.max(0, -h1.biasScore) * 0.12;
    conf += Math.max(0, -m15.biasScore) * 0.1;
  }

  if (path === "MEAN_REV") conf += 8;
  if (path === "SQUEEZE") conf += 6;
  if (path === "TREND" && t1 === t15 && t15 === t4 && t4 !== "neutral") conf += 6;

  if (action === "LONG" && m5.macdUp) conf += 4;
  if (action === "SHORT" && m5.macdDown) conf += 4;
  if (action === "LONG" && m5.reversal.bias === "bullish") conf += 5 * m5.reversal.quality;
  if (action === "SHORT" && m5.reversal.bias === "bearish") conf += 5 * m5.reversal.quality;
  if (action === "LONG" && m5.volume.pressure > 10) conf += 5;
  if (action === "SHORT" && m5.volume.pressure < -10) conf += 5;
  if (m5.volume.spike) conf += 2;

  if (action === "LONG" && m5.rsi < 40) conf += 2;
  if (action === "LONG" && m5.rsi > 72) conf -= 12;
  if (action === "SHORT" && m5.rsi > 60) conf += 2;
  if (action === "SHORT" && m5.rsi < 28) conf -= 12;
  if (action === "LONG" && funding < -0.0003) conf += 2;
  if (action === "SHORT" && funding > 0.0003) conf += 2;
  if (adxMax >= 22 && path === "TREND") conf += 4;
  else if (adxMax < 14 && path === "TREND") conf -= 6;

  conf += btcAdj;
  conf += chasePen;
  conf = clamp(Math.round(conf), 0, 99);
  if (conf < 75) return null;

  return {
    action,
    probability: conf,
    setup: path,
    h1,
    m15,
    m5,
    h4,
    adx: adxMax,
    trends: { h1: t1, m15: t15, h4: t4 },
  };
}

function buildLevels(candles, signal, mark) {
  const atrV = atr(candles) || mark * 0.005;
  // Wider swing window — SL beyond noise / stop-hunt zone
  const recent = candles.slice(-20);
  const swingLow = Math.min(...recent.map((c) => c.low));
  const swingHigh = Math.max(...recent.map((c) => c.high));
  const tick = Math.max(mark * 0.0001, 1e-12);
  const m5 = signal.m5;
  let entry = mark, sl, tp1, tp2;
  // Min risk ~1.4 ATR so random wicks don't kill the trade
  const minRisk = atrV * 1.4;
  const maxRisk = atrV * 2.4;
  if (signal.action === "LONG") {
    // SL below swing low + buffer (whale sweep room)
    let slStruct = swingLow - atrV * 0.45 - tick;
    // Clamp risk between minRisk and maxRisk
    if (entry - slStruct < minRisk) slStruct = entry - minRisk;
    if (entry - slStruct > maxRisk) slStruct = entry - maxRisk;
    sl = slStruct;
    if (!(sl < entry)) sl = entry - minRisk;
    const risk = entry - sl;
    tp1 = entry + risk * 1.5;
    tp2 = entry + risk * 2.5;
    // Prefer BB targets if farther (better RR) but never closer than min
    if (m5.middle != null && m5.middle > tp1) tp1 = m5.middle;
    if (m5.upper != null && m5.upper > tp2) tp2 = m5.upper;
    if (tp1 <= entry) tp1 = entry + risk * 1.5;
    if (tp2 <= tp1) tp2 = tp1 + risk * 0.8;
  } else {
    let slStruct = swingHigh + atrV * 0.45 + tick;
    if (slStruct - entry < minRisk) slStruct = entry + minRisk;
    if (slStruct - entry > maxRisk) slStruct = entry + maxRisk;
    sl = slStruct;
    if (!(sl > entry)) sl = entry + minRisk;
    const risk = sl - entry;
    tp1 = entry - risk * 1.5;
    tp2 = entry - risk * 2.5;
    if (m5.middle != null && m5.middle < tp1) tp1 = m5.middle;
    if (m5.lower != null && m5.lower < tp2) tp2 = m5.lower;
    if (tp1 >= entry) tp1 = entry - risk * 1.5;
    if (tp2 >= tp1) tp2 = tp1 - risk * 0.8;
  }
  const risk = Math.abs(entry - sl);
  const rr = risk > 0 ? Math.abs(tp2 - entry) / risk : 0;
  if (signal.action === "LONG" && !(sl < entry && entry < tp1 && tp1 <= tp2)) return { entry, sl, tp1, tp2, rr: 0 };
  if (signal.action === "SHORT" && !(sl > entry && entry > tp1 && tp1 >= tp2)) return { entry, sl, tp1, tp2, rr: 0 };
  return { entry, sl, tp1, tp2, rr };
}
function formatTelegramMessage(s) {
  const isSniper = s.probability >= MIN_PROB_SNIPER;
  const tag = isSniper ? "🎯 SNIPER" : "✅ VALID";
  const arrow = s.action === "LONG" ? "🟢 LONG" : "🔴 SHORT";
  return (
    `${tag} · <b>${s.base}</b> ${arrow}\n\n` +
    `📊 Probability: <b>${s.probability}%</b>\n` +
    `🧩 Setup: <b>${s.setup}</b>\n` +
    `🎯 Entry: <code>${formatPrice(s.entry)}</code>\n` +
    `🛑 SL: <code>${formatPrice(s.sl)}</code>\n` +
    `🎯 TP1: <code>${formatPrice(s.tp1)}</code>\n` +
    `🎯 TP2: <code>${formatPrice(s.tp2)}</code>\n` +
    `📈 R:R 1:${s.rr.toFixed(1)}\n\n` +
    `1H ${s.trends ? s.trends.h1 : s.h1.bias} · 15M ${s.trends ? s.trends.m15 : s.m15.bias} · 4H ${s.trends ? s.trends.h4 : "—"}\n` +
    `Vol ${s.m5.volume.side} · RSI ${Number(s.m5.rsi).toFixed(0)}\n\n` +
    `<i>Strict Core v2.4 · Score not guarantee · Risk max 0.75% · NFA</i>`
  );
}
function formatSquareCoinBlock(s) {
  const isSniper = s.probability >= MIN_PROB_SNIPER;
  const grade = isSniper ? "SNIPER" : "VALID";
  const side = s.action === "LONG" ? "LONG" : "SHORT";
  const mark = s.action === "LONG" ? "🟢" : "🔴";
  return (
    `${grade}  ·  ${s.base}  ${mark} ${side}\n` +
    `Score ${s.probability}%  ·  ${s.setup}  ·  R:R 1:${s.rr.toFixed(1)}\n` +
    `Entry  ${formatPrice(s.entry)}\n` +
    `SL     ${formatPrice(s.sl)}\n` +
    `TP1    ${formatPrice(s.tp1)}   ·   TP2  ${formatPrice(s.tp2)}\n` +
    `Context  1H ${s.h1.structure}  ·  15M ${s.m15.bias}  ·  Vol ${s.m5.volume.side}`
  );
}
function formatSquareBatchMessage(coins) {
  const now = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta", dateStyle: "medium", timeStyle: "short" });
  const lines = [
    "STRICT CORE  ·  Futures Scan",
    `WIB ${now}`,
    "",
    "Setup terpilih (struktur ketat, bukan sinyal acak):",
    "",
  ];
  coins.forEach((s, i) => {
    if (i > 0) lines.push("────────────────");
    lines.push(formatSquareCoinBlock(s));
    lines.push("");
  });
  lines.push("Risk max 0.75% per ide");
  lines.push("Edukasi saja — bukan saran finansial");
  lines.push("#Crypto #Futures #Trading");
  return lines.join("\n").trim();
}
function buildSquareCardSvg(coins) {
  // Portrait mobile 720×1520 — readable on phone without zoom
  const W = 720;
  const H = 1520;
  const rows = coins.slice(0, 3);
  const pad = 28;
  const headerH = 130;
  const footerH = 56;
  const gap = 16;
  const usable = H - headerH - footerH - gap * (rows.length + 1);
  const rowH = Math.floor(usable / Math.max(rows.length, 1));

  const esc = (x) =>
    String(x ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  let cards = "";
  rows.forEach((s, i) => {
    const y = headerH + gap + i * (rowH + gap);
    const isLong = s.action === "LONG";
    const accent = isLong ? "#059669" : "#e11d48";
    const soft = isLong ? "#ecfdf5" : "#fff1f2";
    const grade = s.probability >= MIN_PROB_SNIPER ? "SNIPER" : "VALID";
    const side = isLong ? "LONG" : "SHORT";
    const trendLine = s.trends
      ? `1H ${esc(s.trends.h1)}  ·  15M ${esc(s.trends.m15)}  ·  4H ${esc(s.trends.h4)}`
      : `1H ${esc(s.h1.structure)}  ·  15M ${esc(s.m15.bias)}`;

    cards += `
    <rect x="${pad}" y="${y}" width="${W - pad * 2}" height="${rowH}" rx="20" fill="${soft}" stroke="${accent}" stroke-width="3"/>
    <rect x="${pad}" y="${y}" width="12" height="${rowH}" rx="6" fill="${accent}"/>
    <text x="${pad + 28}" y="${y + 42}" font-family="Arial, Helvetica, sans-serif" font-size="34" font-weight="700" fill="#0f172a">${esc(s.base)}</text>
    <text x="${W - pad - 24}" y="${y + 42}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="28" font-weight="700" fill="${accent}">${isLong ? "▲" : "▼"} ${side}</text>
    <text x="${pad + 28}" y="${y + 78}" font-family="Arial, Helvetica, sans-serif" font-size="22" font-weight="700" fill="${accent}">${grade}  ·  ${s.probability}%</text>
    <text x="${pad + 28}" y="${y + 120}" font-family="Arial, Helvetica, sans-serif" font-size="20" fill="#1e293b">Entry   ${esc(formatPrice(s.entry))}</text>
    <text x="${pad + 28}" y="${y + 152}" font-family="Arial, Helvetica, sans-serif" font-size="20" fill="#1e293b">SL        ${esc(formatPrice(s.sl))}</text>
    <text x="${pad + 28}" y="${y + 184}" font-family="Arial, Helvetica, sans-serif" font-size="20" fill="#1e293b">TP1     ${esc(formatPrice(s.tp1))}</text>
    <text x="${pad + 28}" y="${y + 216}" font-family="Arial, Helvetica, sans-serif" font-size="20" fill="#1e293b">TP2     ${esc(formatPrice(s.tp2))}</text>
    <text x="${pad + 28}" y="${y + 252}" font-family="Arial, Helvetica, sans-serif" font-size="17" fill="#475569">${esc(s.setup)}  ·  R:R 1:${s.rr.toFixed(1)}  ·  Vol ${esc(s.m5.volume.side)}</text>
    <text x="${pad + 28}" y="${y + 284}" font-family="Arial, Helvetica, sans-serif" font-size="16" fill="#64748b">${trendLine}</text>`;
  });

  const now = new Date().toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <rect x="0" y="0" width="${W}" height="${headerH}" fill="#0f172a"/>
  <text x="${pad}" y="48" font-family="Arial, Helvetica, sans-serif" font-size="32" font-weight="700" fill="#ffffff">STRICT CORE</text>
  <text x="${pad}" y="84" font-family="Arial, Helvetica, sans-serif" font-size="16" fill="#94a3b8">Futures scan  ·  1H+15M lock  ·  4H gate</text>
  <text x="${pad}" y="110" font-family="Arial, Helvetica, sans-serif" font-size="15" fill="#64748b">${esc(now)} WIB</text>
  <text x="${W - pad}" y="52" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="18" font-weight="600" fill="#38bdf8">Top ${rows.length}</text>
  ${cards}
  <text x="${pad}" y="${H - 22}" font-family="Arial, Helvetica, sans-serif" font-size="14" fill="#64748b">Risk max 0.75%  ·  Educational only  ·  NFA</text>
</svg>`;
}

function renderSquareCardPng(coins) {
  const dir = "/tmp/square-card";
  fs.mkdirSync(dir, { recursive: true });
  const svgPath = path.join(dir, "card.svg");
  const pngPath = path.join(dir, "card.png");
  fs.writeFileSync(svgPath, buildSquareCardSvg(coins), "utf8");
  try {
    execFileSync("rsvg-convert", ["-w", "720", "-h", "1520", svgPath, "-o", pngPath], { stdio: "pipe" });
  } catch (e) {
    console.warn("rsvg-convert failed, Square will post text only:", e.message);
    return null;
  }
  if (!fs.existsSync(pngPath)) return null;
  return pngPath;
}
async function squareApi(endpoint, apiKey, body, useV2 = true) {
  const base = useV2
    ? "https://www.binance.com/bapi/composite/v2/public/pgc/openApi"
    : "https://www.binance.com/bapi/composite/v1/public/pgc/openApi";
  const res = await fetch(`${base}${endpoint}`, {
    method: "POST",
    headers: {
      "X-Square-OpenAPI-Key": apiKey,
      "Content-Type": "application/json",
      clienttype: "binanceSkill",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (String(json.code) !== "000000") {
    throw new Error(`Square API ${endpoint} [${json.code}]: ${json.message || res.status}`);
  }
  return json.data;
}
async function uploadSquareImage(apiKey, pngPath) {
  const imageName = path.basename(pngPath);
  const { presignedUrl, fileTicket } = await squareApi("/image/presignedUrl", apiKey, { imageName }, true);
  const buf = fs.readFileSync(pngPath);
  const put = await fetch(presignedUrl, { method: "PUT", headers: { "Content-Type": "image/png" }, body: buf });
  if (!put.ok) throw new Error(`S3 upload failed: ${put.status}`);
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = await squareApi("/image/imageStatus", apiKey, { fileTicket }, true);
    if (st.status === 1 && st.imageUrl) return st.imageUrl;
    if (st.status === 2) throw new Error(`Image process failed: ${st.failedReason || "unknown"}`);
    console.log(`  Square image processing... (${i + 1}/10)`);
  }
  throw new Error("Square image poll timeout");
}
async function sendBinanceSquare(signals) {
  if (!BINANCE_SQUARE_KEY) {
    console.log("Binance Square: skip (no BINANCE_SQUARE_OPENAPI_KEY)");
    return;
  }
  const ranked = [...signals]
    .filter((s) => s.probability >= MIN_PROB_VALID)
    .sort((a, b) => b.probability - a.probability || a.base.localeCompare(b.base));
  const batch = ranked.slice(0, SQUARE_POST_COUNT);
  if (!batch.length) {
    console.log("Binance Square: no Valid signals this run");
    return;
  }
  console.log(
    `Binance Square 1 post · ${batch.length} coin(s) → ` +
      batch.map((s) => `${s.base} ${s.action} ${s.probability}%`).join(", ")
  );
  const text = formatSquareBatchMessage(batch);
  const body = { contentType: 1, bodyTextOnly: text };
  try {
    const pngPath = renderSquareCardPng(batch);
    if (pngPath) {
      console.log("Square: uploading professional card image...");
      const imageUrl = await uploadSquareImage(BINANCE_SQUARE_KEY, pngPath);
      body.imageList = [imageUrl];
      console.log("Square: image ready");
    }
  } catch (e) {
    console.warn("Square image skip (text-only fallback):", e.message);
  }
  try {
    const res = await fetch("https://www.binance.com/bapi/composite/v1/public/pgc/openApi/content/add", {
      method: "POST",
      headers: {
        "X-Square-OpenAPI-Key": BINANCE_SQUARE_KEY,
        "Content-Type": "application/json",
        clienttype: "binanceSkill",
      },
      body: JSON.stringify(body),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || String(payload.code) !== "000000") {
      console.error("Binance Square failed:", res.status, payload.code, payload.message || JSON.stringify(payload));
    } else {
      const id = payload.data?.id;
      console.log(
        `Binance Square sent (${batch.length} coins` +
          (body.imageList ? " + image" : "") +
          `)` +
          (id ? ` → https://www.binance.com/square/post/${id}` : "")
      );
    }
  } catch (e) {
    console.error("Binance Square error:", e.message);
  }
}
async function sendTelegram(signals) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("Telegram: skip (no secrets)");
    return;
  }
  if (!signals.length) return;
  for (const s of signals) {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: formatTelegramMessage(s),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) console.error("Telegram failed:", res.status, JSON.stringify(body));
    else console.log(`Telegram sent: ${s.base} ${s.action} ${s.probability}%`);
  }
}
async function sendDiscord(signals) {
  if (!DISCORD_WEBHOOK) {
    console.log("Discord: skip (no secret)");
    return;
  }
  if (!signals.length) {
    console.log("No high-quality signals");
    return;
  }
  for (let i = 0; i < signals.length; i++) {
    const s = signals[i];
    if (i > 0) await new Promise((r) => setTimeout(r, 400));
    const isSniper = s.probability >= MIN_PROB_SNIPER;
    const color = s.action === "LONG" ? 0x35ef9a : 0xff5c7a;
    const embed = {
      title: `${isSniper ? "🎯 SNIPER" : "✅ VALID"} · ${s.base} ${s.action}`,
      color,
      fields: [
        { name: "Probability", value: `**${s.probability}%**`, inline: true },
        { name: "Setup", value: s.setup, inline: true },
        { name: "R:R", value: `1:${s.rr.toFixed(1)}`, inline: true },
        { name: "Entry", value: `$${formatPrice(s.entry)}`, inline: true },
        { name: "SL", value: `$${formatPrice(s.sl)}`, inline: true },
        { name: "TP1 / TP2", value: `$${formatPrice(s.tp1)} / $${formatPrice(s.tp2)}`, inline: true },
        { name: "1H", value: `${s.h1.structure} (${s.h1.bias})`, inline: true },
        { name: "15M", value: s.m15.bias, inline: true },
        { name: "5M / Vol", value: `${s.m5.structure} / ${s.m5.volume.side}`, inline: true },
      ],
      footer: { text: "Strict Core v2.4 · Score not guarantee · NFA" },
      timestamp: new Date().toISOString(),
    };
    const res = await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "Strict Core", embeds: [embed] }),
    });
    if (!res.ok) console.error("Discord failed:", res.status, await res.text());
    else console.log(`Discord sent: ${s.base} ${s.action} ${s.probability}%`);
  }
}
async function fetchOkxCandles(instId, bar, limit = 100) {
  const url = `${OKX}/api/v5/market/candles?instId=${encodeURIComponent(instId)}&bar=${bar}&limit=${limit}`;
  const data = await getJson(url);
  const list = data?.data || [];
  const candles = list
    .map((r) => ({
      open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5], confirm: String(r[8]),
    }))
    .reverse();
  if (candles.length && candles[candles.length - 1].confirm === "0") candles.pop();
  return candles;
}
async function fetchFunding(instId) {
  try {
    const data = await getJson(`${OKX}/api/v5/public/funding-rate?instId=${encodeURIComponent(instId)}`);
    return +(data?.data?.[0]?.fundingRate || 0);
  } catch {
    return 0;
  }
}
async function main() {
  console.log("=== Strict Core v2.5.0 | pullback entry · structure SL · anti-hunt ===");
  console.log(new Date().toISOString());
  console.log(
    "Discord:", DISCORD_WEBHOOK ? "YES" : "NO",
    "| Telegram:", TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? "YES" : "NO",
    "| Square:", BINANCE_SQUARE_KEY ? "YES" : "NO"
  );
  let btcBias = { bias: "neutral", score: 0 };
  try {
    const btcCandles = await fetchOkxCandles("BTC-USDT-SWAP", "1H", 100);
    const btcTF = analyzeTF(btcCandles, "BTC1H");
    if (btcTF) {
      btcBias = { bias: btcTF.bias, score: btcTF.biasScore, adx: btcTF.adx };
      console.log(`BTC soft bias: ${btcBias.bias} (score ${btcBias.score}, ADX ${btcBias.adx != null ? btcBias.adx.toFixed(1) : "n/a"})`);
    }
  } catch (e) {
    console.warn("BTC bias skip:", e.message);
  }
  const tickersRes = await getJson(`${OKX}/api/v5/market/tickers?instType=SWAP`);
  const tickers = (tickersRes?.data || []).filter((t) => t.instId.endsWith("-USDT-SWAP"));
  const candidates = tickers
    .map((t) => {
      const last = +t.last || 0;
      const open = +t.open24h || last;
      const baseVol = +t.volCcy24h || 0;
      const turnover = baseVol * last;
      const chg = open ? ((last - open) / open) * 100 : 0;
      if (turnover < 2_000_000 || Math.abs(chg) > 28) return null;
      const base = t.instId.replace("-USDT-SWAP", "");
      if (/^[0-9]/.test(base) || /UP|DOWN|BEAR|BULL/i.test(base)) return null;
      return {
        instId: t.instId,
        base,
        volume: turnover,
        change: chg,
        score: Math.log10(Math.max(turnover, 1)) * 0.65 + Math.min(Math.abs(chg) / 10, 1) * 0.35,
        mark: last,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, CANDIDATE_LIMIT);
  console.log(`Candidates (${candidates.length}): ${candidates.map((c) => c.base).join(", ")}`);
  const signals = [];
  for (const c of candidates) {
    try {
      const [h1c, m15c, m5c, h4c, funding] = await Promise.all([
        fetchOkxCandles(c.instId, "1H", 100),
        fetchOkxCandles(c.instId, "15m", 100),
        fetchOkxCandles(c.instId, "5m", 100),
        fetchOkxCandles(c.instId, "4H", 100),
        fetchFunding(c.instId),
      ]);
      const h1 = analyzeTF(h1c, "1H");
      const m15 = analyzeTF(m15c, "15M");
      const m5 = analyzeTF(m5c, "5M");
      const h4 = analyzeTF(h4c, "4H");
      const scored = scoreSignal(h1, m15, m5, h4, funding, btcBias);
      if (!scored || scored.probability < MIN_PROB_VALID) continue;
      const levels = buildLevels(m5c, scored, c.mark);
      if (levels.rr < MIN_RR) continue;
      signals.push({
        base: c.base,
        action: scored.action,
        probability: scored.probability,
        setup: scored.setup,
        entry: levels.entry,
        sl: levels.sl,
        tp1: levels.tp1,
        tp2: levels.tp2,
        rr: levels.rr,
        h1: scored.h1,
        m15: scored.m15,
        m5: scored.m5,
        h4: scored.h4,
        trends: scored.trends,
      });
    } catch (e) {
      console.warn(`Skip ${c.base}:`, e.message);
    }
  }
  signals.sort((a, b) => b.probability - a.probability);
  console.log(`Strict signals: ${signals.length}`);
  signals.forEach((s) => console.log(`  ${s.base} ${s.action} ${s.probability}% ${s.setup} R:R 1:${s.rr.toFixed(1)}`));
  await sendDiscord(signals);
  await sendTelegram(signals);
  await sendBinanceSquare(signals);
  console.log("Done.");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
