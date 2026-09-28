/**
 * Entry / Timing Calibration — ENTRY NOW execution semantics.
 *
 * This layer owns timing only:
 *   - Entry = current live market price (ENTRY NOW).
 *   - structuralSl = nearby directional support/resistance used to validate timing.
 *   - timing score/mode.
 *
 * It NEVER calculates or changes leverage, margin, executable SL or TP.
 * Trade Geometry remains the sole owner of the fixed 20x risk/reward contract.
 *
 * Directional structure:
 *   LONG  -> support below live price.
 *   SHORT -> resistance above live price.
 *
 * A structural level outside the fixed 0.5% price-risk envelope is unusable.
 * No limit-style pullback entry is synthesized from that structure.
 */
const MAX_PRICE_RISK_PCT = 0.005;
const MIN_GEOMETRY_CAPACITY_ATR = 0.10;
const EPSILON = 1e-12;

function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

function normalizeLevels(values, direction, livePrice) {
  if (!Array.isArray(values) || !Number.isFinite(livePrice) || livePrice <= 0) return [];
  const levels = values
    .map(finitePositive)
    .filter(Boolean)
    .filter((x) => direction === "LONG" ? x < livePrice : x > livePrice);
  return [...new Set(levels.map((x) => +x.toFixed(12)))]
    .sort((a, b) => direction === "LONG" ? b - a : a - b);
}

function calibrateEntry(input = {}) {
  const action = String(input.action || "").toUpperCase();
  if (action !== "LONG" && action !== "SHORT") {
    return { pass: false, entry: null, score: 0, reasons: ["invalid direction"] };
  }

  const livePrice = finitePositive(input.livePrice);
  const technicalPrice = finitePositive(input.technicalPrice);
  const atr = finitePositive(input.atr);
  if (!livePrice || !technicalPrice || !atr) {
    return { pass: false, entry: null, score: 0, reasons: ["entry calibration data unavailable"] };
  }

  const maxRiskPrice = livePrice * MAX_PRICE_RISK_PCT;
  const geometryCapacityAtr = maxRiskPrice / atr;
  const technicalDistanceAtr = Math.abs(technicalPrice - livePrice) / atr;

  if (geometryCapacityAtr < MIN_GEOMETRY_CAPACITY_ATR) {
    return {
      pass: false,
      entry: livePrice,
      score: 0,
      distanceAtr: 0,
      geometryCapacityAtr: +geometryCapacityAtr.toFixed(3),
      geometryUse: 0,
      mode: "REJECT_VOLATILITY_CAPACITY",
      reasons: ["fixed geometry covers less than 10% of observed ATR"],
    };
  }

  const supports = normalizeLevels(input.supports, "LONG", livePrice);
  const resistances = normalizeLevels(input.resistances, "SHORT", livePrice);
  const levels = action === "LONG" ? supports : resistances;

  // ENTRY NOW: never move Entry to a support/resistance pullback level.
  // Structure is used only as timing/structural-SL evidence.
  const usableLevels = levels.filter((level) => {
    const distance = Math.abs(livePrice - level);
    return distance <= maxRiskPrice + EPSILON;
  });

  if (!usableLevels.length) {
    return {
      pass: false,
      entry: livePrice,
      score: 0,
      distanceAtr: 0,
      technicalDistanceAtr: +technicalDistanceAtr.toFixed(3),
      geometryCapacityAtr: +geometryCapacityAtr.toFixed(3),
      geometryUse: 0,
      mode: "REJECT_NO_EXECUTABLE_STRUCTURE",
      reasons: [
        action === "LONG"
          ? "no support below live price inside fixed 0.5% timing envelope"
          : "no resistance above live price inside fixed 0.5% timing envelope",
      ],
    };
  }

  const structuralLevel = usableLevels[0];
  const structuralDistancePrice = Math.abs(livePrice - structuralLevel);
  const structuralDistanceAtr = structuralDistancePrice / atr;
  const structureUse = structuralDistancePrice / Math.max(maxRiskPrice, EPSILON);

  // Entry is exactly the live market price. GeometryUse for Entry is therefore
  // zero by construction; structural utilisation is tracked separately.
  const entry = livePrice;
  const entryDistanceAtr = 0;
  const proximityScore = 100;
  const structureScore = clamp(
    100 * (1 - structuralDistancePrice / Math.max(maxRiskPrice, EPSILON)),
    0,
    100,
  );
  const geometryScore = 100;
  const score = Math.round(
    0.50 * proximityScore +
    0.30 * structureScore +
    0.20 * geometryScore,
  );

  return {
    pass: score >= 55,
    entry,
    score,
    mode: action === "LONG" ? "ENTRY_NOW_SUPPORT" : "ENTRY_NOW_RESISTANCE",
    structuralLevel,
    distanceAtr: +entryDistanceAtr.toFixed(3),
    technicalDistanceAtr: +technicalDistanceAtr.toFixed(3),
    structuralDistanceAtr: +structuralDistanceAtr.toFixed(3),
    geometryCapacityAtr: +geometryCapacityAtr.toFixed(3),
    geometryUse: 0,
    structuralGeometryUse: +structureUse.toFixed(3),
    maxRiskPricePct: MAX_PRICE_RISK_PCT,
    reasons: [
      "ENTRY NOW uses current live price; structure is timing/structural-SL evidence only",
      action === "LONG"
        ? "support is below live price and inside the fixed geometry envelope"
        : "resistance is above live price and inside the fixed geometry envelope",
    ],
  };
}

module.exports = { calibrateEntry, MAX_PRICE_RISK_PCT, MIN_GEOMETRY_CAPACITY_ATR };
