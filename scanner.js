
/**
 * Strict Core Scanner v2.9.3
 * + Volatility Regime (Clodds-inspired)
 * + Orderbook Quality Score
 * + Adaptive Risk Suggestion (modal minim)
 * + Persistence filter
 * + Adaptive SL/TP by Regime
 * + Volume Spike / Momentum Confirmation
 * + Hard Liquidity Filter
 * + Soft Overtrade Guard
 * + Hybrid Entry (dekat zona → ZONE; agak jauh → MARKET + SL struktur)
 * + Supertrend (tolak ukur tambahan 1H/15M)
 * + BTC bias lebih ringan
 * + Optimized Discord / Telegram / Binance Square messages
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
const MIN_RR = 1.5;
const CANDIDATE_LIMIT = 40;
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
    headers: { Accept: "application/json", "User-Agent": "StrictCore/2.9.3" },
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

/** Supertrend (ATR-based) — direction: 1 = bullish, -1 = bearish */
function supertrend(candles, period = 10, mult = 3) {
  if (!candles || candles.length < period + 2) return { dir: 0, line: null };
  const n = candles.length;
  const tr = Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (i === 0) tr[i] = candles[i].high - candles[i].low;
    else {
      const pc = candles[i - 1].close;
      tr[i] = Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - pc),
        Math.abs(candles[i].low - pc)
      );
    }
  }
  let atrV = mean(tr.slice(0, period));
  const atrArr = Array(n).fill(null);
  atrArr[period - 1] = atrV;
  for (let i = period; i < n; i++) {
    atrV = (atrV * (period - 1) + tr[i]) / period;
    atrArr[i] = atrV;
  }
  let finalUpper = null, finalLower = null, dir = 1;
  let line = null;
  for (let i = period - 1; i < n; i++) {
    const hl2 = (candles[i].high + candles[i].low) / 2;
    const basicUpper = hl2 + mult * atrArr[i];
    const basicLower = hl2 - mult * atrArr[i];
    if (finalUpper == null) {
      finalUpper = basicUpper;
      finalLower = basicLower;
      dir = candles[i].close >= finalLower ? 1 : -1;
    } else {
      finalUpper = basicUpper < finalUpper || candles[i - 1].close > finalUpper ? basicUpper : finalUpper;
      finalLower = basicLower > finalLower || candles[i - 1].close < finalLower ? basicLower : finalLower;
      if (dir === 1) {
        dir = candles[i].close < finalLower ? -1 : 1;
      } else {
        dir = candles[i].close > finalUpper ? 1 : -1;
      }
    }
    line = dir === 1 ? finalLower : finalUpper;
  }
  return { dir, line };
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
  const st = supertrend(candles, 10, 3);
  return {
    label, middle: mid, upper: up, lower: lo, width: w, position: pos, squeeze, bias, biasScore, structure,
    emaBull, emaBear, rsi: rsiV[idx], volume: vol, reversal: rev, ms, macdUp, macdDown,
    meanLong: touchLo && pos <= 18 && rev.bias === "bullish" && rev.quality >= 0.75 && rsiV[idx] < 38,
    meanShort: touchUp && pos >= 82 && rev.bias === "bearish" && rev.quality >= 0.75 && rsiV[idx] > 62,
    adx: adxV,
    slope6, slope12,
    close: last.close,
    ema21: e21,
    stDir: st.dir,
    stLine: st.line,
  };
}
function tfTrend(tf) {
  if (!tf) return "neutral";
  let votes = 0;
  if (tf.emaBull) votes += 1;
  if (tf.emaBear) votes -= 1;
  if (tf.ms.trend === "up") votes += 1;
  if (tf.ms.trend === "down") votes -= 1;
  if (tf.bias === "bullish" && tf.biasScore >= 18) votes += 1;
  if (tf.bias === "bearish" && tf.biasScore <= -18) votes -= 1;
  if (tf.slope12 != null) {
    if (tf.slope12 > 0.08) votes += 1;
    if (tf.slope12 < -0.08) votes -= 1;
  }
  if (tf.close != null && tf.ema21 != null) {
    if (tf.close > tf.ema21) votes += 1;
    if (tf.close < tf.ema21) votes -= 1;
  }
  // Supertrend vote (soft, 1 vote)
  if (tf.stDir === 1) votes += 1;
  if (tf.stDir === -1) votes -= 1;
  // ≥2 clear, or ≥1 with strong bias/slope
  if (votes >= 2) return "bullish";
  if (votes <= -2) return "bearish";
  if (votes === 1 && ((tf.biasScore ?? 0) >= 28 || (tf.slope12 ?? 0) > 0.35)) return "bullish";
  if (votes === -1 && ((tf.biasScore ?? 0) <= -28 || (tf.slope12 ?? 0) < -0.35)) return "bearish";
  return "neutral";
}
function councilConsensus(h1, m15, m5, h4) {
  // Multi-method "discussion": each module votes LONG(+1) / SHORT(-1) / abstain(0)
  const votes = [];
  const push = (name, v, w = 1) => votes.push({ name, v, w });

  // 1) HTF trend structure
  const t1 = tfTrend(h1), t15 = tfTrend(m15), t4 = tfTrend(h4);
  if (t1 === "bullish") push("1H_trend", 1, 1.4);
  if (t1 === "bearish") push("1H_trend", -1, 1.4);
  if (t15 === "bullish") push("15M_trend", 1, 1.2);
  if (t15 === "bearish") push("15M_trend", -1, 1.2);
  if (t4 === "bullish") push("4H_trend", 1, 1.0);
  if (t4 === "bearish") push("4H_trend", -1, 1.0);

  // 2) Slope (price truth)
  if ((h1.slope12 ?? 0) > 0.2) push("1H_slope", 1, 1.3);
  if ((h1.slope12 ?? 0) < -0.2) push("1H_slope", -1, 1.3);
  if ((m15.slope6 ?? 0) > 0.15) push("15M_slope", 1, 0.9);
  if ((m15.slope6 ?? 0) < -0.15) push("15M_slope", -1, 0.9);

  // 3) EMA stack
  if (h1.emaBull) push("1H_ema", 1, 1.0);
  if (h1.emaBear) push("1H_ema", -1, 1.0);
  if (m15.emaBull) push("15M_ema", 1, 0.8);
  if (m15.emaBear) push("15M_ema", -1, 0.8);

  // 4) Volume pressure
  if ((m5.volume?.pressure ?? 0) > 14) push("vol", 1, 1.0);
  if ((m5.volume?.pressure ?? 0) < -14) push("vol", -1, 1.0);

  // 5) MACD momentum 5m
  if (m5.macdUp) push("macd", 1, 0.7);
  if (m5.macdDown) push("macd", -1, 0.7);

  // 6) Market structure
  if (h1.ms?.trend === "up") push("ms", 1, 1.1);
  if (h1.ms?.trend === "down") push("ms", -1, 1.1);

  // 7) Location penalty (don't vote long at top / short at bottom)
  const pos = m5.position ?? 50;
  if (pos >= 80) push("location", -1, 1.2); // favor short-side caution at highs
  if (pos <= 20) push("location", 1, 1.2);

  let score = 0, weight = 0;
  for (const v of votes) {
    score += v.v * v.w;
    weight += v.w;
  }
  const net = weight ? score / weight : 0;
  let side = "neutral";
  if (net >= 0.22) side = "LONG";
  else if (net <= -0.22) side = "SHORT";
  return { side, net, votes: votes.length, t1, t15, t4 };
}

function scoreSignal(h1, m15, m5, h4, funding, btcBias, book = null, regime = null) {
  if (!h1 || !m15 || !m5) return null;

  // Hard block on extreme volatility (protect small capital)
  if (regime && regime.regime === "extreme") return null;

  const t1 = tfTrend(h1);
  const t15 = tfTrend(m15);
  const t4 = tfTrend(h4);
  const adxMax = Math.max(h1.adx != null ? h1.adx : 0, m15.adx != null ? m15.adx : 0);

  // --- HARD slope lock (block only when slope fights the signal) ---
  const h1Up = (h1.slope12 ?? 0) > 0.05;
  const h1Down = (h1.slope12 ?? 0) < -0.05;
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
  const ob = book || { imbalance: 0, side: "FLAT" };
  if (action === "LONG" && ob.side === "ASK" && (ob.imbalance ?? 0) <= -12) return null;
  if (action === "SHORT" && ob.side === "BID" && (ob.imbalance ?? 0) >= 12) return null;
  if (action === "LONG" && (ob.imbalance ?? 0) <= -22) return null;
  if (action === "SHORT" && (ob.imbalance ?? 0) >= 22) return null;


  // Council: block only when it actively opposes the action
  const council = councilConsensus(h1, m15, m5, h4);
  if (council.side !== "neutral" && council.side !== action) return null;
  // Neutral council OK if 1H+15M already locked same way



  // --- Anti-chase + pullback-only TREND (all coins) ---
  const pos5 = m5.position != null ? m5.position : 50;
  const pos15 = m15.position != null ? m15.position : 50;
  // TREND: only enter on pullback zone inside the trend (not at extremes)
  // LONG pullback = mid/lower half of BB; SHORT pullback = mid/upper half
  if (path === "TREND") {
    if (action === "LONG" && pos5 >= 88) return null;   // only block extreme chase
    if (action === "SHORT" && pos5 <= 12) return null;
    if (action === "LONG" && pos15 >= 92) return null;
    if (action === "SHORT" && pos15 <= 8) return null;
  }
  // Extreme chase hard block (any path)
  if (action === "LONG" && (pos5 >= 90 || (pos5 >= 85 && (m5.rsi ?? 50) > 68))) return null;
  if (action === "SHORT" && (pos5 <= 10 || (pos5 <= 15 && (m5.rsi ?? 50) < 32))) return null;
  let chasePen = 0;
  if (action === "LONG" && pos5 >= 65) chasePen -= 6;
  if (action === "SHORT" && pos5 <= 35) chasePen -= 6;
  if (path === "MEAN_REV") {
    if (action === "LONG" && pos5 > 42) return null;
    if (action === "SHORT" && pos5 < 58) return null;
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
  if (action === "LONG" && m5.bias === "bearish" && m5.biasScore < -50) return null;
  if (action === "SHORT" && m5.bias === "bullish" && m5.biasScore > 50) return null;
  if (action === "LONG" && m5.volume.pressure < -35) return null;
  if (action === "SHORT" && m5.volume.pressure > 35) return null;
  if (path === "TREND" && adxMax < 14 && !m5.volume.spike) return null;
  if (path === "SQUEEZE" && adxMax > 38) return null;

  // BTC soft bias — ringan saja (konteks pasar, bukan hard force)
  let btcAdj = 0;
  if (btcBias && Math.abs(btcBias.score) >= 35) {
    if (btcBias.bias === "bullish") btcAdj = action === "LONG" ? 2 : -2;
    if (btcBias.bias === "bearish") btcAdj = action === "SHORT" ? 2 : -2;
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
  if (book) {
    if (action === "LONG" && book.imbalance >= 12) conf += 6;
    else if (action === "LONG" && book.imbalance >= 5) conf += 3;
    else if (action === "LONG" && book.imbalance < -5) conf -= 5;
    if (action === "SHORT" && book.imbalance <= -12) conf += 6;
    else if (action === "SHORT" && book.imbalance <= -5) conf += 3;
    else if (action === "SHORT" && book.imbalance > 5) conf -= 5;
    if (book.spread != null && book.spread > 0.08) conf -= 4;
  }
  conf += chasePen;

  // Orderbook Quality Score (enhanced)
  const obq = orderbookQuality(book);
  if (obq.quality === "poor") conf -= 9;
  else if (obq.quality === "good") conf += 4;
  else if (obq.quality === "excellent") conf += 7;

  // === HARD LIQUIDITY FILTER (Clodds-inspired) ===
  // Skip thin / wide-spread books entirely — protects small capital from slippage
  if (obq.quality === "poor") return null;
  if (obq.spread != null && obq.spread > 0.12) return null;

  // === VOLUME SPIKE / MOMENTUM CONFIRMATION ===
  const vol = m5.volume || {};
  const hasSpike = !!vol.spike;
  const press = vol.pressure || 0;
  let volConfirm = false;
  if (action === "LONG" && hasSpike && press >= 8) volConfirm = true;
  if (action === "SHORT" && hasSpike && press <= -8) volConfirm = true;
  if (action === "LONG" && press >= 18) volConfirm = true;
  if (action === "SHORT" && press <= -18) volConfirm = true;

  if (volConfirm) conf += 5;
  // Mild penalty only on TREND path without volume support (don't kill MEAN_REV)
  if (path === "TREND" && !volConfirm && !hasSpike) conf -= 4;

  // === SUPERTREND soft confirm (tolak ukur tambahan) ===
  // 15M + 1H ST searah signal → boost; lawan di 15M → penalty ringan
  const st15 = m15.stDir || 0;
  const st1 = h1.stDir || 0;
  if (action === "LONG") {
    if (st15 === 1) conf += 4;
    if (st1 === 1) conf += 3;
    if (st15 === -1) conf -= 5;
  } else if (action === "SHORT") {
    if (st15 === -1) conf += 4;
    if (st1 === -1) conf += 3;
    if (st15 === 1) conf -= 5;
  }

  // Volatility Regime soft adjustment
  if (regime) {
    if (regime.regime === "high") conf = Math.round(conf * 0.92);
    if (regime.regime === "low") conf = Math.round(conf * 1.04);
  }

  conf = clamp(Math.round(conf), 0, 99);

  // Dynamic threshold: stricter in high volatility
  let minConf = MIN_PROB_VALID;
  if (regime && regime.regime === "high") minConf = 80;
  if (conf < minConf) return null;

  return {
    action,
    probability: conf,
    setup: path,
    council: typeof council !== "undefined" ? council.net : null,
    h1,
    m15,
    m5,
    h4,
    adx: adxMax,
    trends: { h1: t1, m15: t15, h4: t4 },
    book: obq,
    regime: regime || null,
    volConfirm,
  };
}

function buildLevels(candles, signal, mark, regime = null) {
  const atrV = atr(candles) || mark * 0.005;
  const recent = candles.slice(-28);
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2] || last;
  const m5 = signal.m5;
  const tick = Math.max(mark * 0.0001, 1e-12);
  const prior = candles.slice(-28, -1);
  const priorLow = Math.min(...prior.map((c) => c.low));
  const priorHigh = Math.max(...prior.map((c) => c.high));
  const swingLow = Math.min(...recent.map((c) => c.low));
  const swingHigh = Math.max(...recent.map((c) => c.high));

  // Adaptive by regime
  let slBuf = 0.35;
  let slMinMult = 0.7, slMaxMult = 2.2, slDefault = 0.95;
  let mktSlMin = 1.0, mktSlMax = 2.6, mktSlDef = 1.15; // market-entry SL width
  let tp1R = 1.5, tp2R = 2.5, tp3R = 4.0;
  const reg = regime && regime.regime ? regime.regime : "normal";
  if (reg === "low") {
    slBuf = 0.28; slMinMult = 0.6; slMaxMult = 1.9; slDefault = 0.85;
    mktSlMin = 0.85; mktSlMax = 2.2; mktSlDef = 1.0;
    tp1R = 1.4; tp2R = 2.3; tp3R = 3.6;
  } else if (reg === "high") {
    slBuf = 0.45; slMinMult = 0.9; slMaxMult = 2.6; slDefault = 1.15;
    mktSlMin = 1.2; mktSlMax = 3.1; mktSlDef = 1.35;
    tp1R = 1.6; tp2R = 2.7; tp3R = 4.2;
  } else if (reg === "extreme") {
    slBuf = 0.55; slMinMult = 1.1; slMaxMult = 3.0; slDefault = 1.3;
    mktSlMin = 1.4; mktSlMax = 3.4; mktSlDef = 1.5;
    tp1R = 1.7; tp2R = 2.8; tp3R = 4.0;
  }

  // Hybrid thresholds (in ATR units from structural zone)
  const NEAR_ATR = 0.85;   // within this → pure zone entry
  const FAR_ATR = 2.8;     // beyond this → WAIT (too late)
  // between NEAR and FAR → market entry + SL beyond structure

  let entry, sl, tp1, tp2, tp3, mode;

  if (signal.action === "LONG") {
    const wickLow = Math.min(last.low, prev.low);
    const swept =
      wickLow <= priorLow * 1.001 &&
      last.close > wickLow + atrV * 0.15 &&
      last.close >= (last.open + last.close) / 2 &&
      last.close > ((last.low + last.high) / 2) * 0.98;

    const reclaim =
      (m5.position ?? 50) <= 45 &&
      last.close > last.open &&
      last.low <= (m5.lower != null ? m5.lower * 1.015 : priorLow * 1.012);

    const pullback =
      (m5.position ?? 50) <= 78 &&
      (m5.position ?? 50) >= 12 &&
      last.close >= Math.min(last.open, prev.close) * 0.994;

    let zone;
    if (swept) {
      mode = "SWEEP";
      zone = wickLow;
    } else if (reclaim) {
      mode = "RECLAIM";
      zone = Math.min(last.low, m5.lower != null ? m5.lower : last.low);
    } else if (pullback) {
      mode = "PULLBACK";
      zone = Math.min(swingLow, priorLow);
    } else {
      return { entry: mark, sl: mark, tp1: mark, tp2: mark, tp3: mark, rr: 0, mode: "WAIT", mark };
    }

    const dist = (mark - zone) / atrV; // positive = price above zone

    // Zona sudah rusak (harga di bawah struktur + buffer)
    if (mark < zone - atrV * slBuf) {
      return { entry: mark, sl: mark, tp1: mark, tp2: mark, tp3: mark, rr: 0, mode: "WAIT", mark };
    }
    // Terlalu jauh di atas zona → terlambat
    if (dist > FAR_ATR) {
      return { entry: mark, sl: mark, tp1: mark, tp2: mark, tp3: mark, rr: 0, mode: "WAIT", mark };
    }

    if (dist <= NEAR_ATR) {
      // ZONE entry
      entry = zone;
      sl = entry - atrV * slBuf - tick;
      if (entry - sl < atrV * slMinMult) sl = entry - atrV * slMinMult;
      if (entry - sl > atrV * slMaxMult) sl = entry - atrV * slMaxMult;
      if (!(sl < entry)) sl = entry - atrV * slDefault;
      mode = mode + "_ZONE";
    } else {
      // MARKET entry (hybrid mid-range)
      entry = mark;
      sl = zone - atrV * slBuf - tick; // SL tetap di luar struktur
      if (entry - sl < atrV * mktSlMin) sl = entry - atrV * mktSlMin;
      if (entry - sl > atrV * mktSlMax) sl = entry - atrV * mktSlMax;
      if (!(sl < entry)) sl = entry - atrV * mktSlDef;
      mode = mode + "_MKT";
    }

    const risk = entry - sl;
    tp1 = entry + risk * tp1R;
    tp2 = entry + risk * tp2R;
    tp3 = entry + risk * tp3R;
    if (m5.middle != null && m5.middle > tp1) tp1 = m5.middle;
    if (m5.upper != null && m5.upper > tp2) tp2 = Math.max(tp2, m5.upper);
    if (tp1 <= entry) tp1 = entry + risk * tp1R;
    if (tp2 <= tp1) tp2 = tp1 + risk * 0.6;
    if (tp3 <= tp2) tp3 = tp2 + risk * 1.2;
  } else {
    const wickHigh = Math.max(last.high, prev.high);
    const swept =
      wickHigh >= priorHigh * 0.999 &&
      last.close < wickHigh - atrV * 0.15 &&
      last.close <= (last.open + last.close) / 2 &&
      last.close < ((last.low + last.high) / 2) * 1.02;

    const reclaim =
      (m5.position ?? 50) >= 55 &&
      last.close < last.open &&
      last.high >= (m5.upper != null ? m5.upper * 0.985 : priorHigh * 0.988);

    const pullback =
      (m5.position ?? 50) >= 22 &&
      (m5.position ?? 50) <= 88 &&
      last.close <= Math.max(last.open, prev.close) * 1.006;

    let zone;
    if (swept) {
      mode = "SWEEP";
      zone = wickHigh;
    } else if (reclaim) {
      mode = "RECLAIM";
      zone = Math.max(last.high, m5.upper != null ? m5.upper : last.high);
    } else if (pullback) {
      mode = "PULLBACK";
      zone = Math.max(swingHigh, priorHigh);
    } else {
      return { entry: mark, sl: mark, tp1: mark, tp2: mark, tp3: mark, rr: 0, mode: "WAIT", mark };
    }

    const dist = (zone - mark) / atrV; // positive = price below zone (good for short zone)

    if (mark > zone + atrV * slBuf) {
      return { entry: mark, sl: mark, tp1: mark, tp2: mark, tp3: mark, rr: 0, mode: "WAIT", mark };
    }
    if (dist > FAR_ATR) {
      return { entry: mark, sl: mark, tp1: mark, tp2: mark, tp3: mark, rr: 0, mode: "WAIT", mark };
    }

    if (dist <= NEAR_ATR) {
      entry = zone;
      sl = entry + atrV * slBuf + tick;
      if (sl - entry < atrV * slMinMult) sl = entry + atrV * slMinMult;
      if (sl - entry > atrV * slMaxMult) sl = entry + atrV * slMaxMult;
      if (!(sl > entry)) sl = entry + atrV * slDefault;
      mode = mode + "_ZONE";
    } else {
      entry = mark;
      sl = zone + atrV * slBuf + tick;
      if (sl - entry < atrV * mktSlMin) sl = entry + atrV * mktSlMin;
      if (sl - entry > atrV * mktSlMax) sl = entry + atrV * mktSlMax;
      if (!(sl > entry)) sl = entry + atrV * mktSlDef;
      mode = mode + "_MKT";
    }

    const risk = sl - entry;
    tp1 = entry - risk * tp1R;
    tp2 = entry - risk * tp2R;
    tp3 = entry - risk * tp3R;
    if (m5.middle != null && m5.middle < tp1) tp1 = m5.middle;
    if (m5.lower != null && m5.lower < tp2) tp2 = Math.min(tp2, m5.lower);
    if (tp1 >= entry) tp1 = entry - risk * tp1R;
    if (tp2 >= tp1) tp2 = tp1 - risk * 0.6;
    if (tp3 >= tp2) tp3 = tp2 - risk * 1.2;
  }

  const risk = Math.abs(entry - sl);
  if (signal.action === "LONG" && !(sl < entry && entry < tp1 && tp1 <= tp2 && tp2 <= tp3)) {
    return { entry, sl, tp1, tp2, tp3, rr: 0, mode, mark };
  }
  if (signal.action === "SHORT" && !(sl > entry && entry > tp1 && tp1 >= tp2 && tp2 >= tp3)) {
    return { entry, sl, tp1, tp2, tp3, rr: 0, mode, mark };
  }
  const rrCore = risk > 0 ? Math.abs(tp2 - entry) / risk : 0;
  return { entry, sl, tp1, tp2, tp3, rr: rrCore, mode, mark };
}

function formatTelegramMessage(s) {
  const isSniper = s.probability >= MIN_PROB_SNIPER;
  const tag = isSniper ? "🎯 SNIPER" : "✅ VALID";
  const arrow = s.action === "LONG" ? "🟢 LONG" : "🔴 SHORT";
  const persist = s.persistent ? " · 🔁 Persistent" : "";
  const volOk = s.volConfirm ? " · 📈 VolOK" : "";
  const regimeTxt = s.regime
    ? ` · Vol ${s.regime.regime.toUpperCase()} (${s.regime.atrPct}%)`
    : "";
  const riskTxt = s.riskPct ? `\n⚠️ Risk saran: <b>${s.riskPct}%</b> equity` : "";
  const bookTxt = s.book
    ? ` · Book ${s.book.side} (${s.book.imbalance})${s.book.quality ? " · " + s.book.quality : ""}`
    : "";

  return (
    `${tag} · <b>${s.base}</b> ${arrow}${persist}${volOk}\n\n` +
    `📊 Probability: <b>${s.probability}%</b>${regimeTxt}\n` +
    `🧩 Setup: <b>${s.setup}</b>\n` +
    `🎯 Entry: <code>${formatPrice(s.entry)}</code>${s.mode ? " · " + s.mode : ""}\n` +
    `🛑 SL: <code>${formatPrice(s.sl)}</code>\n` +
    `🎯 TP1: <code>${formatPrice(s.tp1)}</code>\n` +
    `🎯 TP2: <code>${formatPrice(s.tp2)}</code>\n` +
    `🚀 TP3: <code>${formatPrice(s.tp3)}</code>\n` +
    `📈 R:R 1:${s.rr.toFixed(1)}${riskTxt}\n\n` +
    `1H ${s.trends ? s.trends.h1 : s.h1?.bias || "—"} · 15M ${s.trends ? s.trends.m15 : s.m15?.bias || "—"} · 4H ${s.trends ? s.trends.h4 : "—"}\n` +
    `Vol ${s.m5?.volume?.side || "—"}${bookTxt} · RSI ${Number(s.m5?.rsi || 0).toFixed(0)}\n\n` +
    `<i>Strict Core v2.9 · Regime + Adaptive SL/TP · Risk max 0.75% · NFA</i>`
  );
}
function formatSquareCoinBlock(s) {
  const isSniper = s.probability >= MIN_PROB_SNIPER;
  const tag = isSniper ? "🎯 SNIPER" : "✅ VALID";
  const arrow = s.action === "LONG" ? "🟢 LONG" : "🔴 SHORT";
  const mode = s.mode ? ` · ${s.mode}` : "";
  const persist = s.persistent ? " · 🔁" : "";
  const book =
    s.book && s.book.side && s.book.side !== "FLAT"
      ? `\nBook ${s.book.side} (${s.book.imbalance})${s.book.quality ? " · " + s.book.quality : ""}`
      : "";
  const regime = s.regime ? `\nVol regime: ${s.regime.regime} (${s.regime.atrPct}%)` : "";
  const risk = s.riskPct ? ` · Risk ${s.riskPct}%` : "";
  const tf = s.trends
    ? `1H ${s.trends.h1} · 15M ${s.trends.m15} · 4H ${s.trends.h4}`
    : `1H ${s.h1?.bias || "—"} · 15M ${s.m15?.bias || "—"}`;
  const rsi = s.m5?.rsi != null ? Number(s.m5.rsi).toFixed(0) : "—";
  const vol = s.m5?.volume?.side || "—";
  return (
    `${tag} · ${s.base} ${arrow}${persist}\n` +
    `\n` +
    `📊 Probability: ${s.probability}%\n` +
    `🧩 Setup: ${s.setup}\n` +
    `🎯 Entry: ${formatPrice(s.entry)}${mode}\n` +
    `🛑 SL: ${formatPrice(s.sl)}\n` +
    `🎯 TP1: ${formatPrice(s.tp1)}\n` +
    `🎯 TP2: ${formatPrice(s.tp2)}\n` +
    `🚀 TP3: ${formatPrice(s.tp3 || s.tp2)}\n` +
    `📈 R:R 1:${s.rr.toFixed(1)}${risk}\n` +
    `\n` +
    `${tf}\n` +
    `Vol ${vol} · RSI ${rsi}` +
    book +
    regime
  );
}

function formatSquareBatchMessage(coins) {
  const footers = [
    "Risk kecil saja. Jangan FOMO — invalid levelnya jelas di atas.",
    "Selalu pakai SL. Ini edukasi chart, bukan saran keuangan.",
    "Kelola risiko sendiri ya. Pasar bisa berubah kapan saja.",
    "Kalau belum yakin, skip saja. Masih banyak setup lain nanti.",
    "Catatan pribadi untuk referensi. NFA.",
  ];
  const fo = footers[Math.floor(Date.now() / 900000) % footers.length];

  // Header: Hasil scanner (hari, tanggal, bulan, tahun, jam) + tagar
  const hari = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
  const bulan = [
    "Januari", "Februari", "Maret", "April", "Mei", "Juni",
    "Juli", "Agustus", "September", "Oktober", "November", "Desember",
  ];
  const now = new Date();
  // WIB = UTC+7
  const wib = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const h = String(wib.getUTCHours()).padStart(2, "0");
  const m = String(wib.getUTCMinutes()).padStart(2, "0");
  const hi =
    `Hasil scanner (${hari[wib.getUTCDay()]}, ${wib.getUTCDate()} ${bulan[wib.getUTCMonth()]} ${wib.getUTCFullYear()}, ${h}:${m})`;

  const lines = [hi, ""];
  coins.forEach((s, i) => {
    if (i > 0) lines.push("", "────────────", "");
    lines.push(formatSquareCoinBlock(s));
  });
  lines.push("");
  lines.push("Strict Core v2.9 · Regime + Adaptive SL/TP · Risk max 0.75% · NFA");
  lines.push("");
  lines.push(fo);
  lines.push("");
  lines.push("#CPIWatch");
  return lines.join("\n").trim();
}

function buildSquareCardSvg(coins) {
  // Portrait mobile 720×1520 — readable on phone without zoom
  const W = 720;
  const rows = coins.slice(0, 3);
  const pad = 28;
  const headerH = 130;
  const footerH = 64;
  const gap = 18;
  // Auto height so 3 cards never crush text (TP1-3 + meta)
  const minRow = 340;
  const H = Math.max(1520, headerH + footerH + gap * (rows.length + 1) + minRow * Math.max(rows.length, 1));
  const usable = H - headerH - footerH - gap * (rows.length + 1);
  const rowH = Math.max(340, Math.floor(usable / Math.max(rows.length, 1)));

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
    <text x="${pad + 28}" y="${y + 114}" font-family="Arial, Helvetica, sans-serif" font-size="20" fill="#1e293b">Entry   ${esc(formatPrice(s.entry))}</text>
    <text x="${pad + 28}" y="${y + 146}" font-family="Arial, Helvetica, sans-serif" font-size="20" fill="#1e293b">SL        ${esc(formatPrice(s.sl))}</text>
    <text x="${pad + 28}" y="${y + 178}" font-family="Arial, Helvetica, sans-serif" font-size="20" fill="#1e293b">TP1     ${esc(formatPrice(s.tp1))}</text>
    <text x="${pad + 28}" y="${y + 210}" font-family="Arial, Helvetica, sans-serif" font-size="20" fill="#1e293b">TP2     ${esc(formatPrice(s.tp2))}</text>
    <text x="${pad + 28}" y="${y + 242}" font-family="Arial, Helvetica, sans-serif" font-size="20" fill="#0f766e">TP3     ${esc(formatPrice(s.tp3 || s.tp2))}  ·  runner</text>
    <text x="${pad + 28}" y="${y + 280}" font-family="Arial, Helvetica, sans-serif" font-size="17" fill="#475569">${esc(s.setup)}  ·  R:R 1:${s.rr.toFixed(1)}  ·  Vol ${esc(s.m5.volume.side)}${s.book ? " · Book " + esc(s.book.side) : ""}</text>
    <text x="${pad + 28}" y="${y + 312}" font-family="Arial, Helvetica, sans-serif" font-size="16" fill="#64748b">${trendLine}</text>`;
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
  <text x="${pad}" y="48" font-family="Arial, Helvetica, sans-serif" font-size="32" font-weight="700" fill="#ffffff">STRICT CORE v2.9</text>
  <text x="${pad}" y="84" font-family="Arial, Helvetica, sans-serif" font-size="16" fill="#94a3b8">Regime · OB Quality · 1H+15M lock</text>
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
    const persistTag = (s.persistent ? " · 🔁" : "") + (s.volConfirm ? " · 📈" : "");
    const embed = {
      title: `${isSniper ? "🎯 SNIPER" : "✅ VALID"} · ${s.base} ${s.action}${persistTag}`,
      color,
      fields: [
        { name: "Probability", value: `**${s.probability}%**`, inline: true },
        { name: "Setup", value: s.setup, inline: true },
        { name: "R:R", value: `1:${s.rr.toFixed(1)}`, inline: true },
        { name: "Entry", value: `$${formatPrice(s.entry)}`, inline: true },
        { name: "SL", value: `$${formatPrice(s.sl)}`, inline: true },
        { name: "Risk Saran", value: s.riskPct ? `**${s.riskPct}%**` : "—", inline: true },
        { name: "TP1 / TP2 / TP3", value: `$${formatPrice(s.tp1)} / $${formatPrice(s.tp2)} / $${formatPrice(s.tp3 || s.tp2)}`, inline: false },
        { name: "Regime", value: s.regime ? `${s.regime.regime} (${s.regime.atrPct}%)` : "—", inline: true },
        { name: "Book", value: s.book ? `${s.book.side} (${s.book.imbalance}) · ${s.book.quality || "—"}` : "—", inline: true },
        { name: "1H / 15M / 5M", value: `${s.trends?.h1 || s.h1?.bias || "—"} / ${s.trends?.m15 || s.m15?.bias || "—"} / ${s.m5?.volume?.side || "—"}`, inline: true },
      ],
      footer: { text: "Strict Core v2.9 · Regime + Adaptive SL/TP · NFA" },
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

async function fetchOrderBook(instId, sz = 20) {
  try {
    const data = await getJson(
      `${OKX}/api/v5/market/books?instId=${encodeURIComponent(instId)}&sz=${sz}`
    );
    const row = (data && data.data && data.data[0]) || null;
    if (!row) return null;
    const bids = (row.bids || []).map((x) => ({ price: +x[0], size: +x[1] }));
    const asks = (row.asks || []).map((x) => ({ price: +x[0], size: +x[1] }));
    return { bids, asks, ts: row.ts };
  } catch {
    return null;
  }
}

function analyzeOrderBook(book) {
  if (!book || !book.bids || !book.bids.length || !book.asks || !book.asks.length) {
    return { imbalance: 0, side: "FLAT", bidVol: 0, askVol: 0, spread: 0, mid: null };
  }
  const depthBid = book.bids.slice(0, 15);
  const depthAsk = book.asks.slice(0, 15);
  let bidVol = 0, askVol = 0;
  depthBid.forEach((b, i) => {
    const w = 1 - i * 0.04;
    bidVol += b.size * Math.max(w, 0.4);
  });
  depthAsk.forEach((a, i) => {
    const w = 1 - i * 0.04;
    askVol += a.size * Math.max(w, 0.4);
  });
  const total = bidVol + askVol || 1;
  const imbalance = ((bidVol - askVol) / total) * 100;
  const bestBid = book.bids[0].price;
  const bestAsk = book.asks[0].price;
  const mid = (bestBid + bestAsk) / 2;
  const spread = mid ? ((bestAsk - bestBid) / mid) * 100 : 0;
  let side = "FLAT";
  if (imbalance >= 12) side = "BID";
  else if (imbalance <= -12) side = "ASK";
  return {
    imbalance: +imbalance.toFixed(2),
    side,
    bidVol,
    askVol,
    spread: +spread.toFixed(4),
    mid,
    bestBid,
    bestAsk,
  };
}

// ========== CLODDS-INSPIRED MODULES (v2.8) ==========

/**
 * Volatility Regime Detection
 * low / normal / high / extreme — critical for small capital
 */
function getVolatilityRegime(candles, atrPeriod = 14) {
  if (!candles || candles.length < atrPeriod + 5) {
    return { regime: "normal", mult: 1.0, atrPct: 0 };
  }
  const atrV = atr(candles, atrPeriod);
  if (!atrV) return { regime: "normal", mult: 1.0, atrPct: 0 };

  const closes = candles.map((c) => c.close);
  const avgPrice = mean(closes.slice(-20)) || candles[candles.length - 1].close;
  const atrPct = (atrV / avgPrice) * 100;

  if (atrPct < 0.75) return { regime: "low", mult: 1.15, atrPct: +atrPct.toFixed(2) };
  if (atrPct < 1.55) return { regime: "normal", mult: 1.0, atrPct: +atrPct.toFixed(2) };
  if (atrPct < 2.7) return { regime: "high", mult: 0.72, atrPct: +atrPct.toFixed(2) };
  return { regime: "extreme", mult: 0.35, atrPct: +atrPct.toFixed(2) };
}

/**
 * Enhanced Orderbook Quality Score
 * Combines imbalance + spread + depth dominance
 */
function orderbookQuality(book) {
  if (!book || book.side === undefined) {
    return { score: 50, quality: "unknown", ...(book || {}) };
  }

  let score = 50;
  const absImb = Math.abs(book.imbalance || 0);

  if (absImb >= 18) score += 18;
  else if (absImb >= 12) score += 12;
  else if (absImb >= 7) score += 6;
  else if (absImb < 3) score -= 4;

  if (book.spread != null) {
    if (book.spread < 0.025) score += 12;
    else if (book.spread < 0.045) score += 6;
    else if (book.spread > 0.09) score -= 14;
    else if (book.spread > 0.065) score -= 7;
  }

  const totalVol = (book.bidVol || 0) + (book.askVol || 0);
  if (totalVol > 0) {
    const depthRatio = Math.max(book.bidVol || 0, book.askVol || 0) / totalVol;
    if (depthRatio > 0.68) score += 6;
  }

  score = clamp(Math.round(score), 0, 100);

  let quality = "medium";
  if (score >= 78) quality = "excellent";
  else if (score >= 65) quality = "good";
  else if (score < 42) quality = "poor";

  return { ...book, score, quality };
}

/**
 * Adaptive risk suggestion for small capital (0.25% – 0.85%)
 */
function suggestRisk(regime, probability) {
  let base = 0.55;
  if (regime && regime.regime === "low") base = 0.7;
  else if (regime && regime.regime === "high") base = 0.4;
  else if (regime && regime.regime === "extreme") base = 0.25;

  if (probability >= 85) base += 0.1;
  else if (probability >= 82) base += 0.05;

  return +Math.min(base, 0.85).toFixed(2);
}

const STATE_FILE = path.join(process.cwd(), "last-signals.json");

function loadLastSignals() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    }
  } catch {}
  return {};
}

function saveLastSignals(map) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(map, null, 2));
  } catch (e) {
    console.warn("Could not save state:", e.message);
  }
}

function isPersistent(base, action, lastMap, maxAgeMin = 75) {
  const key = `${base}_${action}`;
  const prev = lastMap[key];
  if (!prev) return false;
  const ageMin = (Date.now() - prev.ts) / 60000;
  return ageMin <= maxAgeMin;
}

// ========== END CLODDS MODULES ==========

async function main() {
  console.log("=== Strict Core v2.9.3 | Supertrend + Soft BTC + Hybrid Entry ===");
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
      const [h1c, m15c, m5c, h4c, funding, rawBook] = await Promise.all([
        fetchOkxCandles(c.instId, "1H", 100),
        fetchOkxCandles(c.instId, "15m", 100),
        fetchOkxCandles(c.instId, "5m", 100),
        fetchOkxCandles(c.instId, "4H", 100),
        fetchFunding(c.instId),
        fetchOrderBook(c.instId, 20),
      ]);
      const h1 = analyzeTF(h1c, "1H");
      const m15 = analyzeTF(m15c, "15M");
      const m5 = analyzeTF(m5c, "5M");
      const h4 = analyzeTF(h4c, "4H");
      const book = analyzeOrderBook(rawBook);

      // Volatility regime from 15m (most relevant for 15m-1h scalping)
      const regime = getVolatilityRegime(m15c);

      const scored = scoreSignal(h1, m15, m5, h4, funding, btcBias, book, regime);
      if (!scored || scored.probability < MIN_PROB_VALID) continue;

      const levels = buildLevels(m5c, scored, c.mark, regime);
      if (levels.rr < MIN_RR) continue;

      let riskPct = suggestRisk(regime, scored.probability);

      signals.push({
        base: c.base,
        action: scored.action,
        probability: scored.probability,
        setup: scored.setup,
        entry: levels.entry,
        mode: levels.mode || null,
        sl: levels.sl,
        tp1: levels.tp1,
        tp2: levels.tp2,
        tp3: levels.tp3,
        rr: levels.rr,
        h1: scored.h1,
        m15: scored.m15,
        m5: scored.m5,
        h4: scored.h4,
        trends: scored.trends,
        book: scored.book,
        regime: scored.regime,
        riskPct,
        volConfirm: !!scored.volConfirm,
        persistent: false,
      });
      await new Promise((r) => setTimeout(r, 150));
    } catch (e) {
      console.warn(`Skip ${c.base}:`, e.message);
    }
  }

  // === Persistence filter ===
  const lastMap = loadLastSignals();
  const newMap = { ...lastMap };
  for (const s of signals) {
    const key = `${s.base}_${s.action}`;
    if (isPersistent(s.base, s.action, lastMap)) {
      s.probability = Math.min(99, s.probability + 3);
      s.persistent = true;
    }
    newMap[key] = { ts: Date.now(), prob: s.probability };
  }

  // === Soft Overtrade Guard (Clodds risk spirit) ===
  // If too many fresh (non-persistent) signals this run, slightly cut risk suggestion
  // Protects small capital from spraying many low-conviction ideas at once
  const freshCount = signals.filter((s) => !s.persistent).length;
  if (freshCount >= 6) {
    for (const s of signals) {
      if (!s.persistent && s.riskPct) {
        s.riskPct = +Math.max(0.25, s.riskPct * 0.75).toFixed(2);
      }
    }
  } else if (freshCount >= 4) {
    for (const s of signals) {
      if (!s.persistent && s.riskPct) {
        s.riskPct = +Math.max(0.25, s.riskPct * 0.9).toFixed(2);
      }
    }
  }

  saveLastSignals(newMap);

  signals.sort((a, b) => b.probability - a.probability);
  console.log(`Strict signals: ${signals.length}`);
  signals.forEach((s) =>
    console.log(
      `  ${s.base} ${s.action} ${s.probability}% ${s.setup} R:R 1:${s.rr.toFixed(1)}` +
        (s.regime ? ` [${s.regime.regime}]` : "") +
        (s.persistent ? " 🔁" : "")
    )
  );

  await sendDiscord(signals);
  await sendTelegram(signals);
  await sendBinanceSquare(signals);
  console.log("Done.");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
