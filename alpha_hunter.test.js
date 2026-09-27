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

test("alpha hunter passes aligned margin geometry",()=>{
  const out=calculateAlpha({action:"LONG",instId:"BTCUSDT",entry:100,sl:99.6,tp1:101.2,tp2:102.4,tp3:104.8,ts:Date.now()},payload(),deriv());
  assert.equal(out.pass,true);
  assert.ok(out.alphaScore>=72);
  assert.equal(out.factors.mtfAligned,3);
  assert.equal(out.factors.marginRiskPct,10);
  assert.equal(out.factors.reward1,30);
  assert.equal(out.factors.reward2,60);
  assert.equal(out.factors.reward3,120);
  assert.equal(out.factors.historical.edge,"insufficient");
});

test("alpha hunter vetoes weak MTF alignment",()=>{
  const p=payload();for (const i of [1, 2]) { p.timeframes[i].summary.bias="bearish"; p.timeframes[i].summary.trend.direction="down"; p.timeframes[i].summary.trend.emaStack="bearish"; p.timeframes[i].indicators.supertrend.trend="down"; }
  const out=calculateAlpha({action:"LONG",instId:"BTCUSDT",entry:100,sl:99.6,tp1:101.2,tp2:102.4,tp3:104.8,ts:Date.now()},p,deriv());
  assert.equal(out.pass,false);
  assert.ok(out.hardReject.includes("MTF alignment <2/3"));
});

test("alpha hunter vetoes insufficient margin reward geometry",()=>{
  const out=calculateAlpha({action:"LONG",instId:"BTCUSDT",entry:100,sl:99.6,tp1:100.5,tp2:101,tp3:101.5,ts:Date.now()},payload(),deriv());
  assert.equal(out.pass,false);
  assert.ok(out.hardReject.includes("signal levels do not match fixed 25x geometry"));
});

test("alpha hunter vetoes stale signal",()=>{
  const out=calculateAlpha({action:"LONG",instId:"BTCUSDT",entry:100,sl:99.6,tp1:101.2,tp2:102.4,tp3:104.8,ts:Date.now()-121*60000},payload(),deriv());
  assert.equal(out.pass,false);
  assert.ok(out.hardReject.includes("signal stale"));
});


test("alpha hunter uses historical positive edge only after minimum sample",()=>{
  const closed=[];
  for(let i=0;i<12;i++) closed.push({ts:Date.now()-i*3600000,base:"BTC",action:"LONG",setup:"SCALP_MTF",outcome:i<8?"WIN_TP1":"LOSS_SL",rMultiple:i<8?1.5:-1});
  const out=calculateAlpha({action:"LONG",setup:"SCALP_MTF",instId:"BTCUSDT",entry:100,sl:99.6,tp1:101.2,tp2:102.4,tp3:104.8,ts:Date.now()},payload(),deriv(),Date.now(),{closed});
  assert.equal(out.factors.historical.sampleSize,12);
  assert.equal(out.factors.historical.edge,"positive");
  assert.equal(out.factors.historical.scoreDelta,6);
  assert.equal(out.pass,true);
});

test("alpha hunter vetoes materially negative historical edge with enough outcomes",()=>{
  const closed=[];
  for(let i=0;i<20;i++) closed.push({ts:Date.now()-i*3600000,base:"BTC",action:"SHORT",setup:"SCALP_MTF",outcome:i<7?"WIN_TP1":"LOSS_SL",rMultiple:i<7?1.5:-1});
  const out=calculateAlpha({action:"SHORT",setup:"OTHER",instId:"BTCUSDT",entry:100,sl:100.4,tp1:98.8,tp2:97.6,tp3:95.2,ts:Date.now()},payload(),deriv(),Date.now(),{closed});
  assert.equal(out.factors.historical.sampleSize,20);
  assert.equal(out.factors.historical.edge,"negative");
  assert.ok(out.hardReject.includes("historical edge negative with >=20 outcomes"));
  assert.equal(out.pass,false);
});


test("alpha hunter uses conditional quality-bucket edge before generic action edge",()=>{
  const closed=[];
  for(let i=0;i<14;i++) closed.push({ts:Date.now()-i*3600000,base:"BTC"+i,action:"LONG",setup:"OTHER",probability:80+i%9,outcome:i<10?"WIN_TP1":"LOSS_SL",rMultiple:i<10?1.4:-1,horizons:{h15:{r:i<10?0.35:-0.05}}});
  for(let i=0;i<12;i++) closed.push({ts:Date.now()-i*7200000,base:"ETH"+i,action:"LONG",setup:"OTHER",probability:95,outcome:i<5?"WIN_TP1":"LOSS_SL",rMultiple:i<5?1.2:-1});
  const out=calculateAlpha({action:"LONG",setup:"NEW_SETUP",instId:"BTCUSDT",qualityScore:84,entry:100,sl:99.6,tp1:101.2,tp2:102.4,tp3:104.8,ts:Date.now()},payload(),deriv(),Date.now(),{closed});
  assert.equal(out.factors.historical.source,"quality_bucket_action");
  assert.ok(out.factors.historical.scoreDelta>0);
  assert.equal(out.factors.historical.bucket,"80_89");
});

test("alpha hunter ignores legacy non-crypto and pre-baseline outcomes",()=>{
  const closed=[];
  for(let i=0;i<30;i++) closed.push({ts:Date.parse("2026-09-10T00:00:00Z")+i*3600000,base:"AAPL",action:"LONG",setup:"SCALP_MTF",outcome:"LOSS_SL",rMultiple:-1});
  for(let i=0;i<30;i++) closed.push({ts:Date.parse("2026-09-20T00:00:00Z")+i*3600000,base:"BTC",action:"LONG",setup:"OTHER",outcome:"WIN_TP1",rMultiple:1.5});
  const out=calculateAlpha({action:"LONG",setup:"NEW_SETUP",instId:"BTCUSDT",entry:100,sl:99.6,tp1:101.2,tp2:102.4,tp3:104.8,ts:Date.now()},payload(),deriv(),Date.now(),{closed});
  assert.equal(out.factors.historical.sampleSize,30);
  assert.equal(out.factors.historical.edge,"positive");
});
