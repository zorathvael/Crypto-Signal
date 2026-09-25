/**
 * TraderSpy intelligence adapter for Crypto-Signal.
 *
 * Runtime contract:
 * - Connects to TraderSpy's remote MCP server over Streamable HTTP.
 * - Uses exactly one MCP tool call per scan: get_signals.
 * - Fails closed: no TraderSpy data => no signal.
 * - Never invents market data, probability, entries, SL or TP.
 *
 * Required secret:
 *   TRADERSPY_MCP_URL  Personal TraderSpy MCP URL (recommended; may embed token)
 * Optional:
 *   TRADERSPY_MCP_TOKEN Bearer token when the URL itself has no token
 *   TRADERSPY_SIGNAL_LIMIT Number of recent signals to request (default 20)
 *   TRADERSPY_MAX_AGE_MIN Maximum signal age (default 120 minutes)
 *   TRADERSPY_MIN_SCORE Derived delivery quality floor (default 80)
 */

const DEFAULT_SIGNAL_LIMIT = 20;
const DEFAULT_MAX_AGE_MIN = 120;
const DEFAULT_MIN_SCORE = 80;
const MAX_POST = 3;

const NON_CRYPTO_BASES = new Set([
  "AAPL", "AMZN", "AMD", "COIN", "GOOG", "GOOGL", "META", "MSFT", "MSTR", "NFLX",
  "NVDA", "PLTR", "TSLA",
]);

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(n, lo, hi) {
  return Math.min(Math.max(n, lo), hi);
}

function timeframeMs(timeframe) {
  const m = String(timeframe || "").trim().toLowerCase().match(/^(\\d+)\\s*(m|h|d)$/);
  if (!m) return 60 * 60 * 1000;
  const n = Number(m[1]);
  if (m[2] === "m") return n * 60 * 1000;
  if (m[2] === "h") return n * 60 * 60 * 1000;
  return n * 24 * 60 * 60 * 1000;
}

function signalQualityScore(signal) {
  const strength = {
    very_strong: 96,
    strong: 90,
    moderate: 84,
    weak: 76,
  }[String(signal.signalStrength || "").toLowerCase()] ?? 0;
  const importanceBonus = {
    high: 3,
    medium: 1,
    low: 0,
  }[String(signal.importance || "").toLowerCase()] ?? 0;
  return clamp(strength + importanceBonus, 0, 99);
}

function targetPct(targets, names) {
  if (!Array.isArray(targets)) return null;
  const wanted = new Set(names.map((x) => String(x).toLowerCase()));
  for (const t of targets) {
    const label = String(t?.label || t?.type || "").toLowerCase();
    if (!wanted.has(label)) continue;
    const pct = finiteNumber(t?.pct);
    if (pct != null && pct > 0) return pct;
  }
  return null;
}

function parseMcpBody(text, contentType) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  if (contentType && contentType.includes("text/event-stream")) {
    let last = null;
    let eventData = [];
    for (const line of raw.split(/\\r?\\n/)) {
      if (line.startsWith("data:")) {
        eventData.push(line.slice(5).trimStart());
      } else if (!line.trim() && eventData.length) {
        const joined = eventData.join("\\n");
        try { last = JSON.parse(joined); } catch {}
        eventData = [];
      }
    }
    if (eventData.length) {
      try { last = JSON.parse(eventData.join("\\n")); } catch {}
    }
    return last;
  }

  try { return JSON.parse(raw); } catch {}
  return null;
}

async function postMcp(url, body, sessionId) {
  const headers = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "MCP-Protocol-Version": "2025-11-25",
  };
  const token = process.env.TRADERSPY_MCP_TOKEN || "";
  // TraderSpy personal MCP URLs embed the credential and must be used with
  // "No authentication". Never send the URL itself as a Bearer token.
  if (token && !/^https?:\/\//i.test(token)) {
    headers.Authorization = `Bearer ${token}`;
  } else if (url && /^https?:\/\//i.test(url)) {
    // Some MCP hosts accept the personal URL directly; TraderSpy also accepts
    // the same mcp_* credential as a bearer token when it is present in the URL.
    try {
      const embedded = new URL(url).searchParams.get("token");
      if (embedded) headers.Authorization = `Bearer ${embedded}`;
    } catch {}
  }
  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
    headers["MCP-Protocol-Version"] = "2025-11-25";
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) {
    const suffix = text ? `: ${text.slice(0, 300)}` : "";
    throw new Error(`TraderSpy MCP HTTP ${res.status}${suffix}`);
  }
  return {
    payload: parseMcpBody(text, res.headers.get("content-type") || ""),
    sessionId: res.headers.get("mcp-session-id") || sessionId || null,
    status: res.status,
    contentType: res.headers.get("content-type") || "",
    bodyLength: text.length,
  };
}

async function initializeMcp(url) {
  const response = await postMcp(url, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "zorathvael-crypto-signal", version: "4.0.0-traderspy" },
    },
  });

  if (!response.payload?.result) {
    throw new Error(
      `TraderSpy MCP initialize failed: status=${response.status} content-type=${response.contentType || "unknown"} body-length=${response.bodyLength} payload=${JSON.stringify(response.payload).slice(0, 300)}`
    );
  }

  const sessionId = response.sessionId;
  await postMcp(url, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  }, sessionId);

  return sessionId;
}

function unwrapToolResult(payload) {
  if (!payload) throw new Error("TraderSpy MCP returned an empty response");
  if (payload.error) {
    throw new Error(`TraderSpy MCP ${payload.error.code || "error"}: ${payload.error.message || "unknown error"}`);
  }
  const result = payload.result;
  if (!result) throw new Error("TraderSpy MCP response has no result");
  if (result.isError) {
    throw new Error(`TraderSpy get_signals failed: ${JSON.stringify(result.content).slice(0, 500)}`);
  }
  if (result.structuredContent != null) return result.structuredContent;
  if (result.data != null) return result.data;
  if (Array.isArray(result.content)) {
    for (const part of result.content) {
      if (part?.type !== "text" || !part.text) continue;
      try { return JSON.parse(part.text); } catch {}
    }
  }
  return result;
}

async function callTool(url, sessionId, id, name, arguments_) {
  const response = await postMcp(url, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: arguments_ },
  }, sessionId);
  return unwrapToolResult(response.payload);
}

function normalizeSignal(raw, now = Date.now()) {
  const action = String(raw?.action || "").toLowerCase();
  if (action !== "buy" && action !== "sell") return null;

  const symbol = String(raw?.coin || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!symbol.endsWith("USDT")) return null;
  const base = symbol.slice(0, -4);
  if (!base || NON_CRYPTO_BASES.has(base)) return null;

  const entry = finiteNumber(raw?.price);
  if (entry == null || entry <= 0) return null;

  const tp1Pct = targetPct(raw?.targets, ["tp1"]);
  const tp2Pct = targetPct(raw?.targets, ["tp2"]);
  const tp3Pct = targetPct(raw?.targets, ["tp3"]);
  const slPct = targetPct(raw?.targets, ["sl", "stop", "stop_loss"]);
  if ([tp1Pct, slPct].some((x) => x == null)) return null;

  const isLong = action === "buy";
  const sl = isLong ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100);
  const tp1 = isLong ? entry * (1 + tp1Pct / 100) : entry * (1 - tp1Pct / 100);
  const tp2 = tp2Pct != null
    ? (isLong ? entry * (1 + tp2Pct / 100) : entry * (1 - tp2Pct / 100))
    : tp1;
  const tp3 = tp3Pct != null
    ? (isLong ? entry * (1 + tp3Pct / 100) : entry * (1 - tp3Pct / 100))
    : tp2;

  const risk = Math.abs(entry - sl);
  const rr = risk > 0 ? Math.abs(tp1 - entry) / risk : 0;
  if (![sl, tp1, tp2, tp3, rr].every(Number.isFinite) || rr <= 0) return null;

  const createdMs = Date.parse(String(raw?.createdAt || ""));
  const ts = Number.isFinite(createdMs) ? createdMs : now;
  const ageMs = now - ts;
  const maxAgeMs = Number(process.env.TRADERSPY_MAX_AGE_MIN || DEFAULT_MAX_AGE_MIN) * 60 * 1000;
  if (ageMs < -5 * 60 * 1000 || ageMs > maxAgeMs) return null;

  const status = String(raw?.resolutionStatus || "pending").toLowerCase();
  if (status !== "pending") return null;

  const qualityScore = signalQualityScore(raw);
  const minScore = Number(process.env.TRADERSPY_MIN_SCORE || DEFAULT_MIN_SCORE);
  if (qualityScore < minScore) return null;

  const validUntilMs = Math.min(ts + timeframeMs(raw?.timeframe), now + maxAgeMs);
  if (validUntilMs <= now) return null;

  return {
    id: String(raw?.id || `${symbol}_${ts}`),
    source: "TraderSpy",
    base,
    instId: symbol,
    action: isLong ? "LONG" : "SHORT",
    // Legacy field retained because the delivery/outcome layer expects it.
    // It is a derived quality score, NOT a calibrated probability.
    probability: qualityScore,
    qualityScore,
    signalStrength: String(raw?.signalStrength || "unknown"),
    importance: String(raw?.importance || "unknown"),
    strategyName: String(raw?.strategyName || "TraderSpy Signal"),
    timeframe: String(raw?.timeframe || "unknown"),
    setup: `TRADERSPY · ${String(raw?.strategyName || "Signal")}`,
    mode: `TRADERSPY_${String(raw?.timeframe || "NA").toUpperCase()}`,
    entry,
    sl,
    tp1,
    tp2,
    tp3,
    rr: +rr.toFixed(2),
    riskPct: null,
    regime: null,
    book: null,
    m5: { volume: { side: "—" }, rsi: null },
    trends: { h1: "—", m15: "—", h4: "—" },
    confluence: qualityScore,
    persistent: false,
    volConfirm: false,
    ev: null,
    ts,
    validUntil: new Date(validUntilMs).toISOString(),
    horizons: {},
    traderSpy: {
      id: String(raw?.id || ""),
      resolutionStatus: status,
      triggeredConditions: Array.isArray(raw?.triggeredConditions) ? raw.triggeredConditions : [],
      targetPct: { tp1: tp1Pct, tp2: tp2Pct, tp3: tp3Pct, sl: slPct },
    },
  };
}

async function getTraderSpySignals() {
  // TraderSpy personal MCP URLs embed the private key. The repository secret
  // may be named TRADERSPY_MCP_TOKEN, so accept that secret as a URL when it
  // contains an https:// MCP connection URL. Raw bearer tokens are supported
  // only when TRADERSPY_MCP_URL is also configured.
  const tokenValue = process.env.TRADERSPY_MCP_TOKEN || "";
  const url = process.env.TRADERSPY_MCP_URL || (/^https?:\/\//i.test(tokenValue) ? tokenValue : "");
  const limit = clamp(Number(process.env.TRADERSPY_SIGNAL_LIMIT || DEFAULT_SIGNAL_LIMIT), 1, 50);
  const sessionId = await initializeMcp(url);
  const payload = await callTool(url, sessionId, 2, "get_signals", {
    limit,
    skip: 0,
    importance: "all",
  });

  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const now = Date.now();
  const normalized = rows.map((x) => normalizeSignal(x, now)).filter(Boolean);
  normalized.sort((a, b) => (b.qualityScore - a.qualityScore) || (b.ts - a.ts) || a.base.localeCompare(b.base));
  return {
    signals: normalized.slice(0, MAX_POST),
    fetched: rows.length,
  };
}

async function runTraderSpyScan() {
  const tokenValue = process.env.TRADERSPY_MCP_TOKEN || "";
  if (!process.env.TRADERSPY_MCP_URL && !/^https?:\/\//i.test(tokenValue)) {
    throw new Error("TraderSpy MCP URL is missing. Put the personal TraderSpy MCP connection URL in TRADERSPY_MCP_TOKEN or configure TRADERSPY_MCP_URL.");
  }
  const result = await getTraderSpySignals();
  console.log(`TraderSpy: fetched=${result.fetched} valid=${result.signals.length} (one get_signals call)`);
  for (const s of result.signals) {
    console.log(`  ${s.base} ${s.action} quality=${s.qualityScore} ${s.signalStrength}/${s.importance} ${s.timeframe} R:R 1:${s.rr}`);
  }
  return result.signals;
}

module.exports = {
  normalizeSignal,
  signalQualityScore,
  runTraderSpyScan,
  getTraderSpySignals,
};
