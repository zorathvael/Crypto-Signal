/**
 * Telegram trade-plan sizing for Crypto-Signal.
 * Output/sizing only; never executes orders.
 * Default: 5 USDT margin, 10% margin risk budget, 20x max leverage.
 */
const MARGIN_USDT = 5;
const RISK_FRACTION = 0.10;
const MAX_LEVERAGE = 20;
const MIN_LEVERAGE = 5;

function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function calculateTradePlan(signal, options = {}) {
  const marginUsdt = finitePositive(options.marginUsdt ?? process.env.TELEGRAM_MARGIN_USDT) ?? MARGIN_USDT;
  const riskFraction = finitePositive(options.riskFraction ?? process.env.TELEGRAM_MARGIN_RISK_FRACTION) ?? RISK_FRACTION;
  const maxLeverage = Math.max(MIN_LEVERAGE, Math.floor(finitePositive(options.maxLeverage ?? process.env.TELEGRAM_MAX_LEVERAGE) ?? MAX_LEVERAGE));
  const entry = finitePositive(signal?.entry);
  const sl = finitePositive(signal?.sl);
  if (!entry || !sl) throw new Error("Trade plan requires valid entry and SL");

  const slDistancePct = Math.abs(entry - sl) / entry;
  if (!(slDistancePct > 0)) throw new Error("Trade plan requires non-zero entry-to-SL distance");

  const riskBudgetUsdt = marginUsdt * riskFraction;
  const rawLeverage = riskBudgetUsdt / (marginUsdt * slDistancePct);
  const leverage = Math.max(MIN_LEVERAGE, Math.min(maxLeverage, Math.round(rawLeverage)));
  const notionalUsdt = marginUsdt * leverage;
  const slLossUsdt = notionalUsdt * slDistancePct;
  const quantity = notionalUsdt / entry;

  return {
    marginUsdt, riskFraction, riskBudgetUsdt, leverage, notionalUsdt,
    quantity, slDistancePct, slDistancePercent: slDistancePct * 100, slLossUsdt
  };
}

module.exports = { calculateTradePlan };
