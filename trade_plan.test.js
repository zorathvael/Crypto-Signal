const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateTradePlan } = require("./trade_plan");

test("5 USDT margin sizes leverage from 1% SL distance at 10% margin risk", () => {
  const plan = calculateTradePlan({ entry: 100, sl: 99 });
  assert.equal(plan.marginUsdt, 5);
  assert.equal(plan.leverage, 10);
  assert.ok(plan.leverage >= 5 && plan.leverage <= 20);
  assert.equal(plan.notionalUsdt, 50);
  assert.equal(plan.slLossUsdt, 0.5);
});

test("wider but valid SL floors at the 5x minimum", () => {
  const plan = calculateTradePlan({ entry: 100, sl: 98 });
  assert.equal(plan.leverage, 5);
  assert.ok(plan.leverage >= 5 && plan.leverage <= 20);
  assert.equal(plan.slLossUsdt, 0.5);
});

test("SL wider than 2% is rejected instead of falling below 5x", () => {
  assert.throws(
    () => calculateTradePlan({ entry: 100, sl: 97 }),
    /exceeds risk budget at 5x/
  );
});

test("narrow SL respects 20x leverage cap", () => {
  const plan = calculateTradePlan({ entry: 100, sl: 99.9 });
  assert.equal(plan.leverage, 20);
  assert.ok(plan.leverage >= 5 && plan.leverage <= 20);
  assert.ok(plan.slLossUsdt <= 0.5);
});

test("invalid levels are rejected", () => {
  assert.throws(() => calculateTradePlan({ entry: 100, sl: 100 }), /non-zero/);
});
