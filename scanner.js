/**
 * Strict Core Scanner v2.4.2
 * Clean direction · soft BTC · Square card bright/large (mobile readable)
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

function formatPrice(v) {
  if (!Number.isFinite(v)) return "—";
  if (v < 0.000001) return v.toFixed(10);
  if (v < 0.001) return v.toFixed(8);
  if (v < 1) return v.toFixed(5);
  return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "StrictCore/2.4.2" },
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

// TEMP_RESTORE_MARKER - full file continues via next push if truncated
console.error("INCOMPLETE_RESTORE");
process.exit(1);
