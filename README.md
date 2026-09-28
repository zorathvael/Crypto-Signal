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
- validation targets: 10
- hard maximum validation targets: 10
- per target: 3 kline requests + OI + funding + depth
- no order execution
- no synthetic/mock market data
- Binance Futures endpoint failover: `fapi.binance.com` → `fapi1` → `fapi2` → `fapi3` → `fapi4`; the first working endpoint is reused for the scan
- failover is bounded to 403/429/451/5xx responses and network failures; unexpected 4xx errors are not masked

Fallback tidak mengklaim mereplikasi proprietary internals TraderSpy. Ia mereplikasi **observable validation contract dan decision structure** yang digunakan repository ini untuk menjaga bentuk/aturan signal tetap kompatibel.

Fallback geometry is now wired directly to `trade_plan.js`: structural stops are checked against the immutable 0.4% maximum, while the production engine remains the sole owner of the fixed 20x SL/TP geometry. This prevents a missing-module runtime failure and prevents the fallback from inventing a separate TP/SL contract.

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
bounded validation targets (default 20, configurable up to 20)
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

### Candidate funnel optimization

The discovery stage can screen up to 100 tracked futures symbols and return up to 50 liquid candidates, but validating only 10 of those candidates created an unnecessary bottleneck: many potentially valid setups never reached the technical/derivatives gate. The active default is now **20 validation targets**. This widens opportunity coverage without weakening the final validation criteria, fixed 20x geometry, freshness rules, Alpha Hunter gate, or delivery deduplication. The validation target count remains hard-bounded at 20 to keep MCP usage predictable.

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

Crypto-Signal mempertahankan Entry sebagai trigger price dari sumber signal. SL sumber menjadi structural-stop input, lalu satu-satunya production trade-plan engine menghitung leverage dan TP dari margin contract:

- LONG: SL di bawah entry, TP di atas entry
- SHORT: SL di atas entry, TP di bawah entry
- Margin: 5 USDT
- Maximum risk: 10% margin = 0.50 USDT
- Leverage: **20x fixed**
- Maximum SL loss: **10% margin = 0.50 USDT**
- TP1/TP2/TP3: **30% / 60% / 120% of margin**

R:R tetap tersedia sebagai metrik diagnostik/outcome, tetapi tidak lagi menjadi pengendali Entry/SL/TP.

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

## Independent entry calibration

Entry Calibration is a separate adaptive layer from Entry Geometry.

- **Entry Geometry remains immutable:** 5 USDT margin, fixed 20x leverage, 0.4% maximum price-risk envelope, TP1/TP2/TP3 = 30/60/120% of margin.
- Entry calibration derives its usable structural distance from the **actual geometry capacity in ATR units**:
  `geometryCapacityAtr = (Entry × 0.4%) / ATR`.
- Nearby support/resistance is usable only when it can fit inside that executable envelope.
- The calibration score is continuous and combines market proximity, structural proximity, and geometry utilisation; it does not use fixed 0.75/1.5 ATR entry thresholds.
- Closed outcomes now persist calibration score/distance/capacity so Alpha Hunter can learn an empirical calibration floor from observed outcomes.
- The empirical floor uses smoothed historical outcome evidence and only activates after sufficient observations; before that, the system uses the calibrated cold-start floor.

This makes threshold selection **measured by entry context**, rather than manually tightening or loosening arbitrary scanner thresholds.

## Alpha Hunter v3
— conditional edge selection

Alpha Hunter memakai conditional empirical evidence dari outcome tracker, bukan hanya score teknikal.

Evidence historis dikondisikan secara bertingkat: action; setup + action; symbol + action; quality bucket + action; dan 15M follow-through sebagai secondary edge component.

Historical evidence dibatasi ke active crypto-signal era (`ALPHA_HISTORY_AFTER_TS`, default `2026-09-18T00:00:00Z`) dan mengecualikan instrumen non-crypto/legacy yang diketahui. Cohort kecil hanya menjadi diagnostik dan tidak melakukan veto.

Default:
- `ALPHA_MIN_SCORE=72`
- `ALPHA_HISTORY_AFTER_TS=2026-09-18T00:00:00Z`
- hard veto jika MTF alignment < 2/3
- hard veto jika calibrated Entry > 2 ATR dari live price
- historical R metrics may be used for outcome analysis, but never define public Entry/SL/TP geometry
- hard veto jika entry > 2 ATR dari live price
- hard veto jika signal > 120 menit
- empirical edge negatif menjadi hard veto hanya setelah cohort stabil minimal 20 outcome

Scanner sekarang meneruskan `signals-log.json` ke Alpha Hunter pada jalur published signal maupun discovery candidate.
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
TRADERSPY_VALIDATION_TARGETS: "20"
TRADERSPY_VALIDATION_MIN_SCORE: "88"
TRADERSPY_STALE_MIN_SCORE: "90"
```

`TRADERSPY_MAX_AGE_MIN` remains the normal freshness gate. `TRADERSPY_CANDIDATE_MAX_AGE_MIN` is only a wider candidate window; it does not bypass live validation. The final gate requires multi-timeframe technical agreement, derivatives sanity checks, and the bounded validation score.

## TraderSpy authentication

TraderSpy mendukung personal key `mcp_…` sebagai Bearer token pada endpoint MCP resmi, dan juga personal connection URL yang menanamkan key sebagai `?token=mcp_…`. citeturn3search0turn3search1

Runtime mendukung keduanya:
- `TRADERSPY_MCP_URL` bila endpoint/personal URL ingin ditentukan secara eksplisit.
- `TRADERSPY_MCP_TOKEN` untuk raw `mcp_…` Bearer token atau personal URL yang berisi credential.
- Jika `TRADERSPY_MCP_URL` kosong, raw token memakai `https://mcp.traderspy.app/mcp`; jika token sendiri berupa URL, URL tersebut dipakai langsung.

Run 36272996060 gagal HTTP 401. Workflow sebelumnya selalu menyuntikkan endpoint publik ke `TRADERSPY_MCP_URL`, sehingga bila `TRADERSPY_MCP_TOKEN` berisi personal URL, URL credential tersebut tidak pernah dipakai. Workflow sekarang membiarkan `TRADERSPY_MCP_URL` kosong dan adapter memilih endpoint dari secret yang tersedia.

Jangan commit URL/token TraderSpy ke repository.
## GitHub Actions

Workflow:
`.github/workflows/scan.yml`

Schedule tetap **setiap jam UTC**.

Runtime environment:

```yaml
TRADERSPY_ONLY: "true"
TRADERSPY_SIGNAL_LIMIT: "50"
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
- fixed margin geometry validation (10% risk, 30/60/120% reward, fixed 20x)
- quality score
- stale signal rejection
- resolved signal rejection
- non-crypto instrument rejection
- incomplete target rejection

## Cost / call discipline

Pipeline tidak memanggil tool detail yang tidak diperlukan. Discovery dan validation tetap bounded pada default 20 validation targets:

- 1 `get_tracked_symbols`
- 1 `screen_symbols` across up to 100 high-volume futures
- 1 `get_signals` request for up to 50 recent candidates
- 1 batched `get_derivatives` request for the validation targets
- up to 20 `get_technical_indicators` calls when all validation targets require validation
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
HTTP 429 / quota exhausted → bounded Binance fallback
        ↓
Fallback validated → same delivery contract
        ↓
Other provider/auth errors → NO VALID SIGNAL
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


## CI regression fix

The TraderSpy normalization path now always carries an explicit entry-calibration contract. When a provider signal does not include an independent technical calibration payload, the provider trigger is retained and the calibration metadata is marked `PROVIDER_TRIGGER` with no fabricated score. Screened candidates reject only when the fixed executable geometry covers less than 10% of the observed ATR. This is an execution-capacity gate derived from the geometry/volatility ratio; it does not alter the calibrated entry score or widen/tighten the fixed risk geometry.

## Operational reliability rule

Perubahan produksi wajib diperlakukan sebagai perubahan runtime, bukan hanya perubahan kode. Sebelum merge: cek syntax, unit test, workflow dry-run, konsumsi quota/tool call, error-path provider, delivery fan-out, dedup, batching Square, dan sinkronisasi README. Jangan menaikkan validation target tanpa menghitung dampaknya terhadap quota harian. Jika provider quota habis, runtime harus berhenti aman tanpa duplicate post, tanpa outcome mutation, dan tanpa crash yang tidak terkontrol.
