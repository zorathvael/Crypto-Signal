# Positioning Layer v3.11

## Tujuan

Mendekati edge dengan menyaring setup yang **overcrowded** (funding ekstrem + long/short retail ekstrem), tanpa mengganti logika price-action yang sudah ada.

Scanner tetap decision-support: Positioning Layer hanya **menggeser confidence** atau **membuang** sinyal yang sangat berlawanan dengan positioning.

---

## Modul

| File | Peran |
|------|--------|
| `positioning.js` | Fetch + skor: Funding, Open Interest, Long/Short ratio |
| `scanner.js` | Memanggil layer setelah setup terbentuk, sebelum gate final |

---

## Data (Bitget public)

| Endpoint | Field utama |
|----------|-------------|
| `/api/v2/mix/market/current-fund-rate` | `fundingRate` |
| `/api/v2/mix/market/open-interest` | `size` (OI) |
| `/api/v2/mix/market/account-long-short?period=1h` | `longShortAccountRatio`, long/short account % |

---

## Aturan skor (`computePositioningAdj`)

### Funding

| Arah | Kondisi | Delta conf |
|------|---------|------------|
| LONG | funding ≤ −0.08% | +5 |
| LONG | funding ≤ −0.03% | +3 |
| LONG | funding ≥ +0.08% | −6 |
| LONG | funding ≥ +0.03% | −3 |
| SHORT | mirror (kebalikan) | ± sama |

### Long/Short account ratio

| Arah | Kondisi | Delta |
|------|---------|-------|
| LONG | ratio ≥ 1.35 (crowded long) | −5 |
| LONG | ratio ≤ 0.85 | +3 |
| SHORT | ratio ≤ 0.75 (crowded short) | −5 |
| SHORT | ratio ≥ 1.25 | +3 |

### Open Interest

- OI valid → tag `oi_ok` (tidak memaksa arah; konteks likuiditas)

### Book synergy (ringan)

- LONG + imbalance ≥ +15 → +1  
- SHORT + imbalance ≤ −15 → +1  

Delta dibatasi **−12 … +10**.

### Reject gate

Jika `delta ≤ −8` **dan** probability hasil < `MIN_PROB_SNIPER` (82) → sinyal **tidak diteruskan** (`positioning_reject`).

---

## Integrasi di `scanner.js`

1. `const positioning = require("./positioning");`
2. Parallel fetch: `positioning.fetchFunding`, `fetchOpenInterest`, `fetchLongShortRatio`
3. Setelah `scored` terbentuk, sebelum filter SHORT historis:
   - `pos = positioning.computePositioningAdj(...)`
   - `scored.probability += pos.delta`
   - apply reject gate
4. Di `scoreSignal`: penalty funding ekstrem tambahan (−4) sebagai fallback ringan

---

## Filosofi (singkat)

Sesuai diskusi EMH / AMH / Behavioral Finance:

- Market tidak selalu efisien; **crowding** sering mendahului mean-reversion atau squeeze.
- Positioning layer tidak mengklaim prediksi arah candle; ia mengurangi entry saat retail/leverage sangat satu sisi.
- Edge tetap probabilistik — bukan “jarum candle”.

---

## Verifikasi

```bash
node --check positioning.js
node --check scanner.js
node scanner.js
```

Log yang diharapkan:

```text
=== Strict Core v3.11.0 | Positioning Layer · Funding+OI+LS · Anti-chase ===
```

---

## Batasan

- Tidak mengganti co-location / HFT edge.
- API public bisa rate-limit; error fetch → delta netral (0), scanner tetap jalan.
- On-chain exchange flow (CryptoQuant/Glassnode) **belum** diintegrasikan; bisa jadi tahap berikutnya.
