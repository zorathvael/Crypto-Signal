/**
 * Timing Calibration — adaptive market-timing layer.
 *
 * This module decides whether the current market context is suitable for the
 * calibrated Entry/structural-SL timing. It does NOT calculate production
 * SL/TP, margin, leverage, or reward geometry.
 *
 * Contract:
 *   Timing Calibration -> proposes/validates Entry + structural SL context
 *   Trade Geometry      -> deterministically derives executable SL + TP1/2/3
 */
const { calibrateEntry } = require("./entry_calibration");

function calibrateTiming(input = {}) {
  const timing = calibrateEntry(input);
  return {
    ...timing,
    layer: "TIMING_CALIBRATION",
    geometryLayer: "TRADE_GEOMETRY",
    geometryOwns: ["margin", "leverage", "sl", "tp1", "tp2", "tp3"],
    timingOwns: ["entry", "structuralSl", "timingScore", "timingMode"],
    timingScore: Number.isFinite(timing.score) ? timing.score : 0,
    timingMode: timing.mode || "UNAVAILABLE",
    structuralSl: timing.structuralLevel ?? null,
  };
}

module.exports = { calibrateTiming };
