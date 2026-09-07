/**
 * Apex Professional Scanner v5.0
 * Structured · Measured · Defensive · Needle + Flow + Regime
 * Production-hardened futures intelligence (OKX public data)
 * Risk note: educational only — not financial advice
 */

const OKX = "https://www.okx.com";
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BINANCE_SQUARE_KEY = process.env.BINANCE_SQUARE_OPENAPI_KEY;

const MIN_PROB_VALID = 75;
const MIN_PROB_SNIPER = 82;
const MIN_RR = 2.0;
const CANDIDATE_LIMIT = 36;
const SQUARE_POST_COUNT = 3;
const MIN_TURNOVER = 2_000_000;
const MAX_ABS_CHG = 28;
const DIR_MARGIN = 10;
const API_RETRIES = 3;

const mean = (a) => {
  if (!a || !a.length) return 0;
  let s = 0, n = 0;
  for (const v of a) {
    if (Number.isFinite(v)) { s += v; n++; }
  }
  return n ? s / n : 0;
};
const clamp = (v, lo, hi) => {
  if (!Number.isFinite(v)) return lo;
  return Math.min(Math.max(v, lo), hi);
};
const finite = (v, fb = 0) => (Number.isFinite(v) ? v : fb);

function formatPrice(v) {
  v = finite(v, NaN);
  if (!Number.isFinite(v)) return "—";
  if (v < 0.000001) return v.toFixed(10);
  if (v < 0.001) return v.toFixed(8);
  if (v < 1) return v.toFixed(5);
  return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getJson(url) {
  let lastErr;
  for (let i = 0; i < API_RETRIES; i++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "ApexScanner/5.0" },
      });
      if (!res.ok) throw new Error(`API ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await sleep(250 * (i + 1));
    }
  }
  throw lastErr || new Error("API failed");
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
  return finite(v, null);
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
  return finite(adxV, null);
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
  return { pressure: finite(pressure), spike, side: pressure > 8 ? "BUY" : pressure < -8 ? "SELL" : "BALANCED", base };
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

function needleState(candles, bands, idx) {
  const last = candles[idx];
  const mid = bands.middle[idx], up = bands.upper[idx], lo = bands.lower[idx];
  if (![mid, up, lo, last.close].every(Number.isFinite)) {
    return { pctB: 50, loc: 50, zone: "EQUILIBRIUM", longAdvantage: 0, mid, up, lo };
  }
  const span = Math.max(up - lo, 1e-12);
  const pctB = clamp(((last.close - lo) / span) * 100, 0, 100);
  const leg = candles.slice(-20);
  const hi = Math.max(...leg.map((c) => c.high));
  const lw = Math.min(...leg.map((c) => c.low));
  const vaSpan = Math.max(hi - lw, 1e-12);
  const loc = clamp(((last.close - lw) / vaSpan) * 100, 0, 100);
  let zone = "EQUILIBRIUM";
  if (pctB <= 22 || loc <= 25) zone = "DISCOUNT";
  else if (pctB >= 78 || loc >= 75) zone = "PREMIUM";
  const longAdvantage = zone === "DISCOUNT" ? 1 : zone === "PREMIUM" ? -1 : 0;
  return { pctB, loc, zone, longAdvantage, mid, up, lo };
}

function flowIntelligence(candles) {
  const n = candles.length;
  if (n < 30) return { delta: 0, control: "BALANCED", whale: "NONE", absorption: false, climax: false, expansion: false };
  const recent = candles.slice(-16);
  const baseVol = mean(candles.slice(-40, -1).map((c) => c.volume)) || 1;
  let buyV = 0, sellV = 0;
  for (const c of recent) {
    if (c.close >= c.open) buyV += c.volume;
    else sellV += c.volume;
  }
  const delta = finite(((buyV - sellV) / (buyV + sellV || 1)) * 100);
  const last = candles[n - 1];
  const range = Math.max(last.high - last.low, 1e-12);
  const atrApprox = mean(candles.slice(-14).map((c) => c.high - c.low)) || range;
  const absorption = last.volume >= baseVol * 1.8 && range <= atrApprox * 0.55;
  const climax = last.volume >= baseVol * 2.4 && range >= atrApprox * 1.6;
  const prior = candles.slice(-12, -1);
  const pHi = Math.max(...prior.map((c) => c.high));
  const pLo = Math.min(...prior.map((c) => c.low));
  const expansion =
    last.volume >= baseVol * 1.5 &&
    ((last.close > pHi && last.close > last.open) || (last.close < pLo && last.close < last.open));
  let whale = "NONE";
  if (climax && last.close < last.open) whale = "DISTRIBUTION";
  else if (climax && last.close > last.open) whale = "ACCUMULATION";
  else if (absorption && delta > 12) whale = "ABSORB_BID";
  else if (absorption && delta < -12) whale = "ABSORB_ASK";
  else if (expansion && last.close > last.open) whale = "BREAKOUT_LONG";
  else if (expansion && last.close < last.open) whale = "BREAKOUT_SHORT";
  else if (last.volume >= baseVol * 1.7 && delta > 20) whale = "AGGRESSIVE_BUY";
  else if (last.volume >= baseVol * 1.7 && delta < -20) whale = "AGGRESSIVE_SELL";
  const control = delta > 15 ? "BUYERS" : delta < -15 ? "SELLERS" : "BALANCED";
  return { delta, control, whale, absorption, climax, expansion, baseVol };
}

function detectRegime(h1, m15, m5, flow, needle) {
  const adx = Math.max(finite(h1.adx), finite(m15.adx));
  const trendUp = h1.ms.trend === "up" && (h1.emaBull || h1.bias === "bullish");
  const trendDn = h1.ms.trend === "down" && (h1.emaBear || h1.bias === "bearish");
  if (flow.climax && needle.zone === "PREMIUM") return "EXHAUSTION_LONG";
  if (flow.climax && needle.zone === "DISCOUNT") return "EXHAUSTION_SHORT";
  if ((m5.squeeze || m15.squeeze) && flow.expansion) return "SQUEEZE_BREAK";
  if (m5.meanLong || (needle.zone === "DISCOUNT" && m5.reversal.bias === "bullish")) return "MEAN_REV_LONG";
  if (m5.meanShort || (needle.zone === "PREMIUM" && m5.reversal.bias === "bearish")) return "MEAN_REV_SHORT";
  if (trendUp && adx >= 22) return "TREND_UP";
  if (trendDn && adx >= 22) return "TREND_DOWN";
  if (adx < 16) return "CHOP";
  return "TRANSITION";
}

function sessionContext() {
  const h = new Date().getUTCHours();
  if (h >= 0 && h < 7) return { name: "ASIA", risk: 0.9 };
  if (h >= 7 && h < 12) return { name: "LONDON", risk: 1.05 };
  if (h >= 12 && h < 16) return { name: "LONDON_NY", risk: 1.1 };
  if (h >= 16 && h < 21) return { name: "NY", risk: 1.0 };
  return { name: "OFF", risk: 0.85 };
}

function analyzeTF(candles, label) {
  if (!candles || candles.length < 60) return null;
  const closes = candles.map((c) => c.close);
  if (closes.some((x) => !Number.isFinite(x))) return null;
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
  if (![mid, up, lo].every(Number.isFinite)) return null;
  const widths = bands.width.filter((v) => v != null);
  const recentW = widths.slice(-20);
  const sortedW = [...widths.slice(-60)].sort((a, b) => a - b);
  const sqThresh = sortedW[Math.floor(sortedW.length * 0.25)] || w;
  const squeeze = (w != null && w <= sqThresh) || (recentW.length >= 15 && w <= Math.min(...recentW) * 1.05);
  const pos = clamp(((last.close - lo) / Math.max(up - lo, 1e-12)) * 100, 0, 100);
  const e9 = ema9[idx], e21 = ema21[idx], e50 = ema50[idx];
  const emaBull = e9 != null && e21 != null && e9 > e21 && (e50 == null || e21 > e50 * 0.998);
  const emaBear = e9 != null && e21 != null && e9 < e21 && (e50 == null || e21 < e50 * 1.002);
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
  const needle = needleState(candles, bands, idx);
  const flow = flowIntelligence(candles);
  return {
    label, middle: mid, upper: up, lower: lo, width: w, position: pos, squeeze, bias, biasScore, structure,
    emaBull, emaBear, rsi: finite(rsiV[idx], 50), volume: vol, reversal: rev, ms, macdUp, macdDown,
    meanLong: touchLo && rev.bias === "bullish" && rev.quality >= 0.75 && rsiV[idx] < 35,
    meanShort: touchUp && rev.bias === "bearish" && rev.quality >= 0.75 && rsiV[idx] > 65,
    adx: adxV, needle, flow,
  };
}

function scoreSignal(h1, m15, m5, funding, btcBias, session) {
  if (!h1 || !m15 || !m5) return null;
  const h1Bull = h1.bias === "bullish" || (h1.emaBull && h1.ms.trend !== "down");
  const h1Bear = h1.bias === "bearish" || (h1.emaBear && h1.ms.trend !== "up");
  const m15Bull = m15.bias === "bullish" || m15.emaBull;
  const m15Bear = m15.bias === "bearish" || m15.emaBear;
  const adxMax = Math.max(finite(h1.adx), finite(m15.adx));
  const vol = m5.volume;
  const flow = m5.flow || { delta: 0, control: "BALANCED", whale: "NONE", climax: false };
  const needle = m5.needle || { zone: "EQUILIBRIUM" };
  const regime = detectRegime(h1, m15, m5, flow, needle);
  const sessMul = session?.risk || 1;
  let longS = 0, shortS = 0;
  if (needle.zone === "DISCOUNT") { longS += 14; shortS -= 6; }
  else if (needle.zone === "PREMIUM") { shortS += 14; longS -= 6; }
  if (flow.control === "BUYERS") longS += 10;
  if (flow.control === "SELLERS") shortS += 10;
  longS += Math.max(0, flow.delta) * 0.12;
  shortS += Math.max(0, -flow.delta) * 0.12;
  const w = flow.whale;
  if (["ACCUMULATION", "ABSORB_BID", "BREAKOUT_LONG", "AGGRESSIVE_BUY"].includes(w)) longS += 12;
  if (["DISTRIBUTION", "ABSORB_ASK", "BREAKOUT_SHORT", "AGGRESSIVE_SELL"].includes(w)) shortS += 12;
  if (flow.climax && needle.zone === "PREMIUM") shortS += 8;
  if (flow.climax && needle.zone === "DISCOUNT") longS += 8;
  if (h1Bull) longS += 16;
  if (h1Bear) shortS += 16;
  if (h1.emaBull) longS += 7;
  if (h1.emaBear) shortS += 7;
  if (h1.ms.trend === "up") longS += 9;
  if (h1.ms.trend === "down") shortS += 9;
  longS += Math.max(0, h1.biasScore) * 0.1;
  shortS += Math.max(0, -h1.biasScore) * 0.1;
  if (m15Bull) longS += 9;
  if (m15Bear) shortS += 9;
  if (m15.emaBull) longS += 4;
  if (m15.emaBear) shortS += 4;
  if (m5.meanLong) longS += 14;
  if (m5.meanShort) shortS += 14;
  if (m5.macdUp) longS += 5;
  if (m5.macdDown) shortS += 5;
  if (m5.reversal.bias === "bullish") longS += 7 * m5.reversal.quality;
  if (m5.reversal.bias === "bearish") shortS += 7 * m5.reversal.quality;
  if (m5.emaBull) longS += 3;
  if (m5.emaBear) shortS += 3;
  if (m5.squeeze || m15.squeeze) {
    if (flow.delta >= 10 && m5.macdUp) longS += 11;
    if (flow.delta <= -10 && m5.macdDown) shortS += 11;
  }
  if (vol.pressure > 6 || (vol.spike && vol.pressure > 0)) longS += 7;
  if (vol.pressure < -6 || (vol.spike && vol.pressure < 0)) shortS += 7;
  if (m5.rsi < 35) longS += 5;
  if (m5.rsi < 28) longS += 3;
  if (m5.rsi > 65) shortS += 5;
  if (m5.rsi > 72) shortS += 3;
  if (m5.rsi > 75) longS -= 10;
  if (m5.rsi < 25) shortS -= 10;
  if (funding < -0.00025) longS += 3;
  if (funding > 0.00025) shortS += 3;
  if (regime === "TREND_UP") { longS += 6; shortS -= 4; }
  if (regime === "TREND_DOWN") { shortS += 6; longS -= 4; }
  if (regime === "MEAN_REV_LONG") longS += 5;
  if (regime === "MEAN_REV_SHORT") shortS += 5;
  if (regime === "SQUEEZE_BREAK") { if (flow.delta > 0) longS += 4; else shortS += 4; }
  if (regime === "EXHAUSTION_LONG") shortS += 5;
  if (regime === "EXHAUSTION_SHORT") longS += 5;
  if (regime === "CHOP") {
    if (!m5.meanLong) longS -= 7;
    if (!m5.meanShort) shortS -= 7;
  }
  if (btcBias && Math.abs(btcBias.score) >= 20) {
    if (btcBias.bias === "bullish") { longS += 5; shortS -= 3; }
    else if (btcBias.bias === "bearish") { shortS += 5; longS -= 3; }
  }
  if (h1Bear) longS -= 11;
  if (h1Bull) shortS -= 11;
  if (m5.bias === "bearish" && m5.biasScore < -35) longS -= 9;
  if (m5.bias === "bullish" && m5.biasScore > 35) shortS -= 9;
  longS *= sessMul;
  shortS *= sessMul;
  longS = clamp(Math.round(longS), 0, 99);
  shortS = clamp(Math.round(shortS), 0, 99);
  let action = null, conf = 0;
  if (longS >= shortS + DIR_MARGIN && longS >= 55) { action = "LONG"; conf = longS; }
  else if (shortS >= longS + DIR_MARGIN && shortS >= 55) { action = "SHORT"; conf = shortS; }
  else return null;
  const isMean = (action === "LONG" && m5.meanLong) || (action === "SHORT" && m5.meanShort);
  const isSq =
    (m5.squeeze || m15.squeeze) &&
    ((action === "LONG" && (flow.delta >= 8 || vol.pressure >= 8)) ||
      (action === "SHORT" && (flow.delta <= -8 || vol.pressure <= -8)));
  const isTrendAligned =
    (action === "LONG" && h1Bull && m15Bull) || (action === "SHORT" && h1Bear && m15Bear);
  if (!isMean && !isSq && !isTrendAligned && conf < 72) return null;
  if (action === "LONG" && flow.delta < -22) return null;
  if (action === "SHORT" && flow.delta > 22) return null;
  if (isTrendAligned) conf = Math.min(99, conf + 4);
  if (isMean) conf = Math.min(99, conf + 3);
  if (isSq) conf = Math.min(99, conf + 3);
  if (needle.zone === "DISCOUNT" && action === "LONG") conf = Math.min(99, conf + 3);
  if (needle.zone === "PREMIUM" && action === "SHORT") conf = Math.min(99, conf + 3);
  conf = clamp(Math.round(conf), 0, 99);
  let setup = "TREND";
  if (isMean || String(regime).startsWith("MEAN_REV")) setup = "MEAN_REV";
  else if (isSq || regime === "SQUEEZE_BREAK") setup = "SQUEEZE";
  else if (String(regime).startsWith("EXHAUSTION")) setup = "EXHAUSTION";
  const thesis = `${needle.zone} · ${flow.control} · ${w !== "NONE" ? w : "flow " + Number(flow.delta).toFixed(0)} · ${regime}`;
  return { action, probability: conf, setup, h1, m15, m5, adx: adxMax, longScore: longS, shortScore: shortS, regime, needleZone: needle.zone, flowControl: flow.control, whale: w, thesis };
}

function buildLevels(candles, signal, mark) {
  mark = finite(mark);
  if (!mark || mark <= 0) return null;
  const atrV = atr(candles) || mark * 0.005;
  const recent = candles.slice(-16);
  const swingLow = Math.min(...recent.map((c) => c.low));
  const swingHigh = Math.max(...recent.map((c) => c.high));
  const tick = Math.max(mark * 0.00008, 1e-12);
  const m5 = signal.m5;
  let entry, sl, tp1, tp2;
  if (signal.action === "LONG") {
    entry = Math.min(mark, Math.min(swingLow + atrV * 0.2, m5.lower + atrV * 0.15));
    if (mark < entry) entry = mark;
    entry = Math.min(entry, mark * 1.001);
    sl = Math.min(swingLow - tick - atrV * 0.45, entry - atrV * 1.1);
    tp1 = m5.middle > entry ? m5.middle : entry + atrV * 1.5;
    tp2 = Math.max(m5.upper * 0.997, entry + atrV * 2.8);
    if (!(sl < entry && entry < tp1 && tp1 <= tp2)) return null;
  } else {
    entry = Math.max(mark, Math.max(swingHigh - atrV * 0.2, m5.upper - atrV * 0.15));
    if (mark > entry) entry = mark;
    entry = Math.max(entry, mark * 0.999);
    sl = Math.max(swingHigh + tick + atrV * 0.45, entry + atrV * 1.1);
    tp1 = m5.middle < entry ? m5.middle : entry - atrV * 1.5;
    tp2 = Math.min(m5.lower * 1.003, entry - atrV * 2.8);
    if (!(tp2 <= tp1 && tp1 < entry && entry < sl)) return null;
  }
  const risk = Math.abs(entry - sl);
  if (!Number.isFinite(risk) || risk <= 0 || risk / mark < 0.001) return null;
  const rr = Math.abs(tp2 - entry) / risk;
  if (!Number.isFinite(rr) || rr < MIN_RR) return null;
  return { entry: finite(entry), sl: finite(sl), tp1: finite(tp1), tp2: finite(tp2), rr: finite(rr) };
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
    `1H ${s.h1.structure} · 15M ${s.m15.bias} · 5M ${s.m5.structure}\n` +
    `Vol ${s.m5.volume.side} · RSI ${Number(s.m5.rsi).toFixed(0)}\n` +
    (s.thesis ? `🧠 ${s.thesis}\n\n` : `\n`) +
    `<i>Apex Scanner v5 · Risk max 0.75% · Not financial advice</i>`
  );
}

function formatSquareCoinBlock(s) {
  const isSniper = s.probability >= MIN_PROB_SNIPER;
  const tag = isSniper ? "SNIPER" : "VALID";
  const side = s.action === "LONG" ? "LONG" : "SHORT";
  const sideMark = s.action === "LONG" ? "🟢" : "🔴";
  return (
    `${tag} · ${s.base} ${sideMark} ${side}\n\n` +
    `Probabilitas: ${s.probability}%\nSetup: ${s.setup}\n` +
    `Entry: ${formatPrice(s.entry)}\nSL: ${formatPrice(s.sl)}\n` +
    `TP1: ${formatPrice(s.tp1)}\nTP2: ${formatPrice(s.tp2)}\n` +
    `R:R 1:${s.rr.toFixed(1)}\n\n` +
    `1H ${s.h1.structure} · 15M ${s.m15.bias} · 5M ${s.m5.structure}\n` +
    `Vol ${s.m5.volume.side} · RSI ${Number(s.m5.rsi).toFixed(0)}` +
    (s.thesis ? `\nThesis: ${s.thesis}` : "")
  );
}

function formatSquareBatchMessage(coins) {
  const header = "Sinyal Ketat Kripto\n";
  const body = coins.map((s) => formatSquareCoinBlock(s)).join("\n\n————————————\n\n");
  const footer = "\n\nRisk max 0.75% per ide · Analisis edukasi, bukan saran finansial.\n#Crypto #Futures #Trading";
  return header + "\n" + body + footer;
}

async function sendBinanceSquare(signals) {
  if (!BINANCE_SQUARE_KEY) { console.log("Binance Square: skip (no key)"); return; }
  const ranked = [...signals].filter((s) => s.probability >= MIN_PROB_VALID).sort((a, b) => b.probability - a.probability || a.base.localeCompare(b.base));
  const batch = ranked.slice(0, SQUARE_POST_COUNT);
  if (!batch.length) { console.log("Binance Square: no Valid signals"); return; }
  console.log(`Binance Square 1 post · ${batch.length} coin(s) → ` + batch.map((s) => `${s.base} ${s.action} ${s.probability}%`).join(", "));
  try {
    const res = await fetch("https://www.binance.com/bapi/composite/v1/public/pgc/openApi/content/add", {
      method: "POST",
      headers: { "X-Square-OpenAPI-Key": BINANCE_SQUARE_KEY, "Content-Type": "application/json", clienttype: "binanceSkill" },
      body: JSON.stringify({ bodyTextOnly: formatSquareBatchMessage(batch) }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || String(payload.code) !== "000000") console.error("Binance Square failed:", res.status, payload.code, payload.message || JSON.stringify(payload));
    else console.log(`Binance Square sent (${batch.length} coins)` + (payload.data?.id ? ` → https://www.binance.com/square/post/${payload.data.id}` : ""));
  } catch (e) { console.error("Binance Square error:", e.message); }
}

async function sendTelegram(signals) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) { console.log("Telegram: skip"); return; }
  if (!signals.length) return;
  for (const s of signals) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: formatTelegramMessage(s), parse_mode: "HTML", disable_web_page_preview: true }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) console.error("Telegram failed:", res.status, JSON.stringify(body));
      else console.log(`Telegram sent: ${s.base} ${s.action} ${s.probability}%`);
    } catch (e) { console.error("Telegram error:", e.message); }
  }
}

async function sendDiscord(signals) {
  if (!DISCORD_WEBHOOK) { console.log("Discord: skip"); return; }
  if (!signals.length) { console.log("No high-quality signals"); return; }
  for (let i = 0; i < signals.length; i++) {
    const s = signals[i];
    if (i > 0) await sleep(400);
    try {
      const isSniper = s.probability >= MIN_PROB_SNIPER;
      const color = s.action === "LONG" ? 0x35ef9a : 0xff5c7a;
      const embed = {
        title: `${isSniper ? "🎯 SNIPER" : "✅ VALID"} · ${s.base} ${s.action}`, color,
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
          { name: "Thesis", value: s.thesis || "—", inline: false },
        ],
        footer: { text: "Apex Scanner v5 · Risk max 0.75% · NFA" },
        timestamp: new Date().toISOString(),
      };
      const res = await fetch(DISCORD_WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "Apex Scanner", embeds: [embed] }) });
      if (!res.ok) console.error("Discord failed:", res.status, await res.text());
      else console.log(`Discord sent: ${s.base} ${s.action} ${s.probability}%`);
    } catch (e) { console.error("Discord error:", e.message); }
  }
}

async function fetchOkxCandles(instId, bar, limit = 100) {
  const url = `${OKX}/api/v5/market/candles?instId=${encodeURIComponent(instId)}&bar=${bar}&limit=${limit}`;
  const data = await getJson(url);
  const list = data?.data || [];
  const candles = list.map((r) => ({ open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5], confirm: String(r[8]) })).filter((c) => [c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite)).reverse();
  if (candles.length && candles[candles.length - 1].confirm === "0") candles.pop();
  return candles;
}

async function fetchFunding(instId) {
  try {
    const data = await getJson(`${OKX}/api/v5/public/funding-rate?instId=${encodeURIComponent(instId)}`);
    return finite(+(data?.data?.[0]?.fundingRate || 0));
  } catch { return 0; }
}

async function main() {
  console.log("=== APEX PROFESSIONAL SCANNER v5.0 ===");
  console.log(new Date().toISOString());
  const session = sessionContext();
  console.log(`Session: ${session.name} (risk x${session.risk})`);
  console.log("Discord:", DISCORD_WEBHOOK ? "YES" : "NO", "| Telegram:", TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? "YES" : "NO", "| Square:", BINANCE_SQUARE_KEY ? "YES" : "NO");
  let btcBias = { bias: "neutral", score: 0 };
  try {
    const btcCandles = await fetchOkxCandles("BTC-USDT-SWAP", "1H", 100);
    const btcTF = analyzeTF(btcCandles, "BTC1H");
    if (btcTF) {
      btcBias = { bias: btcTF.bias, score: btcTF.biasScore, adx: btcTF.adx };
      console.log(`BTC regime (soft): ${btcBias.bias} (score ${btcBias.score}, ADX ${btcBias.adx != null ? Number(btcBias.adx).toFixed(1) : "—"})`);
    }
  } catch (e) { console.warn("BTC bias skip:", e.message); }
  const tickersRes = await getJson(`${OKX}/api/v5/market/tickers?instType=SWAP`);
  const tickers = (tickersRes?.data || []).filter((t) => t.instId && t.instId.endsWith("-USDT-SWAP"));
  const candidates = tickers.map((t) => {
    const last = +t.last || 0;
    const open = +t.open24h || last;
    const baseVol = +t.volCcy24h || 0;
    const turnover = baseVol * last;
    const chg = open ? ((last - open) / open) * 100 : 0;
    if (!Number.isFinite(last) || last <= 0) return null;
    if (turnover < MIN_TURNOVER || Math.abs(chg) > MAX_ABS_CHG) return null;
    const base = t.instId.replace("-USDT-SWAP", "");
    if (!base || /^[0-9]/.test(base) || /UP|DOWN|BEAR|BULL/i.test(base)) return null;
    return { instId: t.instId, base, volume: turnover, change: chg, score: Math.log10(Math.max(turnover, 1)) * 0.65 + Math.min(Math.abs(chg) / 10, 1) * 0.35, mark: last };
  }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, CANDIDATE_LIMIT);
  console.log(`Candidates (${candidates.length}): ${candidates.map((c) => c.base).join(", ")}`);
  const signals = [];
  for (const c of candidates) {
    try {
      const [h1c, m15c, m5c, funding] = await Promise.all([
        fetchOkxCandles(c.instId, "1H", 100), fetchOkxCandles(c.instId, "15m", 100),
        fetchOkxCandles(c.instId, "5m", 100), fetchFunding(c.instId),
      ]);
      if (!h1c?.length || !m15c?.length || !m5c?.length) continue;
      const h1 = analyzeTF(h1c, "1H");
      const m15 = analyzeTF(m15c, "15M");
      const m5 = analyzeTF(m5c, "5M");
      const scored = scoreSignal(h1, m15, m5, funding, btcBias, session);
      if (!scored || scored.probability < MIN_PROB_VALID) continue;
      const levels = buildLevels(m5c, scored, c.mark);
      if (!levels || levels.rr < MIN_RR) continue;
      signals.push({ base: c.base, action: scored.action, probability: scored.probability, setup: scored.setup, entry: levels.entry, sl: levels.sl, tp1: levels.tp1, tp2: levels.tp2, rr: levels.rr, h1: scored.h1, m15: scored.m15, m5: scored.m5, thesis: scored.thesis, regime: scored.regime, whale: scored.whale });
    } catch (e) { console.warn(`Skip ${c.base}:`, e.message); }
  }
  signals.sort((a, b) => b.probability - a.probability);
  console.log(`Apex signals: ${signals.length}`);
  signals.forEach((s) => console.log(`  ${s.base} ${s.action} ${s.probability}% ${s.setup} | ${s.thesis || ""}`));
  await sendDiscord(signals);
  await sendTelegram(signals);
  await sendBinanceSquare(signals);
  console.log("Done.");
}

main().catch((e) => { console.error(e); process.exit(1); });
