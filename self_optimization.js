/**
 * Outcome-driven calibration helpers for Crypto-Signal.
 * Conservative by design: only closed, explicitly labelled outcomes are used.
 * This module never raises the existing publication floor of 90 or auto-trades.
 */
"use strict";

const MIN_PUBLICATION_SCORE = 90;
const DEFAULT_CONFIG = Object.freeze({
  minPublicationScore: MIN_PUBLICATION_SCORE,
  minClosedSamples: 30,
  minPerBucket: 8,
  shrinkage: 20,
  maxThresholdStep: 2,
  maxThreshold: 98
});

function finite(n) { return typeof n === "number" && Number.isFinite(n); }

function normalizeOutcome(row) {
  if (!row || typeof row !== "object") return null;
  const score = Number(row.probability ?? row.score);
  const rawOutcome = String(row.outcome ?? row.result ?? "").toUpperCase();
  const aliases = {
    WIN: "WIN", TP1: "WIN", TP1_HIT: "WIN", TP2: "WIN", TP2_HIT: "WIN",
    TP3: "WIN", TP3_HIT: "WIN", LOSS: "LOSS", LOSS_SL: "LOSS", SL: "LOSS",
    SL_HIT: "LOSS", BREAKEVEN: "BREAKEVEN", BE: "BREAKEVEN"
  };
  const outcome = aliases[rawOutcome];
  if (!finite(score) || score < 0 || score > 100) return null;
  if (!outcome) return null;
  return { score, outcome, pnlR: finite(Number(row.pnlR)) ? Number(row.pnlR) : null };
}

function summarize(rows) {
  const normalized = (Array.isArray(rows) ? rows : []).map(normalizeOutcome).filter(Boolean);
  const wins = normalized.filter(x => x.outcome === "WIN").length;
  const losses = normalized.filter(x => x.outcome === "LOSS").length;
  const breakeven = normalized.length - wins - losses;
  const pnls = normalized.map(x => x.pnlR).filter(finite);
  return {
    samples: normalized.length, wins, losses, breakeven,
    winRate: normalized.length ? wins / normalized.length : null,
    avgR: pnls.length ? pnls.reduce((a, b) => a + b, 0) / pnls.length : null
  };
}

/**
 * Propose a conservative score threshold from historical outcomes.
 * Uses out-of-sample rows for acceptance; insufficient evidence keeps config unchanged.
 * Returns a proposal only; caller must persist/version it and can roll it back.
 */
function proposeCalibration(closedRows, current = {}, options = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...options };
  const currentThreshold = Math.max(MIN_PUBLICATION_SCORE,
    Math.min(cfg.maxThreshold, Number(current.minPublicationScore) || MIN_PUBLICATION_SCORE));
  const rows = (Array.isArray(closedRows) ? closedRows : []).map(normalizeOutcome).filter(Boolean);
  const report = summarize(rows);
  const unchanged = (reason) => ({
    accepted: false, reason, previousThreshold: currentThreshold,
    proposedThreshold: currentThreshold, report
  });
  if (rows.length < cfg.minClosedSamples) return unchanged("INSUFFICIENT_CLOSED_SAMPLES");

  const split = Math.floor(rows.length * 0.7);
  const train = rows.slice(0, split);
  const validation = rows.slice(split);
  if (validation.length < 10) return unchanged("INSUFFICIENT_VALIDATION_SAMPLES");

  const evaluate = (set, threshold) => {
    const picked = set.filter(x => x.score >= threshold);
    if (picked.length < cfg.minPerBucket) return null;
    const wins = picked.filter(x => x.outcome === "WIN").length;
    const losses = picked.filter(x => x.outcome === "LOSS").length;
    const decisive = wins + losses;
    if (decisive < cfg.minPerBucket) return null;
    const winRate = wins / decisive;
    const pnls = picked.map(x => x.pnlR).filter(finite);
    return { samples: picked.length, decisive, winRate,
      avgR: pnls.length ? pnls.reduce((a,b)=>a+b,0)/pnls.length : null };
  };

  const baseline = evaluate(validation, currentThreshold);
  if (!baseline) return unchanged("BASELINE_VALIDATION_TOO_SMALL");

  const candidates = [...new Set([
    Math.max(MIN_PUBLICATION_SCORE, currentThreshold - cfg.maxThresholdStep),
    currentThreshold,
    Math.min(cfg.maxThreshold, currentThreshold + cfg.maxThresholdStep)
  ])].filter(x => x >= MIN_PUBLICATION_SCORE && x <= cfg.maxThreshold);
  const scored = candidates.map(threshold => ({
    threshold, train: evaluate(train, threshold), validation: evaluate(validation, threshold)
  })).filter(x => x.train && x.validation);
  if (!scored.length) return unchanged("NO_CANDIDATE_HAS_ENOUGH_SAMPLES");

  // Do not optimize on win rate alone if realized R-multiples are unavailable.
  const rank = x => x.validation.avgR === null ? x.validation.winRate : x.validation.avgR;
  scored.sort((a,b) => rank(b) - rank(a));
  const best = scored[0];
  const improvement = rank(best) - rank({ validation: baseline });
  if (best.threshold === currentThreshold) return unchanged("CURRENT_THRESHOLD_BEST");
  if (!(improvement > 0)) return unchanged("NO_VALIDATION_IMPROVEMENT");
  return {
    accepted: true, reason: "VALIDATION_IMPROVED",
    previousThreshold: currentThreshold, proposedThreshold: best.threshold,
    report, baseline, candidate: best.validation,
    train: best.train, validation: best.validation,
    note: "Proposal only; review and version before activating."
  };
}

module.exports = { MIN_PUBLICATION_SCORE, DEFAULT_CONFIG, normalizeOutcome, summarize, proposeCalibration };
