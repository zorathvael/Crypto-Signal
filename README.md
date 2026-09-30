# Crypto-Signal v4.1.0

Source-calibrated 8-agent crypto futures scanner with AI moderation, Fibonacci entry geometry, adaptive 5x–20x risk geometry, and the existing Telegram/Discord/Binance Square delivery contract.

## Decision methodology

The supplied `scanner-council.html` is authoritative for the decision method. The production engine ports its:

- Wyckoff
- OrderFlow
- Exhaustion
- SmartMoney
- Structure
- Whale
- MTF
- Pullback
- trending / ranging / volatile regime detection
- regime-dependent weights
- weighted LONG/SHORT voting
- consensus formula
- minimum consensus and minimum winning-agent-weight gates
- 20-candle Fibonacci pullback detector

The engine does **not** invent a second scoring system. AI is a moderator/validator layer and never changes Council scores or weights.

## Market data

Production discovery uses Binance Futures public endpoints because the source methodology requires:

- candle taker-buy volume
- aggregate trades
- top-trader long/short positioning
- global long/short account positioning
- 5M / 15M / 1H / 4H candles

No mock market data is generated.

## AI moderator

`ai_moderator.js` provides a free-provider path:

1. Optional OpenAI-compatible gateway such as **ReallyArtificial/freeport** via `FREEPORT_URL`.
2. Pollinations public inference fallback, matching the AI approach present in the supplied Council HTML.

The Freeport project is MIT licensed and provides an OpenAI-compatible multi-provider gateway; it is an adapter target, not a bundled server inside GitHub Actions.

Optional variables:

```
FREEPORT_URL=
FREEPORT_API_KEY=
FREEPORT_MODEL=gpt-4o-mini
AI_TIMEOUT_MS=22000
AI_MAX_CANDIDATES=3
```

AI is limited to the strongest Council candidates. If AI is unavailable, the deterministic Council result remains intact; no fabricated AI verdict is produced.

## Fibonacci trade geometry

The supplied Council file calculates a 20-candle swing and identifies the 38.2%–61.8% pullback zone. Production execution geometry now uses that same swing:

- Entry: **50% Fibonacci retracement**
- Structural SL: swing extreme ± **0.8 ATR**, matching the source trade-plan method
- Margin: **5 USDT**
- Risk target: **0.50 USDT**
- Leverage: **adaptive 5x–20x**
- TP1: **2R**
- TP2: **4R**
- TP3: **6R**
- no leverage below 5x
- no target above 6R
- Entry / SL / TP are emitted as actual prices

If the structural Fibonacci stop would require leverage below 5x to stay within the 0.50 USDT risk budget, the candidate is rejected rather than distorting the stop.

## Delivery contract

The existing destinations remain:

- Telegram: every new valid signal
- Discord: every new valid signal
- Binance Square: only complete **3-coin** batches, with the exact same three coins in text and visual

If fewer than three eligible Square signals remain, no partial Square post is created. A remainder of 1–2 coins is held for a later full batch.

Public posts do not expose internal provider names.

Square hashtag remains:

`#PintarPakaiBinanceEarn`

The Square visual is labeled **CRYPTO-SIGNAL v4.1**.

## Deduplication

Cross-scan duplicates remain blocked through `signals-log.json`. Fingerprints include:

- symbol
- direction
- setup
- relative SL
- relative TP1
- relative TP2
- relative TP3

## Configuration

```
SCANNER_INTERVAL=5m
SCANNER_CANDLES=60
SCANNER_UNIVERSE=30
SCANNER_CANDIDATES=10
SCANNER_MIN_VOLUME=15000000
SCANNER_BATCH=3
SCANNER_MIN_CONSENSUS=45
SCANNER_DEEP_CANDIDATES=10
SCANNER_DRY_RUN=false
```

## Production files

| File | Role |
|---|---|
| `scanner_engine.js` | Source-calibrated 8-agent Council |
| `ai_moderator.js` | Free AI moderator adapter |
| `trade_plan.js` | Fibonacci + adaptive risk geometry |
| `scanner.js` | orchestration, AI, geometry, dedup and delivery |
| `delivery.js` | Telegram / Discord / Binance Square |
| `trade_plan.test.js` | geometry regression tests |
| `signals-log.json` | persistent dedup/audit state |
| `.github/workflows/scan.yml` | scheduled/manual/PR validation |

## Validation

```
node --check scanner.js
node --check scanner_engine.js
node --check ai_moderator.js
node --check delivery.js
node --check trade_plan.js
npm test
```

No claim of production success is made until GitHub Actions validates the changed commit.

## Disclaimer

Crypto-Signal is an information/education tool for market analysis. It does not execute orders automatically and is not financial advice. Validate execution price, fees, slippage, leverage and risk independently.
