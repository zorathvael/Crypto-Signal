/**
 * Positioning Layer v3.11 — Funding, Open Interest, Long/Short crowding
 * Used by Strict Core scanner to adjust confidence near overcrowded positioning.
 */
const BITGET = "https://api.bitget.com";
const BG_PRODUCT = "USDT-FUTURES";

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

async function getJson(url, retries = 3) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "StrictCore-Positioning/3.11" },
      });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        lastErr = new Error("API 429");
        continue;
      }
      if (!res.ok) throw new Error(`API ${res.status}`);
      const body = await res.json();
      if (body && body.code != null && String(body.code) !== "00000") {
        throw new Error(`API ${body.code} ${body.msg || ""}`.trim());
      }
      return body;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error("request failed");
}

function toBitgetSymbol(instId) {
  return String(instId || "").replace(/[-_]/g, "").toUpperCase();
}

async function fetchFunding(instId) {
  try {
    const symbol = toBitgetSymbol(instId);
    const data = await getJson(
      `${BITGET}/api/v2/mix/market/current-fund-rate?symbol=${encodeURIComponent(symbol)}&productType=${BG_PRODUCT}`
    );
    const row = Array.isArray(data?.data) ? data.data[0] : data?.data;
    return +(row?.fundingRate ?? row?.fundRate ?? 0);
  } catch {
    return 0;
  }
}

async function fetchOpenInterest(instId) {
  try {
    const symbol = toBitgetSymbol(instId);
    const data = await getJson(
      `${BITGET}/api/v2/mix/market/open-interest?symbol=${encodeURIComponent(symbol)}&productType=${BG_PRODUCT}`
    );
    const list = data?.data?.openInterestList || data?.data || [];
    const row = Array.isArray(list) ? list[0] : list;
    const size = +(row?.size ?? row?.openInterest ?? 0);
    return Number.isFinite(size) && size > 0 ? size : null;
  } catch {
    return null;
  }
}

async function fetchLongShortRatio(instId) {
  try {
    const symbol = toBitgetSymbol(instId);
    const data = await getJson(
      `${BITGET}/api/v2/mix/market/account-long-short?symbol=${encodeURIComponent(symbol)}&productType=${BG_PRODUCT}&period=1h`
    );
    const rows = Array.isArray(data?.data) ? data.data : [];
    if (!rows.length) return null;
    const last = rows[rows.length - 1];
    const ratio = +(last?.longShortAccountRatio ?? 0);
    const longR = +(last?.longAccountRatio ?? 0);
    const shortR = +(last?.shortAccountRatio ?? 0);
    if (!Number.isFinite(ratio) || ratio <= 0) return null;
    return {
      ratio,
      longRatio: longR,
      shortRatio: shortR,
      crowdedLong: ratio >= 1.35,
      crowdedShort: ratio <= 0.75,
    };
  } catch {
    return null;
  }
}

function computePositioningAdj(action, funding, oi, ls, book) {
  let delta = 0;
  const tags = [];
  const f = Number.isFinite(funding) ? funding : 0;

  if (action === "LONG") {
    if (f <= -0.0008) { delta += 5; tags.push("fund_extreme_short"); }
    else if (f <= -0.0003) { delta += 3; tags.push("fund_favor_long"); }
    else if (f >= 0.0008) { delta -= 6; tags.push("fund_crowded_long"); }
    else if (f >= 0.0003) { delta -= 3; tags.push("fund_against_long"); }
  } else if (action === "SHORT") {
    if (f >= 0.0008) { delta += 5; tags.push("fund_extreme_long"); }
    else if (f >= 0.0003) { delta += 3; tags.push("fund_favor_short"); }
    else if (f <= -0.0008) { delta -= 6; tags.push("fund_crowded_short"); }
    else if (f <= -0.0003) { delta -= 3; tags.push("fund_against_short"); }
  }

  if (ls && Number.isFinite(ls.ratio)) {
    if (action === "LONG") {
      if (ls.crowdedLong) { delta -= 5; tags.push("ls_crowded_long"); }
      else if (ls.ratio <= 0.85) { delta += 3; tags.push("ls_favor_long"); }
    } else if (action === "SHORT") {
      if (ls.crowdedShort) { delta -= 5; tags.push("ls_crowded_short"); }
      else if (ls.ratio >= 1.25) { delta += 3; tags.push("ls_favor_short"); }
    }
  }

  if (oi != null && Number.isFinite(oi) && oi > 0) tags.push("oi_ok");

  if (book && !book.missing) {
    if (action === "LONG" && book.imbalance >= 15) { delta += 1; tags.push("book_synergy"); }
    if (action === "SHORT" && book.imbalance <= -15) { delta += 1; tags.push("book_synergy"); }
  }

  delta = clamp(delta, -12, 10);
  return {
    delta,
    tags,
    funding: f,
    oi: oi != null ? oi : null,
    lsRatio: ls && Number.isFinite(ls.ratio) ? +ls.ratio.toFixed(3) : null,
  };
}

module.exports = {
  fetchFunding,
  fetchOpenInterest,
  fetchLongShortRatio,
  computePositioningAdj,
};
