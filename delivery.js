/**
 * Crypto-Signal v4.1.0 — delivery contract
 * Output layer intentionally preserved from the existing scanner.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { calculateTradePlan } = require("./trade_plan");

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BINANCE_SQUARE_KEY = process.env.BINANCE_SQUARE_OPENAPI_KEY;
const MIN_PROB_VALID = 76;
const MIN_PROB_SNIPER = 82;
const SQUARE_POST_COUNT = 3;
function resolvePlan(s){
  if(s&&s.geometry==="LIVE_BINANCE_CALIBRATED_120C"){
    const dist=Number(s.entry)>0?Math.abs(Number(s.entry)-Number(s.sl))/Number(s.entry)*100:null;
    return {tp1:s.tp1,tp2:s.tp2,tp3:s.tp3,marginUsdt:s.marginUsdt??5,leverage:s.leverage??20,riskMarginPercent:Number.isFinite(s.riskMarginPercent)?s.riskMarginPercent:null,slDistancePercent:dist,rewardRMultiples:[1,1.618,2.618],rewardMarginPcts:[10,16.18,26.18]};
  }
  try{return calculateTradePlan(s);}catch{return null;}
}


function formatPrice(v) {
  if (!Number.isFinite(v)) return "—";
  if (v < 0.000001) return v.toFixed(10);
  if (v < 0.001) return v.toFixed(8);
  if (v < 1) return v.toFixed(5);
  return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function formatTelegramMessage(s) {
  const plan = resolvePlan(s);
  const isSniper = s.probability >= MIN_PROB_SNIPER;
  const tag = isSniper ? "🎯 SNIPER" : "✅ VALID";
  const arrow = s.action === "LONG" ? "🟢 LONG" : "🔴 SHORT";
  const persist = s.persistent ? " · 🔁 Persistent" : "";
  const volOk = s.volConfirm ? " · 📈 VolOK" : "";
  const regimeTxt = s.regime
    ? ` · Vol ${String(s.regime.regime ?? "NORMAL").toUpperCase()} (${s.regime.atrPct ?? "n/a"}%)`
    : "";
  const bookTxt = s.book
    ? ` · Book ${s.book.side} (${s.book.imbalance})${s.book.quality ? " · " + s.book.quality : ""}`
    : "";

  return (
    `${tag} · <b>${s.base}</b> ${arrow}${persist}${volOk}\n\n` +
    `📊 Score: <b>${s.probability}</b>${regimeTxt}\n` +
    `🧩 Setup: <b>${displaySetup(s.setup)}</b>\n\n` +
    `🎯 Entry: <code>${formatPrice(s.entry)}</code>${displayMode(s.mode) ? " · " + displayMode(s.mode) : ""}\n` +
    `🛑 SL: <code>${formatPrice(s.sl)}</code>\n` +
    `🎯 TP1: <code>${formatPrice(plan?.tp1 || s.tp1)}</code>\n` +
    `🎯 TP2: <code>${formatPrice(plan?.tp2 || s.tp2)}</code>\n` +
    `🚀 TP3: <code>${formatPrice(plan?.tp3 || s.tp3)}</code>\n` +
    `💵 Margin: <b>${plan?.marginUsdt ?? 5} USDT</b> · Leverage: <b>${plan?.leverage ?? "—"}x</b>\n` +
    `🛑 Risk: <b>${plan?.riskMarginPercent ?? 5}% margin</b> · SL <b>${plan?.slDistancePercent?.toFixed(2) ?? "—"}% price</b>\n` +
    `🎯 Reward: <b>${plan?.rewardMarginPcts?.join("% / ") || "25 / 50 / 100"}% margin</b>\n`
    + (s.ev && s.ev.netRr != null ? `\n📐 Net R (after cost): ~${s.ev.netRr}` : "") +
    `\n\n` +
    `1H ${s.trends ? s.trends.h1 : s.h1?.bias || "—"} · 15M ${s.trends ? s.trends.m15 : s.m15?.bias || "—"} · 4H ${s.trends ? s.trends.h4 : "—"}\n` +
    `Vol ${s.m5?.volume?.side || "—"}${bookTxt} · RSI ${Number(s.m5?.rsi || 0).toFixed(0)}\n\n` +
    `<i>Crypto-Signal v5.0 · Live Binance + Qwen3 · information only · NFA</i>`
  );
}

function formatSquareCoinBlock(s) {
  let plan; try { plan = calculateTradePlan(s); } catch { plan = null; }
  const isSniper = s.probability >= MIN_PROB_SNIPER;
  const tag = isSniper ? "🎯 SNIPER" : "✅ VALID";
  const arrow = s.action === "LONG" ? "🟢 LONG" : "🔴 SHORT";
  const mode = displayMode(s.mode) ? ` · ${displayMode(s.mode)}` : "";
  const persist = s.persistent ? " · 🔁" : "";
  const book =
    s.book && s.book.side && s.book.side !== "FLAT"
      ? `\nBook ${s.book.side} (${s.book.imbalance})${s.book.quality ? " · " + s.book.quality : ""}`
      : "";
  const regime = s.regime ? `\nVol regime: ${s.regime.regime} (${s.regime.atrPct}%)` : "";
  const risk = s.riskPct ? ` · Risk ${s.riskPct}%` : "";
  const tf = s.trends
    ? `1H ${s.trends.h1} · 15M ${s.trends.m15} · 4H ${s.trends.h4}`
    : `1H ${s.h1?.bias || "—"} · 15M ${s.m15?.bias || "—"}`;
  const rsi = s.m5?.rsi != null ? Number(s.m5.rsi).toFixed(0) : "—";
  const vol = s.m5?.volume?.side || "—";
  return (
    `${tag} · ${s.base} ${arrow}${persist}\n` +
    `\n` +
    `📊 Score: ${s.probability}\n` +
    `🧩 Setup: ${displaySetup(s.setup)}\n` +
    `🎯 Entry: ${formatPrice(s.entry)}${mode}\n` +
    `🛑 SL: ${formatPrice(s.sl)}\n` +
    `🎯 TP1: ${formatPrice(plan?.tp1 || s.tp1)}\n` +
    `🎯 TP2: ${formatPrice(plan?.tp2 || s.tp2)}\n` +
    `🚀 TP3: ${formatPrice(plan?.tp3 || s.tp3 || s.tp2)}\n` +
    `💵 Margin ${plan?.marginUsdt ?? 5} USDT · Leverage ${plan?.leverage ?? "—"}x\n` +
    `🛑 Risk ${plan?.riskMarginPercent ?? 10}% margin · SL ${plan?.slDistancePercent?.toFixed(2) ?? "—"}% price\n` +
    `🎯 Reward ${(plan?.rewardRMultiples || [2,4,6]).join("R / ")}R` +
    (s.ev && s.ev.netRr != null ? `\nNet R~${s.ev.netRr}` : "") +
    `\n` +
    `\n` +
    `${tf}\n` +
    `Vol ${vol} · RSI ${rsi}` +
    book +
    regime
  );
}

function formatSquareBatchMessage(coins) {
  const footers = [
    "Risk kecil saja. Jangan FOMO — invalid levelnya jelas di atas.",
    "Selalu pakai SL. Ini edukasi chart, bukan saran keuangan.",
    "Kelola risiko sendiri ya. Pasar bisa berubah kapan saja.",
    "Kalau belum yakin, skip saja. Masih banyak setup lain nanti.",
    "Catatan pribadi untuk referensi. NFA.",
  ];
  const fo = footers[Math.floor(Date.now() / 900000) % footers.length];

  // Header: Hasil scanner (hari, tanggal, bulan, tahun, jam) + tagar
  const hari = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
  const bulan = [
    "Januari", "Februari", "Maret", "April", "Mei", "Juni",
    "Juli", "Agustus", "September", "Oktober", "November", "Desember",
  ];
  const now = new Date();
  // WIB = UTC+7
  const wib = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const h = String(wib.getUTCHours()).padStart(2, "0");
  const m = String(wib.getUTCMinutes()).padStart(2, "0");
  const hi =
    `Hasil scanner (${hari[wib.getUTCDay()]}, ${wib.getUTCDate()} ${bulan[wib.getUTCMonth()]} ${wib.getUTCFullYear()}, ${h}:${m})`;

  const lines = [hi, ""];
  coins.forEach((s, i) => {
    if (i > 0) lines.push("", "────────────", "");
    lines.push(formatSquareCoinBlock(s));
  });
  lines.push("");
  lines.push("Crypto-Signal v5.0 · Live Binance + Qwen3 · NFA");
  lines.push("");
  lines.push(fo);
  lines.push("");
  lines.push("#PintarPakaiBinanceEarn");
  return lines.join("\n").trim();
}

function buildSquareCardSvg(coins) {
  // Portrait mobile 720×1520 — readable on phone without zoom
  const W = 720;
  const rows = coins.slice(0, 3);
  const pad = 28;
  const headerH = 130;
  const footerH = 64;
  const gap = 18;
  // Auto height so 3 cards never crush text (TP1-3 + meta)
  const minRow = 340;
  const H = Math.max(1520, headerH + footerH + gap * (rows.length + 1) + minRow * Math.max(rows.length, 1));
  const usable = H - headerH - footerH - gap * (rows.length + 1);
  const rowH = Math.max(340, Math.floor(usable / Math.max(rows.length, 1)));

  const esc = (x) =>
    String(x ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  let cards = "";
  rows.forEach((s, i) => {
    const y = headerH + gap + i * (rowH + gap);
    const isLong = s.action === "LONG";
    const accent = isLong ? "#059669" : "#e11d48";
    const soft = isLong ? "#ecfdf5" : "#fff1f2";
    const grade = s.probability >= MIN_PROB_SNIPER ? "SNIPER" : "VALID";
    const side = isLong ? "LONG" : "SHORT";
    const trendLine = s.trends
      ? `1H ${esc(s.trends.h1)}  ·  15M ${esc(s.trends.m15)}  ·  4H ${esc(s.trends.h4)}`
      : `1H ${esc(s.h1.structure)}  ·  15M ${esc(s.m15.bias)}`;

    cards += `
    <rect x="${pad}" y="${y}" width="${W - pad * 2}" height="${rowH}" rx="20" fill="${soft}" stroke="${accent}" stroke-width="3"/>
    <rect x="${pad}" y="${y}" width="12" height="${rowH}" rx="6" fill="${accent}"/>
    <text x="${pad + 28}" y="${y + 42}" font-family="Arial, Helvetica, sans-serif" font-size="34" font-weight="700" fill="#0f172a">${esc(s.base)}</text>
    <text x="${W - pad - 24}" y="${y + 42}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="28" font-weight="700" fill="${accent}">${isLong ? "▲" : "▼"} ${side}</text>
    <text x="${pad + 28}" y="${y + 78}" font-family="Arial, Helvetica, sans-serif" font-size="22" font-weight="700" fill="${accent}">${grade}  ·  ${s.probability}%</text>
    <text x="${pad + 28}" y="${y + 114}" font-family="Arial, Helvetica, sans-serif" font-size="20" fill="#1e293b">Entry   ${esc(formatPrice(s.entry))}</text>
    <text x="${pad + 28}" y="${y + 146}" font-family="Arial, Helvetica, sans-serif" font-size="20" fill="#1e293b">SL        ${esc(formatPrice(s.sl))}</text>
    <text x="${pad + 28}" y="${y + 178}" font-family="Arial, Helvetica, sans-serif" font-size="20" fill="#1e293b">TP1     ${esc(formatPrice(s.tp1))}</text>
    <text x="${pad + 28}" y="${y + 210}" font-family="Arial, Helvetica, sans-serif" font-size="20" fill="#1e293b">TP2     ${esc(formatPrice(s.tp2))}</text>
    <text x="${pad + 28}" y="${y + 242}" font-family="Arial, Helvetica, sans-serif" font-size="20" fill="#0f766e">TP3     ${esc(formatPrice(s.tp3 || s.tp2))}  ·  runner</text>
    <text x="${pad + 28}" y="${y + 280}" font-family="Arial, Helvetica, sans-serif" font-size="17" fill="#475569">${esc(displaySetup(s.setup))}  ·  R:R 1:${Number(s.rr || 1).toFixed(1)}  ·  Vol ${esc(s.m5.volume.side)}${s.book ? " · Book " + esc(s.book.side) : ""}</text>
    <text x="${pad + 28}" y="${y + 312}" font-family="Arial, Helvetica, sans-serif" font-size="16" fill="#64748b">${trendLine}</text>`;
  });

  const now = new Date().toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <rect x="0" y="0" width="${W}" height="${headerH}" fill="#0f172a"/>
  <text x="${pad}" y="48" font-family="Arial, Helvetica, sans-serif" font-size="32" font-weight="700" fill="#ffffff">CRYPTO-SIGNAL v4.1</text>
  <text x="${pad}" y="84" font-family="Arial, Helvetica, sans-serif" font-size="16" fill="#94a3b8">Regime · OB Quality · 1H+15M lock</text>
  <text x="${pad}" y="110" font-family="Arial, Helvetica, sans-serif" font-size="15" fill="#64748b">${esc(now)} WIB</text>
  <text x="${W - pad}" y="52" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="18" font-weight="600" fill="#38bdf8">Top ${rows.length}</text>
  ${cards}
  <text x="${pad}" y="${H - 22}" font-family="Arial, Helvetica, sans-serif" font-size="14" fill="#64748b">Margin 5 USDT · Leverage 20x sizing · Live Binance calibration · NFA</text>
</svg>`;
}

function renderSquareCardPng(coins) {
  const dir = "/tmp/square-card";
  fs.mkdirSync(dir, { recursive: true });
  const svgPath = path.join(dir, "card.svg");
  const pngPath = path.join(dir, "card.png");
  fs.writeFileSync(svgPath, buildSquareCardSvg(coins), "utf8");
  try {
    execFileSync("rsvg-convert", ["-w", "720", "-h", "1520", svgPath, "-o", pngPath], { stdio: "pipe" });
  } catch (e) {
    console.warn("rsvg-convert failed, Square visual post cannot be published:", e.message);
    return null;
  }
  if (!fs.existsSync(pngPath)) return null;
  return pngPath;
}
async function squareApi(endpoint, apiKey, body, useV2 = true) {
  const base = useV2
    ? "https://www.binance.com/bapi/composite/v2/public/pgc/openApi"
    : "https://www.binance.com/bapi/composite/v1/public/pgc/openApi";
  const res = await fetch(`${base}${endpoint}`, {
    method: "POST",
    headers: {
      "X-Square-OpenAPI-Key": apiKey,
      "Content-Type": "application/json",
      clienttype: "binanceSkill",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (String(json.code) !== "000000") {
    throw new Error(`Square API ${endpoint} [${json.code}]: ${json.message || res.status}`);
  }
  return json.data;
}
async function uploadSquareImage(apiKey, pngPath) {
  const imageName = path.basename(pngPath);
  const { presignedUrl, fileTicket } = await squareApi("/image/presignedUrl", apiKey, { imageName }, true);
  const buf = fs.readFileSync(pngPath);
  const put = await fetch(presignedUrl, { method: "PUT", headers: { "Content-Type": "image/png" }, body: buf });
  if (!put.ok) throw new Error(`S3 upload failed: ${put.status}`);
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = await squareApi("/image/imageStatus", apiKey, { fileTicket }, true);
    if (st.status === 1 && st.imageUrl) return st.imageUrl;
    if (st.status === 2) throw new Error(`Image process failed: ${st.failedReason || "unknown"}`);
    console.log(`  Square image processing... (${i + 1}/10)`);
  }
  throw new Error("Square image poll timeout");
}
async function sendBinanceSquare(signals) {
  if (!BINANCE_SQUARE_KEY) {
    console.log("Binance Square: skip (no BINANCE_SQUARE_OPENAPI_KEY)");
    return;
  }
  const ranked = [...signals]
    .filter((s) => s.probability >= MIN_PROB_VALID)
    .sort((a, b) => b.probability - a.probability || a.base.localeCompare(b.base));
  if (!ranked.length) {
    console.log("Binance Square: no new Valid signals this run");
    return;
  }

  // Square is the only channel with a per-post capacity. Never truncate the
  // shared delivery list: Telegram/Discord receive every new signal. Square
  // publishes the same complete set in sequential batches of up to 3 coins.
  const fullCount = Math.floor(ranked.length / SQUARE_POST_COUNT) * SQUARE_POST_COUNT;
  const batches = [];
  for (let i = 0; i < fullCount; i += SQUARE_POST_COUNT) {
    batches.push(ranked.slice(i, i + SQUARE_POST_COUNT));
  }
  const remainder = ranked.length - fullCount;
  console.log(
    `Binance Square: ${batches.length} full batch(es) · ${ranked.length} eligible coin(s) · ${SQUARE_POST_COUNT}/post` +
    (remainder ? ` · ${remainder} remainder held for next full batch` : "")
  );
  if (!batches.length) {
    console.log("Binance Square: fewer than 3 eligible coins; no Square post created.");
    return;
  }

  for (let index = 0; index < batches.length; index++) {
    const batch = batches[index];
    console.log(
      `Binance Square batch ${index + 1}/${batches.length} · ${batch.length} coin(s) → ` +
        batch.map((s) => `${s.base} ${s.action} ${s.probability}%`).join(", ")
    );

    const text = formatSquareBatchMessage(batch);
    const body = { contentType: 1, bodyTextOnly: text };

    // The visual is generated from the exact same batch sent in bodyTextOnly.
    // If rendering/upload fails, abort this Square batch rather than posting
    // a text-only fallback or a mismatched visual.
    try {
      const pngPath = renderSquareCardPng(batch);
      if (!pngPath) {
        throw new Error("Square visual card could not be rendered");
      }
      console.log("Square: uploading professional card image...");
      const imageUrl = await uploadSquareImage(BINANCE_SQUARE_KEY, pngPath);
      if (!imageUrl) {
        throw new Error("Square visual card upload returned no image URL");
      }
      body.imageList = [imageUrl];
      console.log("Square: image ready");
    } catch (e) {
      console.error(
        `Binance Square visual required — batch ${index + 1} aborted:`,
        e.message
      );
      continue;
    }

    try {
      const res = await fetch("https://www.binance.com/bapi/composite/v1/public/pgc/openApi/content/add", {
        method: "POST",
        headers: {
          "X-Square-OpenAPI-Key": BINANCE_SQUARE_KEY,
          "Content-Type": "application/json",
          clienttype: "binanceSkill",
        },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || String(payload.code) !== "000000") {
        console.error(
          `Binance Square batch ${index + 1} failed:`,
          res.status,
          payload.code,
          payload.message || JSON.stringify(payload)
        );
      } else {
        const id = payload.data?.id;
        console.log(
          `Binance Square sent batch ${index + 1}/${batches.length} (${batch.length} coins + image)` +
            (id ? ` → https://www.binance.com/square/post/${id}` : "")
        );
      }
    } catch (e) {
      console.error(`Binance Square batch ${index + 1} error:`, e.message);
    }
  }
}
async function sendTelegram(signals) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("Telegram: skip (no secrets)");
    return;
  }
  if (!signals.length) return;
  for (const s of signals) {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: formatTelegramMessage(s),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) console.error("Telegram failed:", res.status, JSON.stringify(body));
    else console.log(`Telegram sent: ${s.base} ${s.action} ${s.probability}%`);
  }
}

async function sendWatchDiscord(watches) {
  if (!DISCORD_WEBHOOK || !watches || !watches.length) return;
  const top = watches.slice(0, 8);
  const lines = top.map(
    (w) =>
      `• **${w.base}** ${w.action} · score ${w.score}` +
      (w.confluence != null ? ` · conf ${w.confluence}` : "") +
      (w.reason ? ` · _${w.reason}_` : "")
  );
  const embed = {
    title: `👀 WATCH · ${top.length} potensi (bukan entry)`,
    description: lines.join("\n") + "\n\n_Belum lolos gate VALID — pantau zona, jangan FOMO._",
    color: 0xfbbf24,
    footer: { text: "Selective Scalper v3.2 · lokasi+MTF · NFA" },
    timestamp: new Date().toISOString(),
  };
  try {
    const res = await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "Strict Core Watch", embeds: [embed] }),
    });
    if (res.ok) console.log(`Discord WATCH: ${top.length} items`);
    else console.warn("Discord WATCH failed:", res.status);
  } catch (e) {
    console.warn("Discord WATCH error:", e.message);
  }
}


function consecutiveLossStreak(log) {
  const closed = (log && log.closed) || [];
  let streak = 0;
  for (const c of closed) {
    if ((c.ts || 0) < OUTCOME_STATS_AFTER_TS) break;
    if (c.outcome === "LOSS_SL") streak++;
    else break;
  }
  return streak;
}


/** Public labels must not expose internal intelligence-provider names. */
function displaySetup(setup) {
  const s = String(setup || "");
  if (/TRADERSPY/i.test(s)) return "Scalp MTF";
  if (/SCALP|POTENSI|LOC|SCALP|TREND|PRE_|EARLY|MEAN|SQUEEZE/i.test(s)) return "Scalp MTF";
  return s || "Scalp MTF";
}

function displayMode(mode) {
  const s = String(mode || "");
  if (!s) return "";
  if (/TRADERSPY/i.test(s)) return "MTF";
  return s;
}

async function sendDiscord(signals) {
  if (!DISCORD_WEBHOOK) {
    console.log("Discord: skip (no secret)");
    return;
  }
  if (!signals.length) {
    console.log("No high-quality signals");
    return;
  }
  for (let i = 0; i < signals.length; i++) {
    const s = signals[i];
    if (i > 0) await new Promise((r) => setTimeout(r, 600));
    const isSniper = s.probability >= MIN_PROB_SNIPER;
    const color = s.action === "LONG" ? 0x35ef9a : 0xff5c7a;
    const persistTag = (s.persistent ? " · 🔁" : "") + (s.volConfirm ? " · 📈" : "");
    const embed = {
      title: `${isSniper ? "🎯 SNIPER" : "✅ VALID"} · ${s.base} ${s.action}${persistTag}`,
      color,
      fields: [
        { name: "Score", value: `**${s.probability}**`, inline: true },
        { name: "Setup", value: displaySetup(s.setup), inline: true },
        ...(s.validUntil ? [{ name: "Valid s/d", value: String(s.validUntil).slice(11, 19) + " UTC (15m)", inline: true }] : []),
        { name: "R:R", value: `1:${s.rr.toFixed(1)}`, inline: true },
        { name: "Entry", value: `$${formatPrice(s.entry)}`, inline: true },
        { name: "SL", value: `$${formatPrice(s.sl)}`, inline: true },
        { name: "Risk Saran", value: s.riskPct ? `**${s.riskPct}%**` : "—", inline: true },
        { name: "TP1 / TP2 / TP3", value: `$${formatPrice(s.tp1)} / $${formatPrice(s.tp2)} / $${formatPrice(s.tp3 || s.tp2)}`, inline: false },
        { name: "Regime", value: s.regime ? `${s.regime.regime} (${s.regime.atrPct}%)` : "—", inline: true },
        { name: "Book", value: s.book ? `${s.book.side} (${s.book.imbalance}) · ${s.book.quality || "—"}` : "—", inline: true },
        { name: "1H / 15M / 5M", value: `${s.trends?.h1 || s.h1?.bias || "—"} / ${s.trends?.m15 || s.m15?.bias || "—"} / ${s.m5?.volume?.side || "—"}`, inline: true },
      ],
      footer: { text: "Selective Scalper v3.2 · lokasi+MTF · NFA" },
      timestamp: new Date().toISOString(),
    };
    const res = await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "Strict Core", embeds: [embed] }),
    });
    if (!res.ok) console.error("Discord failed:", res.status, await res.text());
    else console.log(`Discord sent: ${s.base} ${s.action} ${s.probability}%`);
  }
}
/** Bitget bar map: internal bar → API granularity */

module.exports = {
  formatTelegramMessage,
  formatSquareCoinBlock,
  formatSquareBatchMessage,
  buildSquareCardSvg,
  renderSquareCardPng,
  sendBinanceSquare,
  sendTelegram,
  sendWatchDiscord,
  sendDiscord,
  displaySetup,
  displayMode,
};
