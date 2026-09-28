const test = require("node:test");
const assert = require("node:assert/strict");
const { calibrateTiming } = require("./timing_calibration");
const { calculateTradePlan } = require("./trade_plan");

test("timing calibration and trade geometry are separate layers", () => {
  const timing = calibrateTiming({ action:"LONG", livePrice:100, technicalPrice:100, atr:2, supports:[99.8], resistances:[] });
  assert.equal(timing.layer, "TIMING_CALIBRATION");
  assert.equal(timing.entry, 99.894);
  assert.equal(timing.structuralSl, 99.8);
  assert.deepEqual(timing.geometryOwns, ["margin","leverage","sl","tp1","tp2","tp3"]);
  const plan = calculateTradePlan({action:"LONG", entry:timing.entry, sl:timing.structuralSl});
  assert.equal(plan.leverage,20);
  assert.equal(plan.sl, timing.entry * 0.995);
  assert.equal(plan.tp1, timing.entry * 1.015);
  assert.equal(plan.tp2, timing.entry * 1.03);
  assert.equal(plan.tp3, timing.entry * 1.06);
  assert.equal(plan.entryUnchanged,true);
});
