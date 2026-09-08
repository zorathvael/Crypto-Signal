/**
 * Strict Core Scanner v2.4.3
 * Clean direction · soft BTC · Ichimoku confirmation (9/26/52)
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
const MIN_RR = 2.0;
const CANDIDATE_LIMIT = 36;
const SQUARE_POST_COUNT = 3;

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/** Ichimoku Cloud — classic 9 / 26 / 52 (confirmation only, never sole direction) */
function donchianMid(candles, endIdx, period) {
  if (endIdx - period + 1 < 0) return null;
  let hi = -Infinity, lo = Infinity;
  for (let i = endIdx - period + 1; i <= endIdx; i++) {
    if (candles[i].high > hi) hi = candles[i].high;
    if (candles[i].low < lo) lo = candles[i].low;
  }
  return (hi + lo) / 2;
}

function ichimoku(candles, tenkanP = 9, kijunP = 26, senkouP = 52, disp = 26) {
  const n = candles.length;
  if (!candles || n < senkouP + disp + 2) {
    return { ok: false, bias: "neutral", score: 0, cloudPos: "NA", tk: "FLAT", cloud: "FLAT", chikou: "NA", label: "Ichimoku n/a" };
  }
  const idx = n - 1;
  const tenkan = donchianMid(candles, idx, tenkanP);
  const kijun = donchianMid(candles, idx, kijunP);
  const tenkanPrev = donchianMid(candles, idx - 1, tenkanP);
  const kijunPrev = donchianMid(candles, idx - 1, kijunP);
  const base = idx - disp;
  const tenkanBase = donchianMid(candles, base, tenkanP);
  const kijunBase = donchianMid(candles, base, kijunP);
  const senkouA = tenkanBase != null && kijunBase != null ? (tenkanBase + kijunBase) / 2 : null;
  const senkouB = donchianMid(candles, base, senkouP);
  const price = candles[idx].close;
  let cloudPos = "INSIDE";
  if (senkouA != null && senkouB != null) {
    const top = Math.max(senkouA, senkouB);
    const bot = Math.min(senkouA, senkouB);
    if (price > top) cloudPos = "ABOVE";
    else if (price < bot) cloudPos = "BELOW";
  }
  let tk = "FLAT";
  if (tenkan != null && kijun != null) {
    if (tenkan > kijun) tk = "BULL";
    else if (tenkan < kijun) tk = "BEAR";
  }
  let tkCross = null;
  if (tenkan != null && kijun != null && tenkanPrev != null && kijunPrev != null) {
    if (tenkanPrev <= kijunPrev && tenkan > kijun) tkCross = "BULL";
    if (tenkanPrev >= kijunPrev && tenkan < kijun) tkCross = "BEAR";
  }
  const cloud = senkouA != null && senkouB != null
    ? (senkouA > senkouB ? "BULL" : senkouA < senkouB ? "BEAR" : "FLAT")
    : "FLAT";
  let chikou = "NA";
  const past = candles[idx - disp];
  if (past) {
    if (price > past.close) chikou = "BULL";
    else if (price < past.close) chikou = "BEAR";
    else chikou = "FLAT";
  }
  let score = 0;
  if (cloudPos === "ABOVE") score += 28;
  if (cloudPos === "BELOW") score -= 28;
  if (tk === "BULL") score += 18;
  if (tk === "BEAR") score -= 18;
  if (tkCross === "BULL") score += 12;
  if (tkCross === "BEAR") score -= 12;
  if (cloud === "BULL") score += 12;
  if (cloud === "BEAR") score -= 12;
  if (chikou === "BULL") score += 14;
  if (chikou === "BEAR") score -= 14;
  if (kijun != null) {
    if (price > kijun) score += 8;
    if (price < kijun) score -= 8;
  }
  score = clamp(score, -100, 100);
  const bias = score >= 22 ? "bullish" : score <= -22 ? "bearish" : "neutral";
  const label = `Cloud ${cloudPos} · TK ${tk}${tkCross ? " X" + tkCross : ""} · Kumo ${cloud} · Chi ${chikou}`;
  return {
    ok: true, tenkan, kijun, senkouA, senkouB, cloudPos, tk, tkCross, cloud, chikou, bias, score, label,
  };
}
