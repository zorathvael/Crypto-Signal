"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { adjustScoreWithEdge, summarizePersonalEdge } = require("./edge_optimizer");

test("does not personalize scores until enough outcomes exist", () => {
  const stats = { byAction: { SHORT: { n: 8, avgR: -1 } }, bySetup: {} };
  const result = adjustScoreWithEdge(95, { action: "SHORT", setup: "SCALP_MTF" }, stats);
  assert.equal(result.score, 95);
  assert.equal(result.adjustment, 0);
});

test("penalizes a repeatedly losing action and setup without dropping the score floor below zero", () => {
  const stats = {
    byAction: { SHORT: { n: 20, avgR: -0.64 } },
    bySetup: { TRADERSPY_COMPATIBLE_MTF: { n: 27, avgR: -0.54 } }
  };
  const result = adjustScoreWithEdge(99, { action: "SHORT", setup: "TRADERSPY_COMPATIBLE_MTF" }, stats);
  assert.ok(result.score < 99);
  assert.ok(result.score >= 0);
  assert.ok(result.adjustment < 0);
  assert.equal(result.evidence.actionSamples, 20);
  assert.equal(result.evidence.setupSamples, 27);
});

test("does not let weak positive expectancy create an oversized score boost", () => {
  const stats = { byAction: { LONG: { n: 61, avgR: 0.04 } }, bySetup: {} };
  const result = adjustScoreWithEdge(90, { action: "LONG", setup: "NEW_SETUP" }, stats);
  assert.ok(result.score >= 90);
  assert.ok(result.score <= 91);
});

test("summarizes explicitly labelled outcomes and ignores expired or malformed rows", () => {
  const report = summarizePersonalEdge([
    { action: "LONG", setup: "A", outcome: "WIN_TP1", entry: 100, sl: 98, tp1: 104 },
    { action: "LONG", setup: "A", outcome: "LOSS_SL", entry: 100, sl: 98, tp1: 104 },
    { action: "LONG", setup: "A", outcome: "EXPIRED", entry: 100, sl: 98, tp1: 104 },
    { action: "SHORT", setup: "B", outcome: "WIN_TP1", entry: 100, sl: 102, tp1: 96 }
  ]);
  assert.equal(report.overall.samples, 3);
  assert.equal(report.overall.wins, 2);
  assert.equal(report.overall.losses, 1);
  assert.equal(report.byAction.LONG.samples, 2);
  assert.equal(report.bySetup.A.avgR, 0.5);
});
