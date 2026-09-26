/**
 * TraderSpy-compatible fallback intelligence engine.
 *
 * Purpose:
 * - Activate only when TraderSpy daily quota is exhausted (HTTP 429).
 * - Use public Binance USDⓈ-M Futures market data.
 * - Preserve the observable TraderSpy decision contract:
 *   discovery -> MTF direction -> momentum/volatility -> derivatives sanity
 *   -> structure levels -> bounded validation -> signal contract.
 * - Never execute orders and never claim to reproduce TraderSpy proprietary internals.
 *
 * Resource budget per scan:
 * - 1 exchangeInfo
 * - 1 ticker/24h
 * - up to FALLBACK_TARGETS symbols
 * - 3 klines + 1 OI + 1 funding + 1 depth per validated symbol
 * - default 6 targets
 */

const DEFAULT_BITGET_BASE = "https://api.bitget.com";
const DEFAULT_BINANCE_FUTURES_BASES = ["https://fapi.binance.com","https://fapi1.binance.com","https://fapi2.binance.com","https://fapi3.binance.com","https://fapi4.binance.com"];
const DEFAULT_TARGETS = 6;
const DEFAULT_MIN_SCORE = 88;
const NON_CRYPTO = new Set(["AAPL","AMZN","AMD","COIN","GOOG","GOOGL","META","MSFT","MSTR","NFLX","NVDA","PLTR","TSLA","SOXL","CRCL","XAU","XAG"]);

function n(v) { const x=Number(v); return Number.isFinite(x)?x:null; }
function clamp(v,lo,hi) { return Math.min(Math.max(v,lo),hi); }
function mean(a) { return a.length?a.reduce((x,y)=>x+y,0)/a.length:0; }
let activeBinanceBase=null;

function binanceBases() {
  const configured=String(process.env.BINANCE_FUTURES_BASE_URLS||"").split(",").map(x=>x.trim().replace(/\/$/,"")).filter(Boolean);
  return configured.length?configured:DEFAULT_BINANCE_FUTURES_BASES;
}

async function requestJson(url,headers={}) {
  const res=await fetch(url,{headers:{Accept:"application/json","User-Agent":"Crypto-Signal/4.0.0-fallback",...headers},signal:AbortSignal.timeout(15000)});
  const body=await res.text();
  if(!res.ok) throw new Error("HTTP "+res.status+" "+url);
  if(!body.trim()) throw new Error("empty JSON response "+url);
  try{return JSON.parse(body);}catch{throw new Error("invalid JSON response "+url+" ("+body.length+" bytes)");}
}

async function bitget(pathname,params={}) {
  const qs=new URLSearchParams(params);
  const data=await requestJson(DEFAULT_BITGET_BASE+pathname+"?"+qs.toString());
  if(data?.code!=="00000") throw new Error("Bitget API "+String(data?.code||"unknown")+": "+String(data?.msg||"error"));
  return data.data;
}

async function binance(pathname,params={}) {
  const qs=new URLSearchParams(params);
  const bases=activeBinanceBase?[activeBinanceBase,...binanceBases().filter(x=>x!==activeBinanceBase)]:binanceBases();
  let lastErr=null;
  for(const base of bases){
    try{const data=await requestJson(base+pathname+"?"+qs.toString());activeBinanceBase=base;return data;}
    catch(e){lastErr=e;const m=String(e.message||"");if(!(/HTTP (403|429|451|500|502|503|504) /.test(m)||/empty JSON response|invalid JSON response|fetch failed|timed out|timeout/i.test(m)))break;}
  }
  throw lastErr||new Error("Binance fallback endpoint unavailable");
}

function parseBitgetCandles(rows) {
  return (Array.isArray(rows)?rows:[]).map(x=>({open:n(x[1]),high:n(x[2]),low:n(x[3]),close:n(x[4]),volume:n(x[5]),closeTime:n(x[0])})).filter(x=>[x.open,x.high,x.low,x.close,x.volume,x.closeTime].every(Number.isFinite)).sort((a,b)=>a.closeTime-b.closeTime);
}
function parseBitgetDepth(depth) { return {bids:Array.isArray(depth?.b)?depth.b:[],asks:Array.isArray(depth?.a)?depth.a:[]}; }

async function bitgetSnapshot() {
  const instruments=await bitget("/api/v3/market/instruments",{category:"USDT-FUTURES"});
  const symbols=(Array.isArray(instruments)?instruments:[]).filter(s=>s.status==="online"&&s.type==="perpetual"&&String(s.symbol||"").endsWith("USDT")&&!NON_CRYPTO.has(String(s.baseCoin||"").toUpperCase())).map(s=>s.symbol);
  const tickers=await bitget("/api/v3/market/tickers",{category:"USDT-FUTURES"});
  const universe=new Map(symbols.map(s=>[s,true]));
  const ranked=(Array.isArray(tickers)?tickers:[]).filter(t=>universe.has(t.symbol)).map(t=>({symbol:t.symbol,quoteVolume:n(t.turnover24h)||0,change:n(t.price24hPcnt)||0,price:n(t.lastPrice)})).filter(x=>x.quoteVolume>5000000&&Number.isFinite(x.price)).sort((a,b)=>b.quoteVolume-a.quoteVolume).slice(0,Math.max(DEFAULT_TARGETS,Number(process.env.FALLBACK_DISCOVERY_LIMIT||20)));
  return {ranked,provider:"Bitget"};
}

async function bitgetMarket(symbol) {
  const [k15,k1h,k4h,depth,tickerRows]=await Promise.all([
    bitget("/api/v3/market/candles",{category:"USDT-FUTURES",symbol,interval:"15m",limit:100}),
    bitget("/api/v3/market/candles",{category:"USDT-FUTURES",symbol,interval:"1H",limit:100}),
    bitget("/api/v3/market/candles",{category:"USDT-FUTURES",symbol,interval:"4H",limit:100}),
    bitget("/api/v3/market/orderbook",{category:"USDT-FUTURES",symbol,limit:5}),
    bitget("/api/v3/market/tickers",{category:"USDT-FUTURES",symbol})
  ]);
  const ticker=Array.isArray(tickerRows)?tickerRows[0]:null;
  return {k15:parseBitgetCandles(k15),k1h:parseBitgetCandles(k1h),k4h:parseBitgetCandles(k4h),oi:{openInterest:ticker?.openInterest},funding:{lastFundingRate:ticker?.fundingRate},depth:parseBitgetDepth(depth)};
}

function ema(values, period) {
  if (values.length < period) return null;
  let e = mean(values.slice(0, period));
  const k = 2/(period+1);
  for (let i=period;i<values.length;i++) e=(values[i]-e)*k+e;
  return e;
}

function rsi(values, period=14) {
  if (values.length <= period) return null;
  let g=0,l=0;
  for(let i=1;i<=period;i++){const d=values[i]-values[i-1];g+=Math.max(d,0);l+=Math.max(-d,0);}
  let ag=g/period, al=l/period;
  for(let i=period+1;i<values.length;i++){
    const d=values[i]-values[i-1];
    ag=(ag*(period-1)+Math.max(d,0))/period;
    al=(al*(period-1)+Math.max(-d,0))/period;
  }
  return al ? 100-100/(1+ag/al) : 100;
}

function atr(c, period=14) {
  if(c.length<period+1)return null;
  const tr=[];
  for(let i=1;i<c.length;i++){
    const p=c[i-1].close;
    tr.push(Math.max(c[i].high-c[i].low,Math.abs(c[i].high-p),Math.abs(c[i].low-p)));
  }
  return mean(tr.slice(-period));
}

function adx(c, period=14) {
  if(c.length<period*2+1)return null;
  const tr=[],pd=[],md=[];
  for(let i=1;i<c.length;i++){
    const h=c[i].high,l=c[i].low,p=c[i-1];
    tr.push(Math.max(h-l,Math.abs(h-p.close),Math.abs(l-p.close)));
    const up=h-p.high, down=p.low-l;
    pd.push(up>down&&up>0?up:0); md.push(down>up&&down>0?down:0);
  }
  const dx=[];
  for(let i=period;i<tr.length;i++){
    const at=mean(tr.slice(i-period,i)), p=mean(pd.slice(i-period,i)), m=mean(md.slice(i-period,i));
    const pdi=at?100*p/at:0, mdi=at?100*m/at:0, sum=pdi+mdi;
    dx.push(sum?100*Math.abs(pdi-mdi)/sum:0);
  }
  return dx.length?mean(dx.slice(-period)):null;
}

function parseKlines(rows) {
  return rows.map(x=>({open:n(x[1]),high:n(x[2]),low:n(x[3]),close:n(x[4]),volume:n(x[5]),closeTime:n(x[6])}))
    .filter(x=>[x.open,x.high,x.low,x.close,x.volume,x.closeTime].every(Number.isFinite));
}

function tfAnalysis(c) {
  if(c.length<60)return null;
  const closes=c.map(x=>x.close), last=closes.at(-1);
  const e9=ema(closes,9), e21=ema(closes,21), e50=ema(closes,50);
  const prev=closes.slice(0,-1), prevE9=ema(prev,9), prevE21=ema(prev,21);
  const r=rsi(closes), a=atr(c), d=adx(c);
  const slope=((last-closes.at(-13))/closes.at(-13))*100;
  const buy=c.slice(-12).reduce((s,x)=>s+(x.close>x.open?x.volume:0),0);
  const sell=c.slice(-12).reduce((s,x)=>s+(x.close<=x.open?x.volume:0),0);
  const pressure=(buy-sell)/(buy+sell||1);
  let score=0;
  if(e9>e21 && (e50==null||e21>e50))score+=3;
  if(e9<e21 && (e50==null||e21<e50))score-=3;
  if(last>e21)score+=2; else if(last<e21)score-=2;
  if(slope>0.2)score+=2; else if(slope<-0.2)score-=2;
  if(pressure>0.08)score+=2; else if(pressure<-0.08)score-=2;
  if(Number.isFinite(r)){if(r>=45&&r<=72)score+=1;if(r>=28&&r<=55)score-=1;}
  const direction=score>=3?"LONG":score<=-3?"SHORT":"NEUTRAL";
  return {direction,score,rsi:r,atr:a,adx:d,pressure,slope,last,e9,e21,prevE9,prevE21};
}

function levels(c, side, a) {
  const entry=c.at(-1).close;
  const look=c.slice(-40);
  const low=Math.min(...look.map(x=>x.low));
  const high=Math.max(...look.map(x=>x.high));
  const minRisk=Math.max(a*1.5,entry*0.004);
  if(side==="LONG"){
    const structural=Math.min(low,entry-minRisk*0.75);
    const sl=Math.min(entry-minRisk,structural);
    const risk=Math.max(entry-sl,minRisk);
    return {entry,sl:entry-risk,tp1:entry+risk*2,tp2:entry+risk*4,tp3:entry+risk*6};
  }
  const structural=Math.max(high,entry+minRisk*0.75);
  const sl=Math.max(entry+minRisk,structural);
  const risk=Math.max(sl-entry,minRisk);
  return {entry,sl:entry+risk,tp1:entry-risk*2,tp2:entry-risk*4,tp3:entry-risk*6};
}

function derivativeScore(side, oi, funding, depth) {
  const o=n(oi?.openInterest);
  const f=n(funding?.lastFundingRate);
  const bid=n(depth?.bids?.[0]?.[1]), ask=n(depth?.asks?.[0]?.[1]);
  let score=0, adverse=false;
  if(Number.isFinite(f)){
    if(side==="LONG" && f>0.0005){score-=4;adverse=true;}
    else if(side==="SHORT" && f<-0.0005){score-=4;adverse=true;}
    else score+=2;
  }
  if(Number.isFinite(o)&&o>0)score+=2;
  if(Number.isFinite(bid)&&Number.isFinite(ask)&&bid>0&&ask>0){
    const imbalance=(bid-ask)/(bid+ask);
    if(side==="LONG"&&imbalance>0.03)score+=4;
    else if(side==="SHORT"&&imbalance<-0.03)score+=4;
    else score+=1;
  }
  return {score:Math.max(0,Math.min(10,score)),adverse};
}

function candidateScore(discovery, tfs, deriv, rr) {
  const dirs=tfs.map(x=>x.direction).filter(x=>x!=="NEUTRAL");
  const side=dirs.length>=2 && dirs.filter(x=>x===dirs[0]).length>=2 ? dirs[0] : null;
  if(!side)return {side:null,score:0};
  const aligned=tfs.filter(x=>x.direction===side).length;
  let score=72;
  score+=Math.min(8,discovery);
  score+=aligned>=3?8:aligned===2?5:0;
  score+=tfs.reduce((s,x)=>s+(x.adx>=20?2:0),0);
  score+=Math.max(0,deriv);
  if(rr>=2.5)score+=4; else if(rr>=2)score+=2;
  return {side,score:Math.min(99,Math.round(score))};
}

async function buildSignals(snapshot,provider,marketLoader) {
  const ranked=snapshot.ranked,targetLimit=clamp(Number(process.env.FALLBACK_TARGETS||DEFAULT_TARGETS),1,10),targets=ranked.slice(0,targetLimit),out=[];
  for(const d of targets) try {
    const market=await marketLoader(d.symbol), tfs=[tfAnalysis(market.k15),tfAnalysis(market.k1h),tfAnalysis(market.k4h)];
    if(tfs.some(x=>!x)) continue;
    const dirs=tfs.map(x=>x.direction),longN=dirs.filter(x=>x==="LONG").length,shortN=dirs.filter(x=>x==="SHORT").length,side=longN>=2?"LONG":shortN>=2?"SHORT":null;
    if(!side) continue;
    const lv=levels(market.k1h,side,tfs[1].atr),risk=Math.abs(lv.entry-lv.sl),rr=risk?Math.abs(lv.tp1-lv.entry)/risk:0;
    if(!Number.isFinite(rr)||rr<2) continue;
    const ds=derivativeScore(side,market.oi,market.funding,market.depth); if(ds.adverse) continue;
    const disc=Math.min(10,Math.round(Math.log10(Math.max(d.quoteVolume,1))-6)),cs=candidateScore(disc,tfs,ds.score,rr);
    if(cs.side!==side) continue;
    const threshold=Number(process.env.FALLBACK_MIN_SCORE||DEFAULT_MIN_SCORE); if(cs.score<threshold) continue;
    out.push({id:`fallback-${provider.toLowerCase()}-${d.symbol}-${Date.now()}`,source:"Public-Market-Compatible",origin:provider+" public futures data · compatible fallback",base:d.symbol.replace(/USDT$/,""),instId:d.symbol,action:side,probability:cs.score,qualityScore:cs.score,signalStrength:cs.score>=96?"very_strong":cs.score>=90?"strong":"moderate",importance:d.quoteVolume>=50000000?"high":"medium",strategyName:"TraderSpy-Compatible MTF",timeframe:"1h",setup:"TRADERSPY_COMPATIBLE_MTF",mode:"TRADERSPY_COMPATIBLE",...lv,rr:+rr.toFixed(2),riskPct:+(risk/lv.entry*100).toFixed(3),regime:{atrPct:+(tfs[1].atr/lv.entry*100).toFixed(3)},book:{source:provider+" public futures depth"},m5:{volume:{side:"—"},rsi:null},trends:{m15:dirs[0],h1:dirs[1],h4:dirs[2]},confluence:dirs.filter(x=>x===side).length,persistent:false,volConfirm:Math.abs(tfs[0].pressure)>0.08,ev:null,ts:Date.now(),validUntil:new Date(Date.now()+3600000).toISOString(),horizons:{},validation:{passed:true,stale:false,ageMin:0,threshold,discoveryScore:disc,technicalScore:tfs.reduce((s,x)=>s+Math.max(0,x.score),0),derivativesScore:ds.score,detailScore:null,reasons:["2/3+ MTF agreement","ATR/structure levels","derivatives sanity","public futures market data"]},traderSpy:{id:"",resolutionStatus:"pending",triggeredConditions:[],targetPct:null,fallback:true}});
  } catch(e) { console.warn("Fallback skipped "+provider+" "+d.symbol+": "+e.message); }
  out.sort((a,b)=>b.qualityScore-a.qualityScore||b.ts-a.ts);
  return {signals:out,discovered:ranked.length,fetched:ranked.length,validated:out.length,validationCalls:targets.length,source:provider.toLowerCase()};
}

async function getFallbackIntelligence() {
  const providers=[
    ["Bitget",bitgetSnapshot,bitgetMarket],
    ["Binance",async()=>{const info=await binance("/fapi/v1/exchangeInfo");const symbols=(info.symbols||[]).filter(s=>s.status==="TRADING"&&s.quoteAsset==="USDT"&&s.contractType==="PERPETUAL"&&!NON_CRYPTO.has(String(s.baseAsset||"").toUpperCase())).map(s=>s.symbol);const tickers=await binance("/fapi/v1/ticker/24hr");const universe=new Map(symbols.map(s=>[s,true]));const ranked=(Array.isArray(tickers)?tickers:[]).filter(t=>universe.has(t.symbol)).map(t=>({symbol:t.symbol,quoteVolume:n(t.quoteVolume)||0,change:n(t.priceChangePercent)||0,price:n(t.lastPrice)})).filter(x=>x.quoteVolume>5000000&&Number.isFinite(x.price)).sort((a,b)=>b.quoteVolume-a.quoteVolume).slice(0,Math.max(DEFAULT_TARGETS,Number(process.env.FALLBACK_DISCOVERY_LIMIT||20)));return {ranked,provider:"Binance"}},async (symbol)=>{const [k15,k1h,k4h,oi,funding,depth]=await Promise.all([binance("/fapi/v1/klines",{symbol,interval:"15m",limit:100}),binance("/fapi/v1/klines",{symbol,interval:"1h",limit:100}),binance("/fapi/v1/klines",{symbol,interval:"4h",limit:100}),binance("/fapi/v1/openInterest",{symbol}),binance("/fapi/v1/premiumIndex",{symbol}),binance("/fapi/v1/depth",{symbol,limit:5})]);return {k15:parseKlines(k15),k1h:parseKlines(k1h),k4h:parseKlines(k4h),oi,funding,depth}}]];
  let lastErr=null;
  for(const [provider,discover,loader] of providers) {
    try { console.log("Fallback provider: "+provider); const snapshot=await discover(); const result=await buildSignals(snapshot,provider,loader); if(result.signals.length>0)return result; lastErr=new Error(provider+" returned zero validated signals"); }
    catch(e){lastErr=e;console.warn("Fallback provider "+provider+" unavailable: "+e.message);}
  }
  throw lastErr||new Error("No public market-data provider available");
}

module.exports={getFallbackIntelligence,tfAnalysis,derivativeScore,levels,binance};
