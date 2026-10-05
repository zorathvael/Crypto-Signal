# Crypto-Signal v5.2.0

## Live Binance scanner + Bitget fallback + local Qwen3 intelligence

Production scanner v5 is based on the supplied **Radar Sinyal — Live Binance Futures** implementation. The deterministic market method is ported directly rather than replaced with a new scoring model.

### Live Binance data

The scanner uses Binance Futures public read-only market data:

- `/fapi/v1/klines`
- `/fapi/v1/ticker/price`
- configurable watchlist
- default timeframe: **1H**
- fallback provider: **Bitget USDT-Futures**
- broad crypto-perpetual universe discovery
- publish gate: **combined score >= 90**
- Binance Square: **1–3 coins in one post per scanner run** (3 maximum)
- Telegram/Discord: every new signal with score >= 90
- provider mode: `auto` (Binance first), `binance`, or `bitget`
- default history: **150 candles**
- no Binance API key or secret required

There is **no mock market data**. Provider order is Binance → Bitget. If Binance is blocked, unavailable, times out, or returns invalid market data for a symbol, that symbol is automatically retried against Bitget USDT-Futures.

Binance documents public REST data endpoints and the Futures kline interval family. citeturn1search0turn1search3

### Crypto futures universe + AI scoring

Each scan dynamically discovers active perpetual USDT futures, ranks the universe by live 24h liquidity, excludes configured TradFi/RWA-style symbols, and evaluates up to the configured universe size. Binance is primary and Bitget is the fallback.

Qwen3 is an active second-stage scanner, not merely a formatter: it independently scores the deterministic candidates and flags conflicts. The publish gate uses a combined score: **60% deterministic technical/calibration score + 40% Qwen AI score**. Only **combined score >= 90** and a non-rejected Qwen verdict can reach Telegram/Discord.

### Deterministic calibration (unchanged across providers)

The supplied scanner methodology is preserved:

1. EMA20 / EMA50 trend
2. RSI14
3. MACD histogram
4. relative volume
5. signed strength
6. historical forward-move calibration over the latest 120-candle window
7. median adverse/favourable movement
8. calibrated entry distance
9. structural stop
10. historical fill probability
11. historical TP1 reach probability

The original source explicitly describes the calibration as using a 120-candle pullback history and derives Entry/SL/TP from those historical distributions. fileciteturn14file0L156-L218

### Qwen3 local intelligence

The scanner now has a second-stage **Qwen3-0.6B Q4_K_M** validator.

The supplied model file was verified locally by SHA-256:

`3479875d3e4c726f7a20b2181f5e1536aefe9925f284f9ae9997a39a7e0d8dc9`

This exactly matches the public `gvij/qwen3-0.6b-gguf` Q4_K_M file, which is 484 MB. citeturn3search2turn3search4

Qwen does **not** rewrite the deterministic Entry/SL/TP. It receives the calculated market state and returns:

- VALID / CAUTION / REJECT
- AI score
- AI confidence
- reasons
- risk flags

The model is served through an OpenAI-compatible local endpoint. llama.cpp officially supports `/v1/chat/completions` and GGUF local models. citeturn0search1turn2search3

### Local Qwen

Place the supplied file at:

`models/qwen3-0.6b-q4_k_m.gguf`

Then start a local llama.cpp server, for example:

`llama-server -m models/qwen3-0.6b-q4_k_m.gguf --alias qwen3-0.6b --host 127.0.0.1 --port 11434`

The scanner expects:

`QWEN_BASE_URL=http://127.0.0.1:11434/v1`

The repository also contains `scripts/start_qwen.sh`, which verifies the model SHA and can provision the same model for CI.

### GitHub Actions

CI:

- syntax-checks all production modules
- runs deterministic regression tests
- caches the 484 MB Qwen model
- attempts to start local Qwen through the official llama.cpp server image
- continues deterministically if Qwen or the model download is unavailable
- runs the scanner against live Binance data
- never generates mock signals

This keeps a market-data outage from becoming a false trading result.

### Output contract

Existing distribution remains:

- Telegram: every new valid signal
- Discord: every new valid signal
- Binance Square: every run with 1–3 eligible coins is posted (3 maximum)
- the exact same eligible coins appear in Square text and visual
- `#PintarPakaiBinanceEarn`
- duplicate suppression via `signals-log.json`

The public output is now labeled **Crypto-Signal v5.0** and **Live Binance + Qwen3**.

### Configuration

```
SCANNER_SYMBOLS=NEARUSDT,PUMPUSDT,SOLUSDT,...
SCANNER_INTERVAL=1h
SCANNER_CANDLES=150
SCANNER_CANDIDATES=10
SCANNER_CONCURRENCY=4
SCANNER_PROVIDER=auto

QWEN_BASE_URL=http://127.0.0.1:11434/v1
QWEN_MODEL=qwen3-0.6b
QWEN_MAX_CANDIDATES=3
QWEN_TIMEOUT_MS=20000
```

### Validation

```
node --check scanner.js
node --check scanner_engine.js
node --check qwen_ai.js
node --check delivery.js
node --check trade_plan.js
npm test
```

No claim of production success is made until the new GitHub Actions run validates the changed commit.

### Disclaimer

Crypto-Signal is an information/education tool. It does not automatically execute orders and is not financial advice.
