# Crypto-Signal · TraderSpy Intelligence v4.0

Crypto-Signal adalah pipeline publikasi signal futures yang menggunakan **TraderSpy sebagai intelligence engine** dan mempertahankan delivery flow yang sudah ada:

**TraderSpy → validation/normalization → dedup & outcome tracking → Discord + Telegram + Binance Square**

> Crypto-Signal tidak mengeksekusi order. Signal adalah informasi untuk validasi manual.

## Perubahan inti v4.0

### Intelligence engine
Mulai v4.0, workflow aktif tidak lagi membuat signal dari scanner Bitget lokal.

Signal aktif berasal dari TraderSpy MCP `get_signals`, kemudian dinormalisasi oleh `traderspy.js`.

Yang tetap dipertahankan:
- `signals-log.json`
- outcome tracking
- dedup 90 menit
- maksimum 3 signal per run
- safety cap saat loss streak
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

## TraderSpy adapter

File:
- `traderspy.js` — remote MCP client + signal normalization
- `traderspy.test.js` — unit tests untuk normalisasi
- `scanner.js` — pipeline dan delivery
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
top 3 candidates
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

The pipeline deliberately uses TraderSpy's screener and tracked-symbol universe before signal validation. A stale signal is never accepted merely because its timestamp is present: signals older than the normal delivery window can survive candidate selection only when current multi-timeframe technical and derivatives data still validate the setup. The tracked-symbol check prevents tokenized equities/metals and other non-crypto instruments from entering the crypto delivery path.

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

## Delivery — tidak diubah

Destination tetap:

1. **Telegram**
2. **Binance Square**
3. **Discord**

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
TRADERSPY_VALIDATION_TARGETS: "3"
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

Pipeline sengaja tidak memanggil seluruh tool TraderSpy pada setiap coin. Discovery and validation are bounded:

- 1 `get_tracked_symbols`
- 1 `screen_symbols` across up to 100 high-volume futures
- 1 `get_signals` request for up to 50 recent candidates
- 1 batched `get_derivatives` request for the top validation targets
- up to 3 `get_technical_indicators` calls
- up to 2 `get_signal_details` calls

This keeps the deep validation stage small while making the candidate universe substantially broader than the previous 20-signal-only importer.

Tujuannya:
- mengurangi MCP credits
- mengurangi latency
- menghindari rate-limit
- menghindari pemanggilan data redundan
- menggunakan signal engine TraderSpy langsung sebagai source of truth

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
