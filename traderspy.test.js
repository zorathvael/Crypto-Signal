const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeSignal, signalQualityScore, normalizeDiscoveryRows, buildScreenCandidate, technicalValidation, derivativesValidation } = require("./traderspy");

const NOW = Date.parse("2026-09-26T00:00:00Z");

function sample(overrides = {}) {
  return {
    id: "test-1",
    strategyName: "Pullback Trend Continuation Buy (1H)",
    importance: "high",
    action: "buy",
    signalStrength: "very_strong",
    coin: "ETHUSDT",
    timeframe: "1h",
    price: 100,
    targets: [
      { label: "TP1", type: "tp1", pct: 2 },
      { label: "TP2", type: "tp2", pct: 3 },
      { label: "TP3", type: "tp3", pct: 4 },
      { label: "SL", type: "sl", pct: 0.4 },
    ],
    triggeredConditions: ["RSI 55", "EMA reclaim"],
    resolutionStatus: "pending",
    createdAt: "2026-09-25T23:30:00Z",
    ...overrides,
  };
}

test("quality score is derived from TraderSpy strength and importance", () => {
  assert.equal(signalQualityScore(sample()), 99);
  assert.equal(signalQualityScore(sample({ signalStrength: "moderate", importance: "low" })), 84);
});

test("normalizes a LONG signal without inventing probability", () => {
  const out = normalizeSignal(sample(), NOW);
  assert.ok(out);
  assert.equal(out.action, "LONG");
  assert.equal(out.entry, 100);
  assert.equal(out.sl, 99.6);
  assert.equal(out.tp1, 101.2);
  assert.ok(Math.abs(out.tp2 - 102.4) < 1e-9);
  assert.ok(Math.abs(out.tp3 - 104.8) < 1e-9);
  assert.equal(out.rr, 3);
  assert.equal(out.probability, 99);
  assert.equal(out.qualityScore, 99);
  assert.equal(out.riskPct, 0.4);
  assert.equal(out.marginRiskPct, 10);
  assert.ok(out.leverage >= 5 && out.leverage <= 20);
  assert.deepEqual(out.rewardMarginPcts, [30, 60, 120]);
});

test("normalizes a SHORT signal with mirrored levels", () => {
  const out = normalizeSignal(sample({
    action: "sell",
    coin: "SOLUSDT",
    price: 200,
  }), NOW);
  assert.ok(out);
  assert.equal(out.action, "SHORT");
  assert.equal(out.sl, 200.8);
  assert.ok(Math.abs(out.tp1 - 197.6) < 1e-9);
  assert.ok(Math.abs(out.tp2 - 195.2) < 1e-9);
  assert.ok(Math.abs(out.tp3 - 190.4) < 1e-9);
  assert.ok(out.rr >= 2);
  assert.ok(Math.abs(out.rr - 3) < 0.01);
});

test("rejects resolved, stale and non-crypto signals", () => {
  assert.equal(normalizeSignal(sample({ resolutionStatus: "tp1_hit" }), NOW), null);
  assert.equal(normalizeSignal(sample({ createdAt: "2026-09-25T18:00:00Z" }), NOW), null);
  assert.equal(normalizeSignal(sample({ coin: "AAPLUSDT" }), NOW), null);
});

test("rejects incomplete level data instead of fabricating it", () => {
  const bad = sample({ targets: [{ label: "TP1", pct: 2 }] });
  assert.equal(normalizeSignal(bad, NOW), null);
});


test("discovery normalization ranks only crypto futures candidates", () => {
  const out = normalizeDiscoveryRows({
    results: [
      { symbol: "ETHUSDT", bias: "bullish", trend: "up", adx14: 28, rsi14: 58, change24hPct: 3, values: { "Volume ratio": 1.4 } },
      { symbol: "AAPLUSDT", bias: "bullish", trend: "up", adx14: 40, rsi14: 60, change24hPct: 4, values: { "Volume ratio": 2 } },
      { symbol: "SOLUSDT", bias: "bearish", trend: "down", adx14: 22, rsi14: 42, change24hPct: -2, values: { "Volume ratio": 1.2 } }
    ]
  });
  assert.deepEqual(out.map(x => x.symbol), ["ETHUSDT", "SOLUSDT"]);
});

test("technical validation requires multi-timeframe directional agreement", () => {
  const signal = normalizeSignal(sample(), NOW);
  const payload = {
    price: 100.5,
    timeframes: [
      { interval: "15m", indicators: { rsi:{value:58}, macd:{histogram:1}, ema:{stack:"bullish"}, adx:{value:25}, supertrend:{trend:"up"} }, summary:{bias:"bullish",trend:{direction:"up",emaStack:"bullish",adx:25},momentum:{rsi:58,macdHistogram:1}} },
      { interval: "1h", indicators: { rsi:{value:60}, macd:{histogram:1}, ema:{stack:"bullish"}, adx:{value:30}, supertrend:{trend:"up"} }, summary:{bias:"bullish",trend:{direction:"up",emaStack:"bullish",adx:30},momentum:{rsi:60,macdHistogram:1}} },
      { interval: "4h", indicators: { rsi:{value:61}, macd:{histogram:1}, ema:{stack:"bullish"}, adx:{value:22}, supertrend:{trend:"up"} }, summary:{bias:"bullish",trend:{direction:"up",emaStack:"bullish",adx:22},momentum:{rsi:61,macdHistogram:1}} }
    ]
  };
  const out = technicalValidation(signal, payload);
  assert.equal(out.pass, true);
  assert.ok(out.aligned >= 2);
});

test("derivatives validation rejects extreme adverse crowding", () => {
  const signal = normalizeSignal(sample(), NOW);
  const out = derivativesValidation(signal, {
    data: [{
      symbol: "ETHUSDT",
      funding: { ratePct: 0.08 },
      openInterest: { regime: "new_longs" },
      positioning: { globalLongPct: 78, takerBuySellRatio: 1.2 }
    }]
  });
  assert.equal(out.pass, false);
});


test("discovery candidates use the margin reward geometry contract", () => {
  const discovery = {
    symbol: "ETHUSDT",
    base: "ETH",
    bias: "bullish",
    trend: "up",
    score: 10,
  };
  const payload = {
    price: 100,
    timeframes: [
      { interval: "15m", summary:{bias:"bullish",trend:{direction:"up",emaStack:"bullish"}}, indicators:{} },
      { interval: "1h", summary:{bias:"bullish",trend:{direction:"up",emaStack:"bullish"}}, indicators:{atr:{value:1},levels:{support:[{price:99.6}],resistance:[{price:104}]}} },
      { interval: "4h", summary:{bias:"bullish",trend:{direction:"up",emaStack:"bullish"}}, indicators:{} },
    ],
  };
  const out = buildScreenCandidate(discovery, payload, NOW, "LONG");
  assert.ok(out);
  const risk = Math.abs(out.entry - out.sl);
  assert.equal(out.leverage, 25);\n  assert.equal(out.marginRiskPct, 10);\n  assert.deepEqual(out.rewardMarginPcts, [30, 60, 120]);\n  assert.ok(Math.abs((out.tp1 - out.entry) / out.entry * out.leverage - 0.30) < 1e-9);
  assert.ok(Math.abs((out.tp2 - out.entry) / out.entry * out.leverage - 0.60) < 1e-9);
  assert.ok(Math.abs((out.tp3 - out.entry) / out.entry * out.leverage - 1.20) < 1e-9);
});

test("discovery candidates respect the fixed 25x risk-plan SL ceiling", () => {
  const discovery = { symbol:"ETHUSDT", base:"ETH", bias:"bullish", trend:"up", score:10 };
  const payload = {
    price:100,
    timeframes:[
      { interval:"15m", summary:{bias:"bullish",trend:{direction:"up",emaStack:"bullish"}}, indicators:{} },
      { interval:"1h", summary:{bias:"bullish",trend:{direction:"up",emaStack:"bullish"}}, indicators:{atr:{value:1},levels:{support:[]}} },
      { interval:"4h", summary:{bias:"bullish",trend:{direction:"up",emaStack:"bullish"}}, indicators:{} },
    ],
  };
  const out=buildScreenCandidate(discovery,payload,NOW,"LONG");
  assert.ok(out);
  assert.ok(Math.abs(out.entry-out.sl)/out.entry<=0.004);
});

test("discovery candidates with excessive volatility are rejected before validation", () => {
  const discovery = { symbol:"ETHUSDT", base:"ETH", bias:"bullish", trend:"up", score:10 };
  const payload = {
    price:100,
    timeframes:[
      { interval:"15m", summary:{bias:"bullish",trend:{direction:"up",emaStack:"bullish"}}, indicators:{} },
      { interval:"1h", summary:{bias:"bullish",trend:{direction:"up",emaStack:"bullish"}}, indicators:{atr:{value:5},levels:{support:[]}} },
      { interval:"4h", summary:{bias:"bullish",trend:{direction:"up",emaStack:"bullish"}}, indicators:{} },
    ],
  };
  assert.equal(buildScreenCandidate(discovery,payload,NOW,"LONG"),null);
});

test("discovery candidates are rejected when multi-timeframe data has no directional confluence", () => {
  const signal = normalizeSignal(sample({ coin: "SOLUSDT" }), NOW);
  const payload = {
    price: 100,
    timeframes: [
      { interval: "15m", indicators: { rsi:{value:50}, macd:{histogram:0}, ema:{stack:"mixed"}, adx:{value:12}, supertrend:{trend:"down"} }, summary:{bias:"neutral",trend:{direction:"sideways",emaStack:"mixed",adx:12},momentum:{rsi:50,macdHistogram:0}} },
      { interval: "1h", indicators: { rsi:{value:50}, macd:{histogram:0}, ema:{stack:"mixed"}, adx:{value:14}, supertrend:{trend:"down"} }, summary:{bias:"neutral",trend:{direction:"sideways",emaStack:"mixed",adx:14},momentum:{rsi:50,macdHistogram:0}} },
      { interval: "4h", indicators: { rsi:{value:50}, macd:{histogram:0}, ema:{stack:"mixed"}, adx:{value:15}, supertrend:{trend:"down"} }, summary:{bias:"neutral",trend:{direction:"sideways",emaStack:"mixed",adx:15},momentum:{rsi:50,macdHistogram:0}} }
    ]
  };
  assert.equal(technicalValidation(signal, payload).pass, false);
});
