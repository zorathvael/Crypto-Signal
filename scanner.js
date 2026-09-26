
/**
 * Strict Core Scanner v3.12.3 — MTF scalp + LOC + Positioning Layer
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
 * + Outcome Tracker (signals-log.json — TP/SL live)
 * + Block A: Score (bukan claim Prob%), EV filter, OB fail=NO-TRADE, outcome window
 * + Optimized Discord / Telegram / Binance Square messages
 * + Positioning Layer (v3.11): Funding, Open Interest, Long/Short crowding
 * Note: market data from Bitget USDT-M futures
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const positioning = require("./positioning");
const { runTraderSpyScan } = require("./traderspy");

const BITGET = "https://api.bitget.com";
const BG_PRODUCT = "USDT-FUTURES";
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BINANCE_SQUARE_KEY = process.env.BINANCE_SQUARE_OPENAPI_KEY;
const MIN_PROB_VALID = 76;
const MIN_PROB_SNIPER = 82;
const MIN_RR = 1.5;
const CANDIDATE_LIMIT = 60; // v3.12.3 speed: top liquidity only
const SQUARE_POST_COUNT = 3;
// Block A — execution cost (taker-ish round trip estimate Bitget USDT-M)
const FEE_RATE_RT = 0.001;      // 0.10% round-turn notional ≈ 0.05%*2
const SLIPPAGE_RT = 0.0004;     // 0.04% round-turn conservative
const EV_MIN_R = 0.05;          // minimum expected R after costs
// Stats only count closed trades after this (Block A baseline) — ISO ms
const OUTCOME_STATS_AFTER_TS = Date.parse("2026-09-18T00:00:00Z") || 0; // v3.0 scalp 15M era

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function formatPrice(v) {
  if (!Number.isFinite(v)) return "—";
  if (v < 0.000001) return v.toFixed(10);
  if (v < 0.001) return v.toFixed(8);
  if (v < 1) return v.toFixed(5);
  return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

async function getJson(url, retries = 3) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "StrictCore/2.13.0" },
      });
      if (res.status === 429) {
        const wait = 450 * (attempt + 1) + Math.floor(Math.random() * 150);
        await new Promise((r) => setTimeout(r, wait));
        lastErr = new Error("API 429");
        continue;
      }
      if (!res.ok) throw new Error(`API ${res.status}`);
      const body = await res.json();
      // Bitget envelope: { code: "00000", data: ... }
      if (body && body.code != null && String(body.code) !== "00000") {
        throw new Error(`API ${body.code} ${body.msg || ""}`.trim());
      }
      return body;
    } catch (e) {
      lastErr = e;
      if (attempt < retries && /429|fetch|network/i.test(String(e.message || e))) {
        await new Promise((r) => setTimeout(r, 320 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error("API 429");
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
  if (candles.length < 30) return { trend: "chop", hh: false, hl: false, lh: false, ll: false };
  const swingsH = [];
  const swingsL = [];
  for (let i = 2; i < candles.length - 2; i++) {
    const c = candles[i];
    if (
      c.high >= candles[i - 1].high && c.high >= candles[i - 2].high &&
      c.high >= candles[i + 1].high && c.high >= candles[i + 2].high
    ) swingsH.push(c.high);
    if (
      c.low <= candles[i - 1].low && c.low <= candles[i - 2].low &&
      c.low <= candles[i + 1].low && c.low <= candles[i + 2].low
    ) swingsL.push(c.low);
  }
  const h1s = swingsH.length >= 2 ? swingsH[swingsH.length - 2] : null;
  const h2s = swingsH.length >= 1 ? swingsH[swingsH.length - 1] : null;
  const l1s = swingsL.length >= 2 ? swingsL[swingsL.length - 2] : null;
  const l2s = swingsL.length >= 1 ? swingsL[swingsL.length - 1] : null;
  const hh = h1s != null && h2s != null && h2s > h1s;
  const lh = h1s != null && h2s != null && h2s < h1s;
  const hl = l1s != null && l2s != null && l2s > l1s;
  const ll = l1s != null && l2s != null && l2s < l1s;
  let trend = "chop";
  if (hh && hl) trend = "up";
  else if (lh && ll) trend = "down";
  else if (hh && !ll) trend = "up";
  else if (ll && !hh) trend = "down";
  else {
    const leg = candles.slice(-20);
    const mid = Math.floor(leg.length / 2);
    const first = leg.slice(0, mid);
    const second = leg.slice(mid);
    const hi1 = Math.max(...first.map((c) => c.high));
    const hi2 = Math.max(...second.map((c) => c.high));
    const lo1 = Math.min(...first.map((c) => c.low));
    const lo2 = Math.min(...second.map((c) => c.low));
    if (hi2 > hi1 && lo2 > lo1) trend = "up";
    if (lo2 < lo1 && hi2 < hi1) trend = "down";
  }
  return { trend, hh: !!hh, hl: !!hl, lh: !!lh, ll: !!ll };
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
  const macdPrev2 = hist[idx - 2];
  const macdUp = macdNow != null && macdPrev != null && macdNow > macdPrev;
  const macdDown = macdNow != null && macdPrev != null && macdNow < macdPrev;
  const macdCrossUp =
    macdNow != null &&
    macdPrev != null &&
    ((macdPrev <= 0 && macdNow > 0) ||
      (macdPrev2 != null && macdNow > macdPrev && macdPrev2 <= macdPrev && macdNow > 0));
  const macdCrossDown =
    macdNow != null &&
    macdPrev != null &&
    ((macdPrev >= 0 && macdNow < 0) ||
      (macdPrev2 != null && macdNow < macdPrev && macdPrev2 >= macdPrev && macdNow < 0));
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
    emaBull, emaBear, rsi: rsiV[idx], volume: vol, reversal: rev, ms, macdUp, macdDown, macdCrossUp, macdCrossDown, macdHist: macdNow,
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


/** upstream research/Crypto-Scanner style: Location, Exhaustion, Flow, Structure
 * Early / PRE-EXPANSION layers — Discord/Telegram/Square posting unchanged.
 */
function clamp01(x) {
  if (x == null || !Number.isFinite(+x)) return 0;
  return Math.min(1, Math.max(0, +x));
}

function candleFeaturesER(candles) {
  if (!candles || candles.length < 40) return null;
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const vols = candles.map((c) => c.volume || 0);
  const last = closes[n - 1];
  const tr = [];
  for (let i = 0; i < n; i++) {
    const h = candles[i].high, l = candles[i].low;
    if (i === 0) tr.push(h - l);
    else {
      const pc = candles[i - 1].close;
      tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
  }
  const atr14 = mean(tr.slice(-14)) || last * 0.01;
  const atr5 = mean(tr.slice(-5)) || atr14;
  const atr20 = mean(tr.slice(-20)) || atr14;
  const atrPct = (atr14 / last) * 100;
  const rangeBars = Math.min(48, n);
  const rangeSlice = closes.slice(-rangeBars);
  const hi = Math.max(...rangeSlice);
  const lo = Math.min(...rangeSlice);
  const rng = hi - lo || 1e-12;
  const pos = (last - lo) / rng;
  const rsiV = rsi(closes, 14);
  const r = rsiV[n - 1] != null ? rsiV[n - 1] : 50;
  const baseVol = mean(vols.slice(-21, -1)) || 1;
  const volumeRatio = vols[n - 1] / baseVol;
  const down12 = n > 13 && closes[n - 13] ? (closes[n - 13] - last) / closes[n - 13] : 0;
  const up12 = n > 13 && closes[n - 13] ? (last - closes[n - 13]) / closes[n - 13] : 0;
  const down24 = n > 25 && closes[n - 25] ? (closes[n - 25] - last) / closes[n - 25] : 0;
  const up24 = n > 25 && closes[n - 25] ? (last - closes[n - 25]) / closes[n - 25] : 0;
  const longMove = Math.max(down12, down24);
  const shortMove = Math.max(up12, up24);
  let longExhaust = atrPct ? clamp01((longMove / ((atrPct / 100) * 8) - 0.45) / 1.2) : 0;
  let shortExhaust = atrPct ? clamp01((shortMove / ((atrPct / 100) * 8) - 0.45) / 1.2) : 0;
  longExhaust = 0.7 * longExhaust + 0.3 * clamp01((45 - r) / 20);
  shortExhaust = 0.7 * shortExhaust + 0.3 * clamp01((r - 55) / 20);
  const compression = clamp01(1 - (atr20 ? atr5 / atr20 : 1));
  const recentLow = Math.min(...closes.slice(Math.max(0, n - 7), n - 1));
  const recentHigh = Math.max(...closes.slice(Math.max(0, n - 7), n - 1));
  const longReclaim = atr14 ? clamp01((last - recentLow) / (atr14 * 1.5)) : 0;
  const shortReject = atr14 ? clamp01((recentHigh - last) / (atr14 * 1.5)) : 0;
  return {
    atrPct,
    rsi: r,
    pos,
    volumeRatio,
    compression,
    long_location: clamp01((0.38 - pos) / 0.38),
    short_location: clamp01((pos - 0.62) / 0.38),
    long_exhaust: longExhaust,
    short_exhaust: shortExhaust,
    long_reclaim: longReclaim,
    short_reject: shortReject,
  };
}

function flowScoreER(m5, book) {
  let flow = 0.5;
  const press = m5 && m5.volume ? m5.volume.pressure : 0;
  flow = clamp01(0.5 + press / 80);
  if (book && book.imbalance != null) {
    flow = clamp01(0.65 * flow + 0.35 * (0.5 + book.imbalance / 200));
  }
  return flow;
}

function earlyClassifyER(f, flow) {
  if (!f) return null;
  const sides = [
    { side: "LONG", location: f.long_location, exhaustion: f.long_exhaust, flow, structure: f.long_reclaim },
    { side: "SHORT", location: f.short_location, exhaustion: f.short_exhaust, flow: 1 - flow, structure: f.short_reject },
  ];
  const scored = sides.map((p) => {
    const score =
      30 * clamp01(p.location) +
      25 * clamp01(p.exhaustion) +
      25 * clamp01(p.flow) +
      20 * clamp01(p.structure);
    // v2.18.2: slightly closer to  production feel; still no expansion required
    const ok =
      score >= 62 &&
      p.location >= 0.60 &&
      p.exhaustion >= 0.48 &&
      p.flow >= 0.52 &&
      p.structure >= 0.12;
    return Object.assign({}, p, { score: +score.toFixed(1), ok });
  });
  const hits = scored.filter((s) => s.ok).sort((a, b) => b.score - a.score);
  if (hits.length) return { tier: "EARLY", side: hits[0].side, score: hits[0].score, parts: hits[0] };
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  return { tier: best.score >= 55 ? "MONITOR" : "NONE", side: best.side, score: best.score, parts: best };
}

function preClassifyER(f, flow) {
  if (!f) return null;
  const expansion = 0.55 * clamp01((f.volumeRatio - 1) / 2) + 0.45 * f.compression;
  const longScore =
    30 * clamp01(f.long_location) +
    20 * clamp01(f.long_exhaust) +
    20 * clamp01(flow) +
    15 * clamp01(f.long_reclaim) +
    15 * clamp01(expansion);
  const shortScore =
    30 * clamp01(f.short_location) +
    20 * clamp01(f.short_exhaust) +
    20 * clamp01(1 - flow) +
    15 * clamp01(f.short_reject) +
    15 * clamp01(expansion);
  if (longScore >= 70 && f.long_location >= 0.6 && f.long_reclaim >= 0.25 && flow >= 0.55) {
    return { tier: "PRE", side: "LONG", score: +longScore.toFixed(1), expansion };
  }
  if (shortScore >= 70 && f.short_location >= 0.6 && f.short_reject >= 0.25 && flow <= 0.45) {
    return { tier: "PRE", side: "SHORT", score: +shortScore.toFixed(1), expansion };
  }
  return {
    tier: "NONE",
    side: longScore >= shortScore ? "LONG" : "SHORT",
    score: +Math.max(longScore, shortScore).toFixed(1),
    expansion,
  };
}


/**
 * v3.0 SCALP 15M — pure multi-TF scalping
 * Setup 15M + bias 1H + trigger 5M | pullback entry | no fake 99
 */
/** Agregasi 1H → 2H (Bitget sering tanpa granularity 2H) */

function tfSideScore(tf, wantLong) {
  if (!tf) return 0.5;
  const tr = tfTrend(tf);
  if (wantLong) {
    if (tr === "bullish") return 1;
    if (tr === "neutral") return 0.55;
    return 0.15;
  }
  if (tr === "bearish") return 1;
  if (tr === "neutral") return 0.55;
  return 0.15;
}
function liquiditySweepScore(m5, wantLong) {
  if (!m5 || m5.position == null) return 0.5;
  const pos = m5.position;
  const rev = m5.reversal || { bias: "neutral", quality: 0 };
  if (wantLong) {
    let s = pos <= 30 ? 0.85 : pos <= 45 ? 0.65 : 0.35;
    if (rev.bias === "bullish" && rev.quality >= 0.7) s = Math.min(1, s + 0.2);
    return s;
  }
  let s = pos >= 70 ? 0.85 : pos >= 55 ? 0.65 : 0.35;
  if (rev.bias === "bearish" && rev.quality >= 0.7) s = Math.min(1, s + 0.2);
  return s;
}
function volumeScoreMtf(m5) {
  if (!m5 || !m5.volume) return 0.5;
  let s = 0.45;
  if (m5.volume.spike) s += 0.25;
  const pr = Math.abs(m5.volume.pressure || 0);
  if (pr >= 12) s += 0.15;
  if (pr >= 22) s += 0.1;
  return Math.min(1, Math.max(0, s));
}
function rsiMomScore(m5, wantLong) {
  const r = m5 && m5.rsi != null ? m5.rsi : 50;
  if (wantLong) {
    if (r <= 35) return 0.9;
    if (r <= 45) return 0.75;
    if (r <= 55) return 0.55;
    return 0.25;
  }
  if (r >= 65) return 0.9;
  if (r >= 55) return 0.75;
  if (r >= 45) return 0.55;
  return 0.25;
}
function mtfLocationScore(pos, wantLong) {
  if (wantLong) return Math.min(1, Math.max(0, (0.38 - pos / 100) / 0.38));
  return Math.min(1, Math.max(0, (pos / 100 - 0.62) / 0.38));
}
function mtfScalpAction(h4, h1, m30, m15, m5, book, regime) {
  if (!h4 || !h1 || !m15 || !m5) return null;
  if (regime && regime.regime === "extreme") return null;
  const pos15 = m15.position != null ? m15.position : 50;
  function confFor(wantLong) {
    const w4 = tfSideScore(h4, wantLong);
    const w1 = tfSideScore(h1, wantLong);
    const w30 = tfSideScore(m30 || m15, wantLong);
    const w15 = tfSideScore(m15, wantLong);
    const sweep = liquiditySweepScore(m5, wantLong);
    const vol = volumeScoreMtf(m5);
    const rsiS = rsiMomScore(m5, wantLong);
    let conf =
      100 *
      (0.2 * w4 + 0.2 * w1 + 0.2 * w30 + 0.15 * w15 + 0.1 * sweep + 0.1 * vol + 0.05 * rsiS);
    const loc = mtfLocationScore(pos15, wantLong);
    if (loc >= 0.6) conf += 6;
    else if (loc >= 0.4) conf += 2;
    else conf -= 8;
    if (book && !book.missing) {
      if (wantLong && book.side === "BID" && (book.imbalance || 0) >= 8) conf += 3;
      if (!wantLong && book.side === "ASK" && (book.imbalance || 0) <= -8) conf += 3;
      if (wantLong && book.side === "ASK" && (book.imbalance || 0) <= -18) conf -= 10;
      if (!wantLong && book.side === "BID" && (book.imbalance || 0) >= 18) conf -= 10;
    }
    let align = 0;
    if (w4 >= 0.9) align += 1;
    if (w1 >= 0.9) align += 1;
    if (w30 >= 0.9) align += 1;
    if (w15 >= 0.9) align += 1;
    conf = Math.min(92, Math.max(0, Math.round(conf)));
    return { side: wantLong ? "LONG" : "SHORT", conf, align, loc, w4, w1, w30, w15 };
  }
  const L = confFor(true);
  const S = confFor(false);
  const best = L.conf >= S.conf ? L : S;
  // v3.3.1: regime high butuh conf lebih tinggi (audit INJ false positive)
  const isHigh = regime && (regime.regime === "high" || regime.regime === "extreme");
  const needConf = isHigh ? 78 : 68;
  const needAlign = isHigh ? 3 : 3;
  if (best.conf >= needConf && best.align >= needAlign && best.loc >= 0.35) {
    return {
      action: best.side,
      probability: best.conf,
      setup: "SCALP_MTF",
      h1: h1,
      m15: m15,
      m5: m5,
      h4: h4,
      trends: { h4: tfTrend(h4), h1: tfTrend(h1), m30: m30 ? tfTrend(m30) : "n/a", m15: tfTrend(m15) },
      book: book,
      regime: regime || null,
      volConfirm: !!(m5.volume && m5.volume.spike),
      confluence: best.align,
      pillars: ["mtf_align", "loc", "align"],
      mtf: best,
    };
  }
  if (best.conf >= 65 && best.loc >= 0.25) {
    let why = "conf=" + best.conf + " align=" + best.align + " loc=" + best.loc.toFixed(2);
    if (isHigh && best.conf < 84) why += " | high-vol butuh conf>=84";
    if (isHigh && best.align < 3) why += " | high-vol butuh align>=3";
    return {
      watch: true,
      action: best.side,
      probability: best.conf,
      setup: "POTENSI",
      reason: why,
      mtf: best,
    };
  }
  return null;
}



/**
 * ========== upstream research Early Reversal Engine  ==========
 * Eligible = location extreme + exhaustion + trigger + (base|structure)
 * Primary VALID path when eligible; does not require HTF trend flip.
 */
function _erClose(c) { return c.close; }
function _erHigh(c) { return c.high; }
function _erLow(c) { return c.low; }

function erLocationScore(candles, direction, lookback = 32) {
  if (!candles || candles.length < Math.max(8, lookback)) return 0;
  const w = candles.slice(-lookback);
  const hi = Math.max(...w.map(_erHigh));
  const lo = Math.min(...w.map(_erLow));
  const span = hi - lo;
  if (span <= 0) return 0;
  const pos = (_erClose(candles[candles.length - 1]) - lo) / span;
  if (direction === "LONG") return pos <= 0.35 ? 1 : pos <= 0.5 ? 0.5 : 0;
  return pos >= 0.65 ? 1 : pos >= 0.5 ? 0.5 : 0;
}

function erImpulseExhaustion(candles, direction) {
  if (!candles || candles.length < 24) return 0;
  const closes = candles.map(_erClose);
  const last = closes[closes.length - 1];
  const n = closes.length;
  // move magnitude vs recent ATR-ish
  const look = Math.min(24, n - 1);
  const past = closes[n - 1 - look];
  if (!past) return 0;
  const move = direction === "LONG" ? (past - last) / past : (last - past) / past;
  const atrV = atr(candles) || last * 0.01;
  const atrPct = atrV / last;
  let score = Math.min(1, Math.max(0, (move / Math.max(atrPct * 6, 0.01) - 0.3) / 1.2));
  // RSI exhaustion soft
  const rsis = rsi(closes, 14);
  const r = rsis[rsis.length - 1];
  if (direction === "LONG" && r != null && r <= 40) score = Math.min(1, score + 0.15);
  if (direction === "SHORT" && r != null && r >= 60) score = Math.min(1, score + 0.15);
  return score;
}

function erBaseScore(candles, direction) {
  if (!candles || candles.length < 12) return 0;
  const recent = candles.slice(-8);
  const atrV = atr(candles) || recent[recent.length - 1].close * 0.01;
  const range = Math.max(...recent.map(_erHigh)) - Math.min(...recent.map(_erLow));
  // compact base after impulse
  if (range <= atrV * 1.8) return 1;
  if (range <= atrV * 2.8) return 0.5;
  return 0;
}

function erStructureShift(candles5, direction) {
  if (!candles5 || candles5.length < 8) return 0;
  const prev = candles5.slice(-7, -1);
  const last = candles5[candles5.length - 1];
  const priorHigh = Math.max(...prev.map(_erHigh));
  const priorLow = Math.min(...prev.map(_erLow));
  if (direction === "LONG") {
    if (last.close > priorHigh) return 1;
    if (last.close > prev[prev.length - 1].close && last.close > last.open) return 0.5;
    return 0;
  }
  if (last.close < priorLow) return 1;
  if (last.close < prev[prev.length - 1].close && last.close < last.open) return 0.5;
  return 0;
}

function erReversalTrigger(candles5, direction) {
  if (!candles5 || candles5.length < 8) return 0;
  const previous = candles5.slice(-7, -1);
  const last = candles5[candles5.length - 1];
  const priorHigh = Math.max(...previous.map(_erHigh));
  const priorLow = Math.min(...previous.map(_erLow));
  const o = last.open, c = last.close, h = last.high, l = last.low;
  const rng = h - l;
  if (rng <= 0) return 0;
  if (direction === "LONG") {
    const sweep = l < priorLow && c > priorLow;
    const recovery = c > o && (c - l) / rng >= 0.6 && c > previous[previous.length - 1].close;
    return sweep ? 1 : recovery ? 0.75 : 0;
  }
  const sweep = h > priorHigh && c < priorHigh;
  const recovery = c < o && (h - c) / rng >= 0.6 && c < previous[previous.length - 1].close;
  return sweep ? 1 : recovery ? 0.75 : 0;
}

function evaluateEarlyReversal(candles15, candles5, direction) {
  if (direction !== "LONG" && direction !== "SHORT") {
    return { eligible: false, score: 0, reason: "invalid direction" };
  }
  if (!candles15 || candles15.length < 40 || !candles5 || candles5.length < 20) {
    return { eligible: false, score: 0, reason: "insufficient history" };
  }
  const location = erLocationScore(candles15, direction);
  const exhaustion = erImpulseExhaustion(candles15, direction);
  const base = erBaseScore(candles15, direction);
  const structure = erStructureShift(candles5, direction);
  const trigger = erReversalTrigger(candles5, direction);
  const eligible =
    location >= 1.0 &&
    exhaustion >= 0.5 &&
    trigger >= 0.75 &&
    (base >= 1.0 || structure >= 1.0);
  const score =
    0.25 * location + 0.25 * exhaustion + 0.2 * base + 0.15 * structure + 0.15 * trigger;
  let reason = "early reversal setup confirmed";
  if (!eligible) {
    if (location < 1) reason = "not at range extreme";
    else if (exhaustion < 0.5) reason = "insufficient 15m exhaustion";
    else if (trigger < 0.75) reason = "no 5m reversal trigger";
    else reason = "no 15m base or 5m structure shift";
  }
  return {
    eligible,
    score: +score.toFixed(4),
    location_15m: location,
    exhaustion_15m: exhaustion,
    base_15m: base,
    structure_shift_5m: structure,
    reversal_trigger_5m: trigger,
    reason,
  };
}

function inferEarlyDirection(candles15, candles5) {
  const L = evaluateEarlyReversal(candles15, candles5, "LONG");
  const S = evaluateEarlyReversal(candles15, candles5, "SHORT");
  const elig = [];
  if (L.eligible) elig.push(["LONG", L]);
  if (S.eligible) elig.push(["SHORT", S]);
  if (!elig.length) return { direction: null, long: L, short: S };
  elig.sort((a, b) => b[1].score - a[1].score);
  if (elig.length === 2 && elig[0][1].score - elig[1][1].score < 0.2) {
    return { direction: null, long: L, short: S };
  }
  return { direction: elig[0][0], detail: elig[0][1], long: L, short: S };
}

/** Legacy soft diag for POTENSI text */
function earlyReversalDiag(m15, m5, candles15, candles5) {
  const inf = inferEarlyDirection(candles15, candles5);
  const L = inf.long, S = inf.short;
  return {
    longLoc: L.location_15m, shortLoc: S.location_15m,
    longExh: L.exhaustion_15m, shortExh: S.exhaustion_15m,
    longReclaim: L.reversal_trigger_5m, shortReject: S.reversal_trigger_5m,
    longTrig: L.reversal_trigger_5m, shortTrig: S.reversal_trigger_5m,
    longScore: Math.round(L.score * 100), shortScore: Math.round(S.score * 100),
    longEligible: L.eligible, shortEligible: S.eligible,
    longReason: L.reason, shortReason: S.reason,
    infer: inf.direction,
  };
}

/** 24h extreme anchors for standard SL */
function extremes24h(candles1h) {
  if (!candles1h || candles1h.length < 12) return null;
  const w = candles1h.slice(-24);
  return {
    low: Math.min(...w.map((c) => c.low)),
    high: Math.max(...w.map((c) => c.high)),
  };
}

/**
 *  execution geometry: entry=5m close, SL=24h extreme±0.25ATR, TP=2R
 * risk band 0.10%–8%
 */

/**
 * Entry dari ekstrem 40 candle 5m (acuan user):
 * LONG  → entry sedikit di atas low40, SL di bawah low, TP di bawah high 15m
 * SHORT → entry sedikit di bawah high40, SL di atas high, TP di atas low 15m
 * Arah action tetap dari engine trend/MTF (bukan dari ekstrem ini).
 */
function buildLevels40Swing(candles5, candles15, action, mark, regime) {
  if (!candles5 || candles5.length < 40) return null;
  if (!action || (action !== "LONG" && action !== "SHORT")) return null;
  const win = candles5.slice(-40);
  const n = win.length;

  let low40 = Infinity, high40 = -Infinity, lowIdx = -1, highIdx = -1;
  for (let i = 0; i < n; i++) {
    const c = win[i];
    if (c.low <= low40) {
      low40 = c.low;
      lowIdx = i;
    }
    if (c.high >= high40) {
      high40 = c.high;
      highIdx = i;
    }
  }
  if (!(low40 > 0) || !(high40 > low40)) return null;

  const atrV = atr(candles5) || mark * 0.005;
  const tick = Math.max(mark * 0.00012, low40 * 0.0002, 1e-12);
  const pad = Math.max(tick, atrV * 0.05);

  // v3.12.3: lebih longgar — ekstrem window 40 masih dipakai
  const FRESH_BARS = 32;
  const MAX_DIST_ATR = 2.5;
  const barsFromEndLow = n - 1 - lowIdx;
  const barsFromEndHigh = n - 1 - highIdx;

  const w15 =
    candles15 && candles15.length >= 12 ? candles15.slice(-Math.min(40, candles15.length)) : win;
  const high15 = Math.max(...w15.map((c) => c.high));
  const low15 = Math.min(...w15.map((c) => c.low));

  const wait = (reason, extra) => ({
    entry: mark,
    sl: mark,
    tp1: mark,
    tp2: mark,
    tp3: mark,
    rr: 0,
    mode: "WAIT",
    reason,
    mark,
    meta: { low40, high40, high15, low15, barsFromEndLow, barsFromEndHigh, ...(extra || {}) },
  });

  let entry, sl, tp1, tp2, tp3, mode;

  if (action === "LONG") {
    if (barsFromEndLow > FRESH_BARS) {
      return wait("low40 tidak segar (" + barsFromEndLow + " bar) — pantau", {
        need: "low di ≤" + FRESH_BARS + " bar 5m",
      });
    }
    const distAtr = (mark - low40) / Math.max(atrV, 1e-12);
    if (distAtr > MAX_DIST_ATR) {
      return wait("belum di zona low40 (dist " + distAtr.toFixed(2) + " ATR) — pantau", { distAtr });
    }
    // Timing entry: sedikit di atas low 40×5m
    entry = low40 + pad;
    if (mark > entry && distAtr > 0.25) {
      entry = mark;
      mode = "SWING40_MKT";
    } else {
      mode = "SWING40_ZONE";
    }
    sl = low40 - Math.max(pad * 1.1, atrV * 0.18);
    let risk = entry - sl;
    const riskCap = Math.min(entry * 0.01, atrV * 1.35);
    const riskFloor = Math.max(entry * 0.001, atrV * 0.28);
    if (risk > riskCap) {
      sl = entry - riskCap;
      risk = riskCap;
    }
    if (risk < riskFloor) {
      sl = entry - riskFloor;
      risk = riskFloor;
    }
    // TP 2R – 5R – 8R (prioritas R-multiple; 15m high hanya soft ceiling di TP3)
    tp1 = entry + risk * 2.0;
    tp2 = entry + risk * 5.0;
    tp3 = entry + risk * 8.0;
    if (high15 > entry && tp3 > high15 * 1.02) {
      // jangan terlalu absurd di atas high15, tetap jaga ≥2R
      tp3 = Math.max(entry + risk * 2.0, Math.min(tp3, high15 + risk * 0.5));
      if (tp2 > tp3) tp2 = entry + (tp3 - entry) * 0.65;
      if (tp1 > tp2) tp1 = entry + (tp2 - entry) * 0.5;
      if (tp1 < entry + risk * 1.8) tp1 = entry + risk * 2.0;
    }
  } else {
    if (barsFromEndHigh > FRESH_BARS) {
      return wait("high40 tidak segar (" + barsFromEndHigh + " bar) — pantau", {
        need: "high di ≤" + FRESH_BARS + " bar 5m",
      });
    }
    const distAtr = (high40 - mark) / Math.max(atrV, 1e-12);
    if (distAtr > MAX_DIST_ATR) {
      return wait("belum di zona high40 (dist " + distAtr.toFixed(2) + " ATR) — pantau", { distAtr });
    }
    entry = high40 - pad;
    if (mark < entry && distAtr > 0.25) {
      entry = mark;
      mode = "SWING40_MKT";
    } else {
      mode = "SWING40_ZONE";
    }
    sl = high40 + Math.max(pad * 1.1, atrV * 0.18);
    let risk = sl - entry;
    const riskCap = Math.min(entry * 0.01, atrV * 1.35);
    const riskFloor = Math.max(entry * 0.001, atrV * 0.28);
    if (risk > riskCap) {
      sl = entry + riskCap;
      risk = riskCap;
    }
    if (risk < riskFloor) {
      sl = entry + riskFloor;
      risk = riskFloor;
    }
    tp1 = entry - risk * 2.0;
    tp2 = entry - risk * 5.0;
    tp3 = entry - risk * 8.0;
    if (low15 < entry && tp3 < low15 * 0.98) {
      tp3 = Math.min(entry - risk * 2.0, Math.max(tp3, low15 - risk * 0.5));
      if (tp2 < tp3) tp2 = entry - (entry - tp3) * 0.65;
      if (tp1 < tp2) tp1 = entry - (entry - tp2) * 0.5;
      if (tp1 > entry - risk * 1.8) tp1 = entry - risk * 2.0;
    }
  }

  const risk = Math.abs(entry - sl);
  if (!(risk > 0)) return null;
  const rr = Math.abs(tp1 - entry) / risk; // ~2R
  if (rr < 1.8) {
    return wait("swing40 rr<" + rr.toFixed(2) + " — pantau", { rr, entry, sl, tp1 });
  }
  if (action === "LONG" && !(sl < entry && entry < tp1 && tp1 <= tp2 && tp2 <= tp3)) {
    return wait("swing40 long level invalid", { entry, sl, tp1, tp2, tp3 });
  }
  if (action === "SHORT" && !(sl > entry && entry > tp1 && tp1 >= tp2 && tp2 >= tp3)) {
    return wait("swing40 short level invalid", { entry, sl, tp1, tp2, tp3 });
  }
  return {
    entry,
    sl,
    tp1,
    tp2,
    tp3,
    rr, // TP1 = 2R; ladder to 8R
    mode,
    mark,
    meta: {
      low40,
      high40,
      high15,
      low15,
      pad,
      barsFromEndLow,
      barsFromEndHigh,
      freshBars: FRESH_BARS,
      maxDistAtr: MAX_DIST_ATR,
      tpLadder: "2R-5R-8R",
    },
  };
}

function buildLevelsExtreme(candles5, candles1h, action, mark, regime) {
  if (!candles5 || candles5.length < 5) return null;
  const last = candles5[candles5.length - 1];
  const entry = last.close;
  const atrV = atr(candles5) || entry * 0.005;
  const ex = extremes24h(candles1h);
  if (!ex) return null;
  let sl, tp1, tp2, tp3;
  // v3.9 scalp: SL tidak boleh terlalu dalam (cap 1.2% atau 1.8*ATR)
  const riskCap = Math.min(entry * 0.012, atrV * 1.8);
  const riskFloor = Math.max(atrV * 0.55, entry * 0.0025);
  if (action === "LONG") {
    let rawSl = ex.low - 0.12 * atrV;
    if (rawSl >= entry) rawSl = entry - riskFloor;
    // tarik SL naik jika 24h low terlalu jauh
    sl = Math.max(rawSl, entry - riskCap);
    if (entry - sl < riskFloor) sl = entry - riskFloor;
    const risk = entry - sl;
    if (risk <= 0) return null;
    tp1 = entry + 1.8 * risk;
    tp2 = entry + 2.6 * risk;
    tp3 = entry + 3.5 * risk;
  } else {
    let rawSl = ex.high + 0.12 * atrV;
    if (rawSl <= entry) rawSl = entry + riskFloor;
    sl = Math.min(rawSl, entry + riskCap);
    if (sl - entry < riskFloor) sl = entry + riskFloor;
    const risk = sl - entry;
    if (risk <= 0) return null;
    tp1 = entry - 1.8 * risk;
    tp2 = entry - 2.6 * risk;
    tp3 = entry - 3.5 * risk;
  }
  const riskPct = (Math.abs(entry - sl) / entry) * 100;
  if (riskPct < 0.12 || riskPct > 2.5) {
    return { mode: "WAIT", reason: "risk_pct outside 0.12-2.5% scalp", riskPct, entry, sl, rr: 0 };
  }
  // high vol: still allow but require wider already via extreme
  const rr = 2.0;
  return {
    entry, sl, tp1, tp2, tp3, rr,
    mode: "EARLY_ZONE",
    riskPct: +riskPct.toFixed(4),
  };
}

function isCandleFresh(candles, maxAgeMin) {
  if (!candles || !candles.length) return false;
  const last = candles[candles.length - 1];
  const ts = last.ts || last.time || 0;
  if (!ts) return true;
  const ageMin = (Date.now() - ts) / 60000;
  // longgar: data feed kadang tanpa bar open → last closed bisa 1-2 interval tua
  return ageMin <= maxAgeMin;
}

/** Drop bar terakhir jika masih forming (FreqAI closed-only) — jangan skip pair */
function dropIncompleteCandle(candles, intervalMin) {
  if (!candles || candles.length < 10) return candles || [];
  const last = candles[candles.length - 1];
  const ts = last.ts || last.time || 0;
  if (!ts) return candles;
  const ageMs = Date.now() - ts;
  const intervalMs = intervalMin * 60 * 1000;
  // masih dalam interval bar ini → incomplete
  if (ageMs < intervalMs - 3000) return candles.slice(0, -1);
  return candles;
}


/** Agregasi candle TF lebih tinggi dari base (n bar → 1). Hemat request 4H. */
function aggregateTF(candles, n) {
  if (!candles || candles.length < n * 5) return null;
  const out = [];
  for (let i = 0; i + n <= candles.length; i += n) {
    const chunk = candles.slice(i, i + n);
    out.push({
      ts: chunk[0].ts,
      open: chunk[0].open,
      high: Math.max(...chunk.map((c) => c.high)),
      low: Math.min(...chunk.map((c) => c.low)),
      close: chunk[n - 1].close,
      volume: chunk.reduce((s, c) => s + (c.volume || 0), 0),
    });
  }
  return out.length >= 15 ? out : null;
}

function candlesTo2H(h1Candles) {
  if (!h1Candles || h1Candles.length < 4) return [];
  const out = [];
  const start = h1Candles.length % 2 === 0 ? 0 : 1;
  for (let k = start; k + 1 < h1Candles.length; k += 2) {
    const a = h1Candles[k];
    const b = h1Candles[k + 1];
    out.push({
      ts: b.ts,
      open: a.open,
      high: Math.max(a.high, b.high),
      low: Math.min(a.low, b.low),
      close: b.close,
      volume: (a.volume || 0) + (b.volume || 0),
      confirm: "1",
    });
  }
  return out;
}

/**
 * v3.1 SCALP location-extreme + MTF termasuk 2H
 * LONG: harga di area BAWAH (15M/5M) + 2H tidak bearish
 * SHORT: harga di area ATAS + 2H tidak bullish
 */
function scalpSignal(h1, m15, m5, h4, book, regime, h2) {
  if (!h1 || !m15 || !m5) return null;
  if (regime && regime.regime === "extreme") return null;
  // high vol: LOC scalp tidak VALID (hindari catch-knife seperti INJ)
  if (regime && regime.regime === "high") return null;

  const t1 = tfTrend(h1);
  const t15 = tfTrend(m15);
  const t5 = tfTrend(m5);
  const t2 = h2 ? tfTrend(h2) : "neutral";
  const t4 = h4 ? tfTrend(h4) : "neutral";

  const pos15 = m15.position != null ? m15.position : 50;
  const pos5 = m5.position != null ? m5.position : 50;
  const pos2 = h2 && h2.position != null ? h2.position : 50;
  const rsi5 = m5.rsi != null ? m5.rsi : 50;
  const rsi15 = m15.rsi != null ? m15.rsi : 50;

  // Seleksi ketat: benar-benar bawah/atas, bukan tengah
  const longLoc = pos15 <= 35 && pos5 <= 42 && pos2 <= 52;
  const shortLoc = pos15 >= 65 && pos5 >= 58 && pos2 >= 48;
  const longRsi = rsi15 <= 45 && rsi5 <= 48;
  const shortRsi = rsi15 >= 55 && rsi5 >= 52;

  let action = null;
  if (longLoc && longRsi) action = "LONG";
  if (shortLoc && shortRsi) action = "SHORT";
  if (!action) return null;

  if (action === "LONG") {
    if (t2 === "bearish") return null;
    if (t1 === "bearish" && (h1.slope12 ?? 0) < -0.2) return null;
    if (t15 === "bearish" && (m15.slope6 ?? 0) < -0.15) return null;
    if (t5 === "bearish") return null;
  } else {
    if (t2 === "bullish") return null;
    if (t1 === "bullish" && (h1.slope12 ?? 0) > 0.2) return null;
    if (t15 === "bullish" && (m15.slope6 ?? 0) > 0.15) return null;
    if (t5 === "bullish") return null;
  }

  const press = (m5.volume && m5.volume.pressure != null) ? m5.volume.pressure : 0;
  if (action === "LONG" && press < -28) return null;
  if (action === "SHORT" && press > 28) return null;

  if (book && !book.missing) {
    if (action === "LONG" && book.side === "ASK" && (book.imbalance ?? 0) <= -20) return null;
    if (action === "SHORT" && book.side === "BID" && (book.imbalance ?? 0) >= 20) return null;
  }

  let score = 50;
  if (action === "LONG") {
    if (pos15 <= 25) score += 12;
    else if (pos15 <= 32) score += 9;
    else score += 6;
    if (pos5 <= 30) score += 6;
    if (pos2 <= 40) score += 5;
    if (t2 === "bullish") score += 8;
    if (t1 !== "bearish") score += 5;
    if (t15 === "bullish" || t15 === "neutral") score += 6;
    if (m5.macdUp || m5.macdCrossUp) score += 5;
  } else {
    if (pos15 >= 75) score += 12;
    else if (pos15 >= 68) score += 9;
    else score += 6;
    if (pos5 >= 70) score += 6;
    if (pos2 >= 60) score += 5;
    if (t2 === "bearish") score += 8;
    if (t1 !== "bullish") score += 5;
    if (t15 === "bearish" || t15 === "neutral") score += 6;
    if (m5.macdDown || m5.macdCrossDown) score += 5;
  }
  if (m5.volume && m5.volume.spike) score += 3;
  if (regime && regime.regime === "high") score -= 4;

  score = clamp(Math.round(score), 0, 90); // tidak pernah 99 palsu
  if (score < 76) return null; // lebih selektif

  return {
    action: action,
    probability: score,
    setup: "SCALP_LOC_15M",
    h1: h1,
    m15: m15,
    m5: m5,
    h4: h4,
    h2: h2 || null,
    trends: { h2: t2, h1: t1, m15: t15, h4: t4 },
    book: book,
    regime: regime || null,
    volConfirm: !!(m5.volume && m5.volume.spike),
    confluence: 4,
    pillars: ["loc_extreme", "tf_2h", "tf_1h", "tf_15m", "tf_5m"],
    location: { pos5: pos5, pos15: pos15, pos2: pos2 },
  };
}


/** WATCH/POTENSI: near-miss lokasi atau MTF — bukan entry */
function scalpPotential(h1, m15, m5, h4, book, regime, h2) {
  if (!h1 || !m15 || !m5) return null;
  const t1 = tfTrend(h1);
  const t15 = tfTrend(m15);
  const t5 = tfTrend(m5);
  const t2 = h2 ? tfTrend(h2) : "neutral";
  const pos15 = m15.position != null ? m15.position : 50;
  const pos5 = m5.position != null ? m5.position : 50;
  const pos2 = h2 && h2.position != null ? h2.position : 50;
  const rsi15 = m15.rsi != null ? m15.rsi : 50;
  const rsi5 = m5.rsi != null ? m5.rsi : 50;

  // Zona "hampir" ekstrem (lebih longgar dari VALID)
  const nearLong = pos15 <= 42 && pos5 <= 50 && pos2 <= 58;
  const nearShort = pos15 >= 58 && pos5 >= 50 && pos2 >= 42;
  if (!nearLong && !nearShort) return null;

  let action = null;
  let reasons = [];
  if (nearLong && !nearShort) action = "LONG";
  else if (nearShort && !nearLong) action = "SHORT";
  else {
    // keduanya near: pilih yang lebih ekstrem
    action = pos15 <= 50 - (pos15 - 50) ? "LONG" : "SHORT";
    if (pos15 < 50) action = "LONG";
    else action = "SHORT";
  }

  if (action === "LONG") {
    if (t2 === "bearish") reasons.push("2H bearish");
    if (t1 === "bearish") reasons.push("1H bearish");
    if (t5 === "bearish") reasons.push("5M bearish");
    if (pos15 > 35) reasons.push("15M belum cukup bawah (pos=" + Math.round(pos15) + ")");
    if (rsi15 > 45) reasons.push("RSI15 belum oversold-ish");
  } else {
    if (t2 === "bullish") reasons.push("2H bullish");
    if (t1 === "bullish") reasons.push("1H bullish");
    if (t5 === "bullish") reasons.push("5M bullish");
    if (pos15 < 65) reasons.push("15M belum cukup atas (pos=" + Math.round(pos15) + ")");
    if (rsi15 < 55) reasons.push("RSI15 belum overbought-ish");
  }

  // score potensi 60-75
  let score = 62;
  if (action === "LONG" && pos15 <= 35) score += 6;
  if (action === "SHORT" && pos15 >= 65) score += 6;
  if (action === "LONG" && t2 !== "bearish") score += 4;
  if (action === "SHORT" && t2 !== "bullish") score += 4;
  if (action === "LONG" && t5 !== "bearish") score += 3;
  if (action === "SHORT" && t5 !== "bullish") score += 3;
  score = clamp(score, 60, 75);

  return {
    action,
    score,
    setup: "POTENSI",
    reason: reasons.length ? reasons.slice(0, 3).join("; ") : "dekat zona + MTF belum lengkap",
    location: { pos5, pos15, pos2 },
  };
}

function scoreSignal(h1, m15, m5, h4, funding, btcBias, book = null, regime = null, opts = {}) {
  if (!h1 || !m15 || !m5) return null;
  const strict = opts.strict !== false;

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

  // REVERSAL (early): tangkap putaran SEBELUM impuls besar — ketat
  // ekstrem BB/RSI + volume climax + candle reversal + momentum 5m mulai berbalik + HTF tidak strong against
  if (!action) {
    const pos5r = m5.position != null ? m5.position : 50;
    const rsi5r = m5.rsi != null ? m5.rsi : 50;
    const pressR = m5.volume?.pressure ?? 0;
    const spikeR = !!(m5.volume && m5.volume.spike);
    const revR = m5.reversal || { bias: "neutral", quality: 0 };
    const slope5r = m5.slope6 != null ? m5.slope6 : 0;
    const macdTurnUp = !!(m5.macdUp || m5.macdCrossUp);
    const macdTurnDown = !!(m5.macdDown || m5.macdCrossDown);

    const longExt = pos5r <= 18 || (pos5r <= 28 && rsi5r <= 32);
    const longClimax = (spikeR && pressR <= -8) || pressR <= -22;
    const longCandle = revR.bias === "bullish" && revR.quality >= 0.75;
    const longTurn = slope5r >= -0.12 && (macdTurnUp || slope5r > 0.04 || longCandle);
    const longHtfOk =
      t1 !== "bearish" &&
      !h1StrongDown &&
      (h1.slope12 ?? 0) > -1.2 &&
      t4 !== "bearish";
    if (longExt && longClimax && longCandle && longTurn && longHtfOk) {
      action = "LONG";
      path = "REVERSAL";
    }

    const shortExt = pos5r >= 82 || (pos5r >= 72 && rsi5r >= 68);
    const shortClimax = (spikeR && pressR >= 8) || pressR >= 22;
    const shortCandle = revR.bias === "bearish" && revR.quality >= 0.75;
    const shortTurn = slope5r <= 0.12 && (macdTurnDown || slope5r < -0.04 || shortCandle);
    const shortHtfOk =
      t1 !== "bullish" &&
      !h1StrongUp &&
      (h1.slope12 ?? 0) < 1.2 &&
      t4 !== "bullish";
    if (!action && shortExt && shortClimax && shortCandle && shortTurn && shortHtfOk) {
      action = "SHORT";
      path = "REVERSAL";
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
  // VALID (strict): TREND atau REVERSAL early — SQUEEZE/parked paths hanya WATCH
  if (strict && path !== "TREND" && path !== "PRE_EXPANSION") return null; // VALID: TREND atau PRE only
  // REVERSAL VALID: wajib score sedikit lebih tinggi (hindari false bottom/top)
  if (strict && path === "REVERSAL") {
    // conf dicek nanti; tandai untuk minConf bump via setup
  }
  // v2.19: SHORT VALID frozen — sample SHORT avgR negative & declining; LONG-only VALID
  if (strict && action === "SHORT") return null;
  if (strict && btcBias && btcBias.bias === "bearish" && (btcBias.score || 0) <= -40 && action === "LONG") return null;

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

  // ========== DEEP CONFLUENCE: pilar independen harus saling menguatkan ==========
  const pillars = [];
  if (action === "LONG") {
    if (t1 === "bullish" && t15 === "bullish") pillars.push("tf_align");
    if (h1.stDir === 1 && m15.stDir === 1) pillars.push("st_align");
    else if (m15.stDir === 1) pillars.push("st_15");
    if (h1.emaBull || m15.emaBull) pillars.push("ema");
    if (h1.ms && (h1.ms.trend === "up" || (h1.ms.hh && h1.ms.hl))) pillars.push("structure");
    else if (m15.ms && m15.ms.trend === "up") pillars.push("structure_15");
    if ((h1.slope12 ?? 0) > 0.05 && (m15.slope6 ?? 0) > -0.15) pillars.push("slope");
    if ((m5.volume && m5.volume.pressure > 5) || (m15.volume && m15.volume.pressure > 8)) pillars.push("volume");
    if (m15.macdUp || m15.macdCrossUp || (m15.macdHist != null && m15.macdHist > 0 && m5.macdUp)) pillars.push("macd");
    if (book && book.side !== "ASK" && (book.imbalance == null || book.imbalance > -12)) pillars.push("book");
    if ((m5.rsi ?? 50) >= 42 && (m5.rsi ?? 50) <= 68) pillars.push("rsi_ok");
  } else {
    if (t1 === "bearish" && t15 === "bearish") pillars.push("tf_align");
    if (h1.stDir === -1 && m15.stDir === -1) pillars.push("st_align");
    else if (m15.stDir === -1) pillars.push("st_15");
    if (h1.emaBear || m15.emaBear) pillars.push("ema");
    if (h1.ms && (h1.ms.trend === "down" || (h1.ms.lh && h1.ms.ll))) pillars.push("structure");
    else if (m15.ms && m15.ms.trend === "down") pillars.push("structure_15");
    if ((h1.slope12 ?? 0) < -0.05 && (m15.slope6 ?? 0) < 0.15) pillars.push("slope");
    if ((m5.volume && m5.volume.pressure < -5) || (m15.volume && m15.volume.pressure < -8)) pillars.push("volume");
    if (m15.macdDown || m15.macdCrossDown || (m15.macdHist != null && m15.macdHist < 0 && m5.macdDown)) pillars.push("macd");
    if (book && book.side !== "BID" && (book.imbalance == null || book.imbalance < 12)) pillars.push("book");
    if ((m5.rsi ?? 50) <= 58 && (m5.rsi ?? 50) >= 32) pillars.push("rsi_ok");
  }
  const needPillars = strict ? 3 : 2;
  if (pillars.length < needPillars) return null;
  if (strict && path === "TREND" && !pillars.includes("tf_align")) return null;
  if (!strict && path === "TREND" && t1 !== "neutral" && t15 !== "neutral" && t1 !== t15) return null;
  const confluenceN = pillars.length;

  // BTC soft bias — penalty jika lawan bias kuat (live protect), bukan hard block
  let btcAdj = 0;
  if (btcBias && Math.abs(btcBias.score || 0) >= 30) {
    const aligned =
      (btcBias.bias === "bullish" && action === "LONG") ||
      (btcBias.bias === "bearish" && action === "SHORT");
    const against =
      (btcBias.bias === "bullish" && action === "SHORT") ||
      (btcBias.bias === "bearish" && action === "LONG");
    const mag = Math.abs(btcBias.score);
    if (aligned) btcAdj = mag >= 50 ? 4 : 2;
    if (against) btcAdj = mag >= 50 ? -12 : mag >= 40 ? -8 : -5;
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

  if (path === "REVERSAL") conf += 10;
  if (path === "MEAN_REV") conf += 4;
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
  if (action === "LONG" && funding > 0.0008) conf -= 4;
  if (action === "SHORT" && funding < -0.0008) conf -= 4;
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

  // === SUPERTREND soft confirm (boost only; hard align for TREND is above) ===
  const st15b = m15.stDir || 0;
  const st1 = h1.stDir || 0;
  if (action === "LONG") {
    if (st15b === 1) conf += 4;
    if (st1 === 1) conf += 3;
  } else if (action === "SHORT") {
    if (st15b === -1) conf += 4;
    if (st1 === -1) conf += 3;
  }

  // Volatility Regime soft adjustment
  if (regime) {
    if (regime.regime === "high") conf = Math.round(conf * 0.92);
    if (regime.regime === "low") conf = Math.round(conf * 1.04);
  }

  if (confluenceN >= 7) conf += 5;
  else if (confluenceN >= 6) conf += 3;
  conf = clamp(Math.round(conf), 0, 99);

  // === Quality gates (proteksi, bukan bunuh potensi) ===
  const st15 = m15.stDir || 0;
  // Supertrend 15M lawan arah → penalty, bukan hard block
  if (path === "TREND") {
    if (action === "LONG" && st15 === -1) conf -= 8;
    if (action === "SHORT" && st15 === 1) conf -= 8;
  }
  let minConf = strict ? MIN_PROB_VALID : 68;
  if (strict && path === "REVERSAL") minConf = Math.max(minConf, 80);
  if (strict && regime && regime.regime === "high") minConf = Math.max(minConf, 80);
  if (strict && path === "REVERSAL" && regime && regime.regime === "high") minConf = Math.max(minConf, 84);
  conf = clamp(Math.round(conf), 0, 99);
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
    confluence: confluenceN,
    pillars,
  };
}


/** Block A: rough EV in R units after fees+slippage */
function estimateEV(rr, entry) {
  if (!rr || rr <= 0 || !entry) return -1;
  // costs as fraction of price → convert to R using stop distance proxy from rr
  // Assume risk 1R ≈ move to SL; cost notional / risk ≈ costPct / (riskPct of price)
  // Simpler: cost drag in R ≈ (fee+slip)*entry / (entry * 0.01) if 1% stop typical
  // Use fixed: round-turn cost ≈ 0.14% price; if stop ~0.8% price, cost ≈ 0.175R
  const costPct = FEE_RATE_RT + SLIPPAGE_RT;
  // Approximate risk distance from rr and tp2 relationship: risk ≈ move/rr for tp2
  // EV ≈ p_win * rr_avg - p_loss * 1 - cost_R; without calibrated p use rr as gross
  // Gross edge proxy: (rr - 1) / 2 as crude long-run if 50% — too optimistic
  // Trader rule: require rr large enough that 1R win still beats costs
  // cost in R if stop is ~0.6%-1.2% of price: costR = costPct / stopPct
  const stopPctAssumed = 0.009; // 0.9% stop assumption for cost→R
  const costR = costPct / stopPctAssumed;
  const ev = rr - 1.0 - costR; // need better than 1:1 after costs (conservative gate)
  // Actually for R:R 1:2.5, "rr" field is tp2/risk so gross if always hit tp2
  // Gate: netR = rr - costR must exceed 1.15 (prefer >1R net after costs on TP2 path)
  const netRr = rr - costR;
  return { ev: +netRr.toFixed(3), costR: +costR.toFixed(3), netRr: +netRr.toFixed(3) };
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

  // Adaptive by regime + live buffer (noise + fee space) — v2.15
  let slBuf = 0.48;
  let slMinMult = 0.9, slMaxMult = 2.2, slDefault = 1.15;
  let mktSlMin = 1.1, mktSlMax = 2.6, mktSlDef = 1.35;
  let tp1R = 1.7, tp2R = 2.5, tp3R = 3.5;
  const reg = regime && regime.regime ? regime.regime : "normal";
  if (reg === "low") {
    slBuf = 0.55; slMinMult = 0.95; slMaxMult = 2.5; slDefault = 1.2;
    mktSlMin = 1.2; mktSlMax = 2.8; mktSlDef = 1.35;
    tp1R = 1.5; tp2R = 2.4; tp3R = 3.8;
  } else if (reg === "high") {
    slBuf = 0.78; slMinMult = 1.35; slMaxMult = 3.4; slDefault = 1.65;
    mktSlMin = 1.6; mktSlMax = 3.6; mktSlDef = 1.85;
    tp1R = 1.7; tp2R = 2.8; tp3R = 4.2;
  } else if (reg === "extreme") {
    slBuf = 0.95; slMinMult = 1.5; slMaxMult = 3.8; slDefault = 1.85;
    mktSlMin = 1.8; mktSlMax = 4.0; mktSlDef = 2.0;
    tp1R = 1.8; tp2R = 2.9; tp3R = 4.0;
  }
  let liveBuf = mark * 0.0012 + atrV * 0.18;
  if (regime && regime.regime === "high") liveBuf = mark * 0.0022 + atrV * 0.32; // audit INJ
  if (regime && regime.regime === "extreme") liveBuf = mark * 0.0028 + atrV * 0.42;

  // Hybrid: prefer ZONE; MKT only if still reasonably close
  const NEAR_ATR = 1.35; // v3.9: zona lebih longgar
  const FAR_ATR = 2.6;
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

  // v2.15: dorong SL menjauh sedikit dari entry (live noise/fee)
  if (Number.isFinite(liveBuf) && liveBuf > 0) {
    if (signal.action === "LONG") sl = Math.min(sl, entry) - liveBuf;
    else sl = Math.max(sl, entry) + liveBuf;
  }

  // v3.10: cap risk kedua path (extreme + classic)
  let risk = Math.abs(entry - sl);
  const atrHere = atr(candles) || entry * 0.005;
  const maxRisk = Math.min(entry * 0.012, atrHere * 1.9);
  const minRisk = Math.max(entry * 0.002, atrHere * 0.5);
  if (signal.action === "LONG") {
    if (risk > maxRisk) { sl = entry - maxRisk; risk = maxRisk; }
    else if (risk < minRisk) { sl = entry - minRisk; risk = minRisk; }
    tp1 = entry + risk * tp1R;
    tp2 = entry + risk * tp2R;
    tp3 = entry + risk * tp3R;
  } else {
    if (risk > maxRisk) { sl = entry + maxRisk; risk = maxRisk; }
    else if (risk < minRisk) { sl = entry + minRisk; risk = minRisk; }
    tp1 = entry - risk * tp1R;
    tp2 = entry - risk * tp2R;
    tp3 = entry - risk * tp3R;
  }
  if (signal.action === "LONG" && !(sl < entry && entry < tp1 && tp1 <= tp2 && tp2 <= tp3)) {
    return { entry, sl, tp1, tp2, tp3, rr: 0, mode, mark };
  }
  if (signal.action === "SHORT" && !(sl > entry && entry > tp1 && tp1 >= tp2 && tp2 >= tp3)) {
    return { entry, sl, tp1, tp2, tp3, rr: 0, mode, mark };
  }
  const rrCore = risk > 0 ? Math.abs(tp1 - entry) / risk : 0;
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
    `📊 Score: <b>${s.probability}</b>${regimeTxt}\n` +
    `🧩 Setup: <b>${displaySetup(s.setup)}</b>\n` +
    `🎯 Entry: <code>${formatPrice(s.entry)}</code>${displayMode(s.mode) ? " · " + displayMode(s.mode) : ""}\n` +
    `🛑 SL: <code>${formatPrice(s.sl)}</code>\n` +
    `🎯 TP1: <code>${formatPrice(s.tp1)}</code>\n` +
    `🎯 TP2: <code>${formatPrice(s.tp2)}</code>\n` +
    `🚀 TP3: <code>${formatPrice(s.tp3)}</code>\n` +
    `📈 R:R 1:${s.rr.toFixed(1)}${riskTxt}` +
    (s.ev && s.ev.netRr != null ? `\n📐 Net R (after cost): ~${s.ev.netRr}` : "") +
    `\n\n` +
    `1H ${s.trends ? s.trends.h1 : s.h1?.bias || "—"} · 15M ${s.trends ? s.trends.m15 : s.m15?.bias || "—"} · 4H ${s.trends ? s.trends.h4 : "—"}\n` +
    `Vol ${s.m5?.volume?.side || "—"}${bookTxt} · RSI ${Number(s.m5?.rsi || 0).toFixed(0)}\n\n` +
    `<i>Strict Core v2.12 · potensi + proteksi · NFA</i>`
  );
}
function formatSquareCoinBlock(s) {
  const isSniper = s.probability >= MIN_PROB_SNIPER;
  const tag = isSniper ? "🎯 SNIPER" : "✅ VALID";
  const arrow = s.action === "LONG" ? "🟢 LONG" : "🔴 SHORT";
  const mode = displayMode(s.mode) ? ` · ${displayMode(s.mode)}` : "";
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
    `📊 Score: ${s.probability}\n` +
    `🧩 Setup: ${displaySetup(s.setup)}\n` +
    `🎯 Entry: ${formatPrice(s.entry)}${mode}\n` +
    `🛑 SL: ${formatPrice(s.sl)}\n` +
    `🎯 TP1: ${formatPrice(s.tp1)}\n` +
    `🎯 TP2: ${formatPrice(s.tp2)}\n` +
    `🚀 TP3: ${formatPrice(s.tp3 || s.tp2)}\n` +
    `📈 R:R 1:${s.rr.toFixed(1)}${risk}` +
    (s.ev && s.ev.netRr != null ? `\nNet R~${s.ev.netRr}` : "") +
    `\n` +
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
  lines.push("Strict Core v2.12 · potensi + proteksi · NFA");
  lines.push("");
  lines.push(fo);
  lines.push("");
  lines.push("#PintarPakaiBinanceEarn");
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
    <text x="${pad + 28}" y="${y + 280}" font-family="Arial, Helvetica, sans-serif" font-size="17" fill="#475569">${esc(displaySetup(s.setup))}  ·  R:R 1:${s.rr.toFixed(1)}  ·  Vol ${esc(s.m5.volume.side)}${s.book ? " · Book " + esc(s.book.side) : ""}</text>
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
    console.warn("rsvg-convert failed, Square visual post cannot be published:", e.message);
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
  // Binance Square posts must keep the visual card. Do not silently
  // downgrade to text-only: if the image cannot be rendered/uploaded,
  // abort this Square post so the required visual format is preserved.
  try {
    const pngPath = renderSquareCardPng(batch);
    if (!pngPath) {
      throw new Error("Square visual card could not be rendered");
    }
    console.log("Square: uploading professional card image...");
    const imageUrl = await uploadSquareImage(BINANCE_SQUARE_KEY, pngPath);
    if (!imageUrl) {
      throw new Error("Square visual card upload returned no image URL");
    }
    body.imageList = [imageUrl];
    console.log("Square: image ready");
  } catch (e) {
    console.error("Binance Square visual required — post aborted:", e.message);
    return;
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

async function sendWatchDiscord(watches) {
  if (!DISCORD_WEBHOOK || !watches || !watches.length) return;
  const top = watches.slice(0, 8);
  const lines = top.map(
    (w) =>
      `• **${w.base}** ${w.action} · score ${w.score}` +
      (w.confluence != null ? ` · conf ${w.confluence}` : "") +
      (w.reason ? ` · _${w.reason}_` : "")
  );
  const embed = {
    title: `👀 WATCH · ${top.length} potensi (bukan entry)`,
    description: lines.join("\n") + "\n\n_Belum lolos gate VALID — pantau zona, jangan FOMO._",
    color: 0xfbbf24,
    footer: { text: "Selective Scalper v3.2 · lokasi+MTF · NFA" },
    timestamp: new Date().toISOString(),
  };
  try {
    const res = await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "Strict Core Watch", embeds: [embed] }),
    });
    if (res.ok) console.log(`Discord WATCH: ${top.length} items`);
    else console.warn("Discord WATCH failed:", res.status);
  } catch (e) {
    console.warn("Discord WATCH error:", e.message);
  }
}


function consecutiveLossStreak(log) {
  const closed = (log && log.closed) || [];
  let streak = 0;
  for (const c of closed) {
    if ((c.ts || 0) < OUTCOME_STATS_AFTER_TS) break;
    if (c.outcome === "LOSS_SL") streak++;
    else break;
  }
  return streak;
}


/** Public labels must not expose internal intelligence-provider names. */
function displaySetup(setup) {
  const s = String(setup || "");
  if (/TRADERSPY/i.test(s)) return "Scalp MTF";
  if (/SCALP|POTENSI|LOC|SCALP|TREND|PRE_|EARLY|MEAN|SQUEEZE/i.test(s)) return "Scalp MTF";
  return s || "Scalp MTF";
}

function displayMode(mode) {
  const s = String(mode || "");
  if (!s) return "";
  if (/TRADERSPY/i.test(s)) return "MTF";
  return s;
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
    if (i > 0) await new Promise((r) => setTimeout(r, 600));
    const isSniper = s.probability >= MIN_PROB_SNIPER;
    const color = s.action === "LONG" ? 0x35ef9a : 0xff5c7a;
    const persistTag = (s.persistent ? " · 🔁" : "") + (s.volConfirm ? " · 📈" : "");
    const embed = {
      title: `${isSniper ? "🎯 SNIPER" : "✅ VALID"} · ${s.base} ${s.action}${persistTag}`,
      color,
      fields: [
        { name: "Score", value: `**${s.probability}**`, inline: true },
        { name: "Setup", value: displaySetup(s.setup), inline: true },
        ...(s.validUntil ? [{ name: "Valid s/d", value: String(s.validUntil).slice(11, 19) + " UTC (15m)", inline: true }] : []),
        { name: "R:R", value: `1:${s.rr.toFixed(1)}`, inline: true },
        { name: "Entry", value: `$${formatPrice(s.entry)}`, inline: true },
        { name: "SL", value: `$${formatPrice(s.sl)}`, inline: true },
        { name: "Risk Saran", value: s.riskPct ? `**${s.riskPct}%**` : "—", inline: true },
        { name: "TP1 / TP2 / TP3", value: `$${formatPrice(s.tp1)} / $${formatPrice(s.tp2)} / $${formatPrice(s.tp3 || s.tp2)}`, inline: false },
        { name: "Regime", value: s.regime ? `${s.regime.regime} (${s.regime.atrPct}%)` : "—", inline: true },
        { name: "Book", value: s.book ? `${s.book.side} (${s.book.imbalance}) · ${s.book.quality || "—"}` : "—", inline: true },
        { name: "1H / 15M / 5M", value: `${s.trends?.h1 || s.h1?.bias || "—"} / ${s.trends?.m15 || s.m15?.bias || "—"} / ${s.m5?.volume?.side || "—"}`, inline: true },
      ],
      footer: { text: "Selective Scalper v3.2 · lokasi+MTF · NFA" },
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
/** Bitget bar map: internal bar → API granularity */
function bitgetGranularity(bar) {
  const m = {
    "1m": "1m",
    "5m": "5m",
    "15m": "15m",
    "1H": "1H",
    "4H": "4H",
    "1D": "1D",
  };
  return m[bar] || bar;
}

/** Normalize symbol to Bitget USDT-M e.g. BTCUSDT */
function toBitgetSymbol(sym) {
  if (!sym) return sym;
  let s = String(sym).toUpperCase().replace(/-USDT-SWAP$/i, "USDT").replace(/-SWAP$/i, "");
  if (s.endsWith("-USDT")) s = s.replace("-USDT", "USDT");
  if (!s.endsWith("USDT") && !/[0-9]/.test(s.slice(-1))) s = s + "USDT";
  return s;
}

async function fetchBitgetCandles(instId, bar, limit = 100) {
  // Bitget USDT-M perpetual candles
  const symbol = toBitgetSymbol(instId);
  const gran = bitgetGranularity(bar);
  const url =
    `${BITGET}/api/v2/mix/market/candles?symbol=${encodeURIComponent(symbol)}` +
    `&productType=${BG_PRODUCT}&granularity=${encodeURIComponent(gran)}&limit=${limit}`;
  const data = await getJson(url);
  let list = data?.data || [];
  // Ensure chronological oldest → newest
  if (list.length >= 2 && +list[0][0] > +list[list.length - 1][0]) list = list.slice().reverse();
  const candles = list.map((r) => ({
    ts: +r[0],
    open: +r[1],
    high: +r[2],
    low: +r[3],
    close: +r[4],
    volume: +r[5],
    confirm: "1",
  }));
  return candles;
}

async function fetchFunding(instId) {
  try {
    const symbol = toBitgetSymbol(instId);
    const data = await getJson(
      `${BITGET}/api/v2/mix/market/current-fund-rate?symbol=${encodeURIComponent(symbol)}&productType=${BG_PRODUCT}`
    );
    const row = Array.isArray(data?.data) ? data.data[0] : data?.data;
    return +(row?.fundingRate ?? row?.fundRate ?? 0);
  } catch {
    return 0;
  }
}

async function fetchOrderBook(instId, sz = 15) {
  try {
    const symbol = toBitgetSymbol(instId);
    const limit = sz >= 50 ? 50 : sz >= 15 ? 15 : 5;
    const data = await getJson(
      `${BITGET}/api/v2/mix/market/orderbook?symbol=${encodeURIComponent(symbol)}&productType=${BG_PRODUCT}&limit=${limit}`
    );
    const row = data?.data;
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
    return { imbalance: 0, side: "FLAT", bidVol: 0, askVol: 0, spread: null, mid: null, missing: true };
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
  // Block A: missing book → NO-TRADE quality (bukan score 50 netral)
  if (!book || book.side === undefined || book.missing) {
    return { score: 0, quality: "poor", missing: true, imbalance: 0, side: "FLAT", spread: null };
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


// ========== OUTCOME TRACKER ==========
const OUTCOME_FILE = path.join(__dirname, "signals-log.json");
const OUTCOME_MAX_AGE_H = 6; // scalp: expire open after 6h
const OUTCOME_BAR = "15m";
const OUTCOME_MAX_CLOSED = 300;
const DEDUP_WINDOW_MS = 90 * 60 * 1000; // no re-post same pair+side within 90m
const SIGNAL_VALID_MS = 15 * 60 * 1000;
const HORIZON_MIN = [15, 60]; // H15 / H60 forward R
/** FreqAI-inspired: adaptive conf from recent outcomes (self-adapt) */
const ADAPTIVE_LOOKBACK = 20;
const ADAPTIVE_MIN_WR = 35;
const ADAPTIVE_CONF_BUMP = 3;
const ADAPTIVE_FLOOR_CAP = 78; // jangan naikkan conf sampai 85+ (bunuh potensi)
const STRATEGY_ID = "zorath-core-v3.12.3"; // identifier seperti FreqAI model id

function loadOutcomeLog() {
  try {
    if (!fs.existsSync(OUTCOME_FILE)) return { open: [], closed: [], stats: {} };
    const raw = JSON.parse(fs.readFileSync(OUTCOME_FILE, "utf8"));
    return {
      open: Array.isArray(raw.open) ? raw.open : [],
      closed: Array.isArray(raw.closed) ? raw.closed : [],
      stats: raw.stats && typeof raw.stats === "object" ? raw.stats : {},
    };
  } catch (e) {
    console.warn("Outcome log load fail:", e.message);
    return { open: [], closed: [], stats: {} };
  }
}

function saveOutcomeLog(log) {
  try {
    fs.writeFileSync(OUTCOME_FILE, JSON.stringify(log, null, 2));
  } catch (e) {
    console.warn("Outcome log save fail:", e.message);
  }
}

function signalFingerprint(signal) {
  const entry = Number(signal?.entry);
  const rel = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || !Number.isFinite(entry) || entry === 0) return "na";
    return ((n - entry) / entry * 100).toFixed(2);
  };
  return [
    String(signal?.base || "").toUpperCase(),
    String(signal?.action || "").toUpperCase(),
    String(signal?.setup || "").toUpperCase(),
    rel(signal?.sl),
    rel(signal?.tp1),
    rel(signal?.tp2),
    rel(signal?.tp3),
  ].join("|");
}

function isDuplicateSignal(log, base, action, now = Date.now(), signal = null) {
  const fingerprint = signal ? signalFingerprint(signal) : null;
  const hit = (o) => {
    if (!o || o.base !== base || o.action !== action) return false;
    if (fingerprint && o.fingerprint && o.fingerprint === fingerprint) return true;
    return now - (o.ts || 0) < DEDUP_WINDOW_MS;
  };
  if ((log.open || []).some(hit)) return true;
  if ((log.closed || []).some(hit)) return true;
  return false;
}

function filterSignalsForDelivery(signals, log) {
  const now = Date.now();
  const out = [];
  for (const s of signals) {
    if (s.validUntil) {
      const exp = Date.parse(s.validUntil);
      if (Number.isFinite(exp) && exp < now) {
        console.log("Skip post " + s.base + " " + s.action + ": valid window expired");
        continue;
      }
    }
    if (isDuplicateSignal(log, s.base, s.action, now, s)) {
      console.log("Skip post " + s.base + " " + s.action + ": duplicate scan result");
      continue;
    }
    out.push(s);
  }
  return out;
}

function enrichHorizons(sig, candles) {
  if (!candles || !candles.length || !sig.entry) return sig;
  const entry = +sig.entry;
  const sl = +sig.sl;
  const risk = Math.abs(entry - sl) || 1e-12;
  const isLong = sig.action === "LONG";
  const t0 = sig.ts || 0;
  const horizons = Object.assign({}, sig.horizons || {});
  for (const mins of HORIZON_MIN) {
    const key = mins === 15 ? "h15" : "h60";
    if (horizons[key] && horizons[key].r != null) continue;
    const targetTs = t0 + mins * 60 * 1000;
    let pick = null;
    for (const c of candles) {
      const ct = c.ts || c.time || 0;
      if (ct >= targetTs) {
        pick = c;
        break;
      }
    }
    if (!pick) continue;
    const mid = (+pick.open + +pick.close) / 2;
    if (!Number.isFinite(mid)) continue;
    const grossR = isLong ? (mid - entry) / risk : (entry - mid) / risk;
    horizons[key] = { r: +grossR.toFixed(3), price: mid, at: pick.ts || targetTs };
  }
  sig.horizons = horizons;
  return sig;
}



/** FreqAI-style: naikkan bar conf jika edge live lemah */
function adaptiveConfFloor(log, baseFloor) {
  const closed = (log && log.closed) || [];
  const recent = [];
  for (const c of closed) {
    if (!c.outcome) continue;
    if (String(c.outcome).startsWith("WIN") || c.outcome === "LOSS_SL") recent.push(c);
    if (recent.length >= ADAPTIVE_LOOKBACK) break;
  }
  if (recent.length < 8) return { floor: baseFloor, wr: null, n: recent.length, bumped: false };
  const wins = recent.filter((c) => String(c.outcome).startsWith("WIN")).length;
  const wr = (100 * wins) / recent.length;
  if (wr <= ADAPTIVE_MIN_WR) {
    const floor = Math.min(ADAPTIVE_FLOOR_CAP, baseFloor + ADAPTIVE_CONF_BUMP);
    return { floor, wr: +wr.toFixed(1), n: recent.length, bumped: true };
  }
  return { floor: baseFloor, wr: +wr.toFixed(1), n: recent.length, bumped: false };
}

/** FreqAI: hanya candle closed — tolak bar yang masih open (ts terlalu dekat now) */
function lastCandleIsClosed(candles, intervalMin) {
  if (!candles || !candles.length) return false;
  const last = candles[candles.length - 1];
  const ts = last.ts || last.time || 0;
  if (!ts) return true;
  const ageMin = (Date.now() - ts) / 60000;
  // bar baru terbuka: age < interval * 0.15 → masih forming
  if (ageMin < intervalMin * 0.12) return false;
  return true;
}

/** Shifted features (FreqAI include_shifted_candles=1): delta RSI/pos 1 bar */
function shiftedMomentum(tf) {
  if (!tf || tf.rsi == null) return { rsiDelta: 0, posDelta: 0 };
  // analyzeTF doesn't store history — approximate from volume pressure / macd
  const rsiDelta = tf.macdUp ? 2 : tf.macdDown ? -2 : 0;
  const posDelta = tf.position != null ? (tf.position - 50) * 0.02 : 0;
  return { rsiDelta, posDelta };
}

function recomputeStats(closed, afterTs = 0) {
  const stats = {
    total: 0, wins: 0, losses: 0, expired: 0, sumR: 0,
    bySetup: {}, byAction: {}, afterTs: afterTs || 0, feeAware: true,
  };
  const bump = (bag, key) => {
    if (!bag[key]) bag[key] = { n: 0, wins: 0, losses: 0, sumR: 0 };
    return bag[key];
  };
  for (const c of closed) {
    if (afterTs && (c.ts || 0) < afterTs) continue;
    stats.total++;
    const setup = c.setup || "NA";
    const act = c.action || "NA";
    const sRow = bump(stats.bySetup, setup);
    const aRow = bump(stats.byAction, act);
    sRow.n++; aRow.n++;
    const r = c.rMultiple != null ? c.rMultiple : (c.outcome === "LOSS_SL" ? -1 : 0);
    if (c.outcome === "LOSS_SL") {
      stats.losses++; sRow.losses++; aRow.losses++;
      stats.sumR += r; sRow.sumR += r; aRow.sumR += r;
    } else if (c.outcome && String(c.outcome).startsWith("WIN")) {
      stats.wins++; sRow.wins++; aRow.wins++;
      stats.sumR += r; sRow.sumR += r; aRow.sumR += r;
    } else if (c.outcome === "EXPIRED") {
      stats.expired++;
    }
  }
  const finalize = (row) => {
    const d = row.wins + row.losses;
    row.winrate = d > 0 ? +((100 * row.wins) / d).toFixed(1) : null;
    row.avgR = d > 0 ? +(row.sumR / d).toFixed(2) : null;
  };
  finalize(stats);
  Object.values(stats.bySetup).forEach(finalize);
  Object.values(stats.byAction).forEach(finalize);
  stats.winrate = stats.wins + stats.losses > 0
    ? +((100 * stats.wins) / (stats.wins + stats.losses)).toFixed(1)
    : null;
  stats.avgR = stats.wins + stats.losses > 0
    ? +(stats.sumR / (stats.wins + stats.losses)).toFixed(2)
    : null;
  return stats;
}

/** Walk candles after signal time; conservative: SL priority if same candle touches both */
function resolveOutcome(sig, candles) {
  if (!candles || !candles.length) return null;
  const isLong = sig.action === "LONG";
  const entry = +sig.entry;
  const sl = +sig.sl;
  const tps = [+sig.tp1, +sig.tp2, +sig.tp3].filter((x) => Number.isFinite(x));
  const risk = Math.abs(entry - sl) || 1e-12;
  const t0 = sig.ts || 0;
  // v2.15: fee+slip as R drag (round-turn)
  const costR = entry > 0 ? ((FEE_RATE_RT + SLIPPAGE_RT) * entry) / risk : 0.15;
  const netR = (gross) => +((gross) - costR).toFixed(2);

  for (const c of candles) {
    const ct = c.ts || c.time || 0;
    // candle ts in ms
    if (ct && t0 && ct < t0 - 60000) continue;

    const hi = +c.high;
    const lo = +c.low;
    if (!Number.isFinite(hi) || !Number.isFinite(lo)) continue;

    if (isLong) {
      const hitSl = lo <= sl;
      const hitTpIdx = tps.findIndex((tp) => hi >= tp);
      if (hitSl && hitTpIdx >= 0) {
        // same candle ambiguity → count SL (conservative)
        return { outcome: "LOSS_SL", rMultiple: netR(-1), exit: sl, closedAt: ct || Date.now(), costR: +costR.toFixed(3) };
      }
      if (hitSl) return { outcome: "LOSS_SL", rMultiple: netR(-1), exit: sl, closedAt: ct || Date.now(), costR: +costR.toFixed(3) };
      if (hitTpIdx >= 0) {
        const tp = tps[hitTpIdx];
        const r = (tp - entry) / risk;
        return {
          outcome: hitTpIdx === 0 ? "WIN_TP1" : hitTpIdx === 1 ? "WIN_TP2" : "WIN_TP3",
          rMultiple: netR(r),
          exit: tp,
          closedAt: ct || Date.now(),
          costR: +costR.toFixed(3),
        };
      }
    } else {
      const hitSl = hi >= sl;
      const hitTpIdx = tps.findIndex((tp) => lo <= tp);
      if (hitSl && hitTpIdx >= 0) {
        return { outcome: "LOSS_SL", rMultiple: netR(-1), exit: sl, closedAt: ct || Date.now(), costR: +costR.toFixed(3) };
      }
      if (hitSl) return { outcome: "LOSS_SL", rMultiple: netR(-1), exit: sl, closedAt: ct || Date.now(), costR: +costR.toFixed(3) };
      if (hitTpIdx >= 0) {
        const tp = tps[hitTpIdx];
        const r = (entry - tp) / risk;
        return {
          outcome: hitTpIdx === 0 ? "WIN_TP1" : hitTpIdx === 1 ? "WIN_TP2" : "WIN_TP3",
          rMultiple: netR(r),
          exit: tp,
          closedAt: ct || Date.now(),
          costR: +costR.toFixed(3),
        };
      }
    }
  }
  return null;
}

async function evaluateOpenOutcomes(log) {
  const stillOpen = [];
  const newlyClosed = [];
  const now = Date.now();

  for (const sig of log.open) {
    const ageH = (now - (sig.ts || now)) / 3600000;
    if (ageH >= OUTCOME_MAX_AGE_H) {
      const closed = { ...sig, outcome: "EXPIRED", rMultiple: 0, closedAt: now };
      newlyClosed.push(closed);
      continue;
    }
    const instId = sig.instId || `${sig.base}USDT`;
    try {
      const candles = await fetchBitgetCandles(instId, OUTCOME_BAR, 100);
      // ensure ts on candles if missing
      const norm = (candles || []).map((c) => ({
        ...c,
        ts: c.ts || c.time || 0,
      }));
      enrichHorizons(sig, norm);
      const resolved = resolveOutcome(sig, norm);
      if (resolved) {
        newlyClosed.push({ ...sig, ...resolved });
      } else {
        stillOpen.push(sig);
      }
      await new Promise((r) => setTimeout(r, 220));
    } catch (e) {
      console.warn(`Outcome eval skip ${sig.base}:`, e.message);
      stillOpen.push(sig);
    }
  }

  log.open = stillOpen;
  log.closed = [...newlyClosed, ...log.closed].slice(0, OUTCOME_MAX_CLOSED);
  log.stats = recomputeStats(log.closed, OUTCOME_STATS_AFTER_TS);
  return { log, newlyClosed };
}

function registerNewSignals(log, signals) {
  const now = Date.now();
  for (const s of signals) {
    if (isDuplicateSignal(log, s.base, s.action, now, s)) continue;
    const id = `${s.base}_${s.action}_${now}`;
    log.open.push({
      id,
      ts: now,
      base: s.base,
      instId: s.instId || `${s.base}USDT`,
      action: s.action,
      fingerprint: signalFingerprint(s),
      setup: s.setup,
      mode: s.mode,
      probability: s.probability,
      entry: s.entry,
      sl: s.sl,
      tp1: s.tp1,
      tp2: s.tp2,
      tp3: s.tp3,
      rr: s.rr,
      regime: s.regime ? s.regime.regime : null,
      validUntil: s.validUntil || new Date(now + SIGNAL_VALID_MS).toISOString(),
      horizons: {},
    });
  }
  return log;
}

function printOutcomeSummary(log, newlyClosed) {
  if (newlyClosed.length) {
    console.log(`Outcome closed this run: ${newlyClosed.length}`);
    for (const c of newlyClosed) {
      const hz = c.horizons || {};
      const htxt =
        (hz.h15 && hz.h15.r != null ? ` H15=${hz.h15.r}` : "") +
        (hz.h60 && hz.h60.r != null ? ` H60=${hz.h60.r}` : "");
      console.log(
        `  ${c.base} ${c.action} → ${c.outcome}` +
          (c.rMultiple != null ? ` R=${c.rMultiple}` : "") +
          htxt
      );
    }
  }

  // FreqAI-style forward research: avg H15/H60 R on closed
  let h15n = 0, h15s = 0, h60n = 0, h60s = 0;
  for (const c of log.closed || []) {
    const hz = c.horizons || {};
    if (hz.h15 && hz.h15.r != null) { h15n++; h15s += hz.h15.r; }
    if (hz.h60 && hz.h60.r != null) { h60n++; h60s += hz.h60.r; }
  }
  if (h15n || h60n) {
    console.log(
      `Horizon research: H15 avgR=${h15n ? (h15s / h15n).toFixed(2) : "n/a"} (n=${h15n}) | H60 avgR=${h60n ? (h60s / h60n).toFixed(2) : "n/a"} (n=${h60n})`
    );
  }
  const st = log.stats || {};
  console.log(
    `Outcome stats (since Block A baseline): closed=${st.total || 0} wins=${st.wins || 0} losses=${st.losses || 0} expired=${st.expired || 0}` +
      (st.winrate != null ? ` winrate=${st.winrate}%` : "") +
      (st.avgR != null ? ` avgR=${st.avgR}` : "") +
      ` | open=${(log.open || []).length}`
  );
    if (st.bySetup && Object.keys(st.bySetup).length) {
      const parts = Object.entries(st.bySetup).map(([k, v]) => `${k}: n=${v.n} wr=${v.winrate ?? "n/a"} avgR=${v.avgR ?? "n/a"}`);
      console.log(`  bySetup: ${parts.join(" | ")}`);
    }
    if (st.byAction && Object.keys(st.byAction).length) {
      const parts = Object.entries(st.byAction).map(([k, v]) => `${k}: n=${v.n} wr=${v.winrate ?? "n/a"} avgR=${v.avgR ?? "n/a"}`);
      console.log(`  byAction: ${parts.join(" | ")}`);
    }

}

// ========== END OUTCOME TRACKER ==========

// ========== END CLODDS MODULES ==========

async function runTraderSpyPipeline() {
  console.log("=== Crypto-Signal v4.0 | TraderSpy Intelligence ===");
  console.log(new Date().toISOString());
  console.log("Intelligence source: TraderSpy MCP / tiered discovery + validation");
  console.log("Delivery: Discord + Telegram + Binance Square (unchanged)");

  // Outcome tracking remains local to preserve the existing audit trail.
  // Market-data fallback is deliberately NOT used for signal generation.
  let outcomeLog = loadOutcomeLog();
  try {
    const evaluated = await evaluateOpenOutcomes(outcomeLog);
    outcomeLog = evaluated.log;
    printOutcomeSummary(outcomeLog, evaluated.newlyClosed);
  } catch (e) {
    console.warn("Outcome tracker error:", e.message);
  }

  const signals = await runTraderSpyScan();
  console.log("TraderSpy delivery gate: only tier-validated signals can be published.");
  let postSignals = filterSignalsForDelivery(
    signals.slice(),
    outcomeLog || { open: [], closed: [] }
  );

  // Preserve the existing maximum of three posts, but remove the old
  // direction-specific LONG/SHORT intelligence bias from the TraderSpy path.
  postSignals.sort(
    (a, b) => (b.qualityScore || b.probability || 0) - (a.qualityScore || a.probability || 0)
  );
  postSignals = postSignals.slice(0, 3);

  const watches = [];
  const streak = consecutiveLossStreak(outcomeLog);
  if (streak >= 3 && postSignals.length > 1) {
    // Safety breaker is direction-neutral: keep the strongest TraderSpy signal.
    const keep = postSignals.slice(0, 1);
    for (const s of postSignals.slice(1)) {
      watches.push({
        base: s.base,
        action: s.action,
        score: s.probability,
        setup: s.setup,
        reason: "loss-streak safety cap=" + streak,
      });
    }
    postSignals = keep;
    console.log("TraderSpy safety breaker: loss streak " + streak + " → 1 strongest signal");
  }

  console.log("TraderSpy VALID:", postSignals.length);
  for (const s of postSignals) {
    console.log(
      `  ${s.base} ${s.action} quality=${s.qualityScore} ${s.signalStrength}/${s.importance} ${s.timeframe} R:R 1:${s.rr}`
    );
  }

  const dryRun = String(process.env.TRADERSPY_DRY_RUN || "false").toLowerCase() === "true";
  if (dryRun) {
    console.log("Delivery dry-run: scan/validation completed; external posts and outcome registration skipped.");
    return;
  }

  await sendDiscord(postSignals);
  await sendTelegram(postSignals);
  await sendBinanceSquare(postSignals);
  if (typeof sendWatchDiscord === "function") await sendWatchDiscord(watches);

  try {
    outcomeLog = registerNewSignals(outcomeLog || loadOutcomeLog(), postSignals);
    outcomeLog.stats = recomputeStats(outcomeLog.closed, OUTCOME_STATS_AFTER_TS);
    saveOutcomeLog(outcomeLog);
  } catch (e) {
    console.warn("Outcome register error:", e.message);
  }

  console.log("TraderSpy pipeline done.");
}

async function main() {
  // TraderSpy is the active intelligence engine. The legacy scanner remains below
  // only as a rollback reference; the workflow never enters it while this gate is on.
  const traderSpyOnly = String(process.env.TRADERSPY_ONLY || "true").toLowerCase() !== "false";
  if (traderSpyOnly) {
    await runTraderSpyPipeline();
    return;
  }
  console.log("=== Strict Core v3.12.3 | Entry40 5m · TP 2R/5R/8R · gates looser ===");
  console.log(new Date().toISOString());
  console.log("Primary: entry timing 40×5m | TP ladder 2R-5R-8R | arah dari MTF");
  console.log("Secondary: SHORT=WATCH | equity filtered | Discord+TG+Square | id=" + STRATEGY_ID);
  console.log(
    "Discord:", DISCORD_WEBHOOK ? "YES" : "NO",
    "| Telegram:", TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? "YES" : "NO",
    "| Square:", BINANCE_SQUARE_KEY ? "YES" : "NO"
  );
  let btcBias = { bias: "neutral", score: 0 };
  try {
    const btcCandles = await fetchBitgetCandles("BTCUSDT", "1H", 100);
    const btcTF = analyzeTF(btcCandles, "BTC1H");
    if (btcTF) {
      btcBias = { bias: btcTF.bias, score: btcTF.biasScore, adx: btcTF.adx };
      console.log(`BTC soft bias: ${btcBias.bias} (score ${btcBias.score}, ADX ${btcBias.adx != null ? btcBias.adx.toFixed(1) : "n/a"})`);
    }
  } catch (e) {
    console.warn("BTC bias skip:", e.message);
  }
  const tickersRes = await getJson(
    `${BITGET}/api/v2/mix/market/tickers?productType=${BG_PRODUCT}`
  );
  const tickers = tickersRes?.data || [];
  const candidates = tickers
    .map((t) => {
      const symbol = String(t.symbol || "");
      if (!symbol.endsWith("USDT")) return null;
      // skip dated delivery contracts e.g. BTCUSDT_231229
      if (symbol.includes("_")) return null;
      const last = +t.lastPr || +t.last || 0;
      const open = +t.open24h || +t.openUtc || last;
      const turnover = +t.usdtVolume || +t.quoteVolume || 0;
      const chgRaw = t.change24h != null ? +t.change24h : open ? (last - open) / open : 0;
      // Bitget change24h often fraction (0.01 = 1%)
      const chg = Math.abs(chgRaw) < 1 && chgRaw !== 0 ? chgRaw * 100 : chgRaw * (Math.abs(chgRaw) <= 1 ? 100 : 1);
      const chgPct = open && last ? ((last - open) / open) * 100 : chg;
      if (turnover < 2_000_000 || Math.abs(chgPct) > 28) return null;
      const base = symbol.replace(/USDT$/i, "");
      // C: buang symbol sampah / non-ASCII / leveraged tokens
      if (!base || base.length > 12 || base.length < 2) return null;
      if (/[^\x00-\x7f]/.test(base)) return null; // non-ASCII e.g. emoji names
      if (!/^[A-Za-z0-9]+$/.test(base)) return null;
      if (/^[0-9]/.test(base) || /UP|DOWN|BEAR|BULL/i.test(base)) return null;
      if (/^(SNXX|TEST|BTCDOM|DEFI)$/i.test(base)) return null;
      // v3.9: fokus crypto — buang equity/stock ticker di Bitget
      if (/^(TSLA|NVDA|AAPL|MSFT|META|AMZN|GOOG|GOOGL|AMD|INTC|NFLX|COIN|MSTR|HOOD|PLTR|SOXL|SOXS|TQQQ|SQQQ|QLD|QID|SPY|QQQ|IWM|MRNA|SAMSUNG|SKHY|SKHYNIX|MU|ARM|CRCL|SNDK|MRVL|NBIS|MSTU|MSTX|CONL)$/i.test(base)) return null;
      return {
        instId: symbol,
        base,
        volume: turnover,
        change: chgPct,
        score: Math.log10(Math.max(turnover, 1)) * 0.65 + Math.min(Math.abs(chgPct) / 10, 1) * 0.35,
        mark: last,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, CANDIDATE_LIMIT);
  console.log(`Candidates (${candidates.length}): ${candidates.map((c) => c.base).join(", ")}`);
  // Outcome log early for adaptive conf (FreqAI self-adapt idea)
  let outcomeLogEarly = loadOutcomeLog();
  const adapt = adaptiveConfFloor(outcomeLogEarly, 68);
  if (adapt.bumped) {
    console.log(`Adaptive conf: WR ${adapt.wr}% on last ${adapt.n} → floor ${adapt.floor} (was 80)`);
  } else if (adapt.wr != null) {
    console.log(`Adaptive conf: WR ${adapt.wr}% on last ${adapt.n} → floor stays ${adapt.floor}`);
  }

  const signals = [];
  const watches = [];
  const funnel = {
    scanned: 0,
    dataSkip: 0,
    stale: 0,
    noScore: 0,
    highVolHold: 0,
    btcSoftHold: 0,
    levelsFail: 0,
    valid: 0,
    potensi: 0,
  };

  for (const c of candidates) {
    try {
      // v3.12.3 Phase-1: candle only (cepat). Phase-2: book+positioning hanya jika lolos skor kasar
      const [h1c, m15c, m5c] = await Promise.all([
        fetchBitgetCandles(c.instId, "1H", 80),
        fetchBitgetCandles(c.instId, "15m", 80),
        fetchBitgetCandles(c.instId, "5m", 80),
      ]);
      funnel.scanned++;
      let m5x = dropIncompleteCandle(m5c, 5);
      let m15x = dropIncompleteCandle(m15c, 15);
      let h1x = dropIncompleteCandle(h1c, 60);
      // 4H dari agregasi 1H — hemat 1 request/pair
      const h4x = aggregateTF(h1x, 4) || h1x;
      const m30x = null;
      if (!isCandleFresh(m15x, 55) || !isCandleFresh(m5x, 25) || m5x.length < 50 || m15x.length < 50) {
        funnel.stale++;
        await new Promise((r) => setTimeout(r, 40));
        continue;
      }
      const h1 = analyzeTF(h1x, "1H");
      const m15 = analyzeTF(m15x, "15M");
      const m5 = analyzeTF(m5x, "5M");
      const h4 = analyzeTF(h4x, "4H");
      const m30 = null;
      const early = earlyReversalDiag(m15, m5, m15x, m5x);
      // skor kasar: skip dead pairs sebelum book/OI (hemat API)
      const rough = Math.max(
        early && early.longScore != null ? early.longScore : 0,
        early && early.shortScore != null ? early.shortScore : 0,
        m15 && m15.rsi != null ? (m15.rsi < 38 || m15.rsi > 62 ? 68 : 52) : 52,
        m5 && m5.position != null ? (m5.position <= 30 || m5.position >= 70 ? 66 : 50) : 50
      );
      let funding = 0, rawBook = null, oiSize = null, lsRatio = null, book = null;
      if (rough >= 50) {
        await new Promise((r) => setTimeout(r, 50));
        const pack = await Promise.all([
          positioning.fetchFunding(c.instId),
          fetchOrderBook(c.instId, 15),
          positioning.fetchOpenInterest(c.instId),
          positioning.fetchLongShortRatio(c.instId),
        ]);
        funding = pack[0];
        rawBook = pack[1];
        oiSize = pack[2];
        lsRatio = pack[3];
        book = analyzeOrderBook(rawBook);
      } else {
        book = analyzeOrderBook(null);
        await new Promise((r) => setTimeout(r, 35));
      }

      // === Primary: Early reversal Reversal → MTF → LOC fallback ===
      const regime = getVolatilityRegime(m15x);
      const h2c = candlesTo2H(h1x);
      const h2 = h2c.length >= 20 ? analyzeTF(h2c, "2H") : null;
      let scored = null;
      let tier = "VALID";
      let useExtremeLevels = false;

      // 1) Early reversal (primary — primary early path)
      const erInf = inferEarlyDirection(m15x, m5x);
      if (erInf.direction && erInf.detail) {
        const conf = Math.min(92, Math.round(erInf.detail.score * 100));
        // high-vol: tetap butuh conf tinggi
        const isHigh = regime && (regime.regime === "high" || regime.regime === "extreme");
        const needConf = isHigh ? Math.max(76, adapt.floor) : Math.max(66, adapt.floor - 2);
        if (conf >= needConf) {
          scored = {
            action: erInf.direction,
            probability: Math.max(conf, 80),
            setup: "SCALP_MTF",
            h1, m15, m5, h4,
            trends: { h4: tfTrend(h4), h1: tfTrend(h1), m15: tfTrend(m15) },
            book, regime: regime || null,
            volConfirm: !!(m5.volume && m5.volume.spike),
            confluence: 4,
            pillars: ["early_reversal", "loc", "exhaust", "trigger"],
            earlyDetail: erInf.detail,
          };
          useExtremeLevels = true;
        }
      }

      // 2) Classic MTF brain
      if (!scored) {
        const kAct = mtfScalpAction(h4, h1, m30, m15, m5, book, regime);
        if (kAct && !kAct.watch) {
          if ((kAct.probability || 0) >= adapt.floor) scored = kAct;
          else {
            watches.push({
              base: c.base,
              action: kAct.action,
              score: kAct.probability,
              setup: "POTENSI",
              reason: "adaptive floor conf " + kAct.probability + "<" + adapt.floor,
            });
            funnel.potensi++;
          }
        } else if (kAct && kAct.watch) {
          watches.push({
            base: c.base,
            action: kAct.action,
            score: kAct.probability,
            setup: "POTENSI",
            reason: kAct.reason,
          });
          funnel.potensi++;
        }
      }
      // 3) LOC extreme fallback
      if (!scored) {
        scored = scalpSignal(h1, m15, m5, h4, book, regime, h2);
      }
      if (!scored) {
        const pot = scalpPotential(h1, m15, m5, h4, book, regime, h2);
        if (pot) {
          let er = pot.reason;
          if (early) {
            const side = pot.action === "LONG" ? "long" : "short";
            const es = pot.action === "LONG" ? early.longScore : early.shortScore;
            const loc = pot.action === "LONG" ? early.longLoc : early.shortLoc;
            const exh = pot.action === "LONG" ? early.longExh : early.shortExh;
            er = (er || "") + ` | early=${es} loc=${loc.toFixed(2)} exh=${exh.toFixed(2)}`;
          }
          watches.push({
            base: c.base,
            action: pot.action,
            score: pot.score,
            setup: "POTENSI",
            reason: er,
            location: pot.location,
            early,
          });
          funnel.potensi++;
        } else {
          funnel.noScore++;
        }
        continue;
      }


      // === Positioning Layer (v3.11) ===
      if (scored && scored.action) {
        const pos = positioning.computePositioningAdj(scored.action, funding, oiSize, lsRatio, book);
        scored.probability = clamp(Math.round((scored.probability || 0) + pos.delta), 0, 99);
        scored.positioning = pos;
        scored.funding = pos.funding;
        if (pos.delta <= -8 && (scored.probability || 0) < MIN_PROB_SNIPER) {
          watches.push({
            base: c.base,
            action: scored.action,
            score: scored.probability,
            setup: scored.setup || "POS",
            reason: "positioning_reject " + (pos.tags || []).join(","),
          });
          funnel.noScore++;
          continue;
        }
      }

      // Data-driven: SHORT historis lemah — butuh conf lebih tinggi
      if (scored.action === "SHORT") {
        watches.push({
          base: c.base,
          action: scored.action,
          score: scored.probability,
          setup: scored.setup || "SCALP_MTF",
          reason: "SHORT = WATCH only (edge VALID off)",
        });
        funnel.potensi++;
        continue;
      }
      // --- v3.3.1 audit gates (INJ-style false positive) ---
      const regName = regime && regime.regime ? regime.regime : "normal";
      if (regName === "high" || regName === "extreme") {
        if ((scored.probability || 0) < 84) {
          watches.push({
            base: c.base,
            action: scored.action,
            score: scored.probability,
            setup: scored.setup || "SCALP_MTF",
            reason: "high-vol: conf " + scored.probability + "<84 → bukan VALID",
          });
          funnel.highVolHold++;
          continue;
        }
      }
      // BTC soft bias: jangan LONG alt saat BTC bearish, jangan SHORT alt saat BTC bullish
      if (btcBias && c.base !== "BTC") {
        const bsc = btcBias.score || 0;
        if (btcBias.bias === "bearish" && bsc <= -20 && scored.action === "LONG") {
          if (bsc <= -35 || (scored.probability || 0) < 90) {
            watches.push({
              base: c.base,
              action: scored.action,
              score: scored.probability,
              setup: scored.setup || "SCALP_MTF",
              reason: "BTC soft bearish (" + bsc + ") — LONG alt ditahan",
            });
            funnel.btcSoftHold++;
            continue;
          }
        }
        if (btcBias.bias === "bullish" && bsc >= 20 && scored.action === "SHORT") {
          if (bsc >= 35 || (scored.probability || 0) < 90) {
            watches.push({
              base: c.base,
              action: scored.action,
              score: scored.probability,
              setup: scored.setup || "SCALP_MTF",
              reason: "BTC soft bullish (" + bsc + ") — SHORT alt ditahan",
            });
            funnel.btcSoftHold++;
            continue;
          }
        }
      }


      // Early-reversal soft bonus — tidak mengoverride high-vol/BTC gate
      if (early && scored) {
        const es = scored.action === "LONG" ? early.longScore : early.shortScore;
        const loc = scored.action === "LONG" ? early.longLoc : early.shortLoc;
        if (es >= 70 && loc >= 0.55 && scored.probability < 90) {
          scored.probability = Math.min(90, scored.probability + 2);
        }
        scored.early = early;
      }

      let levels = null;
      // v3.12: entry utama dari low/high 40×5m (arah tetap dari scored.action)
      levels = buildLevels40Swing(m5x, m15x, scored.action, c.mark, regime);
      if (levels && levels.mode === "WAIT") {
        watches.push({
          base: c.base,
          action: scored.action,
          score: scored.probability,
          setup: scored.setup || "POTENSI",
          reason: levels.reason || "swing40 WAIT",
        });
        funnel.levelsFail++;
        continue;
      }
      if (!levels) {
        if (useExtremeLevels) {
          levels = buildLevelsExtreme(m5x, h1x, scored.action, c.mark, regime);
        }
        if (!levels || levels.mode === "WAIT") {
          levels = buildLevels(m5x, scored, c.mark, regime);
        }
      }
      if (!levels || levels.mode === "WAIT" || !levels.rr || levels.rr < (useExtremeLevels ? 1.5 : MIN_RR)) {
        watches.push({
          base: c.base,
          action: scored.action,
          score: scored.probability,
          setup: "SCALP_15M",
          reason: !levels || levels.mode === "WAIT" ? "belum zona entry" : ("rr<" + MIN_RR + " (rr=" + (levels.rr != null ? levels.rr.toFixed(2) : "?") + ")"),
        });
        funnel.levelsFail++;
        continue;
      }
      const modeStr = String(levels.mode || "");
      if (!modeStr.includes("_ZONE") && !modeStr.includes("_MKT")) {
        watches.push({ base: c.base, action: scored.action, score: scored.probability, setup: "SCALP_15M", reason: "mode entry tidak valid" });
        continue;
      }
      // Market entry only if score kuat
      if (modeStr.includes("_MKT") && scored.probability < 80) {
        watches.push({ base: c.base, action: scored.action, score: scored.probability, setup: "SCALP_15M", reason: "MKT butuh score>=80" });
        continue;
      }

      const evInfo = estimateEV(levels.rr, levels.entry);
      if (!evInfo || evInfo.netRr < 1.0) {
        watches.push({ base: c.base, action: scored.action, score: scored.probability, setup: "SCALP_15M", reason: "EV/netR rendah" });
        continue;
      }

            let riskPct = suggestRisk(regime, scored.probability);

      // v3.10 anti-chase: LONG di puncak range / RSI ekstrem → WATCH saja
      const pos15 = scored.m15 && scored.m15.position != null ? scored.m15.position : 50;
      const rsi15 = scored.m15 && scored.m15.rsi != null ? scored.m15.rsi : 50;
      const pos5 = scored.m5 && scored.m5.position != null ? scored.m5.position : 50;
      if (scored.action === "LONG" && (pos15 >= 98 || rsi15 >= 82 || pos5 >= 99)) {
        watches.push({
          base: c.base,
          action: scored.action,
          score: scored.probability,
          setup: scored.setup || "SCALP_MTF",
          reason: "anti-chase LONG (pos/RSI tinggi pos15=" + pos15.toFixed(0) + " rsi=" + rsi15.toFixed(0) + ")",
        });
        funnel.potensi++;
        continue;
      }

      funnel.valid++;
      const validUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      signals.push({
        strategyId: STRATEGY_ID,
        base: c.base,
        instId: c.instId,
        action: scored.action,
        probability: scored.probability,
        setup: scored.setup,
        validUntil,
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
        score: scored.probability,
        ev: estimateEV(levels.rr, levels.entry),
        confluence: scored.confluence,
        pillars: scored.pillars,
      });
      await new Promise((r) => setTimeout(r, 80));
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

  signals.sort((a, b) => {
    const ca = (a.confluence || 0) + (a.probability || 0) * 0.01;
    const cb = (b.confluence || 0) + (b.probability || 0) * 0.01;
    return cb - ca;
  });
  // Audit: SHORT sample edge lemah — max 2 SHORT VALID per run (keep best)
  const MAX_SHORT = 1;
  const MAX_LONG = 2; // v3.8: jangan buang potensi LONG
  let nS = 0, nL = 0;
  const capped = [];
  for (const s of signals) {
    if (s.action === "SHORT") {
      if (nS >= MAX_SHORT) {
        watches.push({ base: s.base, action: s.action, score: s.probability, setup: s.setup, reason: "cluster cap SHORT (max 2/run)" });
        continue;
      }
      nS++;
    } else {
      if (nL >= MAX_LONG) {
        watches.push({ base: s.base, action: s.action, score: s.probability, setup: s.setup, reason: "cluster cap LONG (max 2/run)" });
        continue;
      }
      nL++;
    }
    capped.push(s);
  }
  if (capped.length < signals.length) {
    console.log("Seleksi cluster: " + signals.length + " → " + capped.length + " VALID (max 2 LONG + 1 SHORT)");
  }
  // Selective: max 3 VALID/run (2L+1S)
  const top = capped.slice(0, 3);
  if (top.length < capped.length) {
    for (const s of capped.slice(3)) {
      watches.push({ base: s.base, action: s.action, score: s.probability, setup: s.setup, reason: "cap total 3 VALID/run" });
    }
  }
  signals.length = 0;
  signals.push(...top);

  watches.sort((a, b) => (b.score || 0) - (a.score || 0));
  if (watches.length > 12) watches.length = 12;
  console.log(`Strict signals (VALID): ${signals.length}`);
  signals.forEach((s) =>
    console.log(
      `  ${s.base} ${s.action} ${s.probability}% ${s.setup} R:R 1:${s.rr.toFixed(1)}` +
        (s.regime ? ` [${s.regime.regime}]` : "") +
        (s.confluence != null ? ` confN=${s.confluence}` : "") + (s.persistent ? " 🔁" : "")
    )
  );

  console.log(`WATCH / POTENSI (bukan entry): ${watches.length}`);
  watches.slice(0, 12).forEach((w) =>
    console.log(
      `  ~ ${w.base} ${w.action} score ${w.score} ${w.setup || ""}` +
        (w.confluence != null ? ` confN=${w.confluence}` : "") +
        (w.reason ? ` — ${w.reason}` : "")
    )
  );

  // === Outcome tracker: evaluate old opens, register new signals ===
  let outcomeLog = loadOutcomeLog();
  try {
    const evaluated = await evaluateOpenOutcomes(outcomeLog);
    outcomeLog = evaluated.log;
    printOutcomeSummary(outcomeLog, evaluated.newlyClosed);
  } catch (e) {
    console.warn("Outcome tracker error:", e.message);
  }

  // A: filter dulu (log belum berisi signal run ini) lalu post, baru register yang lolos
  let postSignals = filterSignalsForDelivery(
    signals.slice(),
    outcomeLog || { open: [], closed: [] }
  );
  if (postSignals.length < signals.length) {
    console.log(`Delivery filter: ${signals.length} → ${postSignals.length} (dedup/expiry)`);
  }
  try {
    const streak = consecutiveLossStreak(outcomeLog);
    // v3.8 SOFT breaker: jangan bunuh semua potensi — izinkan 1 sinyal terbaik conf tinggi
    if (streak >= 4 && postSignals.length) {
      const ranked = postSignals.slice().sort((a, b) => {
        const d = (b.probability || 0) - (a.probability || 0);
        if (d) return d;
        if (a.action === "LONG" && b.action !== "LONG") return -1;
        if (b.action === "LONG" && a.action !== "LONG") return 1;
        return 0;
      });
      let keep = ranked.filter((s) => (s.probability || 0) >= 80 && s.action === "LONG").slice(0, 1);
      if (!keep.length) keep = ranked.filter((s) => (s.probability || 0) >= 90).slice(0, 1);
      const drop = postSignals.filter((s) => !keep.includes(s));
      for (const s of drop) {
        watches.push({
          base: s.base,
          action: s.action,
          score: s.probability,
          setup: s.setup,
          reason: "soft breaker streak=" + streak + " (max 1 LONG conf>=88)",
        });
      }
      postSignals = keep;
      console.log(
        "SOFT CIRCUIT BREAKER: " + streak + " LOSS — post " + keep.length + " LONG conf>=88"
      );
    } else if (streak >= 3 && postSignals.length) {
      const ranked = postSignals.slice().sort((a, b) => (b.probability || 0) - (a.probability || 0));
      const longs = ranked.filter((s) => s.action === "LONG");
      postSignals = (longs.length ? longs : ranked).slice(0, 1);
      console.log("Loss streak " + streak + "/4 — post 1 terbaik (prioritas LONG)");
    } else if (streak > 0) {
      console.log("Loss streak (baseline): " + streak + "/4");
    }
  } catch (e) {
    console.warn("Circuit breaker:", e.message);
  }

  await sendDiscord(postSignals);
  await sendTelegram(postSignals);
  await sendBinanceSquare(postSignals);
  if (typeof sendWatchDiscord === "function") await sendWatchDiscord(watches);
  try {
    outcomeLog = registerNewSignals(outcomeLog || loadOutcomeLog(), postSignals);
    outcomeLog.stats = recomputeStats(outcomeLog.closed, OUTCOME_STATS_AFTER_TS);
    saveOutcomeLog(outcomeLog);
  } catch (e) {
    console.warn("Outcome register error:", e.message);
  }

  console.log(
    `Funnel: scanned=${funnel.scanned} stale=${funnel.stale} noScore=${funnel.noScore} highVol=${funnel.highVolHold} btcSoft=${funnel.btcSoftHold} levelsFail=${funnel.levelsFail} potensi=${funnel.potensi} VALID=${funnel.valid}`
  );
  console.log("Done.");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
