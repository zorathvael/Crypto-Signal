const test = require("node:test");
const assert = require("node:assert/strict");
const { tfAnalysis, derivativeScore, levels, binance } = require("./traderspy_fallback");
const http = require("node:http");

function candles(n=100, drift=0.2){
  const out=[]; let p=100;
  for(let i=0;i<n;i++){
    const close=p+drift;
    out.push({open:p,high:close+1,low:p-1,close,volume:1000+i*5,closeTime:i});
    p=close;
  }
  return out;
}

test("fallback technical analysis produces a deterministic directional contract",()=>{
  const out=tfAnalysis(candles(100,0.2));
  assert.ok(out);
  assert.equal(out.direction,"LONG");
  assert.ok(Number.isFinite(out.atr));
  assert.ok(Number.isFinite(out.rsi));
  assert.ok(Number.isFinite(out.adx));
});

test("fallback derivatives gate rejects adverse funding",()=>{
  const out=derivativeScore("LONG",{openInterest:"1000"},{lastFundingRate:"0.001"}, {bids:[["100","10"]],asks:[["101","10"]]});
  assert.equal(out.adverse,true);
});

test("fallback levels preserve directional geometry and R:R",()=>{
  const c=candles(100,0.2);
  const a=tfAnalysis(c).atr;
  const lv=levels(c,"LONG",a);
  assert.ok(lv.sl<lv.entry);
  assert.ok(lv.tp1>lv.entry);
  assert.ok(lv.tp2>lv.tp1);
  assert.ok(lv.tp3>lv.tp2);
  assert.ok(Math.abs((lv.tp1-lv.entry)/(lv.entry-lv.sl))>=1.5);
});


test("fallback request fails over from HTTP 451 to the next configured endpoint", async () => {
  const first = http.createServer((req, res) => {
    res.writeHead(451, { "content-type": "application/json" });
    res.end(JSON.stringify({ msg: "restricted" }));
  });
  const second = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, endpoint: "second" }));
  });
  await new Promise((resolve) => first.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => second.listen(0, "127.0.0.1", resolve));
  const firstUrl = "http://127.0.0.1:" + first.address().port;
  const secondUrl = "http://127.0.0.1:" + second.address().port;
  const previous = process.env.BINANCE_FUTURES_BASE_URLS;
  process.env.BINANCE_FUTURES_BASE_URLS = firstUrl + "," + secondUrl;
  try {
    const out = await binance("/fapi/v1/ping");
    assert.deepEqual(out, { ok: true, endpoint: "second" });
  } finally {
    if (previous == null) delete process.env.BINANCE_FUTURES_BASE_URLS;
    else process.env.BINANCE_FUTURES_BASE_URLS = previous;
    await new Promise((resolve) => first.close(resolve));
    await new Promise((resolve) => second.close(resolve));
  }
});
