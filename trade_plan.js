/**
 * Production trade-plan geometry for Crypto-Signal.
 *
 * IMPORTANT: Entry calibration and margin geometry are separate layers.
 * entry_calibration.js decides the executable Entry from market/technical
 * evidence. This module starts only after Entry + structural SL exist.
 *
 * Fixed production contract:
 * - Margin: 5 USDT
 * - Leverage: 25x (fixed; never recalibrated)
 * - Notional: 125 USDT
 * - Maximum SL loss: 10% of margin = 0.50 USDT
 * - TP1: +30% of margin = +1.50 USDT
 * - TP2: +60% of margin = +3.00 USDT
 * - TP3: +120% of margin = +6.00 USDT
 *
 * Therefore the corresponding linear price geometry is:
 * - SL: 0.4% from Entry
 * - TP1: 1.2% from Entry
 * - TP2: 2.4% from Entry
 * - TP3: 4.8% from Entry
 *
 * A structural SL wider than 0.4% is rejected instead of silently changing
 * leverage or risk. No order is executed by this module.
 */
const MARGIN_USDT = 5;
const FIXED_LEVERAGE = 25;
const RISK_MARGIN_PERCENT = 10;
const RISK_FRACTION = 0.10;
const REWARD_MARGIN_PCTS = [30, 60, 120];
const EPSILON = 1e-9;

function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function calculateTradePlan(signal) {
  const marginUsdt = MARGIN_USDT;
  const leverage = FIXED_LEVERAGE;
  const entry = finitePositive(signal?.entry);
  const sl = finitePositive(signal?.sl);
  if (!entry || !sl) throw new Error("Trade plan requires valid entry and SL");

  const action = String(signal?.action || "LONG").toUpperCase();
  if (action !== "LONG" && action !== "SHORT") {
    throw new Error("Trade plan requires LONG or SHORT action");
  }

  const slDistancePct = Math.abs(entry - sl) / entry;
  if (!(slDistancePct > 0)) throw new Error("Trade plan requires non-zero entry-to-SL distance");

  const notionalUsdt = marginUsdt * leverage;
  const riskBudgetUsdt = marginUsdt * RISK_FRACTION;
  const maxSlDistancePct = riskBudgetUsdt / notionalUsdt;

  if (slDistancePct > maxSlDistancePct + EPSILON) {
    throw new Error(
      `SL distance ${(slDistancePct * 100).toFixed(3)}% exceeds fixed 25x risk geometry (max ${(maxSlDistancePct * 100).toFixed(3)}%)`
    );
  }

  const quantity = notionalUsdt / entry;
  const slLossUsdt = notionalUsdt * slDistancePct;

  // Linear price movement is intentional. It makes margin reward percentages
  // exact for both LONG and SHORT instead of introducing reciprocal asymmetry.
  const priceTargets = REWARD_MARGIN_PCTS.map((rewardMarginPct) => {
    const priceMovePct = rewardMarginPct / leverage;
    const move = priceMovePct / 100;
    return action === "SHORT"
      ? entry * (1 - move)
      : entry * (1 + move);
  });

  const slExpected = action === "SHORT"
    ? entry * (1 + maxSlDistancePct)
    : entry * (1 - maxSlDistancePct);

  // The supplied structural SL remains the production SL input. This field is
  // diagnostic and shows the exact contract boundary without overwriting it.
  const [tp1, tp2, tp3] = priceTargets;
  return {
    marginUsdt,
    riskFraction: RISK_FRACTION,
    riskMarginPercent: RISK_MARGIN_PERCENT,
    riskBudgetUsdt,
    leverage,
    notionalUsdt,
    quantity,
    slDistancePct,
    slDistancePercent: slDistancePct * 100,
    slLossUsdt,
    maxSlDistancePct,
    maxSlDistancePercent: maxSlDistancePct * 100,
    contractSlPrice: slExpected,
    rewardMarginPcts: REWARD_MARGIN_PCTS.slice(),
    rewardPriceMovePcts: REWARD_MARGIN_PCTS.map((x) => x / leverage),
    tp1,
    tp2,
    tp3,
    geometry: "MARGIN_PERCENT_FIXED_25X",
    entryGeometryIndependent: true,
  };
}

module.exports = { calculateTradePlan };
