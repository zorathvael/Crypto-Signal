const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateTradePlan } = require("./trade_plan");

test("production geometry is fixed at 5 USDT margin and 25x leverage", () => {
  const plan = calculateTradePlan({ entry: 100, sl: 99.6, action: "LONG" });
  assert.equal(plan.marginUsdt, 5);
  assert.equal(plan.leverage, 25);
  assert.equal(plan.notionalUsdt, 125);
  assert.equal(plan.riskMarginPercent, 10);
  assert.equal(plan.riskBudgetUsdt, 0.5);
  assert.ok(Math.abs(plan.slDistancePercent - 0.4) < 1e-9);
  assert.ok(Math.abs(plan.slLossUsdt - 0.5) < 1e-9);
});

test("SL wider than 0.4% is rejected rather than changing leverage", () => {
  assert.throws(
    () => calculateTradePlan({ entry: 100, sl: 99.5, action: "LONG" }),
    /fixed 25x risk geometry/
  );
});

test("narrow structural SL does not change the fixed 25x geometry", () => {
  const plan = calculateTradePlan({ entry: 100, sl: 99.9, action: "LONG" });
  assert.equal(plan.leverage, 25);
  assert.ok(Math.abs(plan.slLossUsdt - 0.125) < 1e-9);
  assert.equal(plan.rewardMarginPcts.join(","), "30,60,120");
});

test("LONG targets are exactly 30/60/120% of margin", () => {
  const plan = calculateTradePlan({ entry: 100, sl: 99.6, action: "LONG" });
  assert.deepEqual(plan.rewardMarginPcts, [30, 60, 120]);
  assert.deepEqual(plan.rewardPriceMovePcts, [1.2, 2.4, 4.8]);
  assert.ok(Math.abs(plan.tp1 - 101.2) < 1e-9);
  assert.ok(Math.abs(plan.tp2 - 102.4) < 1e-9);
  assert.ok(Math.abs(plan.tp3 - 104.8) < 1e-9);
});

test("SHORT targets use exact linear mirrored geometry", () => {
  const plan = calculateTradePlan({ entry: 100, sl: 100.4, action: "SHORT" });
  assert.ok(Math.abs(plan.slDistancePercent - 0.4) < 1e-9);
  assert.ok(Math.abs(plan.tp1 - 98.8) < 1e-9);
  assert.ok(Math.abs(plan.tp2 - 97.6) < 1e-9);
  assert.ok(Math.abs(plan.tp3 - 95.2) < 1e-9);
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
  assert.equal(plan.leverage, 25);
  assert.ok(Math.abs(plan.tp1 - result.entry * 1.012) < 1e-9);
});
