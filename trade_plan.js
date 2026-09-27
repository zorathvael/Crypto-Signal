/**
 * Production trade-plan geometry for Crypto-Signal.
 * Margin: 5 USDT. Leverage: integer 5x..20x. Max loss: 0.50 USDT.
 * Targets: 2R / 4R / 6R from the structural SL.
 *
 * Leverage is selected from the structural SL so planned loss stays within
 * the 0.50 USDT budget. A setup requiring less than 5x is rejected.
 * Entry calibration and trade geometry remain separate layers.
 */
const MARGIN_USDT = 5;
const MIN_LEVERAGE = 5;
const MAX_LEVERAGE = 20;
const RISK_MARGIN_PERCENT = 10;
const RISK_FRACTION = 0.10;
const REWARD_R_MULTIPLES = [2, 4, 6];
const EPSILON = 1e-9;

function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function calculateTradePlan(signal) {
  const entry = finitePositive(signal?.entry);
  const sl = finitePositive(signal?.sl);
  if (!entry || !sl) throw new Error("Trade plan requires valid entry and SL");

  const action = String(signal?.action || "LONG").toUpperCase();
  if (action !== "LONG" && action !== "SHORT") {
    throw new Error("Trade plan requires LONG or SHORT action");
  }

  const slDistancePct = Math.abs(entry - sl) / entry;
  if (!(slDistancePct > 0)) throw new Error("Trade plan requires non-zero entry-to-SL distance");

  const riskLimitedLeverage = Math.floor((RISK_FRACTION / slDistancePct) + EPSILON);
  if (riskLimitedLeverage < MIN_LEVERAGE) {
    throw new Error(`SL distance ${(slDistancePct * 100).toFixed(3)}% requires leverage below the 5x minimum`);
  }

  const leverage = Math.min(MAX_LEVERAGE, riskLimitedLeverage);
  const notionalUsdt = MARGIN_USDT * leverage;
  const riskBudgetUsdt = MARGIN_USDT * RISK_FRACTION;
  const maxSlDistancePct = riskBudgetUsdt / notionalUsdt;
  if (slDistancePct > maxSlDistancePct + EPSILON) {
    throw new Error(`SL distance ${(slDistancePct * 100).toFixed(3)}% exceeds the selected ${leverage}x risk geometry`);
  }

  const quantity = notionalUsdt / entry;
  const slLossUsdt = notionalUsdt * slDistancePct;
  const riskPriceDistance = Math.abs(entry - sl);
  const priceTargets = REWARD_R_MULTIPLES.map((r) => {
    const move = riskPriceDistance * r;
    return action === "SHORT" ? entry - move : entry + move;
  });
  const [tp1, tp2, tp3] = priceTargets;

  return {
    marginUsdt: MARGIN_USDT,
    riskFraction: RISK_FRACTION,
    riskMarginPercent: RISK_MARGIN_PERCENT,
    riskBudgetUsdt,
    leverage,
    minLeverage: MIN_LEVERAGE,
    maxLeverage: MAX_LEVERAGE,
    notionalUsdt,
    quantity,
    slDistancePct,
    slDistancePercent: slDistancePct * 100,
    slLossUsdt,
    maxSlDistancePct,
    maxSlDistancePercent: maxSlDistancePct * 100,
    rewardRMultiples: REWARD_R_MULTIPLES.slice(),
    rewardMarginPcts: REWARD_R_MULTIPLES.map((r) => +(r * slDistancePct * 100 * leverage).toFixed(4)),
    rewardPriceMovePcts: REWARD_R_MULTIPLES.map((r) => +(r * slDistancePct * 100).toFixed(6)),
    tp1, tp2, tp3,
    rr: REWARD_R_MULTIPLES[0],
    geometry: "STRUCTURAL_SL_R_MULTIPLE_5_TO_20X",
    entryGeometryIndependent: true,
  };
}

module.exports = { calculateTradePlan };
