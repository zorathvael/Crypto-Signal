# Crypto-Signal v4.0

Crypto-Signal adalah pipeline publikasi signal futures v4.0 dengan **tiered market validation** dan delivery flow yang sudah ada. Provider intelligence tetap berada di backend dan tidak ditampilkan sebagai identitas sumber pada posting publik:

**Discovery → full validation → dedup → outcome tracking → Discord + Telegram + Binance Square**

> Crypto-Signal tidak mengeksekusi order. Signal adalah informasi untuk validasi manual.

## Perubahan inti v4.0

### Intelligence engine
Mulai v4.0, workflow aktif tidak lagi membuat signal dari scanner Bitget lokal.

Signal aktif berasal dari TraderSpy MCP `get_signals`, kemudian dinormalisasi oleh `traderspy.js`.

Yang tetap dipertahankan:
- `signals-log.json`
- outcome tracking
- persistent duplicate-result fingerprint + legacy dedup window
- semua signal baru yang lolos validasi dan dedup
- tidak ada suppression delivery berdasarkan loss streak
- Binance Square batch maksimal 3 coin per post
- format dan destination posting
- GitHub Actions
- Discord
- Telegram
- Binance Square

Yang tidak lagi menjadi sumber signal pada mode aktif:
- local MTF scoring
- local orderbook scoring
- local funding/OI/L/S scoring
- local BTC-bias signal generation
- local probability heuristics
- legacy SHORT/LONG direction bias

File scanner lama masih berada di `scanner.js` sebagai rollback reference, tetapi **workflow aktif memakai `TRADERSPY_ONLY=true`** sehingga jalur lama tidak dieksekusi.

## TraderSpy quota fallback

TraderSpy tetap menjadi **sumber utama**. Jika TraderSpy mengembalikan **HTTP 429 / daily quota exhausted**, scanner otomatis berpindah ke `traderspy_fallback.js`.

Fallback memakai **public Binance USDⓈ-M Futures market data** dan mempertahankan observable TraderSpy-compatible pipeline:

```
Binance futures universe
    ↓
liquidity discovery
    ↓
15M + 1H + 4H technical direction
    ↓
MTF agreement
    ↓
ATR / structure SL-TP
    ↓
funding + open interest + orderbook sanity
    ↓
bounded quality gate
    ↓
same signal contract
    ↓
same dedup / delivery pipeline
```

Fallback **tidak** menjadi sumber kedua yang selalu aktif dan tidak mengubah TraderSpy ketika TraderSpy tersedia. Ia hanya aktif pada quota exhaustion. Authentication errors, malformed TraderSpy responses, dan error lain tetap fail-closed.

Default fallback budget:
- discovery: top 20 liquid perpetual USDT symbols
- validation targets: 6
- hard maximum validation targets: 10
- per target: 3 kline requests + OI + funding + depth
- no order execution
- no synthetic/mock market data
- Binance Futures endpoint failover: `fapi.binance.com` → `fapi1` → `fapi2` → `fapi3` → `fapi4`; the first working endpoint is reused for the scan
- failover is bounded to 403/429/451/5xx responses and network failures; unexpected 4xx errors are not masked

Fallback tidak mengklaim mereplikasi proprietary internals TraderSpy. Ia mereplikasi **observable validation contract dan decision structure** yang digunakan repository ini untuk menjaga bentuk/aturan signal tetap kompatibel.

## TraderSpy adapter

File:
- `traderspy.js` — remote MCP client + signal normalization
- `traderspy.test.js` — unit tests untuk normalisasi
- `scanner.js` — pipeline, dedup, public formatting, dan delivery
- `signals-log.json` — outcome tracker
- `.github/workflows/scan.yml` — scheduled runtime

Adapter memakai **bounded tiered validation** per scan:

```
get_tracked_symbols
    ↓
screen_symbols (4H, top-volume universe)
    ↓
get_signals (up to 50 recent candidates)
    ↓
age/status/level/crypto validation
    ↓
bounded validation targets (default 10, configurable up to 20)
    ↓
get_derivatives (batched)
    ↓
get_technical_indicators (15M + 1H + 4H)
    ↓
get_signal_details (deep-check for strongest candidates)
    ↓
final validation score
    ↓
dedup / safety
    ↓
Discord
Telegram
Binance Square
```

The pipeline deliberately uses TraderSpy's screener and tracked-symbol universe before signal validation. A stale signal is never accepted merely because its timestamp is present: signals older than the normal delivery window can survive candidate selection only when current multi-timeframe technical and derivatives data still validate the setup. The tracked-symbol check is combined with an explicit non-crypto denylist so tokenized equities, metals, and other known non-crypto instruments do not enter the crypto delivery path.

## Signal normalization

TraderSpy memberikan:
- action: buy/sell
- symbol
- timeframe
- trigger price
- TP1/TP2/TP3 percentage
- SL percentage
- signal strength
- importance
- resolution status
- createdAt
- triggered conditions

Crypto-Signal mengubah persentase level tersebut menjadi level absolut:

- LONG: SL di bawah entry, TP di atas entry
- SHORT: SL di atas entry, TP di bawah entry

R:R dihitung dari TP1 terhadap jarak SL.

### Quality score

Field lama `probability` tetap dipertahankan di internal schema agar outcome/delivery layer kompatibel.

**Penting:** nilai tersebut bukan probabilitas statistik terkalibrasi.

Ia adalah **derived quality score** dari:
- TraderSpy signal strength
- TraderSpy importance

Mapping:
- very_strong → 96
- strong → 90
- moderate → 84
- weak → 76
- high importance mendapat bonus +3
- medium importance mendapat bonus +1

Default delivery floor: **80**.

Dengan demikian repository tidak mengklaim bahwa score tersebut adalah win probability.

## Signal freshness

Default:
- maximum signal age: 120 menit
- hanya `resolutionStatus=pending`
- signal dengan timestamp masa depan yang tidak wajar ditolak
- valid-until mengikuti timeframe TraderSpy dan freshness window

Environment variables dapat mengubah:
- `TRADERSPY_SIGNAL_LIMIT`
- `TRADERSPY_MAX_AGE_MIN`
- `TRADERSPY_MIN_SCORE`

## Telegram trade plan — 5 USDT margin

Telegram signal output now includes a deterministic manual-futures sizing plan. It does **not** execute orders.

Default rules:
- margin: **5 USDT**
- estimated SL-loss budget: **10% of margin = 0.50 USDT**, before fees/slippage
- leverage is derived from the entry-to-SL distance and rounded down
- maximum displayed leverage: **20x**
- minimum leverage: **1x**
- position notional = margin × leverage
- quantity = position notional ÷ entry price

Example: a 1% SL distance produces **10x** leverage and about **50 USDT** notional; a 2% SL distance produces **5x**. Tight SLs are capped at 20x. This is a sizing suggestion, not an execution instruction; exchange-specific leverage limits, fees, slippage, funding and liquidation rules still apply.

Environment overrides:
- `TELEGRAM_MARGIN_USDT` (default `5`)
- `TELEGRAM_MARGIN_RISK_FRACTION` (default `0.10`)
- `TELEGRAM_MAX_LEVERAGE` (default `20`)

Telegram now shows Margin, Leverage, Position notional, Entry, SL, TP1/TP2/TP3, R:R and estimated SL loss.


Destination tetap:

1. **Discord** — semua signal baru yang lolos dedup
2. **Telegram** — semua signal baru yang lolos dedup
3. **Binance Square** — semua signal baru yang lolos dedup, dibagi batch maksimal 3 coin per post

Urutan pemanggilan di scanner tetap:

```js
await sendDiscord(postSignals);
await sendTelegram(postSignals);
await sendBinanceSquare(postSignals);
```

Secret lama tetap digunakan:

| Secret | Fungsi |
|---|---|
| `DISCORD_WEBHOOK` | Discord |
| `TELEGRAM_BOT_TOKEN` | Telegram |
| `TELEGRAM_CHAT_ID` | Telegram |
| `BINANCE_SQUARE_OPENAPI_KEY` | Binance Square |

## Tiered validation configuration

Default workflow settings:

```yaml
TRADERSPY_SIGNAL_LIMIT: "50"
TRADERSPY_MAX_AGE_MIN: "120"
TRADERSPY_CANDIDATE_MAX_AGE_MIN: "360"
TRADERSPY_DISCOVERY_UNIVERSE: "100"
TRADERSPY_DISCOVERY_LIMIT: "50"
TRADERSPY_VALIDATION_TARGETS: "10"
TRADERSPY_VALIDATION_MIN_SCORE: "88"
TRADERSPY_STALE_MIN_SCORE: "90"
```

`TRADERSPY_MAX_AGE_MIN` remains the normal freshness gate. `TRADERSPY_CANDIDATE_MAX_AGE_MIN` is only a wider candidate window; it does not bypass live validation. The final gate requires multi-timeframe technical agreement, derivatives sanity checks, and the bounded validation score.

## TraderSpy authentication

TraderSpy menyediakan **personal MCP connection URL** yang membawa credential di dalam URL. Secret yang digunakan repository ini adalah `TRADERSPY_MCP_TOKEN`; adapter otomatis memperlakukannya sebagai MCP URL bila nilainya diawali `http://` atau `https://`.

Jika menggunakan raw bearer token terpisah, gunakan `TRADERSPY_MCP_URL` sebagai endpoint dan `TRADERSPY_MCP_TOKEN` sebagai token.

**Jangan commit URL/token TraderSpy ke repository.**

TraderSpy MCP bersifat read-only; Crypto-Signal hanya membaca signal/data dan tidak memiliki tool untuk membuka atau mengubah order.

## GitHub Actions

Workflow:
`.github/workflows/scan.yml`

Schedule tetap **setiap jam UTC**.

Runtime environment:

```yaml
TRADERSPY_ONLY: "true"
TRADERSPY_SIGNAL_LIMIT: "20"
TRADERSPY_MAX_AGE_MIN: "120"
TRADERSPY_MIN_SCORE: "80"
```

Secret yang perlu ditambahkan:

```
TRADERSPY_MCP_URL
```

atau:

```
TRADERSPY_MCP_TOKEN
```

Secret delivery tetap sama.

## Testing

Sebelum runtime:

```bash
node --check traderspy.js
node --check scanner.js
node --check positioning.js
npm test
```

Test adapter mencakup:
- LONG normalization
- SHORT normalization
- TP/SL conversion
- R:R calculation
- quality score
- stale signal rejection
- resolved signal rejection
- non-crypto instrument rejection
- incomplete target rejection

## Cost / call discipline

Pipeline tidak memanggil tool detail yang tidak diperlukan. Discovery dan validation tetap bounded pada default 10 validation targets:

- 1 `get_tracked_symbols`
- 1 `screen_symbols` across up to 100 high-volume futures
- 1 `get_signals` request for up to 50 recent candidates
- 1 batched `get_derivatives` request for the validation targets
- up to 10 `get_technical_indicators` calls when all validation targets require validation
- up to 2 `get_signal_details` calls for the strongest published candidates

This keeps the deep validation stage small while making the candidate universe substantially broader than the previous 20-signal-only importer.

Tujuannya:
- menjaga candidate discovery tetap bounded (maksimal 50 candidate discovery)
- menjaga validation default tetap 10 target agar quota TraderSpy tidak terbuang
- menghindari pemanggilan data redundan
- menggunakan signal engine TraderSpy langsung sebagai source of truth
- tidak membuang signal valid hanya karena batas delivery channel

TraderSpy MCP memiliki daily tool-call allowance berdasarkan plan akun. Karena itu adapter tidak melakukan `get_candles`, `get_derivatives`, `get_positions`, atau `get_signal_details` secara otomatis pada setiap signal.

## Outcome tracker

`signals-log.json` tetap dipertahankan agar repository mempunyai audit trail lokal.

Signal baru yang berhasil melewati delivery filter diregistrasikan sebagai open outcome.

Outcome lama tetap dievaluasi oleh tracker yang sudah ada. Jika market-data provider outcome gagal, tracker tidak mengubah signal menjadi WIN/LOSS secara paksa.

## Operational safety

Pipeline fail-closed:

```
TraderSpy unavailable
        ↓
NO VALID SIGNAL
        ↓
NO synthetic fallback
        ↓
NO post
```

Kesalahan authentication, malformed response, missing entry/SL/TP, expired signal, resolved signal, dan symbol non-crypto tidak boleh berubah menjadi signal valid.

## Disclaimer

Crypto-Signal adalah alat informasi/edukasi untuk analisis pasar.

Bukan nasihat keuangan dan bukan sistem eksekusi order.

Selalu validasi level, kondisi pasar, leverage, biaya, slippage, dan risiko sebelum mengambil keputusan trading.


## Public posting rules

- Binance Square selalu menggunakan professional visual card; jika renderer atau upload visual gagal, posting text-only tidak diperbolehkan.
- Hashtag Binance Square: `#PintarPakaiBinanceEarn`.
- Internal provider names such as `TraderSpy` are not exposed in public signal copy or visual labels.
- Duplicate scan results are blocked using a persistent signal fingerprint covering symbol, direction, setup, and relative entry/SL/TP structure; duplicate suppression is the only cross-scan delivery filter.
- Discord and Telegram receive every newly validated, non-duplicate signal; there is no global `max 3` delivery cap.
- Binance Square posts the same signals in sequential batches of up to 3 coins, and each batch visual is rendered from the exact same coin set.
- Loss streak is informational for the active TraderSpy delivery path and does not suppress newly validated signals.
- Pull-request CI runs the scanner in delivery dry-run mode, so validation tests do not publish to external channels or mutate outcome/dedup state.
- Production scheduled/manual runs retain live delivery.

## Repository version

The active repository release is **v4.0.0** (`package.json`). Legacy comments/names from older scanner generations are not part of the public v4.0 presentation.


## Operational reliability rule

Perubahan produksi wajib diperlakukan sebagai perubahan runtime, bukan hanya perubahan kode. Sebelum merge: cek syntax, unit test, workflow dry-run, konsumsi quota/tool call, error-path provider, delivery fan-out, dedup, batching Square, dan sinkronisasi README. Jangan menaikkan validation target tanpa menghitung dampaknya terhadap quota harian. Jika provider quota habis, runtime harus berhenti aman tanpa duplicate post, tanpa outcome mutation, dan tanpa crash yang tidak terkontrol.
