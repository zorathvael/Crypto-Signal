const test=require("node:test");
const assert=require("node:assert/strict");
const {calibrateSignal,featureSnapshot,outcomeStats}=require("./calibration");

function rows(n,action="LONG",p=0.75){
  return Array.from({length:n},(_,i)=>({
    ts:Date.now()-i*3600000, action, setup:"TREND", outcome:i<Math.round(n*p)?"WIN_TP1":"LOSS_SL",
    rMultiple:i<Math.round(n*p)?1.5:-1,
    calibrationFeatures:{action,setup:"TREND",trend:"aligned_3",orderFlow:"buy_pressure",oiRegime:"new_longs",volatility:"normal",entryTiming:"good",qualityBucket:"95_plus"}
  }));
}

test("calibration uses Bayesian smoothing and never treats raw score as probability",()=>{
  const history={closed:rows(40,"LONG",0.75)};
  const out=calibrateSignal(history,{
    action:"LONG",setup:"TREND",trend:"aligned_3",orderFlow:"buy_pressure",
    oiRegime:"new_longs",volatility:"normal",entryTiming:"good",qualityBucket:"95_plus"
  },99);
  assert.ok(out.probability>=65 && out.probability<=85);
  assert.notEqual(out.probability,99);
  assert.equal(out.source,"empirical_hierarchical");
  assert.ok(out.cohorts.action>=8);
});

test("negative empirical action history lowers calibrated probability",()=>{
  const history={closed:rows(40,"SHORT",0.15)};
  const out=calibrateSignal(history,{action:"SHORT",setup:"TREND",trend:"mixed",orderFlow:"sell_pressure",oiRegime:"new_shorts",volatility:"high",entryTiming:"fair",qualityBucket:"95_plus"},99);
  assert.ok(out.probability<50);
});

test("feature snapshot captures trend/order-flow/OI/volatility/timing",()=>{
  const snap=featureSnapshot({
    signal:{action:"LONG",setup:"TREND",qualityScore:92,entryCalibrationScore:84,entryCalibrationDistanceAtr:0.4},
    technical:{price:100,timeframes:[
      {interval:"15m",summary:{bias:"bullish",trend:{direction:"up"}},indicators:{atr:{value:0.4}}},
      {interval:"1h",summary:{bias:"bullish",trend:{direction:"up"}},indicators:{atr:{value:0.8}}},
      {interval:"4h",summary:{bias:"bullish",trend:{direction:"up"}},indicators:{atr:{value:1}}}
    ]},
    derivatives:{row:{funding:{ratePct:0},positioning:{takerBuySellRatio:1.12,globalLongPct:55},openInterest:{regime:"new_longs"}}}
  });
  assert.equal(snap.trend,"aligned_3");
  assert.equal(snap.orderFlow,"buy_pressure");
  assert.equal(snap.oiRegime,"new_longs");
  assert.equal(snap.entryTiming,"good");
  assert.equal(snap.volatility,"normal");
});

test("outcomeStats smooths empty samples",()=>{
  const s=outcomeStats([]);
  assert.equal(s.n,0);
  assert.equal(s.p,0.5);
});
