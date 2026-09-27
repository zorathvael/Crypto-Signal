/**
 * Production trade-plan geometry for Crypto-Signal v4.0.
 *
 * Entry calibration and trade geometry are independent layers.
 * This module NEVER calibrates or moves Entry. It receives the already-calibrated
 * Entry and applies the fixed production margin geometry.
 *
 * Fixed contract:
 *   Margin = 5 USDT
 *   Leverage = 25x
 *   Notional = 125 USDT
 *   Max SL loss = 10% of margin = 0.50 USDT
 *   TP1 = 30% margin = 1.50 USDT
 *   TP2 = 60% margin = 3.00 USDT
 *   TP3 = 120% margin = 6.00 USDT
 *
 * At 125 USDT notional: SL max = 0.4%, TP1 = 1.2%, TP2 = 2.4%, TP3 = 4.8%.
 * A structural SL wider than 0.4% is rejected. Leverage is never changed.
 */
const MARGIN_USDT = 5;
const LEVERAGE = 25;
const RISK_MARGIN_PERCENT = 10;
const RISK_BUDGET_USDT = 0.5;
const RISK_FRACTION = 0.10;
const NOTIONAL_USDT = MARGIN_USDT * LEVERAGE;
const MAX_SL_PRICE_PCT = RISK_BUDGET_USDT / NOTIONAL_USDT;
const REWARD_MARGIN_PCTS = [30, 60, 120];
const REWARD_PRICE_MOVE_PCTS = [1.2, 2.4, 4.8];
const EPSILON = 1e-9;

function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function calculateTradePlan(signal = {}) {
  const entry = finitePositive(signal.entry);
  const structuralSl = finitePositive(signal.sl);
  if (!entry || !structuralSl) throw new Error("Trade plan requires valid calibrated entry and structural SL");

  const action = String(signal.action || "LONG").toUpperCase();
  if (action !== "LONG" && action !== "SHORT") throw new Error("Trade plan requires LONG or SHORT action");

  const distancePct = Math.abs(entry - structuralSl) / entry;
  if (!(distancePct > 0)) throw new Error("Trade plan requires non-zero entry-to-SL distance");
  if (distancePct > MAX_SL_PRICE_PCT + EPSILON) {
    throw new Error(`Structural SL distance ${(distancePct * 100).toFixed(3)}% exceeds fixed 25x geometry max ${(MAX_SL_PRICE_PCT * 100).toFixed(3)}%`);
  }

  const sl = action === "SHORT" ? entry * (1 + MAX_SL_PRICE_PCT) : entry * (1 - MAX_SL_PRICE_PCT);
  const targets = REWARD_PRICE_MOVE_PCTS.map((pct) => {
    const move = pct / 100;
    return action === "SHORT" ? entry * (1 - move) : entry * (1 + move);
  });
  const [tp1, tp2, tp3] = targets;
  const quantity = NOTIONAL_USDT / entry;

  return {
    marginUsdt: MARGIN_USDT,
    leverage: LEVERAGE,
    notionalUsdt: NOTIONAL_USDT,
    quantity,
    riskFraction: RISK_FRACTION,
    riskMarginPercent: RISK_MARGIN_PERCENT,
    riskBudgetUsdt: RISK_BUDGET_USDT,
    structuralSl,
    sl,
    slDistancePct: MAX_SL_PRICE_PCT,
    slDistancePercent: MAX_SL_PRICE_PCT * 100,
    slLossUsdt: RISK_BUDGET_USDT,
    maxSlDistancePct: MAX_SL_PRICE_PCT,
    maxSlDistancePercent: MAX_SL_PRICE_PCT * 100,
    rewardMarginPcts: REWARD_MARGIN_PCTS.slice(),
    rewardPriceMovePcts: REWARD_PRICE_MOVE_PCTS.slice(),
    rewardRMultiples: [3, 6, 12],
    tp1, tp2, tp3,
    rr: 3,
    geometry: "FIXED_MARGIN_5USDT_25X_10_30_60_120",
    entryGeometryIndependent: true,
    entryUnchanged: true,
  };
}

module.exports = { calculateTradePlan, MARGIN_USDT, LEVERAGE, RISK_MARGIN_PERCENT, RISK_BUDGET_USDT, REWARD_MARGIN_PCTS };
