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

Adapter memakai **satu tool call TraderSpy per scan**:

```
initialize MCP
    ↓
notifications/initialized
    ↓
tools/call → get_signals
    ↓
normalize + validate
    ↓
dedup / safety
    ↓
Discord
Telegram
Binance Square
```

Tidak ada fallback diam-diam ke data sintetis atau signal acak.

Jika TraderSpy gagal, authentication gagal, data kosong, level tidak lengkap, signal sudah resolved, atau signal sudah terlalu tua, pipeline tidak membuat signal pengganti.

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

## TraderSpy authentication

TraderSpy menyediakan remote MCP server. Gunakan **personal MCP URL** dari akun TraderSpy sebagai GitHub Actions secret:

```
TRADERSPY_MCP_URL
```

Alternatifnya, jika memakai endpoint standar:

```
TRADERSPY_MCP_TOKEN
```

Adapter mendukung keduanya.

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

Pipeline sengaja tidak memanggil seluruh tool TraderSpy pada setiap coin.

Mode v4.0 menggunakan:

**1 `get_signals` call per scheduled scan**

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
