const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateTradePlan } = require("./trade_plan");

test("10 USDT margin sizes leverage from 0.5% SL distance at 5% margin risk", () => {
  const plan = calculateTradePlan({ entry: 100, sl: 99.5 });
  assert.equal(plan.marginUsdt, 10);
  assert.equal(plan.leverage, 10);
  assert.ok(plan.leverage >= 5 && plan.leverage <= 25);
  assert.equal(plan.notionalUsdt, 100);
  assert.equal(plan.slLossUsdt, 0.5);
});

test("wider but valid SL floors at the 5x minimum", () => {
  const plan = calculateTradePlan({ entry: 100, sl: 99 });
  assert.equal(plan.leverage, 5);
  assert.ok(plan.leverage >= 5 && plan.leverage <= 25);
  assert.equal(plan.slLossUsdt, 0.5);
});

test("SL wider than 1% is rejected instead of falling below 5x", () => {
  assert.throws(
    () => calculateTradePlan({ entry: 100, sl: 98 }),
    /exceeds risk budget at 5x/
  );
});

test("narrow SL respects 25x leverage cap", () => {
  const plan = calculateTradePlan({ entry: 100, sl: 99.9 });
  assert.equal(plan.leverage, 25);
  assert.ok(plan.leverage >= 5 && plan.leverage <= 25);
  assert.ok(plan.slLossUsdt <= 0.5);
});

test("invalid levels are rejected", () => {
  assert.throws(() => calculateTradePlan({ entry: 100, sl: 100 }), /non-zero/);
});


test("reward targets are percentages of margin converted through leverage", () => {
  const plan = calculateTradePlan({ entry: 100, sl: 99, action: "LONG" });
  assert.equal(plan.riskMarginPercent, 5);
  assert.equal(plan.leverage, 5);
  assert.deepEqual(plan.rewardMarginPcts, [25, 50, 100]);
  assert.deepEqual(plan.rewardPriceMovePcts, [5, 10, 20]);
  assert.equal(plan.tp1, 105);
  assert.ok(Math.abs(plan.tp2 - 110) < 1e-9);
  assert.equal(plan.tp3, 120);
});
test("short reward targets mirror price movement", () => {
  const plan = calculateTradePlan({ entry: 100, sl: 99, action: "SHORT" });
  assert.equal(plan.tp1, 100 / 1.05);
  assert.equal(plan.tp2, 100 / 1.10);
  assert.equal(plan.tp3, 100 / 1.20);
});


test("entry calibration is independent from margin reward geometry", () => {
  const { calibrateEntry } = require("./entry_calibration");
  const result = calibrateEntry({
    action: "LONG", livePrice: 100, technicalPrice: 100, atr: 2,
    supports: [99], resistances: [103],
  });
  assert.equal(result.pass, true);
  assert.equal(result.entry, 99.2);
  assert.equal(result.mode, "SUPPORT_CALIBRATED");
});
