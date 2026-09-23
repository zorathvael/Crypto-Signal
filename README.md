# Crypto-Signal · Strict Core v3.11

Scanner otomatis **Strict Quality** untuk **Bitget USDT-M Perpetual**.

Dirancang untuk scalping **15 menit – 1 jam** dengan modal minim: filter ketat, risk adaptif, kualitas orderbook, positioning layer, dan proteksi overtrade.

---

## Fitur Utama (v3.11)

| Fitur | Keterangan |
|-------|------------|
| **Multi-Timeframe** | 1H bias + 15M setup + 5M trigger + 4H gate |
| **Setup Path** | TREND · MEAN_REV · SQUEEZE · Early Reversal |
| **Council Consensus** | Voting multi-modul (trend, slope, EMA, volume, structure) |
| **Volatility Regime** | `low / normal / high / extreme` (dari 15m ATR) |
| **Orderbook Quality** | Score + kualitas (`poor / medium / good / excellent`) |
| **Hard Liquidity Filter** | Skip otomatis jika orderbook poor atau spread > 0.12% |
| **Positioning Layer** | Funding ekstrem + Open Interest + Long/Short account ratio (crowding) |
| **Volume Confirm** | Boost conf jika volume/momentum mendukung arah |
| **Adaptive SL/TP** | Lebar SL & rasio TP menyesuaikan regime volatilitas |
| **Adaptive Risk** | Saran risk 0.25% – 0.85% equity (disesuaikan regime) |
| **Soft Overtrade Guard** | Potong saran risk jika terlalu banyak signal fresh dalam 1 run |
| **Persistence** | Soft filter + tag 🔁 jika signal berulang |
| **BTC Soft Bias** | Penyesuaian kecil confidence (±), **bukan** hard force arah |
| **Quality Gate** | Valid ≥ 76% · SNIPER ≥ 82% (lebih ketat di high vol) |
| **R:R minimum** | 1.5 (TP1 / TP2 / TP3 runner) |
| **Output** | Discord · Telegram · Binance Square (text + card image) |

---

## Positioning Layer (baru di v3.11)

Layer ini menyesuaikan confidence berdasarkan **positioning pasar**, bukan price action saja:

| Input | Sumber | Efek |
|-------|--------|------|
| **Funding Rate** | Bitget current-fund-rate | +3…+5 jika ekstrem searah mean-reversion; −3…−6 jika overcrowded |
| **Open Interest** | Bitget open-interest | Tag `oi_ok` jika data valid |
| **Long/Short Ratio** | Bitget account-long-short (1h) | −5 jika crowded searah trade; +3 jika lawan crowded |
| **Reject gate** | Gabungan delta | Signal dibuang jika `delta ≤ −8` dan conf < SNIPER |

Implementasi: `positioning.js` + hook di `scanner.js`.

Detail: lihat [`POSITIONING_V311.md`](./POSITIONING_V311.md).

---

## Indikator & Filter

- Bollinger Bands, EMA (9/21/50), RSI, MACD histogram, ADX
- Volume pressure + spike detection
- Candle reversal (Engulfing, Hammer, Shooting Star, Pin Bar)
- Market structure (HH/HL vs LH/LL)
- Slope lock (anti-chase & anti-invert)
- Funding rate bias (diperkuat di v3.11)
- Open Interest + Long/Short account ratio (crowding)
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

## Setup Secrets

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
| `scanner.js` | Logika utama (v3.11.0) |
| `positioning.js` | Positioning layer (Funding, OI, L/S ratio) |
| `POSITIONING_V311.md` | Dokumentasi integrasi positioning |
| `.github/workflows/scan.yml` | Jadwal cron tiap jam |
| `package.json` | Metadata Node.js (≥18) |
| `signals-log.json` | Outcome tracker (TP/SL live) |

---

## Contoh Output Signal

```
🎯 SNIPER · BTC 🔴 SHORT · 🔁 Persistent · 📈 VolOK

📊 Score: 87 · Vol LOW (0.85%)
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
- Signal tetap harus lahir dari struktur koin itu sendiri
- Banyak alt tidak selalu berkorelasi penuh dengan BTC — itu normal

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

- Data dari **Bitget USDT-M API** (public). Level entry bersifat zona — sesuaikan jika trading di exchange lain.
- `signals-log.json` dipakai untuk soft persistence & outcome tracking.
- Risk suggestion & Adaptive SL/TP hanya **saran**. Sesuaikan dengan modal dan risk tolerance sendiri.
- Regime `extreme` → signal di-skip untuk melindungi modal minim.
- Positioning layer tidak mengganti price-action gate; ia **menyesuaikan** confidence setelah setup terbentuk.

---

## Local run

```bash
node --check positioning.js
node --check scanner.js
node scanner.js
```

---

## Disclaimer

Ini alat informasi / edukasi chart saja.  
**Bukan saran keuangan.**  

Selalu validasi manual sebelum entry.  
Risk management adalah tanggung jawab penuh trader.
