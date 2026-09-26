const test=require("node:test");
const assert=require("node:assert/strict");
const {calculateAlpha}=require("./alpha_hunter");

function payload(){
  const tf=(bias,macd=1)=>({summary:{bias,trend:{direction:bias==="bullish"?"up":"down",emaStack:bias}},indicators:{supertrend:{trend:bias==="bullish"?"up":"down"},adx:{value:30},rsi:{value:bias==="bullish"?58:42},macd:{histogram:macd},atr:{value:2}}});
  return {price:100,timeframes:[{interval:"15m",...tf("bullish")},{interval:"1h",...tf("bullish")},{interval:"4h",...tf("bullish")}]};
}
function deriv(){
  return new Map([["BTCUSDT",{funding:{ratePct:0},positioning:{globalLongPct:55,takerBuySellRatio:1.1},openInterest:{regime:"new_longs"}}]]);
}

test("alpha hunter passes aligned 2R/4R/6R setup",()=>{
  const out=calculateAlpha({action:"LONG",instId:"BTCUSDT",entry:100,sl:99,tp1:102,tp2:104,tp3:106,ts:Date.now()},payload(),deriv());
  assert.equal(out.pass,true);
  assert.ok(out.alphaScore>=72);
  assert.equal(out.factors.mtfAligned,3);
  assert.equal(out.factors.rr1,2);
  assert.equal(out.factors.rr2,4);
  assert.equal(out.factors.rr3,6);
  assert.equal(out.factors.historical.edge,"insufficient");
});

test("alpha hunter vetoes weak MTF alignment",()=>{
  const p=payload();for (const i of [1, 2]) { p.timeframes[i].summary.bias="bearish"; p.timeframes[i].summary.trend.direction="down"; p.timeframes[i].summary.trend.emaStack="bearish"; p.timeframes[i].indicators.supertrend.trend="down"; }
  const out=calculateAlpha({action:"LONG",instId:"BTCUSDT",entry:100,sl:99,tp1:102,tp2:104,tp3:106,ts:Date.now()},p,deriv());
  assert.equal(out.pass,false);
  assert.ok(out.hardReject.includes("MTF alignment <2/3"));
});

test("alpha hunter vetoes non-2R/4R/6R geometry",()=>{
  const out=calculateAlpha({action:"LONG",instId:"BTCUSDT",entry:100,sl:99,tp1:101.5,tp2:103,tp3:104.5,ts:Date.now()},payload(),deriv());
  assert.equal(out.pass,false);
  assert.ok(out.hardReject.some(x=>x.includes("TP1 R:R")));
  assert.ok(out.hardReject.some(x=>x.includes("TP2")));
  assert.ok(out.hardReject.some(x=>x.includes("TP3")));
});

test("alpha hunter vetoes stale signal",()=>{
  const out=calculateAlpha({action:"LONG",instId:"BTCUSDT",entry:100,sl:99,tp1:102,tp2:104,tp3:106,ts:Date.now()-121*60000},payload(),deriv());
  assert.equal(out.pass,false);
  assert.ok(out.hardReject.includes("signal stale"));
});


test("alpha hunter uses historical positive edge only after minimum sample",()=>{
  const closed=[];
  for(let i=0;i<12;i++) closed.push({action:"LONG",setup:"SCALP_MTF",outcome:i<8?"WIN_TP1":"LOSS_SL",rMultiple:i<8?1.5:-1});
  const out=calculateAlpha({action:"LONG",setup:"SCALP_MTF",instId:"BTCUSDT",entry:100,sl:99,tp1:102,tp2:104,tp3:106,ts:Date.now()},payload(),deriv(),Date.now(),{closed});
  assert.equal(out.factors.historical.sampleSize,12);
  assert.equal(out.factors.historical.edge,"positive");
  assert.equal(out.factors.historical.scoreDelta,6);
  assert.equal(out.pass,true);
});

test("alpha hunter vetoes materially negative historical edge with enough outcomes",()=>{
  const closed=[];
  for(let i=0;i<20;i++) closed.push({action:"SHORT",setup:"SCALP_MTF",outcome:i<7?"WIN_TP1":"LOSS_SL",rMultiple:i<7?1.5:-1});
  const out=calculateAlpha({action:"SHORT",setup:"OTHER",instId:"BTCUSDT",entry:100,sl:101,tp1:98,tp2:96,tp3:94,ts:Date.now()},payload(),deriv(),Date.now(),{closed});
  assert.equal(out.factors.historical.sampleSize,20);
  assert.equal(out.factors.historical.edge,"negative");
  assert.ok(out.hardReject.includes("historical edge negative with >=20 outcomes"));
  assert.equal(out.pass,false);
});
