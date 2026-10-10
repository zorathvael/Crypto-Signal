const test = require("node:test");
const assert = require("node:assert/strict");

test("Gemini is used only as a fallback when local Qwen is unavailable", async () => {
  const oldFetch = global.fetch;
  const oldKey = process.env.GEMINI_API_KEY;
  const oldRetries = process.env.QWEN_RETRIES;
  process.env.GEMINI_API_KEY = "test-key";
  process.env.QWEN_RETRIES = "0";
  let qwenCalls = 0;
  let geminiCalls = 0;
  global.fetch = async (url) => {
    if (String(url).includes("127.0.0.1")) {
      qwenCalls++;
      return { ok: false, status: 503, text: async () => "unavailable" };
    }
    if (String(url).includes("generativelanguage.googleapis.com")) {
      geminiCalls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: JSON.stringify({
            scores: [{ symbol: "BTCUSDT", score: 88, confidence: 81, verdict: "VALID" }]
          }) }] } }]
        })
      };
    }
    throw new Error("Unexpected URL: " + url);
  };

  try {
    delete require.cache[require.resolve("./qwen_ai")];
    const { scanUniverse } = require("./qwen_ai");
    const result = await scanUniverse([{
      symbol: "BTCUSDT", direction: "LONG", strength: 70, confidence: 80,
      rsi: 55, relativeVolume: 1.2, atr: 2, fillP: 60, reachP: 70, components: {}
    }]);
    assert.equal(qwenCalls, 1);
    assert.equal(geminiCalls, 1);
    assert.equal(result.candidates[0].ai.provider, "Gemini");
    assert.equal(result.candidates[0].ai.verdict, "VALID");
    assert.equal(result.available, true);
  } finally {
    global.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = oldKey;
    if (oldRetries === undefined) delete process.env.QWEN_RETRIES;
    else process.env.QWEN_RETRIES = oldRetries;
    delete require.cache[require.resolve("./qwen_ai")];
  }
});

test("quota-exhausted Gemini falls back to deterministic unavailable status without throwing", async () => {
  const oldFetch = global.fetch;
  const oldKey = process.env.GEMINI_API_KEY;
  const oldRetries = process.env.QWEN_RETRIES;
  process.env.GEMINI_API_KEY = "test-key";
  process.env.QWEN_RETRIES = "0";
  global.fetch = async (url) => {
    if (String(url).includes("127.0.0.1")) return { ok: false, status: 503, text: async () => "down" };
    return { ok: false, status: 429, text: async () => "quota exceeded" };
  };
  try {
    delete require.cache[require.resolve("./qwen_ai")];
    const { scanUniverse } = require("./qwen_ai");
    const result = await scanUniverse([{ symbol: "ETHUSDT", direction: "SHORT", strength: -70 }]);
    assert.equal(result.candidates[0].ai.verdict, "UNAVAILABLE");
    assert.equal(result.available, false);
    assert.equal(result.candidates.length, 1);
  } finally {
    global.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = oldKey;
    if (oldRetries === undefined) delete process.env.QWEN_RETRIES;
    else process.env.QWEN_RETRIES = oldRetries;
    delete require.cache[require.resolve("./qwen_ai")];
  }
});
