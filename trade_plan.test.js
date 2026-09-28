const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateTradePlan } = require("./trade_plan");

test("fixed production geometry is 5 USDT at 20x", () => {
  const plan = calculateTradePlan({ entry: 100, sl: 99.5, action: "LONG" });
  assert.equal(plan.marginUsdt, 5);
  assert.equal(plan.leverage, 20);
  assert.equal(plan.notionalUsdt, 100);
  assert.equal(plan.riskMarginPercent, 10);
  assert.equal(plan.riskBudgetUsdt, 0.5);
  assert.equal(plan.sl, 99.5);
  assert.ok(Math.abs(plan.slLossUsdt - 0.5) < 1e-9);
});

test("fixed geometry rejects a structural SL wider than 0.5%", () => {
  assert.throws(() => calculateTradePlan({ entry: 100, sl: 99, action: "LONG" }), /fixed 20x geometry/);
});

test("narrower structural SL does not change fixed geometry", () => {
  const plan = calculateTradePlan({ entry: 100, sl: 99.9, action: "LONG" });
  assert.equal(plan.leverage, 20);
  assert.equal(plan.sl, 99.5);
  assert.ok(Math.abs(plan.tp1 - 101.5) < 1e-9);
  assert.equal(plan.tp2, 103);
  assert.ok(Math.abs(plan.tp3 - 106) < 1e-9);
});

test("LONG targets use 30/60/120% margin geometry", () => {
  const plan = calculateTradePlan({ entry: 100, sl: 99.5, action: "LONG" });
  assert.deepEqual(plan.rewardMarginPcts, [30, 60, 120]);
  assert.deepEqual(plan.rewardPriceMovePcts, [1.5, 3.0, 6.0]);
  assert.deepEqual(plan.rewardRMultiples, [3, 6, 12]);
});

test("SHORT geometry is mirrored exactly", () => {
  const plan = calculateTradePlan({ entry: 200, sl: 200.8, action: "SHORT" });
  assert.equal(plan.leverage, 20);
  assert.ok(Math.abs(plan.sl - 201) < 1e-9);
  assert.ok(Math.abs(plan.tp1 - 197) < 1e-9);
  assert.ok(Math.abs(plan.tp2 - 194) < 1e-9);
  assert.ok(Math.abs(plan.tp3 - 188) < 1e-9);
});

test("entry calibration remains independent from margin geometry", () => {
  const { calibrateEntry } = require("./entry_calibration");
  const result = calibrateEntry({ action: "LONG", livePrice: 100, technicalPrice: 100, atr: 2, supports: [99.5], resistances: [103] });
  assert.equal(result.pass, true);
  assert.equal(result.entry, 100);
  const plan = calculateTradePlan({ entry: result.entry, sl: result.entry * 0.995, action: "LONG" });
  assert.equal(plan.entryGeometryIndependent, true);
  assert.equal(plan.entryUnchanged, true);
  assert.ok(Math.abs(plan.tp1 - result.entry * 1.015) < 1e-9);
});
