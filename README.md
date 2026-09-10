# Crypto-Signal · Strict Core v2.8

Scanner otomatis **Strict Quality** untuk **OKX USDT Perpetual (SWAP)**.

Dirancang untuk scalping **15 menit – 1 jam** dengan modal minim: filter ketat, risk adaptif, dan kualitas orderbook.

---

## Fitur Utama (v2.8)

| Fitur | Keterangan |
|-------|------------|
| **Multi-Timeframe** | 1H bias + 15M setup + 5M trigger + 4H gate |
| **Setup Path** | TREND · MEAN_REV · SQUEEZE |
| **Council Consensus** | Voting multi-modul (trend, slope, EMA, volume, structure) |
| **Volatility Regime** | `low / normal / high / extreme` (dari 15m ATR) |
| **Orderbook Quality** | Score + kualitas (`poor / medium / good / excellent`) |
| **Adaptive Risk** | Saran risk 0.25% – 0.85% equity (disesuaikan regime) |
| **Persistence** | Soft filter + tag 🔁 jika signal berulang |
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
- BTC soft bias
- Orderbook imbalance + spread + depth

---

## Jadwal

Scanner jalan **otomatis setiap jam** (UTC) via GitHub Actions.

```yaml
# .github/workflows/scan.yml
- cron: "0 * * * *"
```

Bisa dijalankan manual lewat tab **Actions → Strict Crypto Scanner → Run workflow**.

---

## Setup Secrets (wajib untuk notifikasi)

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
| `scanner.js` | Logika utama (v2.8.0) |
| `.github/workflows/scan.yml` | Jadwal cron tiap jam |
| `package.json` | Metadata Node.js (≥18) |

---

## Contoh Output Signal

```
🎯 SNIPER · BTC 🟢 LONG · 🔁 Persistent

📊 Probability: 87% · Vol NORMAL (1.12%)
🧩 Setup: TREND
🎯 Entry: 78450.5 · PULLBACK
🛑 SL: 77920.0
🎯 TP1: 79245.0
🎯 TP2: 80040.0
🚀 TP3: 81630.0
📈 R:R 1:2.5
⚠️ Risk saran: 0.60% equity

1H bullish · 15M bullish · 4H neutral
Vol BUY · Book BID (14.2) · good · RSI 48
```

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
- Risk suggestion hanya **saran**. Selalu sesuaikan dengan modal dan risk tolerance sendiri.

---

## Disclaimer

Ini alat informasi / edukasi chart saja.  
**Bukan saran keuangan.**  

Selalu validasi manual sebelum entry.  
Risk management adalah tanggung jawab penuh trader.
