/**
 * Personal edge calibration from persisted, fee-aware outcome aggregates.
 * Adjusts candidate scores conservatively; never trades or changes delivery routes.
 */
"use strict";

const MIN_EDGE_SAMPLES = 12;
const SHRINKAGE_SAMPLES = 20;
const MAX_ACTION_ADJUSTMENT = 4;
const MAX_SETUP_ADJUSTMENT = 4;
const MAX_TOTAL_ADJUSTMENT = 8;

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function outcomeR(row) {
  if (finite(row?.pnlR)) return row.pnlR;
  const outcome = String(row?.outcome ?? row?.result ?? "").toUpperCase();
  if (["LOSS", "LOSS_SL", "SL", "SL_HIT"].includes(outcome)) return -1;
  if (["BREAKEVEN", "BE"].includes(outcome)) return 0;
  if (["WIN", "WIN_TP1", "WIN_TP2", "WIN_TP3", "TP1", "TP1_HIT", "TP2", "TP2_HIT", "TP3", "TP3_HIT"].includes(outcome)) {
    const entry = Number(row?.entry), sl = Number(row?.sl), tp1 = Number(row?.tp1);
    const risk = Math.abs(entry - sl);
    if (Number.isFinite(entry) && Number.isFinite(sl) && Number.isFinite(tp1) && risk > 0) {
      return Math.abs(tp1 - entry) / risk;
    }
    return 1;
  }
  return null;
}

function summarizeRows(rows) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const r = outcomeR(row);
    if (r === null || !Number.isFinite(r)) continue;
    const key = String(row?.key ?? "ALL");
    const item = groups.get(key) || { samples: 0, wins: 0, losses: 0, sumR: 0 };
    item.samples++;
    if (r > 0) item.wins++;
    else if (r < 0) item.losses++;
    item.sumR += r;
    groups.set(key, item);
  }
  return Object.fromEntries([...groups].map(([key, value]) => [key, {
    ...value,
    avgR: value.samples ? value.sumR / value.samples : null,
    winRate: value.samples ? value.wins / value.samples : null
  }]));
}

function summarizePersonalEdge(rows) {
  const valid = (Array.isArray(rows) ? rows : []).filter(row => outcomeR(row) !== null);
  const overall = summarizeRows(valid.map(row => ({ ...row, key: "ALL" }))).ALL ||
    { samples: 0, wins: 0, losses: 0, sumR: 0, avgR: null, winRate: null };
  const byAction = summarizeRows(valid.filter(x => x.action).map(row => ({ ...row, key: String(row.action).toUpperCase() })));
  const bySetup = summarizeRows(valid.filter(x => x.setup).map(row => ({ ...row, key: String(row.setup) })));
  return { overall, byAction, bySetup };
}

function getSamples(bucket) {
  const n = Number(bucket?.n ?? bucket?.samples ?? bucket?.count);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function adjustment(bucket, minSamples, maxAbs) {
  const n = getSamples(bucket);
  const avgR = Number(bucket?.avgR ?? bucket?.expectancyR);
  if (n < minSamples || !Number.isFinite(avgR)) return 0;
  const shrunkR = avgR * n / (n + SHRINKAGE_SAMPLES);
  return Math.max(-maxAbs, Math.min(maxAbs, shrunkR * 8));
}

function adjustScoreWithEdge(score, candidate, stats = {}, options = {}) {
  const original = Number(score);
  const safeScore = Number.isFinite(original) ? Math.max(0, Math.min(100, original)) : 0;
  const minSamples = Math.max(1, Number(options.minSamples) || MIN_EDGE_SAMPLES);
  const actionKey = String(candidate?.action || "").toUpperCase();
  const setupKey = String(candidate?.setup || "");
  const actionBucket = stats?.byAction?.[actionKey];
  const setupBucket = stats?.bySetup?.[setupKey];
  const actionAdjustment = Math.max(-MAX_ACTION_ADJUSTMENT,
    Math.min(MAX_ACTION_ADJUSTMENT, adjustment(actionBucket, minSamples, MAX_ACTION_ADJUSTMENT)));
  const setupAdjustment = Math.max(-MAX_SETUP_ADJUSTMENT,
    Math.min(MAX_SETUP_ADJUSTMENT, adjustment(setupBucket, minSamples, MAX_SETUP_ADJUSTMENT)));
  const totalAdjustment = Math.max(-MAX_TOTAL_ADJUSTMENT,
    Math.min(MAX_TOTAL_ADJUSTMENT, actionAdjustment + setupAdjustment));
  const adjustedScore = Math.max(0, Math.min(100, Math.round((safeScore + totalAdjustment) * 10) / 10));
  return {
    score: adjustedScore,
    adjustment: Math.round(totalAdjustment * 10) / 10,
    evidence: {
      actionSamples: getSamples(actionBucket),
      actionAvgR: Number.isFinite(Number(actionBucket?.avgR)) ? Number(actionBucket.avgR) : null,
      setupSamples: getSamples(setupBucket),
      setupAvgR: Number.isFinite(Number(setupBucket?.avgR)) ? Number(setupBucket.avgR) : null
    }
  };
}

module.exports = { MIN_EDGE_SAMPLES, outcomeR, summarizePersonalEdge, adjustScoreWithEdge };
