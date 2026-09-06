/**
 * Strict Quality Crypto Futures Scanner
 * Data: Bybit Linear (GitHub Actions cannot reach Binance - HTTP 451)
 * Alerts: Discord via DISCORD_WEBHOOK secret
 */

const BYBIT = "https://api.bybit.com";
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const MIN_PROB_VALID = 75;
const MIN_PROB_SNIPER = 82;
const MIN_RR = 2.0;

const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

function formatPrice(v) {
  if (!Number.isFinite(v)) return "—";
  if (v < 0.000001) return v.toFixed(10);
  if (v < 0.001) return v.toFixed(8);
  if (v < 1) return v.toFixed(5);
  return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`API ${res.status} ${url}`);
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
function atr(candles, period = 14) {
  const ranges = candles.map((c, i) => {
    if (!i) return c.high - c.low;
    const prev = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
  });
  if (ranges.length < period) return null;
  let v = mean(ranges.slice(0, period));
  for (let i = period; i < ranges.length; i++) v = (v * (period - 1) + ranges[i]) / period;
  return v;
}
function volumeAnalysis(candles) {
  const cur = candles.at(-1);
  const recent = candles.slice(-12);
  const base = mean(candles.slice(-25, -1).map((c) => c.volume));
  const buy = recent.reduce((s, c) => s + (c.close > c.open ? c.volume : 0), 0);
  const sell = recent.reduce((s, c) => s + (c.close <= c.open ? c.volume : 0), 0);
  const pressure = ((buy - sell) / (buy + sell || 1)) * 100;
  const recentAvg = mean(recent.slice(-3).map((c) => c.volume));
  const spike = cur.volume >= base * 1.5 || recentAvg >= base * 1.4;
  return { pressure, spike, side: pressure > 10 ? "BUY" : pressure < -10 ? "SELL" : "BALANCED" };
}
function detectReversal(candles) {
  const last = candles.at(-1);
  const prev = candles.at(-2);
  const body = Math.abs(last.close - last.open);
  const range = Math.max(last.high - last.low, 1e-12);
  const uw = last.high - Math.max(last.open, last.close);
  const lw = Math.min(last.open, last.close) - last.low;
  if (prev.close < prev.open && last.close > last.open && last.open <= prev.close && last.close >= prev.open)
    return { bias: "bullish", quality: 0.95, name: "Bullish Engulfing" };
  if (prev.close > prev.open && last.close < last.open && last.open >= prev.close && last.close <= prev.open)
    return { bias: "bearish", quality: 0.95, name: "Bearish Engulfing" };
  if (lw >= body * 2.2 && uw <= body * 0.7 && last.close > last.open)
    return { bias: "bullish", quality: 0.85, name: "Hammer" };
  if (uw >= body * 2.2 && lw <= body * 0.7 && last.close < last.open)
    return { bias: "bearish", quality: 0.85, name: "Rejection" };
  if (lw >= range * 0.6 && last.close >= last.open) return { bias: "bullish", quality: 0.8, name: "Pin Bar" };
  if (uw >= range * 0.6 && last.close <= last.open) return { bias: "bearish", quality: 0.8, name: "Pin Bar" };
  return { bias: "neutral", quality: 0, name: "None" };
}
function analyzeTF(candles, label) {
  if (!candles || candles.length < 60) return null;
  const closes = candles.map((c) => c.close);
  const bands = bollinger(closes);
  const rsiV = rsi(closes);
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const idx = candles.length - 1;
  const last = candles[idx];
  const mid = bands.middle[idx], up = bands.upper[idx], lo = bands.lower[idx], w = bands.width[idx];
  const widths = bands.width.slice(-60).filter((v) => v != null).sort((a, b) => a - b);
  const sqThresh = widths[Math.floor(widths.length * 0.25)] || w;
  const recentW = bands.width.slice(-20).filter((v) => v != null);
  const squeeze20 = recentW.length >= 20 && w <= Math.min(...recentW);
  const squeeze = w <= sqThresh || squeeze20;
  const pos = clamp(((last.close - lo) / Math.max(up - lo, 1e-12)) * 100, 0, 100);
  const emaBull = ema9[idx] > ema21[idx];
  const emaBear = ema9[idx] < ema21[idx];
  const vol = volumeAnalysis(candles);
  const rev = detectReversal(candles);
  const touchLo = last.low <= lo * 1.002 || last.close <= lo * 1.004;
  const touchUp = last.high >= up * 0.998 || last.close >= up * 0.996;
  const recentLo = candles.slice(-21, -1).map((c) => c.low);
  const recentHi = candles.slice(-21, -1).map((c) => c.high);
  const support = Math.min(...recentLo), resist = Math.max(...recentHi);
  const nearSup = last.low <= support * 1.002;
  const nearRes = last.high >= resist * 0.998;
  const bias = pos < 32 ? "bullish" : pos > 68 ? "bearish" : emaBull ? "bullish" : emaBear ? "bearish" : "neutral";
  const structure = squeeze ? "SQUEEZE" : pos <= 8 ? "NEAR LOWER" : pos >= 92 ? "NEAR UPPER" : "RANGE";
  return {
    label, middle: mid, upper: up, lower: lo, width: w, position: pos, squeeze, bias, structure,
    emaBull, emaBear, priceAboveMid: last.close > mid, priceBelowMid: last.close < mid,
    rsi: rsiV[idx], volume: vol, reversal: rev, touchLower: touchLo, touchUpper: touchUp,
    nearSupport: nearSup, nearResistance: nearRes,
    meanLong: touchLo && rev.quality >= 0.75 && rsiV[idx] < 32 && nearSup,
    meanShort: touchUp && rev.quality >= 0.75 && rsiV[idx] > 68 && nearRes,
  };
}
function scoreSignal(h1, m15, m5, funding) {
  if (!h1 || !m15 || !m5) return null;
  const majorBull = h1.bias === "bullish" && h1.emaBull && h1.priceAboveMid;
  const majorBear = h1.bias === "bearish" && h1.emaBear && h1.priceBelowMid;
  if (!m5.volume.spike && Math.abs(m5.volume.pressure) < 10) return null;
  let s1 = 40;
  if (majorBull) s1 = 92;
  else if (h1.bias === "bullish" && h1.emaBull) s1 = 72;
  else if (h1.bias === "bullish") s1 = 55;
  else if (majorBear) s1 = 8;
  else if (h1.bias === "bearish" && h1.emaBear) s1 = 28;
  else if (h1.bias === "bearish") s1 = 45;
  let s15 = 45;
  if (m15.bias === "bullish" || (m15.structure === "RANGE" && m15.position < 40)) s15 = 78;
  else if (m15.bias === "bearish" || (m15.structure === "RANGE" && m15.position > 60)) s15 = 22;
  if (m15.structure === "SQUEEZE") s15 = 55;
  let s5 = 40;
  if (m5.meanLong) s5 = 90;
  else if (m5.meanShort) s5 = 10;
  else if (m5.squeeze && m5.volume.spike && m5.volume.pressure > 10) s5 = 82;
  else if (m5.squeeze && m5.volume.spike && m5.volume.pressure < -10) s5 = 18;
  else if (m5.emaBull) s5 = 65;
  else if (m5.emaBear) s5 = 35;
  let sVol = 40;
  if (m5.volume.spike && m5.volume.pressure > 15) sVol = 88;
  else if (m5.volume.spike && m5.volume.pressure > 8) sVol = 70;
  else if (m5.volume.spike && m5.volume.pressure < -15) sVol = 12;
  else if (m5.volume.spike && m5.volume.pressure < -8) sVol = 30;
  if (funding < -0.0004) sVol = Math.min(95, sVol + 12);
  if (funding > 0.0004) sVol = Math.max(5, sVol - 12);
  let sMom = 45;
  if (m5.rsi < 28) sMom = 78;
  if (m5.rsi > 72) sMom = 22;
  let sStruct = 50;
  if (m5.squeeze || m15.squeeze) sStruct = 70;
  if (h1.structure === "NEAR UPPER" && majorBull) sStruct = 80;
  if (h1.structure === "NEAR LOWER" && majorBear) sStruct = 20;
  const prob = clamp(s1 * 0.28 + s15 * 0.15 + s5 * 0.24 + sVol * 0.18 + sMom * 0.1 + sStruct * 0.05, 0, 100);
  let direction = "NEUTRAL";
  if (prob >= 62 && majorBull) direction = "BULLISH";
  if (prob <= 38 && majorBear) direction = "BEARISH";
  if (direction === "BULLISH" && !majorBull) direction = "NEUTRAL";
  if (direction === "BEARISH" && !majorBear) direction = "NEUTRAL";
  if (direction === "NEUTRAL") return null;
  return { direction, action: direction === "BULLISH" ? "LONG" : "SHORT", probability: Math.round(prob), h1, m15, m5 };
}
function buildLevels(candles, signal, mark) {
  const atrV = atr(candles) || mark * 0.005;
  const recent = candles.slice(-14);
  const swingLow = Math.min(...recent.map((c) => c.low));
  const swingHigh = Math.max(...recent.map((c) => c.high));
  const tick = Math.max(mark * 0.0001, 1e-12);
  const m5 = signal.m5;
  let entry, sl, tp1, tp2;
  if (signal.action === "LONG") {
    entry = Math.min(swingLow + atrV * 0.25, m5.lower + atrV * 0.2);
    if (mark < entry * 1.01) entry = Math.min(entry, mark * 0.997);
    sl = Math.min(swingLow - tick - atrV * 0.5, entry - atrV * 1.2);
    tp1 = m5.middle > entry ? m5.middle : entry + atrV * 1.6;
    tp2 = Math.max(m5.upper * 0.995, entry + atrV * 3.0);
  } else {
    entry = Math.max(swingHigh - atrV * 0.25, m5.upper - atrV * 0.2);
    if (mark > entry * 0.99) entry = Math.max(entry, mark * 1.003);
    sl = Math.max(swingHigh + tick + atrV * 0.5, entry + atrV * 1.2);
    tp1 = m5.middle < entry ? m5.middle : entry - atrV * 1.6;
    tp2 = Math.min(m5.lower * 1.005, entry - atrV * 3.0);
  }
  const risk = Math.abs(entry - sl);
  const rr = risk > 0 ? Math.abs(tp2 - entry) / risk : 0;
  return { entry, sl, tp1, tp2, rr };
}
async function sendDiscord(signals) {
  if (!DISCORD_WEBHOOK) {
    console.log("No DISCORD_WEBHOOK secret — skip Discord");
    return;
  }
  if (!signals.length) {
    console.log("No high-quality signals to send");
    return;
  }
  for (const s of signals) {
    const isSniper = s.probability >= MIN_PROB_SNIPER;
    const color = s.action === "LONG" ? 0x35ef9a : 0xff5c7a;
    const embed = {
      title: `${isSniper ? "🎯 SNIPER" : "✅ VALID"} · ${s.base} ${s.action}`,
      color,
      fields: [
        { name: "Probability", value: `**${s.probability}%**`, inline: true },
        { name: "Optimal Entry", value: `$${formatPrice(s.entry)}`, inline: true },
        { name: "R:R", value: `1:${s.rr.toFixed(1)}`, inline: true },
        { name: "Stop Loss", value: `$${formatPrice(s.sl)}`, inline: true },
        { name: "TP1", value: `$${formatPrice(s.tp1)}`, inline: true },
        { name: "TP2", value: `$${formatPrice(s.tp2)}`, inline: true },
        { name: "1H", value: s.h1.structure, inline: true },
        { name: "5M", value: s.m5.structure, inline: true },
        { name: "Volume", value: s.m5.volume.side, inline: true },
      ],
      footer: { text: "Strict Scanner · Bybit · GitHub Actions · Risk max 0.75%" },
      timestamp: new Date().toISOString(),
    };
    const res = await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "Strict Crypto Scanner", embeds: [embed] }),
    });
    if (!res.ok) console.error("Discord failed:", res.status, await res.text());
    else console.log(`Discord sent: ${s.base} ${s.action} ${s.probability}%`);
  }
}

/** Bybit kline: list is newest-first → reverse, drop incomplete last bar after reverse */
async function fetchBybitKlines(symbol, interval, limit = 100) {
  const url = `${BYBIT}/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const data = await getJson(url);
  const list = data?.result?.list || [];
  const candles = list
    .map((r) => ({
      open: +r[1],
      high: +r[2],
      low: +r[3],
      close: +r[4],
      volume: +r[5],
    }))
    .reverse();
  // drop last (possibly forming)
  return candles.length > 1 ? candles.slice(0, -1) : candles;
}

async function main() {
  console.log("=== Strict Crypto Scanner (Bybit + GitHub Actions) ===");
  console.log(new Date().toISOString());
  console.log("Discord secret:", DISCORD_WEBHOOK ? "YES" : "NO (set DISCORD_WEBHOOK in repo secrets)");

  const tickersRes = await getJson(`${BYBIT}/v5/market/tickers?category=linear`);
  const tickers = (tickersRes?.result?.list || []).filter((t) => t.symbol.endsWith("USDT"));

  const candidates = tickers
    .map((t) => {
      const turnover = +t.turnover24h || 0;
      const chg = Math.abs(+t.price24hPcnt || 0) * 100;
      if (turnover < 5_000_000 || chg > 25) return null;
      return {
        symbol: t.symbol,
        base: t.symbol.replace("USDT", ""),
        volume: turnover,
        change: (+t.price24hPcnt || 0) * 100,
        score: Math.log10(Math.max(turnover, 1)) * 0.6 + Math.min(chg / 8, 1) * 0.4,
        mark: +t.markPrice || +t.lastPrice,
        funding: +t.fundingRate || 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);

  console.log(`Candidates: ${candidates.map((c) => c.base).join(", ")}`);

  const signals = [];
  for (const c of candidates) {
    try {
      const [h1c, m15c, m5c] = await Promise.all([
        fetchBybitKlines(c.symbol, "60", 100),
        fetchBybitKlines(c.symbol, "15", 100),
        fetchBybitKlines(c.symbol, "5", 100),
      ]);
      const h1 = analyzeTF(h1c, "1H");
      const m15 = analyzeTF(m15c, "15M");
      const m5 = analyzeTF(m5c, "5M");
      const scored = scoreSignal(h1, m15, m5, c.funding);
      if (!scored || scored.probability < MIN_PROB_VALID) continue;
      const levels = buildLevels(m5c, scored, c.mark);
      if (levels.rr < MIN_RR) continue;
      signals.push({
        base: c.base,
        symbol: c.symbol,
        action: scored.action,
        probability: scored.probability,
        entry: levels.entry,
        sl: levels.sl,
        tp1: levels.tp1,
        tp2: levels.tp2,
        rr: levels.rr,
        h1: scored.h1,
        m15: scored.m15,
        m5: scored.m5,
        change: c.change,
      });
    } catch (e) {
      console.warn(`Skip ${c.base}:`, e.message);
    }
  }

  signals.sort((a, b) => b.probability - a.probability);
  console.log(`High quality signals: ${signals.length}`);
  signals.forEach((s) => console.log(`  ${s.base} ${s.action} ${s.probability}% R:R 1:${s.rr.toFixed(1)}`));
  await sendDiscord(signals);
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
