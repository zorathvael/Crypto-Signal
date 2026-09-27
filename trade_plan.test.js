const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateTradePlan } = require("./trade_plan");

test("production geometry uses 5 USDT margin and stays within 5x..20x", () => {
  const plan = calculateTradePlan({ entry: 100, sl: 99.6, action: "LONG" });
  assert.equal(plan.marginUsdt, 5);
  assert.equal(plan.leverage, 20);
  assert.equal(plan.notionalUsdt, 100);
  assert.equal(plan.riskMarginPercent, 10);
  assert.equal(plan.riskBudgetUsdt, 0.5);
  assert.ok(plan.leverage >= 5 && plan.leverage <= 20);
  assert.ok(Math.abs(plan.slDistancePercent - 0.4) < 1e-9);
  assert.ok(Math.abs(plan.slLossUsdt - 0.4) < 1e-9);
});

test("leverage adapts downward when a wider structural SL needs it", () => {
  const plan = calculateTradePlan({ entry: 100, sl: 99, action: "LONG" });
  assert.equal(plan.leverage, 10);
  assert.ok(Math.abs(plan.slLossUsdt - 0.5) < 1e-9);
});

test("SL requiring below 5x is rejected rather than increasing risk", () => {
  assert.throws(
    () => calculateTradePlan({ entry: 100, sl: 97.9, action: "LONG" }),
    /5x minimum/
  );
});

test("narrow structural SL is capped at 20x", () => {
  const plan = calculateTradePlan({ entry: 100, sl: 99.9, action: "LONG" });
  assert.equal(plan.leverage, 20);
  assert.ok(Math.abs(plan.slLossUsdt - 0.1) < 1e-9);
});

test("LONG targets are exactly 2R/4R/6R", () => {
  const plan = calculateTradePlan({ entry: 100, sl: 99.6, action: "LONG" });
  assert.deepEqual(plan.rewardRMultiples, [2, 4, 6]);
  assert.ok(Math.abs(plan.tp1 - 100.8) < 1e-9);
  assert.ok(Math.abs(plan.tp2 - 101.6) < 1e-9);
  assert.ok(Math.abs(plan.tp3 - 102.4) < 1e-9);
});

test("SHORT targets use exact mirrored 2R/4R/6R geometry", () => {
  const plan = calculateTradePlan({ entry: 100, sl: 100.4, action: "SHORT" });
  assert.equal(plan.leverage, 20);
  assert.ok(Math.abs(plan.tp1 - 99.2) < 1e-9);
  assert.ok(Math.abs(plan.tp2 - 98.4) < 1e-9);
  assert.ok(Math.abs(plan.tp3 - 97.6) < 1e-9);
});

test("invalid levels and directions are rejected", () => {
  assert.throws(() => calculateTradePlan({ entry: 100, sl: 100 }), /non-zero/);
  assert.throws(() => calculateTradePlan({ entry: 100, sl: 99.6, action: "SIDEWAYS" }), /LONG or SHORT/);
});

test("entry calibration remains independent from margin geometry", () => {
  const { calibrateEntry } = require("./entry_calibration");
  const result = calibrateEntry({
    action: "LONG", livePrice: 100, technicalPrice: 100, atr: 2,
    supports: [99], resistances: [103],
  });
  assert.equal(result.pass, true);
  assert.equal(result.entry, 99.2);
  assert.equal(result.mode, "SUPPORT_CALIBRATED");

  const plan = calculateTradePlan({ entry: result.entry, sl: result.entry * 0.996, action: "LONG" });
  assert.equal(plan.entryGeometryIndependent, true);
  assert.equal(plan.leverage, 20);
  assert.ok(Math.abs(plan.tp1 - result.entry * 1.008) < 1e-9);
});
