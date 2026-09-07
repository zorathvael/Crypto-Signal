/**
 * Strict Quality Futures Scanner v2.1
 * Discord + Telegram + Binance Square
 */

const OKX = "https://www.okx.com";
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BINANCE_SQUARE_KEY = process.env.BINANCE_SQUARE_OPENAPI_KEY;
const MIN_PROB_VALID = 75;
const MIN_PROB_SNIPER = 82;
const MIN_RR = 2.0;
const CANDIDATE_LIMIT = 24;

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
    headers: { Accept: "application/json", "User-Agent": "StrictCryptoScanner/2.1" },
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

  return {
    label, middle: mid, upper: up, lower: lo, width: w, position: pos, squeeze, bias, biasScore, structure,
    emaBull, emaBear, rsi: rsiV[idx], volume: vol, reversal: rev, ms, macdUp, macdDown,
    meanLong: touchLo && rev.bias === "bullish" && rev.quality >= 0.75 && rsiV[idx] < 35,
    meanShort: touchUp && rev.bias === "bearish" && rev.quality >= 0.75 && rsiV[idx] > 65,
  };
}

function scoreSignal(h1, m15, m5, funding) {
  if (!h1 || !m15 || !m5) return null;
  const h1Bull = h1.bias === "bullish" || (h1.emaBull && h1.ms.trend !== "down");
  const h1Bear = h1.bias === "bearish" || (h1.emaBear && h1.ms.trend !== "up");
  const m15Bull = m15.bias === "bullish" || m15.emaBull;
  const m15Bear = m15.bias === "bearish" || m15.emaBear;

  let action = null;
  if (h1Bull && m15Bull && !h1Bear) action = "LONG";
  if (h1Bear && m15Bear && !h1Bull) action = "SHORT";
  if (!action && m5.meanLong && !h1Bear) action = "LONG";
  if (!action && m5.meanShort && !h1Bull) action = "SHORT";
  if (!action && m5.squeeze && m5.volume.spike) {
    if (m5.volume.pressure > 12 && m5.macdUp && !h1Bear) action = "LONG";
    if (m5.volume.pressure < -12 && m5.macdDown && !h1Bull) action = "SHORT";
  }
  if (!action) return null;
  if (action === "LONG" && m5.bias === "bearish" && m5.biasScore < -30) return null;
  if (action === "SHORT" && m5.bias === "bullish" && m5.biasScore > 30) return null;
  const volOk = m5.volume.spike || Math.abs(m5.volume.pressure) >= 8 || m5.meanLong || m5.meanShort;
  if (!volOk) return null;

  let conf = 50;
  const dir = action === "LONG" ? 1 : -1;
  conf += dir * h1.biasScore * 0.22;
  if (action === "LONG" && h1.emaBull) conf += 8;
  if (action === "SHORT" && h1.emaBear) conf += 8;
  if (action === "LONG" && h1.ms.trend === "up") conf += 6;
  if (action === "SHORT" && h1.ms.trend === "down") conf += 6;
  conf += dir * m15.biasScore * 0.12;
  if (action === "LONG" && m15Bull) conf += 5;
  if (action === "SHORT" && m15Bear) conf += 5;
  conf += dir * m5.biasScore * 0.1;
  if (action === "LONG" && m5.meanLong) conf += 12;
  if (action === "SHORT" && m5.meanShort) conf += 12;
  if (action === "LONG" && m5.macdUp) conf += 5;
  if (action === "SHORT" && m5.macdDown) conf += 5;
  if (action === "LONG" && m5.reversal.bias === "bullish") conf += 6 * m5.reversal.quality;
  if (action === "SHORT" && m5.reversal.bias === "bearish") conf += 6 * m5.reversal.quality;
  if (action === "LONG" && m5.volume.pressure > 10) conf += 7;
  if (action === "SHORT" && m5.volume.pressure < -10) conf += 7;
  if (m5.volume.spike) conf += 4;
  if (action === "LONG" && m5.rsi < 40) conf += 4;
  if (action === "LONG" && m5.rsi > 70) conf -= 8;
  if (action === "SHORT" && m5.rsi > 60) conf += 4;
  if (action === "SHORT" && m5.rsi < 30) conf -= 8;
  if (action === "LONG" && funding < -0.0003) conf += 4;
  if (action === "SHORT" && funding > 0.0003) conf += 4;
  if (m5.squeeze || m15.squeeze) conf += 3;
  if ((action === "LONG" && h1Bull && m15Bull) || (action === "SHORT" && h1Bear && m15Bear)) conf += 6;
  conf = clamp(Math.round(conf), 0, 99);

  let setup = "TREND";
  if (m5.meanLong || m5.meanShort) setup = "MEAN_REV";
  else if (m5.squeeze || m15.squeeze) setup = "SQUEEZE";

  return { action, probability: conf, setup, h1, m15, m5 };
}

function buildLevels(candles, signal, mark) {
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
  } else {
    entry = Math.max(mark, Math.max(swingHigh - atrV * 0.2, m5.upper - atrV * 0.15));
    if (mark > entry) entry = mark;
    entry = Math.max(entry, mark * 0.999);
    sl = Math.max(swingHigh + tick + atrV * 0.45, entry + atrV * 1.1);
    tp1 = m5.middle < entry ? m5.middle : entry - atrV * 1.5;
    tp2 = Math.min(m5.lower * 1.003, entry - atrV * 2.8);
  }
  const risk = Math.abs(entry - sl);
  const rr = risk > 0 ? Math.abs(tp2 - entry) / risk : 0;
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
    `1H ${s.h1.structure} · 15M ${s.m15.bias} · 5M ${s.m5.structure}\n` +
    `Vol ${s.m5.volume.side} · RSI ${Number(s.m5.rsi).toFixed(0)}\n\n` +
    `<i>Strict Scanner · Risk max 0.75% · Not financial advice</i>`
  );
}

function formatSquareMessage(s) {
  const isSniper = s.probability >= MIN_PROB_SNIPER;
  const tag = isSniper ? "SNIPER" : "VALID";
  return (
    `${tag} · ${s.base} ${s.action}\n\n` +
    `Probability: ${s.probability}%\n` +
    `Setup: ${s.setup}\n` +
    `Entry: ${formatPrice(s.entry)}\n` +
    `SL: ${formatPrice(s.sl)}\n` +
    `TP1: ${formatPrice(s.tp1)}\n` +
    `TP2: ${formatPrice(s.tp2)}\n` +
    `R:R 1:${s.rr.toFixed(1)}\n\n` +
    `1H ${s.h1.structure} · 15M ${s.m15.bias} · 5M ${s.m5.structure}\n` +
    `Vol ${s.m5.volume.side} · RSI ${Number(s.m5.rsi).toFixed(0)}\n\n` +
    `Strict Scanner · Risk max 0.75% · NFA\n` +
    `#crypto #futures #${s.base} #${s.action}`
  );
}

async function sendBinanceSquare(signals) {
  if (!BINANCE_SQUARE_KEY) {
    console.log("Binance Square: skip (no BINANCE_SQUARE_OPENAPI_KEY)");
    return;
  }
  if (!signals.length) return;
  for (const s of signals) {
    try {
      const res = await fetch(
        "https://www.binance.com/bapi/composite/v1/public/pgc/openApi/content/add",
        {
          method: "POST",
          headers: {
            "X-Square-OpenAPI-Key": BINANCE_SQUARE_KEY,
            "Content-Type": "application/json",
            clienttype: "binanceSkill",
          },
          body: JSON.stringify({ bodyTextOnly: formatSquareMessage(s) }),
        }
      );
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || String(payload.code) !== "000000") {
        console.error("Binance Square failed:", res.status, payload.code, payload.message || JSON.stringify(payload));
      } else {
        const id = payload.data?.id;
        console.log(
          `Binance Square sent: ${s.base} ${s.action} ${s.probability}%` +
            (id ? ` → https://www.binance.com/square/post/${id}` : "")
        );
      }
    } catch (e) {
      console.error("Binance Square error:", e.message);
    }
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
  for (const s of signals) {
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
      footer: { text: "Strict Scanner · Risk max 0.75% · NFA" },
      timestamp: new Date().toISOString(),
    };
    const res = await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "Strict Scanner", embeds: [embed] }),
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
  console.log("=== Strict Scanner v2.1 (Discord + Telegram + Binance Square) ===");
  console.log(new Date().toISOString());
  console.log(
    "Discord:", DISCORD_WEBHOOK ? "YES" : "NO",
    "| Telegram:", TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? "YES" : "NO",
    "| Square:", BINANCE_SQUARE_KEY ? "YES" : "NO"
  );

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
      const [h1c, m15c, m5c, funding] = await Promise.all([
        fetchOkxCandles(c.instId, "1H", 100),
        fetchOkxCandles(c.instId, "15m", 100),
        fetchOkxCandles(c.instId, "5m", 100),
        fetchFunding(c.instId),
      ]);
      const h1 = analyzeTF(h1c, "1H");
      const m15 = analyzeTF(m15c, "15M");
      const m5 = analyzeTF(m5c, "5M");
      const scored = scoreSignal(h1, m15, m5, funding);
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
      });
    } catch (e) {
      console.warn(`Skip ${c.base}:`, e.message);
    }
  }

  signals.sort((a, b) => b.probability - a.probability);
  console.log(`High quality signals: ${signals.length}`);
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
