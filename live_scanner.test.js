const test=require("node:test");
const assert=require("node:assert/strict");
const {analyze,normalizeBitgetCandles,bitgetInterval}=require("./scanner_engine");
function series(n=150){
  let p=100,seed=7;const c=[],v=[];
  for(let i=0;i<n;i++){seed=(seed*9301+49297)%233280;const noise=(seed/233280-.5)*1.5;p*=1+(.0008+noise/100);c.push(p);v.push(1000+(seed%400));}
  return {c,v};
}
test("live Binance analyzer produces calibrated trade geometry",()=>{
  const {c,v}=series();
  const r=analyze("TESTUSDT",c,v,c.at(-1));
  assert.equal(r.na,false);
  assert.ok(["LONG","SHORT"].includes(r.direction));
  assert.ok(Number.isFinite(r.entry)&&Number.isFinite(r.sl));
  assert.ok(Number.isFinite(r.tp1)&&Number.isFinite(r.tp2)&&Number.isFinite(r.tp3));
  assert.equal(r.calibration.samples,114);
  assert.equal(r.setup,"LIVE_BINANCE_CALIBRATED_120C");
});
test("live analyzer rejects insufficient calibration",()=>{
  const {c,v}=series(16);
  const r=analyze("TESTUSDT",c,v,c.at(-1));
  assert.equal(r.na,true);
});

test("Bitget candles normalize to the same OHLCV ordering used by calibration",()=>{
  const rows=[[3000,"12","13","11","12.5","100"],[1000,"10","11","9","10.5","80"],[2000,"11","12","10","11.5","90"]];
  const r=normalizeBitgetCandles(rows);
  assert.deepEqual(r.map(x=>x.ts),[1000,2000,3000]);
  assert.deepEqual(r.map(x=>x.close),[10.5,11.5,12.5]);
  assert.deepEqual(r.map(x=>x.volume),[80,90,100]);
  assert.equal(bitgetInterval("1h"),"1H");
});
