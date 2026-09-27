const test = require("node:test");
const assert = require("node:assert/strict");
const { calibrateEntry, MAX_PRICE_RISK_PCT } = require("./entry_calibration");

test("entry calibration derives capacity from fixed geometry", () => {
  const out = calibrateEntry({ action: "LONG", livePrice: 100, technicalPrice: 100, atr: 2, supports: [], resistances: [] });
  assert.equal(out.pass, true);
  assert.equal(out.entry, 100);
  assert.equal(out.geometryCapacityAtr, 0.2);
  assert.equal(out.maxRiskPricePct, MAX_PRICE_RISK_PCT);
});

test("nearby structure is calibrated by geometry, not a fixed ATR threshold", () => {
  const out = calibrateEntry({ action: "LONG", livePrice: 100, technicalPrice: 100.05, atr: 2, supports: [99.8], resistances: [] });
  assert.equal(out.pass, true);
  assert.equal(out.mode, "SUPPORT_CALIBRATED");
  assert.equal(out.structuralLevel, 99.8);
  assert.ok(Math.abs(out.entry - 99.9) < 1e-9);
  assert.ok(out.geometryUse <= 1);
});

test("a distant support is ignored when it cannot fit the fixed geometry", () => {
  const out = calibrateEntry({ action: "LONG", livePrice: 100, technicalPrice: 100, atr: 0.1, supports: [98], resistances: [] });
  assert.equal(out.pass, true);
  assert.equal(out.mode, "TECHNICAL_ANCHOR");
  assert.equal(out.structuralLevel, null);
});

test("unexecutable technical anchor is rejected using geometry-adjusted volatility capacity", () => {
  const out = calibrateEntry({ action: "LONG", livePrice: 100, technicalPrice: 103, atr: 1, supports: [], resistances: [] });
  assert.equal(out.pass, false);
  assert.equal(out.mode, "REJECT_UNEXECUTABLE_ANCHOR");
});

test("SHORT calibration mirrors LONG calibration", () => {
  const out = calibrateEntry({ action: "SHORT", livePrice: 100, technicalPrice: 99.95, atr: 2, supports: [], resistances: [100.2] });
  assert.equal(out.pass, true);
  assert.equal(out.mode, "RESISTANCE_CALIBRATED");
  assert.equal(out.structuralLevel, 100.2);
  assert.ok(Math.abs(out.entry - 100.1) < 1e-9);
});
