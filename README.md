# Crypto-Signal · Strict Quality Scanner

Scanner otomatis **Strict Quality** untuk Binance Futures USDT Perpetual.

- Jalan setiap **1 jam** via GitHub Actions
- Hanya kirim sinyal **Valid (≥75%)** dan **SNIPER (≥82%)** ke Discord
- Multi-timeframe: 1H bias + 15M setup + 5M trigger
- Bollinger Bands, EMA, RSI, volume, funding, candle reversal
- R:R minimum **2.0** · Risk saran max **0.75%** equity

---

## Setup Discord Webhook (wajib)

1. Repo → **Settings** → **Secrets and variables** → **Actions**
2. **New repository secret**
3. Name: `DISCORD_WEBHOOK`
4. Value: URL webhook Discord kamu
5. **Add secret**

Tanpa secret ini, scanner tetap jalan tapi **tidak mengirim** ke Discord.

---

## Cara menjalankan

### Otomatis
Setelah workflow aktif, scanner jalan **setiap jam** (UTC).

### Manual (test)
1. Tab **Actions**
2. Pilih workflow **Strict Crypto Scanner**
3. **Run workflow** → Run

---

## File penting

| File | Fungsi |
|------|--------|
| `scanner.js` | Logika scan + kirim Discord |
| `.github/workflows/scan.yml` | Jadwal cron setiap jam |
| `package.json` | Metadata Node.js |

---

## Ubah frekuensi

Edit `.github/workflows/scan.yml`:

```yaml
# Setiap 30 menit
- cron: "*/30 * * * *"

# Setiap 2 jam
- cron: "0 */2 * * *"
```

---

## Disclaimer

Ini alat informasi saja. Bukan saran keuangan.  
Selalu validasi manual sebelum entry. Risk management adalah tanggung jawab trader.
