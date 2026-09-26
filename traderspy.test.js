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
      { label: "SL", type: "sl", pct: 1 },
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
  assert.equal(out.sl, 99);
  assert.equal(out.tp1, 102);
  assert.equal(out.tp2, 103);
  assert.equal(out.tp3, 104);
  assert.equal(out.rr, 2);
  assert.equal(out.probability, 99);
  assert.equal(out.qualityScore, 99);
  assert.equal(out.riskPct, null);
});

test("normalizes a SHORT signal with mirrored levels", () => {
  const out = normalizeSignal(sample({
    action: "sell",
    coin: "SOLUSDT",
    price: 200,
  }), NOW);
  assert.ok(out);
  assert.equal(out.action, "SHORT");
  assert.equal(out.sl, 202);
  assert.equal(out.tp1, 196);
  assert.equal(out.rr, 2);
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


test("builds a candidate from MTF direction when confluence bias is absent", () => {
  const payload = {
    price: 100,
    timeframes: [
      { interval: "15m", indicators: { atr:{value:1}, ema:{stack:"bullish"}, supertrend:{trend:"up"} }, summary:{bias:"",trend:{direction:"up",emaStack:"bullish"}} },
      { interval: "1h", indicators: { atr:{value:1.2}, ema:{stack:"bullish"}, supertrend:{trend:"up"} }, summary:{bias:"",trend:{direction:"up",emaStack:"bullish"}} },
      { interval: "4h", indicators: { atr:{value:2}, ema:{stack:"bullish"}, supertrend:{trend:"up"} }, summary:{bias:"",trend:{direction:"up",emaStack:"bullish"}} }
    ]
  };
  const candidate = buildScreenCandidate(
    { symbol: "ETHUSDT", base: "ETH", score: 8, bias: "bullish", trend: "up" },
    payload,
    NOW
  );
  assert.ok(candidate);
  assert.equal(candidate.generatedCandidate, true);
  assert.equal(candidate.action, "LONG");
  assert.ok(candidate.rr >= 1.5);
});
