const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateTradePlan } = require("./trade_plan");

test("fixed production geometry is 5 USDT at 25x", () => {
  const plan = calculateTradePlan({ entry: 100, sl: 99.6, action: "LONG" });
  assert.equal(plan.marginUsdt, 5);
  assert.equal(plan.leverage, 25);
  assert.equal(plan.notionalUsdt, 125);
  assert.equal(plan.riskMarginPercent, 10);
  assert.equal(plan.riskBudgetUsdt, 0.5);
  assert.equal(plan.sl, 99.6);
  assert.ok(Math.abs(plan.slLossUsdt - 0.5) < 1e-9);
});

test("fixed geometry rejects a structural SL wider than 0.4%", () => {
  assert.throws(() => calculateTradePlan({ entry: 100, sl: 99, action: "LONG" }), /fixed 25x geometry/);
});

test("narrower structural SL does not change fixed geometry", () => {
  const plan = calculateTradePlan({ entry: 100, sl: 99.9, action: "LONG" });
  assert.equal(plan.leverage, 25);
  assert.equal(plan.sl, 99.6);
  assert.equal(plan.tp1, 101.2);
  assert.equal(plan.tp2, 102.4);
  assert.ok(Math.abs(plan.tp3 - 104.8) < 1e-9);
});

test("LONG targets use 30/60/120% margin geometry", () => {
  const plan = calculateTradePlan({ entry: 100, sl: 99.6, action: "LONG" });
  assert.deepEqual(plan.rewardMarginPcts, [30, 60, 120]);
  assert.deepEqual(plan.rewardPriceMovePcts, [1.2, 2.4, 4.8]);
  assert.deepEqual(plan.rewardRMultiples, [3, 6, 12]);
});

test("SHORT geometry is mirrored exactly", () => {
  const plan = calculateTradePlan({ entry: 200, sl: 200.8, action: "SHORT" });
  assert.equal(plan.leverage, 25);
  assert.equal(plan.sl, 200.8);
  assert.equal(plan.tp1, 197.6);
  assert.equal(plan.tp2, 195.2);
  assert.ok(Math.abs(plan.tp3 - 190.4) < 1e-9);
});

test("entry calibration remains independent from margin geometry", () => {
  const { calibrateEntry } = require("./entry_calibration");
  const result = calibrateEntry({ action: "LONG", livePrice: 100, technicalPrice: 100, atr: 2, supports: [99], resistances: [103] });
  assert.equal(result.pass, true);
  assert.equal(result.entry, 100);
  const plan = calculateTradePlan({ entry: result.entry, sl: result.entry * 0.996, action: "LONG" });
  assert.equal(plan.entryGeometryIndependent, true);
  assert.equal(plan.entryUnchanged, true);
  assert.ok(Math.abs(plan.tp1 - result.entry * 1.012) < 1e-9);
});
