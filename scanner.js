/**
 * Crypto-Signal v4.0.0
 * Single production scanner engine:
 * Binance Futures → 8-agent Council → executable geometry → unchanged delivery.
 *
 * Public output is delegated to delivery.js and intentionally remains unchanged.
 */

const fs = require("fs");
const path = require("path");
const { runCouncilEngine } = require("./scanner_engine");
const { calculateTradePlan } = require("./trade_plan");
const {
  sendDiscord,
  sendTelegram,
  sendBinanceSquare,
  sendWatchDiscord,
} = require("./delivery");

const OUTCOME_FILE = path.join(__dirname, "signals-log.json");
const DEDUP_WINDOW_MS = 90 * 60 * 1000;
const SIGNAL_VALID_MS = 15 * 60 * 1000;

function loadOutcomeLog() {
  try {
    if (!fs.existsSync(OUTCOME_FILE)) return { open: [], closed: [], stats: {} };
    const raw = JSON.parse(fs.readFileSync(OUTCOME_FILE, "utf8"));
    return {
      open: Array.isArray(raw.open) ? raw.open : [],
      closed: Array.isArray(raw.closed) ? raw.closed : [],
      stats: raw.stats && typeof raw.stats === "object" ? raw.stats : {},
    };
  } catch {
    return { open: [], closed: [], stats: {} };
  }
}

function saveOutcomeLog(log) {
  try {
    fs.writeFileSync(OUTCOME_FILE, JSON.stringify(log, null, 2));
  } catch (e) {
    console.warn("Outcome log save failed:", e.message);
  }
}

function signalFingerprint(signal) {
  const entry = Number(signal?.entry);
  const rel = value => {
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

function isDuplicateSignal(log, signal, now = Date.now()) {
  const fp = signalFingerprint(signal);
  const hit = item =>
    item &&
    item.base === signal.base &&
    item.action === signal.action &&
    ((item.fingerprint && item.fingerprint === fp) || now - (item.ts || 0) < DEDUP_WINDOW_MS);
  return (log.open || []).some(hit) || (log.closed || []).some(hit);
}

function filterNewSignals(signals, log) {
  const now = Date.now();
  return signals.filter(s => {
    if (s.validUntil && Date.parse(s.validUntil) < now) return false;
    if (isDuplicateSignal(log, s, now)) {
      console.log("Skip duplicate:", s.base, s.action);
      return false;
    }
    return true;
  });
}

function applyProductionGeometry(signals) {
  return signals.map(signal => {
    try {
      const plan = calculateTradePlan(signal);
      return {
        ...signal,
        entry: signal.entry,
        sl: plan.sl,
        tp1: plan.tp1,
        tp2: plan.tp2,
        tp3: plan.tp3,
        rr: plan.rr,
        leverage: plan.leverage,
        marginUsdt: plan.marginUsdt,
        riskMarginPercent: plan.riskMarginPercent,
        rewardMarginPcts: plan.rewardMarginPcts,
        rewardPriceMovePcts: plan.rewardPriceMovePcts,
        geometry: plan.geometry,
      };
    } catch (e) {
      console.warn("NO TRADE", signal.base, signal.action + ":", e.message);
      return null;
    }
  }).filter(Boolean);
}

function registerSignals(log, signals) {
  const now = Date.now();
  for (const s of signals) {
    if (isDuplicateSignal(log, s, now)) continue;
    log.open.push({
      id: s.base + "_" + s.action + "_" + now,
      ts: now,
      base: s.base,
      instId: s.instId,
      action: s.action,
      fingerprint: signalFingerprint(s),
      setup: s.setup,
      probability: s.probability,
      entry: s.entry,
      sl: s.sl,
      tp1: s.tp1,
      tp2: s.tp2,
      tp3: s.tp3,
      rr: s.rr,
      validUntil: s.validUntil || new Date(now + SIGNAL_VALID_MS).toISOString(),
      council: s.council || null,
    });
  }
  return log;
}

async function main() {
  console.log("=== Crypto-Signal v4.0 | Council Engine ===");
  console.log(new Date().toISOString());

  const log = loadOutcomeLog();
  let signals = await runCouncilEngine();

  // The Council is the complete discovery/decision engine. No legacy scanner,
  // TraderSpy discovery, fallback scorer, or second decision tree is executed.
  signals = applyProductionGeometry(signals);
  signals = filterNewSignals(signals, log);

  console.log("NEW VALID:", signals.length);
  for (const s of signals) {
    console.log(
      `  ${s.base} ${s.action} score=${s.probability} entry=${s.entry} SL=${s.sl} TP1=${s.tp1} TP2=${s.tp2} TP3=${s.tp3}`
    );
  }

  const dryRun = String(process.env.TRADERSPY_DRY_RUN || process.env.SCANNER_DRY_RUN || "false").toLowerCase() === "true";
  if (dryRun) {
    console.log("Delivery dry-run: no external posts and no outcome registration.");
    return;
  }

  // Output contract: same three destinations, same signal objects, same Square batching/visual.
  await sendDiscord(signals);
  await sendTelegram(signals);
  await sendBinanceSquare(signals);

  if (typeof sendWatchDiscord === "function") {
    await sendWatchDiscord([]);
  }

  const updated = registerSignals(log, signals);
  saveOutcomeLog(updated);
  console.log("Done.");
}

main().catch(error => {
  console.error("Scanner failed:", error);
  process.exit(1);
});
