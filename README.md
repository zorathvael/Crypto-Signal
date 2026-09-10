# Crypto-Signal · Strict Core v2.9

Scanner otomatis **Strict Quality** untuk **OKX USDT Perpetual (SWAP)**.

Dirancang untuk scalping **15 menit – 1 jam** dengan modal minim: filter ketat, risk adaptif, kualitas orderbook, dan proteksi overtrade.

---

## Fitur Utama (v2.9)

| Fitur | Keterangan |
|-------|------------|
| **Multi-Timeframe** | 1H bias + 15M setup + 5M trigger + 4H gate |
| **Setup Path** | TREND · MEAN_REV · SQUEEZE |
| **Council Consensus** | Voting multi-modul (trend, slope, EMA, volume, structure) |
| **Volatility Regime** | `low / normal / high / extreme` (dari 15m ATR) |
| **Orderbook Quality** | Score + kualitas (`poor / medium / good / excellent`) |
| **Hard Liquidity Filter** | Skip otomatis jika orderbook poor atau spread > 0.12% |
| **Volume Confirm** | Boost conf jika volume/momentum mendukung arah |
| **Adaptive SL/TP** | Lebar SL & rasio TP menyesuaikan regime volatilitas |
| **Adaptive Risk** | Saran risk 0.25% – 0.85% equity (disesuaikan regime) |
| **Soft Overtrade Guard** | Potong saran risk jika terlalu banyak signal fresh dalam 1 run |
| **Persistence** | Soft filter + tag 🔁 jika signal berulang |
| **BTC Soft Bias** | Penyesuaian kecil confidence (±), **bukan** hard force arah |
| **Quality Gate** | Valid ≥ 75% · SNIPER ≥ 82% (lebih ketat di high vol) |
| **R:R minimum** | 1.5 (TP1 / TP2 / TP3 runner) |
| **Output** | Discord · Telegram · Binance Square (text + card image) |

---

## Indikator & Filter

- Bollinger Bands, EMA (9/21/50), RSI, MACD histogram, ADX
- Volume pressure + spike detection
- Candle reversal (Engulfing, Hammer, Shooting Star, Pin Bar)
- Market structure (HH/HL vs LH/LL)
- Slope lock (anti-chase & anti-invert)
- Funding rate bias
- BTC soft bias (hanya geser skor, tidak memaksa arah koin)
- Orderbook imbalance + spread + depth + quality score

---

## Jadwal

Scanner jalan **otomatis setiap jam** (UTC) via GitHub Actions.

```yaml
# .github/workflows/scan.yml
- cron: "0 * * * *"
```

Bisa dijalankan manual lewat tab **Actions → Strict Crypto Scanner → Run workflow**.

---

## Setup Secrets (untuk notifikasi)

Repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

| Secret | Wajib? | Keterangan |
|--------|--------|------------|
| `DISCORD_WEBHOOK` | Direkomendasikan | URL webhook Discord |
| `TELEGRAM_BOT_TOKEN` | Opsional | Token bot Telegram |
| `TELEGRAM_CHAT_ID` | Opsional | Chat ID tujuan |
| `BINANCE_SQUARE_OPENAPI_KEY` | Opsional | Untuk post ke Binance Square |

Tanpa secret, scanner tetap jalan dan hanya menampilkan hasil di log Actions.

---

## File Penting

| File | Fungsi |
|------|--------|
| `scanner.js` | Logika utama (v2.9.0) |
| `.github/workflows/scan.yml` | Jadwal cron tiap jam |
| `package.json` | Metadata Node.js (≥18) |

---

## Contoh Output Signal

```
🎯 SNIPER · BTC 🔴 SHORT · 🔁 Persistent · 📈 VolOK

📊 Probability: 87% · Vol LOW (0.85%)
🧩 Setup: TREND
🎯 Entry: 78450.5 · PULLBACK
🛑 SL: 78920.0
🎯 TP1: 77645.0
🎯 TP2: 76840.0
🚀 TP3: 75250.0
📈 R:R 1:2.3
⚠️ Risk saran: 0.55% equity

1H bearish · 15M bearish · 4H neutral
Vol SELL · Book ASK (−14.2) · good · RSI 48
```

---

## Catatan tentang BTC Bias

BTC soft bias **bukan** perintah “semua koin harus ikut BTC”.

- Hanya menyesuaikan confidence sedikit (+3 searah / −6 lawan) jika bias BTC kuat
- Signal tetap harus lahir dari struktur koin itu sendiri (TREND / MEAN_REV / SQUEEZE)
- Banyak alt / meme coin tidak selalu berkorelasi penuh dengan BTC — itu normal

---

## Cara Ubah Frekuensi

Edit `.github/workflows/scan.yml`:

```yaml
# Setiap 30 menit
- cron: "*/30 * * * *"

# Setiap 2 jam
- cron: "0 */2 * * *"
```

---

## Catatan Teknis

- Data diambil dari **OKX API** (SWAP). Level entry bersifat zona — sesuaikan jika trading di exchange lain.
- `last-signals.json` dipakai untuk soft persistence (state hilang antar run di GitHub Actions kecuali di-commit manual).
- Risk suggestion & Adaptive SL/TP hanya **saran**. Selalu sesuaikan dengan modal dan risk tolerance sendiri.
- Regime `extreme` → signal di-skip untuk melindungi modal minim.

---

## Disclaimer

Ini alat informasi / edukasi chart saja.  
**Bukan saran keuangan.**  

Selalu validasi manual sebelum entry.  
Risk management adalah tanggung jawab penuh trader.
