/**
 * Telegram trade-plan sizing for Crypto-Signal.
 * Output/sizing only; never executes orders.
 * Default: 5 USDT margin, 10% margin risk budget, 25x max leverage.
 * Leverage is always constrained to 5x–25x. Trades whose SL is too wide
 * to respect the 10% margin risk budget at 5x are rejected instead of
 * silently falling back to 1x.
 */
const MARGIN_USDT = 10;
const RISK_FRACTION = 0.05;
const REWARD_MARGIN_PCTS = [25, 50, 100];
const MIN_LEVERAGE = 5;
const MAX_LEVERAGE = 25;

function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function calculateTradePlan(signal, options = {}) {
  const marginUsdt = finitePositive(options.marginUsdt ?? process.env.TELEGRAM_MARGIN_USDT) ?? MARGIN_USDT;
  const riskFraction = finitePositive(options.riskFraction ?? process.env.TELEGRAM_MARGIN_RISK_FRACTION) ?? RISK_FRACTION;
  const maxLeverage = Math.max(MIN_LEVERAGE, Math.min(MAX_LEVERAGE,
    Math.floor(finitePositive(options.maxLeverage ?? process.env.TELEGRAM_MAX_LEVERAGE) ?? MAX_LEVERAGE)
  ));
  const entry = finitePositive(signal?.entry);
  const sl = finitePositive(signal?.sl);
  if (!entry || !sl) throw new Error("Trade plan requires valid entry and SL");

  const slDistancePct = Math.abs(entry - sl) / entry;
  if (!(slDistancePct > 0)) throw new Error("Trade plan requires non-zero entry-to-SL distance");

  const riskBudgetUsdt = marginUsdt * riskFraction;
  const maxSlDistancePct = riskBudgetUsdt / (marginUsdt * MIN_LEVERAGE);
  if (slDistancePct > maxSlDistancePct + 1e-9) {
    throw new Error(`SL distance ${(slDistancePct * 100).toFixed(3)}% exceeds risk budget at ${MIN_LEVERAGE}x`);
  }

  const rawLeverage = riskBudgetUsdt / (marginUsdt * slDistancePct);
  const leverage = Math.max(MIN_LEVERAGE, Math.min(maxLeverage, Math.floor(rawLeverage)));
  const notionalUsdt = marginUsdt * leverage;
  const slLossUsdt = notionalUsdt * slDistancePct;
  const quantity = notionalUsdt / entry;
  const action = String(signal?.action || "LONG").toUpperCase();
  const rewardMarginPcts = Array.isArray(options.rewardMarginPcts)
    ? options.rewardMarginPcts.map(Number).filter(Number.isFinite)
    : REWARD_MARGIN_PCTS.slice();
  if (!rewardMarginPcts.length || rewardMarginPcts.some((x) => x < 25)) {
    throw new Error("Reward ladder requires at least 25% of margin per target");
  }
  const priceTargets = rewardMarginPcts.map((rewardMarginPct) => {
    const priceMovePct = rewardMarginPct / leverage;
    const multiplier = 1 + priceMovePct / 100;
    return action === "SHORT" ? entry / multiplier : entry * multiplier;
  });
  const [tp1, tp2, tp3] = priceTargets;
  return {
    marginUsdt, riskFraction, riskMarginPercent: riskFraction * 100,
    riskBudgetUsdt, leverage, notionalUsdt, quantity,
    slDistancePct, slDistancePercent: slDistancePct * 100, slLossUsdt,
    rewardMarginPcts, rewardPriceMovePcts: rewardMarginPcts.map((x) => x / leverage),
    tp1, tp2, tp3, geometry: "MARGIN_PERCENT"
  };
}

module.exports = { calculateTradePlan };
