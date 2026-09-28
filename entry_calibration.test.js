const test = require("node:test");
const assert = require("node:assert/strict");
const { calibrateEntry, MAX_PRICE_RISK_PCT } = require("./entry_calibration");

test("entry calibration uses live price for ENTRY NOW", () => {
  const out = calibrateEntry({ action: "LONG", livePrice: 100, technicalPrice: 100, atr: 2, supports: [99.8], resistances: [] });
  assert.equal(out.pass, true);
  assert.equal(out.entry, 100);
  assert.equal(out.mode, "ENTRY_NOW_SUPPORT");
  assert.equal(out.structuralLevel, 99.8);
  assert.equal(out.geometryCapacityAtr, 0.25);
  assert.equal(out.geometryUse, 0);
  assert.equal(out.maxRiskPricePct, MAX_PRICE_RISK_PCT);
});

test("LONG never pulls Entry below market to support", () => {
  const out = calibrateEntry({ action: "LONG", livePrice: 100, technicalPrice: 100.05, atr: 2, supports: [99.8], resistances: [] });
  assert.equal(out.pass, true);
  assert.equal(out.entry, 100);
  assert.equal(out.structuralLevel, 99.8);
  assert.equal(out.mode, "ENTRY_NOW_SUPPORT");
});

test("SHORT never pushes Entry above market to resistance", () => {
  const out = calibrateEntry({ action: "SHORT", livePrice: 100, technicalPrice: 99.95, atr: 2, supports: [], resistances: [100.2] });
  assert.equal(out.pass, true);
  assert.equal(out.entry, 100);
  assert.equal(out.mode, "ENTRY_NOW_RESISTANCE");
  assert.equal(out.structuralLevel, 100.2);
});

test("a distant support is rejected instead of inventing a pullback entry", () => {
  const out = calibrateEntry({ action: "LONG", livePrice: 100, technicalPrice: 100, atr: 0.1, supports: [98], resistances: [] });
  assert.equal(out.pass, false);
  assert.equal(out.mode, "REJECT_NO_EXECUTABLE_STRUCTURE");
});

test("missing directional structure is rejected fail-closed", () => {
  const out = calibrateEntry({ action: "LONG", livePrice: 100, technicalPrice: 100, atr: 2, supports: [], resistances: [101] });
  assert.equal(out.pass, false);
  assert.equal(out.mode, "REJECT_NO_EXECUTABLE_STRUCTURE");
});

test("volatility capacity remains a hard timing gate", () => {
  const out = calibrateEntry({ action: "LONG", livePrice: 100, technicalPrice: 100, atr: 60, supports: [99.8], resistances: [] });
  assert.equal(out.pass, false);
  assert.equal(out.mode, "REJECT_VOLATILITY_CAPACITY");
});
