# Crypto-Signal v4.0.0

Eight-agent market scanner for crypto futures with the existing Telegram, Discord, and Binance Square output contract.

## Production architecture

The active scanner is now a **single engine**. The legacy scanner tree, TraderSpy discovery/validation path, Council add-on path, and fallback decision tree are not executed.

```
Bitget USDT Futures public market data
        ↓
Liquid USDT perpetual universe
        ↓
5M / 15M / 1H / 4H market structure
        ↓
8-agent Council
  ├─ Wyckoff
  ├─ OrderFlow
  ├─ Exhaustion
  ├─ SmartMoney
  ├─ Structure
  ├─ Whale
  ├─ MTF
  └─ Pullback
        ↓
Regime-dependent weighting
  ├─ trending
  ├─ ranging
  └─ volatile
        ↓
Weighted LONG / SHORT consensus
        ↓
Deep validation for the strongest candidates
  ├─ order book imbalance
  ├─ aggregate trades
  ├─ open interest
  ├─ funding
  ├─ top long/short positioning
  └─ global long/short positioning
        ↓
Executable trade geometry
        ↓
UNCHANGED DELIVERY CONTRACT
  ├─ Discord
  ├─ Telegram
  └─ Binance Square (max 3 coins/post + visual)
```

The Council score is a deterministic **screening/quality score**, not a statistical win probability.

## Eight-agent model

Each candidate receives independent directional scores from eight agents.

| Agent | Primary evidence |
|---|---|
| Wyckoff | structure, pressure, reversal behavior |
| OrderFlow | candle/taker pressure and volume expansion |
| Exhaustion | RSI location, reversal candles, exhaustion |
| SmartMoney | higher-timeframe structure alignment |
| Structure | swing structure and directional trend |
| Whale | taker flow and deep market participation |
| MTF | 4H + 1H + 15M + 5M agreement |
| Pullback | Fibonacci retracement/location and pressure |

Weights change by detected regime rather than using one static weighting table.

## Candidate funnel

The default production funnel is bounded:

- liquid universe: **30** USDT perpetuals
- candle depth: **120** bars
- initial data: 5M, 15M, 1H, 4H
- Council shortlist: strongest **10**
- deep validation: strongest **10**
- minimum weighted consensus: **52**
- Bitget request concurrency: **6** initial / bounded deep pass

The limits are intentionally configurable so the scanner does not create uncontrolled public-API load.

## Configuration

Optional environment variables:

```
SCANNER_INTERVAL=5m
SCANNER_CANDLES=120
SCANNER_UNIVERSE=30
SCANNER_CANDIDATES=10
SCANNER_MIN_VOLUME=15000000
SCANNER_BATCH=6
SCANNER_MIN_CONSENSUS=52
SCANNER_DEEP_CANDIDATES=10
SCANNER_DRY_RUN=false
```

## Trade geometry

The scanner engine determines the market direction and live Entry candidate. Production executable geometry remains delegated to `trade_plan.js`.

The existing contract is retained:

- Margin: **5 USDT**
- Leverage: **5x–20x** (selected by the existing production geometry; never below 5x)
- Maximum price-risk envelope: **0.5%**
- TP1 / TP2 / TP3: existing production geometry
- Entry / SL / TP are emitted as actual prices

The scanner does not increase leverage to force an invalid structural stop through the geometry gate.

## Output contract

The public presentation layer is intentionally isolated in `delivery.js`.

It preserves the existing destinations and presentation behavior:

### Discord
Every newly validated, non-duplicate signal is sent individually.

### Telegram
Every newly validated, non-duplicate signal is sent individually using the existing HTML message format.

### Binance Square
- signals are grouped in sequential batches of up to **3 coins**
- the text and visual use the **same three coins**
- the visual remains mandatory
- a failed visual render/upload aborts that Square batch instead of publishing mismatched text
- hashtag remains `#PintarPakaiBinanceEarn`

Internal engine/provider names are not intentionally exposed in public signal copy.

## Deduplication

Cross-scan duplicates remain blocked using the persistent fingerprint in `signals-log.json`.

The fingerprint covers:

- symbol
- direction
- setup
- relative SL
- relative TP1
- relative TP2
- relative TP3

This prevents the same scanner result from being repeatedly distributed while still allowing different valid coins in the same scan.

## Files

| File | Role |
|---|---|
| `scanner.js` | production orchestration, geometry, dedup, delivery |
| `scanner_engine.js` | complete 8-agent market decision engine |
| `delivery.js` | preserved Telegram / Discord / Binance Square output layer |
| `trade_plan.js` | executable margin/leverage/SL/TP geometry |
| `signals-log.json` | persistent signal/dedup audit state |
| `.github/workflows/scan.yml` | scheduled/manual/PR scanner workflow |

## Workflow

GitHub Actions:

- scheduled hourly
- manual `workflow_dispatch`
- pull-request validation
- Node 22
- syntax checks for all active production modules
- `npm test`
- PR runs the scanner in dry-run mode
- scheduled/manual runs retain live delivery

## Failure behavior

The active engine is fail-closed:

- Bitget market-data failure → scanner run fails rather than inventing data
- malformed market data → candidate skipped
- insufficient timeframe data → candidate skipped
- weak Council consensus → candidate rejected
- invalid executable geometry → candidate rejected
- duplicate signal → not delivered
- delivery failure → logged explicitly

No mock market data is generated.

## Testing

Local/CI checks:

```bash
node --check scanner.js
node --check scanner_engine.js
node --check delivery.js
node --check trade_plan.js
npm test
```

## Disclaimer

Crypto-Signal is an information/education tool for market analysis. It is not financial advice and does not execute orders automatically. Always validate market conditions, execution price, fees, slippage, leverage, and risk independently.
