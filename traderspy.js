/**
 * TraderSpy intelligence adapter for Crypto-Signal.
 *
 * Runtime contract:
 * - Connects to TraderSpy's remote MCP server over Streamable HTTP.
 * - Uses a bounded tiered MCP pipeline: tracked universe → market discovery → signals → live technical/derivatives validation.
 * - Fails closed: incomplete validation => no published signal.
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

const DEFAULT_SIGNAL_LIMIT = 50;
const DEFAULT_MAX_AGE_MIN = 120;
const DEFAULT_MIN_SCORE = 80;

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
  const raw = String(text || "").replace(/^\uFEFF/, "").trim();
  if (!raw) return null;

  const lines = raw.split(/\r?\n/);
  const dataLines = lines
    .map((line) => line.trimStart())
    .filter((line) => line.startsWith("data:"));

  // TraderSpy returns one JSON-RPC message in the SSE data frame.
  // Parse each data frame directly, matching the MCP SDK's framing behavior.
  for (let i = dataLines.length - 1; i >= 0; i--) {
    const data = dataLines[i].slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try { return JSON.parse(data); } catch {}
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
  const contentType = res.headers.get("content-type") || "";
  return {
    payload: parseMcpBody(text, contentType),
    sessionId: res.headers.get("mcp-session-id") || sessionId || null,
    status: res.status,
    contentType,
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
      `TraderSpy MCP initialize failed: status=${response.status} content-type=${response.contentType || "unknown"} payload=${JSON.stringify(response.payload).slice(0, 200)}`
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

function normalizeSignal(raw, now = Date.now(), options = {}) {
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
  const configuredMaxAgeMin = Number(process.env.TRADERSPY_MAX_AGE_MIN || DEFAULT_MAX_AGE_MIN);
  const maxAgeMin = Number.isFinite(options.maxAgeMin) ? options.maxAgeMin : configuredMaxAgeMin;
  const maxAgeMs = maxAgeMin * 60 * 1000;
  if (options.allowedSymbols && !options.allowedSymbols.has(symbol)) return null;
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

function finiteScore(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }

function normalizeDiscoveryRows(payload) {
  const rows = Array.isArray(payload?.results) ? payload.results : [];
  return rows.map((row) => {
    const symbol = String(row?.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const base = symbol.endsWith('USDT') ? symbol.slice(0, -4) : '';
    if (!base || NON_CRYPTO_BASES.has(base)) return null;
    const values = row?.values || {};
    const adx = finiteScore(row?.adx14 ?? values['ADX(14)']);
    const rsi = finiteScore(row?.rsi14 ?? values['RSI(14)']);
    const volumeRatio = finiteScore(values['Volume ratio'] ?? values['Volume Ratio'] ?? values.volumeRatio);
    const change24hPct = finiteScore(row?.change24hPct);
    const bias = String(row?.bias || '').toLowerCase();
    const trend = String(row?.trend || '').toLowerCase();
    let score = 0;
    if (bias === 'bullish' || bias === 'bearish') score += 4;
    if (trend === 'up' || trend === 'down') score += 3;
    if (adx >= 20) score += 3;
    if (volumeRatio >= 1.1) score += 3;
    if (Math.abs(change24hPct) >= 2) score += 1;
    if (rsi >= 45 && rsi <= 70) score += 1;
    return { symbol, base, price: finiteScore(row?.price), bias, trend, adx, rsi, volumeRatio, change24hPct, score };
  }).filter(Boolean).sort((a,b) => b.score - a.score || Math.abs(b.change24hPct) - Math.abs(a.change24hPct));
}

function directionWord(action) { return action === 'LONG' ? 'bullish' : 'bearish'; }

function timeframeMap(payload) {
  const out = new Map();
  for (const tf of Array.isArray(payload?.timeframes) ? payload.timeframes : []) if (tf?.interval) out.set(String(tf.interval), tf);
  return out;
}

function technicalValidation(signal, payload) {
  const tfs = timeframeMap(payload);
  if (!tfs.size) return { pass: false, score: 0, reasons: ['technical data unavailable'] };
  const wanted = directionWord(signal.action);
  const ordered = ['15m','1h','4h'].map(x => tfs.get(x)).filter(Boolean);
  let score = 0, aligned = 0; const reasons = [];
  for (const tf of ordered) {
    const summary=tf.summary||{}, ind=tf.indicators||{};
    const bias=String(summary.bias||'').toLowerCase();
    const trend=String(summary?.trend?.direction||'').toLowerCase();
    const emaStack=String(summary?.trend?.emaStack||ind?.ema?.stack||'').toLowerCase();
    const st=String(ind?.supertrend?.trend||'').toLowerCase();
    const rsi=Number(ind?.rsi?.value ?? summary?.momentum?.rsi);
    const adx=Number(ind?.adx?.value ?? summary?.trend?.adx);
    const macd=Number(ind?.macd?.histogram ?? summary?.momentum?.macdHistogram);
    const dirOk=bias===wanted || (wanted==='bullish'&&trend==='up') || (wanted==='bearish'&&trend==='down');
    const emaOk=emaStack===wanted;
    const stOk=(wanted==='bullish'&&st==='up') || (wanted==='bearish'&&st==='down');
    const macdOk=Number.isFinite(macd) && ((wanted==='bullish'&&macd>=0)||(wanted==='bearish'&&macd<=0));
    const rsiOk=Number.isFinite(rsi) && ((wanted==='bullish'&&rsi>=45&&rsi<=72)||(wanted==='bearish'&&rsi>=28&&rsi<=55));
    if(dirOk){aligned++;score+=4;} if(emaOk)score+=2; if(stOk)score+=2; if(macdOk)score+=1; if(rsiOk)score+=1; if(Number.isFinite(adx)&&adx>=20)score+=1;
    reasons.push(tf.interval+':dir='+(dirOk?'ok':'no')+' ema='+(emaOk?'ok':'no')+' st='+(stOk?'ok':'no')+' adx='+(Number.isFinite(adx)?adx.toFixed(1):'na'));
  }
  const h1=tfs.get('1h'), price=Number(payload?.price), atr=Number(h1?.indicators?.atr?.value);
  if(Number.isFinite(price)&&Number.isFinite(atr)&&atr>0){const distance=Math.abs(price-signal.entry);if(distance<=atr*1.5)score+=2;else if(distance>atr*2.5)reasons.push('price moved >2.5 ATR from entry');}
  const pass=aligned>=Math.min(2,ordered.length)&&!reasons.includes('price moved >2.5 ATR from entry');
  return {pass,score:Math.min(score,25),aligned,reasons};
}

function derivativesValidation(signal,payload){
  const row=payload instanceof Map
    ? payload.get(String(signal.instId||"").toUpperCase())
    : Array.isArray(payload?.data)
      ? payload.data.find(x=>String(x?.symbol||'').toUpperCase()===signal.instId)
      : null;
  if(!row||row.error)return {pass:false,score:0,reasons:['derivatives data unavailable']};
  const side=signal.action, funding=Number(row?.funding?.ratePct), longPct=Number(row?.positioning?.globalLongPct), taker=Number(row?.positioning?.takerBuySellRatio), regime=String(row?.openInterest?.regime||'').toLowerCase();
  let score=0,adverse=false;const reasons=[];
  if(side==='LONG'){if(Number.isFinite(taker)&&taker>=1)score+=4;if(['new_longs','short_covering'].includes(regime))score+=4;if(Number.isFinite(longPct)&&longPct>72){score-=3;adverse=true;}if(Number.isFinite(funding)&&funding>0.05){score-=4;adverse=true;}}
  else {if(Number.isFinite(taker)&&taker<=1)score+=4;if(['new_shorts','long_liquidation'].includes(regime))score+=4;if(Number.isFinite(longPct)&&longPct<28){score-=3;adverse=true;}if(Number.isFinite(funding)&&funding<-0.05){score-=4;adverse=true;}}
  if(!adverse)score+=2;
  reasons.push('funding='+(Number.isFinite(funding)?funding.toFixed(4):'na')+'%','OI='+(regime||'na'),'taker='+(Number.isFinite(taker)?taker.toFixed(2):'na'),'globalLong='+(Number.isFinite(longPct)?longPct.toFixed(1):'na')+'%');
  return {pass:!adverse,score:Math.max(0,Math.min(score,12)),reasons};
}

function applyValidation(signal,discovery,technical,derivatives,detail){
  const ds=Number(detail?.aiReview?.score);
  let score=Number(signal.qualityScore||0)+Math.min(Number(discovery?.score||0),10)+Number(technical?.score||0)+Number(derivatives?.score||0);
  if(Number.isFinite(ds))score+=Math.round(Math.max(0,Math.min(ds,10))*0.5);
  const ageMin=Math.max(0,(Date.now()-signal.ts)/60000);
  const stale=ageMin>Number(process.env.TRADERSPY_MAX_AGE_MIN||DEFAULT_MAX_AGE_MIN);
  const threshold=stale?Number(process.env.TRADERSPY_STALE_MIN_SCORE||90):Number(process.env.TRADERSPY_VALIDATION_MIN_SCORE||88);
  const finalScore=Math.min(99,Math.round(score));
  return {...signal,qualityScore:finalScore,probability:finalScore,validation:{passed:technical?.pass===true&&derivatives?.pass===true&&finalScore>=threshold,stale,ageMin:+ageMin.toFixed(1),threshold,discoveryScore:Number(discovery?.score||0),technicalScore:Number(technical?.score||0),derivativesScore:Number(derivatives?.score||0),detailScore:Number.isFinite(ds)?ds:null,reasons:[...(technical?.reasons||[]),...(derivatives?.reasons||[]),...(detail?.aiReview?.decision?[`aiReview=${detail.aiReview.decision}`]:[])]}};
}

function buildScreenCandidate(discovery, technicalPayload, now, actionHint = null) {
  const tfs = timeframeMap(technicalPayload);
  const h1 = tfs.get("1h") || tfs.get("15m");
  const h4 = tfs.get("4h");
  if (!h1 || !Number.isFinite(Number(technicalPayload?.price))) return null;

  // Candidate discovery must not depend on a single optional confluence field.
  // TraderSpy's MTF payload can expose direction in bias, trend, EMA stack, or
  // SuperTrend. Use a deterministic MTF vote to hand candidates to the
  // validation layer; the validation gate still decides whether they publish.
  const directionalVotes = [];
  for (const [interval, tf] of tfs.entries()) {
    if (!["15m", "1h", "4h"].includes(interval)) continue;
    const summary = tf?.summary || {};
    const indicators = tf?.indicators || {};
    const bias = String(summary?.bias || "").toLowerCase();
    const trend = String(summary?.trend?.direction || "").toLowerCase();
    const ema = String(summary?.trend?.emaStack || indicators?.ema?.stack || "").toLowerCase();
    const st = String(indicators?.supertrend?.trend || "").toLowerCase();
    const bullish = [bias === "bullish", trend === "up", ema === "bullish", st === "up"].filter(Boolean).length;
    const bearish = [bias === "bearish", trend === "down", ema === "bearish", st === "down"].filter(Boolean).length;
    if (bullish > bearish && bullish >= 2) directionalVotes.push({ interval, direction: "LONG", strength: bullish });
    else if (bearish > bullish && bearish >= 2) directionalVotes.push({ interval, direction: "SHORT", strength: bearish });
  }
  const explicitBias = String(technicalPayload?.confluence?.bias || "").toLowerCase();
  const hintedAction = String(actionHint || "").toUpperCase();
  let action = hintedAction === "LONG" || hintedAction === "SHORT"
    ? hintedAction
    : explicitBias === "bullish" ? "LONG" : explicitBias === "bearish" ? "SHORT" : null;
  if (!action) {
    const longVotes = directionalVotes.filter(x => x.direction === "LONG");
    const shortVotes = directionalVotes.filter(x => x.direction === "SHORT");
    if (longVotes.length >= 2 && longVotes.length > shortVotes.length) action = "LONG";
    else if (shortVotes.length >= 2 && shortVotes.length > longVotes.length) action = "SHORT";
  }
  // Some TraderSpy responses omit the summary/confluence fields entirely.
  // In that case use the primary 1h/4h trend fields as a final discovery
  // handoff fallback. This does not publish anything; technicalValidation()
  // still requires two aligned timeframes before a candidate can pass.
  if (!action) {
    const primary = ["1h", "4h"]
      .map(interval => tfs.get(interval))
      .filter(Boolean)
      .map(tf => String(tf?.summary?.trend?.direction || "").toLowerCase());
    if (primary.filter(x => x === "up").length >= 2) action = "LONG";
    else if (primary.filter(x => x === "down").length >= 2) action = "SHORT";
  }
  // screen_symbols is the discovery source. If the technical payload omits
  // optional directional summaries, preserve the screener's direction as the
  // candidate seed. It is NOT a validation pass: technicalValidation() below
  // still requires multi-timeframe agreement before publication.
  if (!action) {
    const discoveryBias = String(discovery?.bias || "").toLowerCase();
    const discoveryTrend = String(discovery?.trend || "").toLowerCase();
    if (discoveryBias === "bullish" || discoveryTrend === "up") action = "LONG";
    else if (discoveryBias === "bearish" || discoveryTrend === "down") action = "SHORT";
  }
  if (!action) return null;

  const entry = Number(technicalPayload.price);
  const atr = Number(h1?.indicators?.atr?.value);
  if (!Number.isFinite(atr) || atr <= 0) return null;

  const levels = h1?.indicators?.levels || {};
  const supports = Array.isArray(levels.support) ? levels.support.map(x => Number(x?.price)).filter(Number.isFinite).sort((a,b) => b-a) : [];
  const resistances = Array.isArray(levels.resistance) ? levels.resistance.map(x => Number(x?.price)).filter(Number.isFinite).sort((a,b) => a-b) : [];

  const minRisk = Math.max(atr * 1.5, entry * 0.004);
  let sl;
  let tp1;
  let tp2;
  let tp3;

  if (action === "LONG") {
    const support = supports.find(x => x < entry && entry - x >= atr * 0.75);
    const resistance = resistances.filter(x => x > entry);
    sl = support != null && entry - support <= atr * 2.5 ? support : entry - minRisk;
    const risk = entry - sl;
    tp1 = resistance.find(x => x > entry && x - entry >= risk * 1.5) || entry + risk * 1.5;
    tp2 = resistance.find(x => x > tp1) || entry + risk * 2.5;
    tp3 = resistance.find(x => x > tp2) || entry + risk * 3.5;
  } else {
    const resistance = resistances.find(x => x > entry && x - entry >= atr * 0.75);
    const support = supports.filter(x => x < entry).sort((a,b) => b-a);
    sl = resistance != null && resistance - entry <= atr * 2.5 ? resistance : entry + minRisk;
    const risk = sl - entry;
    tp1 = support.find(x => entry - x >= risk * 1.5) || entry - risk * 1.5;
    tp2 = support.find(x => x < tp1) || entry - risk * 2.5;
    tp3 = support.find(x => x < tp2) || entry - risk * 3.5;
  }

  const risk = Math.abs(entry - sl);
  const rr = risk > 0 ? Math.abs(tp1 - entry) / risk : 0;
  if (!Number.isFinite(rr) || rr < 1.5 || ![sl,tp1,tp2,tp3].every(Number.isFinite)) return null;

  const ageValidUntil = now + 60 * 60 * 1000;
  return {
    id: "screen-" + discovery.symbol + "-" + now,
    source: "TraderSpy",
    origin: "TraderSpy screener + MTF technical + derivatives validation",
    generatedCandidate: true,
    base: discovery.base,
    instId: discovery.symbol,
    action,
    probability: 0,
    qualityScore: 0,
    signalStrength: "candidate",
    importance: discovery.score >= 10 ? "high" : "medium",
    strategyName: "TraderSpy MTF Candidate",
    timeframe: "1h",
    setup: "TRADERSPY_CANDIDATE",
    mode: "TRADERSPY_MTF",
    entry,
    sl,
    tp1,
    tp2,
    tp3,
    rr: +rr.toFixed(2),
    riskPct: +(risk / entry * 100).toFixed(3),
    regime: h4?.summary?.volatility ? { regime: h4.summary.volatility.state || "normal", atrPct: Number(h4.summary.volatility.atrPct || 0) } : null,
    book: null,
    m5: { volume: { side: "—" }, rsi: null },
    trends: {
      h1: h1?.summary?.trend?.direction || "—",
      m15: tfs.get("15m")?.summary?.trend?.direction || "—",
      h4: h4?.summary?.trend?.direction || "—",
    },
    confluence: Number(technicalPayload?.confluence?.aligned ? 1 : 0),
    persistent: false,
    volConfirm: Number(h1?.summary?.volume?.ratioVsAverage) >= 1,
    ev: null,
    ts: now,
    validUntil: new Date(ageValidUntil).toISOString(),
    horizons: {},
    traderSpy: {
      id: "",
      resolutionStatus: "candidate",
      triggeredConditions: [],
      targetPct: null,
      validationOrigin: "screen_symbols",
    },
  };
}

async function getTraderSpyIntelligence(){
  const tokenValue=process.env.TRADERSPY_MCP_TOKEN||"";
  const url=process.env.TRADERSPY_MCP_URL||(/^https?:\/\//i.test(tokenValue)?tokenValue:"");
  if(!url)throw new Error("TraderSpy MCP URL is missing.");

  const sessionId=await initializeMcp(url);
  let callId=2;

  const trackedPayload=await callTool(url,sessionId,callId++,"get_tracked_symbols",{});
  const trackedSymbols=new Set((Array.isArray(trackedPayload?.symbols)?trackedPayload.symbols:[]).map(x=>String(x).toUpperCase()));
  if(!trackedSymbols.size)throw new Error("TraderSpy tracked-symbol universe is empty; refusing to validate candidates.");

  const discoveryPayload=await callTool(url,sessionId,callId++,"screen_symbols",{
    interval:"4h",
    universe:clamp(Number(process.env.TRADERSPY_DISCOVERY_UNIVERSE||100),5,100),
    limit:clamp(Number(process.env.TRADERSPY_DISCOVERY_LIMIT||50),5,50),
    sortBy:"volume",
    sortOrder:"desc"
  });
  const discovery=normalizeDiscoveryRows(discoveryPayload).filter(x=>trackedSymbols.has(x.symbol));

  const signalPayload=await callTool(url,sessionId,callId++,"get_signals",{
    limit:clamp(Number(process.env.TRADERSPY_SIGNAL_LIMIT||50),1,50),
    skip:0,
    importance:"all"
  });
  const rows=Array.isArray(signalPayload?.data)?signalPayload.data:[],
    now=Date.now(),
    candidateAgeMin=Number(process.env.TRADERSPY_CANDIDATE_MAX_AGE_MIN||360);

  const publishedSignals=[];
  for(const raw of rows){
    const s=normalizeSignal(raw,now,{maxAgeMin:candidateAgeMin,allowedSymbols:trackedSymbols});
    if(s)publishedSignals.push(s);
  }

  const bySymbol=new Map(discovery.map((x,i)=>[x.symbol,{...x,rank:i+1}]));
  const unique=new Map();
  for(const signal of publishedSignals){
    const key=signal.instId+":"+signal.action;
    if(!unique.has(key)||signal.ts>unique.get(key).ts)unique.set(key,signal);
  }

  const rankedPublished=[...unique.values()].map(signal=>{
    const d=bySymbol.get(signal.instId);
    const recencyBonus=Math.max(0,8-Math.floor(Math.max(0,now-signal.ts)/(30*60*1000)));
    const discoveryBonus=d?Math.min(10,d.score):0;
    return {signal,discovery:d||{score:0,rank:999},rankScore:signal.qualityScore+recencyBonus+discoveryBonus};
  }).sort((a,b)=>b.rankScore-a.rankScore||b.signal.ts-a.signal.ts);

  const maxTargets=clamp(Number(process.env.TRADERSPY_VALIDATION_TARGETS||50),1,50);
  const targets=[];
  const used=new Set();

  for(const x of rankedPublished){
    if(targets.length>=maxTargets)break;
    targets.push({published:x.signal,discovery:x.discovery});
    used.add(x.signal.instId);
  }

  for(const d of discovery){
    if(targets.length>=maxTargets)break;
    if(used.has(d.symbol))continue;
    targets.push({published:null,discovery:d});
    used.add(d.symbol);
  }

  if(!targets.length){
    return {signals:[],fetched:rows.length,discovered:discovery.length,validated:0,validationCalls:callId-2};
  }

  const symbols=targets.map(x=>x.published?.instId||x.discovery.symbol);
  // TraderSpy get_derivatives accepts at most 5 symbols per request. Batch the
  // complete validation target set instead of silently dropping targets.
  const derivativesBySymbol=new Map();
  try{
    for(let i=0;i<symbols.length;i+=5){
      const chunk=symbols.slice(i,i+5);
      const payload=await callTool(url,sessionId,callId++,"get_derivatives",{symbols:chunk});
      for(const row of Array.isArray(payload?.data)?payload.data:[]){
        const key=String(row?.symbol||"").toUpperCase();
        if(key) derivativesBySymbol.set(key,row);
      }
    }
  }catch(e){
    console.warn("TraderSpy derivatives validation failed: "+e.message);
    return {signals:[],fetched:rows.length,discovered:discovery.length,validated:0,validationCalls:callId-2};
  }

  const validated=[];
  let candidatesBuilt=0;
  let candidateBuildRejected=0;
  for(const target of targets){
    let technicalPayload;
    try{
      technicalPayload=await callTool(url,sessionId,callId++,"get_technical_indicators",{
        symbol:target.published?.instId||target.discovery.symbol,
        intervals:["15m","1h","4h"],
        indicators:["rsi","macd","ema","adx","atr","supertrend","obv","vwap","levels"],
        history:2
      });
    }catch(e){
      console.warn("TraderSpy technical validation skipped "+(target.published?.instId||target.discovery.symbol)+": "+e.message);
      continue;
    }

    let signal=target.published;
    if(!signal){
      signal=buildScreenCandidate(target.discovery,technicalPayload,now,target.discovery.bias==="bullish"?"LONG":target.discovery.bias==="bearish"?"SHORT":target.discovery.trend==="up"?"LONG":target.discovery.trend==="down"?"SHORT":null);
      if(!signal)continue;
    }

    const technical=technicalValidation(signal,technicalPayload);
    const derivatives=derivativesValidation(signal,derivativesBySymbol);

    let detail=null;
    if(target.published && validated.length<2){
      try{
        detail=await callTool(url,sessionId,callId++,"get_signal_details",{signalId:target.published.traderSpy.id});
      }catch(e){
        console.warn("TraderSpy detail validation skipped "+signal.instId+": "+e.message);
      }
    }

    if(signal.generatedCandidate){
      const baseScore=Number(target.discovery.score||0)*2;
      const finalScore=Math.min(99,Math.round(72+baseScore+technical.score+derivatives.score+(detail?.aiReview?.score||0)*0.5));
      signal.qualityScore=finalScore;
      signal.probability=finalScore;
      signal.traderSpy.validationScore=finalScore;
      signal.validation={
        passed:technical.pass&&derivatives.pass&&finalScore>=Number(process.env.TRADERSPY_CANDIDATE_MIN_SCORE||88),
        stale:false,
        ageMin:0,
        threshold:Number(process.env.TRADERSPY_CANDIDATE_MIN_SCORE||88),
        discoveryScore:target.discovery.score,
        technicalScore:technical.score,
        derivativesScore:derivatives.score,
        detailScore:null,
        reasons:[...(technical.reasons||[]),...(derivatives.reasons||[]),"candidate generated from TraderSpy live market data"]
      };
    }else{
      signal=applyValidation(signal,target.discovery,technical,derivatives,detail);
    }

    console.log("TraderSpy validation: "+signal.base+" "+signal.action+" source="+(signal.generatedCandidate?"candidate":"published")+" tech="+technical.score+" deriv="+derivatives.score+" final="+signal.qualityScore+" "+(signal.validation?.passed?"PASS":"REJECT"));
    if(signal.validation?.passed)validated.push(signal);
  }

  validated.sort((a,b)=>b.qualityScore-a.qualityScore||b.ts-a.ts);
  return {
    signals:validated,
    fetched:rows.length,
    discovered:discovery.length,
    validated:validated.length,
    validationCalls:callId-2,
    candidatesBuilt,
    candidateBuildRejected
  };
}

async function getTraderSpySignals(){ const result=await getTraderSpyIntelligence(); return result.signals; }

async function runTraderSpyScan(){
  const result=await getTraderSpyIntelligence();
  console.log('TraderSpy funnel: discovered='+result.discovered+' fetched='+result.fetched+' built='+result.candidatesBuilt+' buildRejected='+result.candidateBuildRejected+' validated='+result.validated+' calls='+result.validationCalls);
  for(const s of result.signals)console.log('  '+s.base+' '+s.action+' quality='+s.qualityScore+' '+s.signalStrength+'/'+s.importance+' '+s.timeframe+' R:R 1:'+s.rr);
  return result.signals;
}
module.exports = {
  normalizeSignal,
  signalQualityScore,
  runTraderSpyScan,
  getTraderSpySignals,
  normalizeDiscoveryRows,
  buildScreenCandidate,
  technicalValidation,
  derivativesValidation,
};
