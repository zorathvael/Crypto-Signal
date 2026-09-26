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
  assert.deepEqual(out.factors,{mtfAligned:3,mtfOpposing:0,entryAtrDistance:0,rr1:2,rr2:4,rr3:6});
});

test("alpha hunter vetoes weak MTF alignment",()=>{
  const p=payload();p.timeframes[1].summary.bias="bearish";p.timeframes[1].summary.trend.direction="down";p.timeframes[1].summary.trend.emaStack="bearish";p.timeframes[1].indicators.supertrend.trend="down";
  const out=calculateAlpha({action:"LONG",instId:"BTCUSDT",entry:100,sl:99,tp1:102,tp2:104,tp3:106,ts:Date.now()},p,deriv());
  assert.equal(out.pass,false);
  assert.ok(out.hardReject.includes("MTF alignment <2/3"));
});

test("alpha hunter vetoes non-2R/4R/6R geometry",()=>{
  const out=calculateAlpha({action:"LONG",instId:"BTCUSDT",entry:100,sl:99,tp1:101.5,tp2:103,tp3:105,ts:Date.now()},payload(),deriv());
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
