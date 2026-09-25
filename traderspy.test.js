const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeSignal, signalQualityScore } = require("./traderspy");

const NOW = Date.parse("2026-09-26T00:00:00Z");

function sample(overrides = {}) {
  return {
    id: "test-1",
    strategyName: "Pullback Trend Continuation Buy (1H)",
    importance: "high",
    action: "buy",
    signalStrength: "very_strong",
    coin: "ETHUSDT",
    timeframe: "1h",
    price: 100,
    targets: [
      { label: "TP1", type: "tp1", pct: 2 },
      { label: "TP2", type: "tp2", pct: 3 },
      { label: "TP3", type: "tp3", pct: 4 },
      { label: "SL", type: "sl", pct: 1 },
    ],
    triggeredConditions: ["RSI 55", "EMA reclaim"],
    resolutionStatus: "pending",
    createdAt: "2026-09-25T23:30:00Z",
    ...overrides,
  };
}

test("quality score is derived from TraderSpy strength and importance", () => {
  assert.equal(signalQualityScore(sample()), 99);
  assert.equal(signalQualityScore(sample({ signalStrength: "moderate", importance: "low" })), 84);
});

test("normalizes a LONG signal without inventing probability", () => {
  const out = normalizeSignal(sample());
  assert.ok(out);
  assert.equal(out.action, "LONG");
  assert.equal(out.entry, 100);
  assert.equal(out.sl, 99);
  assert.equal(out.tp1, 102);
  assert.equal(out.tp2, 103);
  assert.equal(out.tp3, 104);
  assert.equal(out.rr, 2);
  assert.equal(out.probability, 99);
  assert.equal(out.qualityScore, 99);
  assert.equal(out.riskPct, null);
});

test("normalizes a SHORT signal with mirrored levels", () => {
  const out = normalizeSignal(sample({
    action: "sell",
    coin: "SOLUSDT",
    price: 200,
  }));
  assert.ok(out);
  assert.equal(out.action, "SHORT");
  assert.equal(out.sl, 202);
  assert.equal(out.tp1, 196);
  assert.equal(out.rr, 2);
});

test("rejects resolved, stale and non-crypto signals", () => {
  assert.equal(normalizeSignal(sample({ resolutionStatus: "tp1_hit" }), NOW), null);
  assert.equal(normalizeSignal(sample({ createdAt: "2026-09-25T18:00:00Z" }), NOW), null);
  assert.equal(normalizeSignal(sample({ coin: "AAPLUSDT" }), NOW), null);
});

test("rejects incomplete level data instead of fabricating it", () => {
  const bad = sample({ targets: [{ label: "TP1", pct: 2 }] });
  assert.equal(normalizeSignal(bad, NOW), null);
});
