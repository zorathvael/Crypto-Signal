const test=require('node:test');
const assert=require('node:assert/strict');
const {calculateTradePlan}=require('./trade_plan');
function signal(action='LONG'){return{action,price:100,atr:.2,pullback:{fibLow:99.3,fibHigh:100.7}};}
test('Fibonacci entry is the 50% level of the 20-candle swing',()=>{const p=calculateTradePlan(signal());assert.equal(p.entryGeometryIndependent,false);assert.equal(p.fibEntryLevel,.5);assert.equal(p.fibEntry,100);});
test('LONG geometry uses adaptive leverage and 2R/4R/6R',()=>{const p=calculateTradePlan(signal('LONG'));assert.equal(p.marginUsdt,5);assert.equal(p.leverage,11);assert.equal(p.notionalUsdt,55);assert.ok(Math.abs(p.sl-99.14)<1e-9);assert.deepEqual(p.rewardRMultiples,[2,4,6]);assert.ok(Math.abs(p.tp1-101.72)<1e-9);assert.ok(Math.abs(p.tp2-103.44)<1e-9);assert.ok(Math.abs(p.tp3-105.16)<1e-9);assert.ok(p.slLossUsdt<=.5+1e-9);});
test('SHORT geometry mirrors Fibonacci structure',()=>{const p=calculateTradePlan(signal('SHORT'));assert.equal(p.leverage,11);assert.ok(Math.abs(p.sl-100.86)<1e-9);assert.ok(Math.abs(p.tp1-98.28)<1e-9);assert.ok(Math.abs(p.tp3-94.84)<1e-9);});
test('geometry rejects a structural stop that would require less than 5x',()=>{assert.throws(()=>calculateTradePlan({action:'LONG',price:100,atr:4,pullback:{fibLow:90,fibHigh:110}}),/needs leverage below 5x/);});