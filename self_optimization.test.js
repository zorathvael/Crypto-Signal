"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeOutcome, summarize, proposeCalibration, MIN_PUBLICATION_SCORE } = require("./self_optimization");

test("rejects unlabelled or invalid outcomes", () => {
  assert.equal(normalizeOutcome({ probability: 95 }), null);
  assert.equal(normalizeOutcome({ probability: 120, outcome: "WIN" }), null);
  assert.equal(normalizeOutcome({ probability: 95, outcome: "MAYBE" }), null);
});

test("summarizes only explicit closed outcomes", () => {
  const s = summarize([
    { probability: 95, outcome: "WIN", pnlR: 1.5 },
    { probability: 92, outcome: "LOSS", pnlR: -1 },
    { probability: 91, outcome: "BREAKEVEN", pnlR: 0 },
    { probability: 99, outcome: "OPEN", pnlR: 0 }
  ]);
  assert.equal(s.samples, 3);
  assert.equal(s.wins, 1);
  assert.equal(s.losses, 1);
  assert.equal(s.breakeven, 1);
  assert.equal(s.avgR, 1 / 6);
});

test("keeps the publication floor at 90 and does not learn from small samples", () => {
  const result = proposeCalibration(
    Array.from({ length: 12 }, (_, i) => ({ probability: 95, outcome: i % 2 ? "LOSS" : "WIN", pnlR: i % 2 ? -1 : 1 })),
    { minPublicationScore: 80 }
  );
  assert.equal(MIN_PUBLICATION_SCORE, 90);
  assert.equal(result.accepted, false);
  assert.equal(result.previousThreshold, 90);
  assert.equal(result.proposedThreshold, 90);
  assert.equal(result.reason, "INSUFFICIENT_CLOSED_SAMPLES");
});

test("returns a bounded, validation-based proposal when sufficient data exists", () => {
  const rows = [];
  for (let i = 0; i < 60; i++) {
    const score = i < 30 ? 91 : 97;
    const win = i >= 30 ? i % 5 !== 0 : i % 2 === 0;
    rows.push({ probability: score, outcome: win ? "WIN" : "LOSS", pnlR: win ? 1 : -1 });
  }
  const result = proposeCalibration(rows, { minPublicationScore: 90 });
  assert.ok(result.proposedThreshold >= 90);
  assert.ok(result.proposedThreshold <= 98);
  if (result.accepted) assert.equal(result.reason, "VALIDATION_IMPROVED");
});
