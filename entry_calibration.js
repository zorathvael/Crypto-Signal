/**
 * Entry Calibration — geometry-aware, data-derived entry selection.
 *
 * This layer determines ONLY the executable Entry.
 * It does not calculate leverage, margin, SL, or TP.
 *
 * The production geometry gives us one hard measurable constraint:
 *   maximum price-risk capacity = 0.5% of Entry.
 *
 * Therefore entry calibration derives its usable structural distance from
 * that capacity and the observed ATR, rather than using fixed "0.75 ATR"
 * / "1.5 ATR" thresholds.
 */
const MAX_PRICE_RISK_PCT = 0.005;
// Execution viability is measured against observed volatility, not a legacy
// absolute ATR threshold: the fixed price-risk envelope must cover at least
// 10% of one ATR. Below that ratio, the geometry is too small to represent a
// meaningful fraction of the current volatility regime.
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

  // Do not publish a candidate when the fixed execution envelope represents
  // less than the minimum measurable volatility coverage. This is an
  // execution-capacity gate, not a tightening of the entry-quality score.
  if (geometryCapacityAtr < MIN_GEOMETRY_CAPACITY_ATR) {
    return {
      pass: false,
      entry: technicalPrice,
      score: 0,
      distanceAtr: +technicalDistanceAtr.toFixed(3),
      geometryCapacityAtr: +geometryCapacityAtr.toFixed(3),
      geometryUse: 0,
      mode: "REJECT_VOLATILITY_CAPACITY",
      reasons: ["fixed geometry covers less than 10% of observed ATR"],
    };
  }

  // A technical anchor farther away than the geometry can reasonably absorb
  // is not "fixed" by widening risk. It must be rejected or replaced by a
  // structure-calibrated entry.
  const supports = normalizeLevels(input.supports, "LONG", livePrice);
  const resistances = normalizeLevels(input.resistances, "SHORT", livePrice);
  const levels = action === "LONG" ? supports : resistances;

  let entry = technicalPrice;
  let mode = "TECHNICAL_ANCHOR";
  let structuralLevel = null;
  const reasons = [];

  // Structure is considered usable when the final entry can place that
  // structural level inside the fixed 0.5% price-risk envelope.
  const usableLevels = levels.filter((level) => {
    const distance = Math.abs(livePrice - level);
    return distance <= maxRiskPrice + EPSILON;
  });

  if (usableLevels.length) {
    structuralLevel = usableLevels[0];
    const levelDistance = Math.abs(livePrice - structuralLevel);

    // Put the calibrated entry between live price and structure. The blend
    // is based on actual geometry capacity: if structure is very close,
    // stay close to market; if it consumes most capacity, move entry toward
    // the structural level so the fixed SL remains executable.
    const capacityUse = clamp(levelDistance / Math.max(maxRiskPrice, EPSILON), 0, 1);
    const pullToStructure = 0.35 + 0.30 * capacityUse;
    entry = action === "LONG"
      ? structuralLevel + levelDistance * pullToStructure
      : structuralLevel - levelDistance * pullToStructure;

    entry = action === "LONG"
      ? Math.min(livePrice, entry)
      : Math.max(livePrice, entry);

    mode = action === "LONG" ? "SUPPORT_CALIBRATED" : "RESISTANCE_CALIBRATED";
    reasons.push("entry calibrated to executable nearby structure");
  } else {
    // No structure fits the fixed geometry. Keep the technical anchor only
    // when it is itself executable relative to current price.
    if (technicalDistanceAtr > Math.max(geometryCapacityAtr * 1.5, 0.25)) {
      return {
        pass: false,
        entry: technicalPrice,
        score: 0,
        distanceAtr: +technicalDistanceAtr.toFixed(3),
        geometryCapacityAtr: +geometryCapacityAtr.toFixed(3),
        mode: "REJECT_UNEXECUTABLE_ANCHOR",
        reasons: ["technical entry exceeds geometry-adjusted volatility capacity"],
      };
    }
    reasons.push("no structure inside fixed geometry; technical anchor retained");
  }

  const finalDistancePrice = Math.abs(entry - livePrice);
  const finalDistanceAtr = finalDistancePrice / atr;
  const geometryUse = finalDistancePrice / Math.max(maxRiskPrice, EPSILON);

  // Score is continuous rather than a ladder of arbitrary ATR buckets.
  // 100 = entry at live price; 0 = outside the executable geometry envelope.
  const proximityScore = clamp(100 * (1 - finalDistancePrice / Math.max(maxRiskPrice * 1.5, EPSILON)), 0, 100);
  const structureScore = structuralLevel == null
    ? 50
    : clamp(100 * (1 - Math.abs(entry - structuralLevel) / Math.max(maxRiskPrice, EPSILON)), 0, 100);
  const geometryScore = clamp(100 * (1 - Math.max(0, geometryUse - 0.75) / 0.25), 0, 100);
  const score = Math.round(0.45 * proximityScore + 0.35 * structureScore + 0.20 * geometryScore);

  if (geometryUse > 1 + 1e-9) {
    return {
      pass: false,
      entry: +entry,
      score: 0,
      distanceAtr: +finalDistanceAtr.toFixed(3),
      geometryCapacityAtr: +geometryCapacityAtr.toFixed(3),
      geometryUse: +geometryUse.toFixed(3),
      mode: "REJECT_GEOMETRY_CAPACITY",
      reasons: ["calibrated entry cannot fit the fixed 0.5% geometry"],
    };
  }

  return {
    pass: score >= 55,
    entry: +entry,
    score,
    mode,
    structuralLevel,
    distanceAtr: +finalDistanceAtr.toFixed(3),
    technicalDistanceAtr: +technicalDistanceAtr.toFixed(3),
    geometryCapacityAtr: +geometryCapacityAtr.toFixed(3),
    geometryUse: +geometryUse.toFixed(3),
    maxRiskPricePct: MAX_PRICE_RISK_PCT,
    reasons,
  };
}

module.exports = { calibrateEntry, MAX_PRICE_RISK_PCT, MIN_GEOMETRY_CAPACITY_ATR };
