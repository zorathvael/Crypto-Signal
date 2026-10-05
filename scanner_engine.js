/**
 * Crypto-Signal v5.1 — Live Binance Futures scanner with Bitget fallback.
 * The deterministic calibration method remains the supplied live-Binance scanner method.
 * Binance is primary; Bitget USDT-Futures is the read-only market-data fallback.
 * No mock market data.
 */
const BINANCE_BASES = String(process.env.BINANCE_FAPI_URLS || "https://fapi.binance.com,https://fapi1.binance.com,https://fapi2.binance.com,https://fapi3.binance.com,https://fapi4.binance.com").split(",").map(s=>s.trim().replace(/\/$/,"")).filter(Boolean);
const BITGET_BASE = String(process.env.BITGET_API_BASE || "https://api.bitget.com").replace(/\/$/,"");
const BITGET_PRODUCT_TYPE = "USDT-FUTURES";
const BITGET_INTERVALS = { "1m":"1m","3m":"3m","5m":"5m","15m":"15m","30m":"30m","1h":"1H","2h":"2H","4h":"4H","6h":"6H","12h":"12H","1d":"1D" };
const DEFAULT_SYMBOLS = "";
const TRADFI_BASE_DENYLIST = new Set(String(process.env.SCANNER_TRADFI_DENYLIST || "AAPL,AMZN,GOOG,GOOGL,META,MSFT,NVDA,TSLA,COIN,HOOD,MSTR,PLTR,NFLX,AMD,INTC,IBM,ORCL,BA,DIS,NKE,XOM,CVX,JPM,BAC,WMT,QQQ,SPY,USO,GLD,SLV,XAU,XAG,EUR,GBP,JPY,CHF,CAD,AUD").split(",").map(x=>x.trim().toUpperCase()).filter(Boolean));
const CFG = {
  symbols: (process.env.SCANNER_SYMBOLS || DEFAULT_SYMBOLS).split(",").map(s=>s.trim().toUpperCase()).filter(Boolean),
  interval: process.env.SCANNER_INTERVAL || "1h",
  limit: Math.min(Math.max(Number(process.env.SCANNER_CANDLES || 150), 120), 500),
  candidates: Math.min(Math.max(Number(process.env.SCANNER_CANDIDATES || 10), 1), 20),
  concurrency: Math.min(Math.max(Number(process.env.SCANNER_CONCURRENCY || 4), 1), 8),
  provider: String(process.env.SCANNER_PROVIDER || "auto").toLowerCase(),
  universe: Math.min(Math.max(Number(process.env.SCANNER_UNIVERSE || 100), 10), 300),
  minVolume: Math.max(Number(process.env.SCANNER_MIN_VOLUME || 0), 0)
};
async function getJson(url,retries=2){
  let err;
  for(let i=0;i<=retries;i++){
    try{
      const r=await fetch(url,{headers:{Accept:"application/json","User-Agent":"Crypto-Signal/5.0"}});
      if(!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    }catch(e){err=e;if(i<retries)await new Promise(r=>setTimeout(r,300*(i+1)));}
  }
  throw err;
}
function ema(arr,period){
  const k=2/(period+1),out=new Array(arr.length).fill(null);let prev=null;
  for(let i=0;i<arr.length;i++){
    if(i<period-1)continue;
    if(prev===null){let sum=0;for(let j=i-period+1;j<=i;j++)sum+=arr[j];prev=sum/period;}
    else prev=arr[i]*k+prev*(1-k);
    out[i]=prev;
  }
  return out;
}
function rsiArr(arr,period){
  const out=new Array(arr.length).fill(null);let gain=0,loss=0;
  for(let i=1;i<=period;i++){const d=arr[i]-arr[i-1];if(d>=0)gain+=d;else loss-=d;}
  gain/=period;loss/=period;out[period]=loss===0?100:100-100/(1+gain/loss);
  for(let i=period+1;i<arr.length;i++){const d=arr[i]-arr[i-1],g=d>0?d:0,l=d<0?-d:0;gain=(gain*(period-1)+g)/period;loss=(loss*(period-1)+l)/period;out[i]=loss===0?100:100-100/(1+gain/loss);}
  return out;
}
function macdHistArr(arr){
  const e12=ema(arr,12),e26=ema(arr,26);
  const macd=arr.map((_,i)=>e12[i]!=null&&e26[i]!=null?e12[i]-e26[i]:null);
  const valid=macd.filter(v=>v!=null),sig=ema(valid,9);let vi=0;
  const signal=macd.map(v=>v==null?null:sig[vi++]);
  return macd.map((v,i)=>v!=null&&signal[i]!=null?v-signal[i]:null);
}
function volAtr(arr,period){
  const out=new Array(arr.length).fill(null);
  for(let i=period;i<arr.length;i++){
    const rets=[];for(let j=i-period+1;j<=i;j++)rets.push((arr[j]-arr[j-1])/arr[j-1]);
    const mean=rets.reduce((a,b)=>a+b,0)/rets.length;
    out[i]=Math.sqrt(rets.reduce((a,b)=>a+(b-mean)*(b-mean),0)/rets.length)*arr[i];
  }
  return out;
}
function percentile(arr,p){
  if(!arr.length)return 0;const s=[...arr].sort((a,b)=>a-b);
  return s[Math.min(s.length-1,Math.max(0,Math.ceil(p/100*s.length)-1))];
}
function clamp(x,lo,hi){return Math.min(hi,Math.max(lo,x));}
function analyze(symbol,closes,vols,livePrice=null){
  const N=closes.length;if(N<40)return{symbol,na:true,reason:"Data terlalu sedikit"};
  const e20=ema(closes,20),e50=ema(closes,50),rsi=rsiArr(closes,14),hist=macdHistArr(closes),atrSeries=volAtr(closes,14);
  const last=N-1,close=closes[last],atrNow=atrSeries[last];
  if(atrNow==null||atrNow<=0)return{symbol,na:true,reason:"Volatilitas 0"};
  let trendS=0;if(e20[last]!=null)trendS+=close>e20[last]?1:-1;if(e20[last]!=null&&e50[last]!=null)trendS+=e20[last]>e50[last]?1:-1;
  let macdS=0;if(hist[last]!=null&&hist[last-1]!=null)macdS=hist[last]>0?(hist[last]>hist[last-1]?2:1):(hist[last]<hist[last-1]?-2:-1);
  let rsiS=0;if(rsi[last]!=null){const r=rsi[last];rsiS=r>70?-1:r<30?1:(r>50?.5:-.5);}
  const win20=vols.slice(Math.max(0,last-19),last+1),avgV=win20.reduce((a,b)=>a+b,0)/win20.length,rv=avgV>0?vols[last]/avgV:1,volS=rv>1.3?1:rv<.7?-1:0;
  const maxRaw=6,raw=trendS+macdS+rsiS+volS,strength=Math.round(raw/maxRaw*100),s=strength>=0?1:-1;
  const winStart=Math.max(20,N-120),fwdUp=[],fwdDn=[];
  for(let i=winStart;i<=N-7;i++){const a=atrSeries[i];if(a==null||a<=0)continue;let hi=-Infinity,lo=Infinity;for(let j=i+1;j<=i+6;j++){hi=Math.max(hi,closes[j]);lo=Math.min(lo,closes[j]);}fwdUp.push((hi-closes[i])/a);fwdDn.push((closes[i]-lo)/a);}
  if(fwdUp.length<10)return{symbol,na:true,reason:"Kalibrasi belum cukup"};
  const upMed=percentile(fwdUp,50),dnMed=percentile(fwdDn,50),up80=percentile(fwdUp,80),dn80=percentile(fwdDn,80),advMed=s===1?dnMed:upMed,adv80=s===1?dn80:up80,favArr=s===1?fwdUp:fwdDn,advArr=s===1?fwdDn:fwdUp;
  const entryK=clamp(.5*advMed,.1,.8),entry=close-s*entryK*atrNow,fillP=advArr.filter(v=>v>=entryK).length/advArr.length;
  const win8=closes.slice(Math.max(0,last-7),last+1),ext=s===1?Math.min(...win8):Math.max(...win8);
  const slStruct=ext-s*.15*atrNow,slMinK=clamp(adv80-entryK+.2,.8,1.5),slNear=entry-s*slMinK*atrNow,slFar=entry-s*2*atrNow;
  const sl=s===1?Math.max(Math.min(slStruct,slNear),slFar):Math.min(Math.max(slStruct,slNear),slFar),r=Math.abs(entry-sl);
  const tp1=entry+s*r,tp2=entry+s*1.618*r,tp3=entry+s*2.618*r,dTp1=s*(tp1-close)/atrNow,reachP=favArr.filter(v=>v>=dTp1).length/favArr.length;
  const sigs=[trendS,macdS,rsiS,volS],pos=sigs.filter(v=>v>0).length,neg=sigs.filter(v=>v<0).length;
  return{symbol,na:false,strength,confidence:Math.round(Math.max(pos,neg)/sigs.length*100),bias:s===1?"long":"short",direction:s===1?"LONG":"SHORT",entry,sl,tp1,tp2,tp3,fillP:fillP*100,reachP:reachP*100,atr:atrNow,rsi:rsi[last],relativeVolume:rv,livePrice:Number(livePrice)||close,candleClose:close,components:{trend:trendS,macd:macdS,rsi:rsiS,volume:volS},calibration:{samples:fwdUp.length,entryK,advMedian:advMed,advP80:adv80,slMinK},setup:"LIVE_BINANCE_CALIBRATED_120C"};
}
async function getBinanceJson(path){let last;for(const base of BINANCE_BASES){try{return await getJson(base+path,0);}catch(e){last=e;console.log("Binance endpoint failed",base,e.message);}}throw last||new Error("Binance unavailable");}
async function getBitgetJson(path){const r=await getJson(BITGET_BASE+path,1);if(!r||r.code!=="00000")throw new Error(`Bitget API ${r?.code||"invalid"}: ${r?.msg||"request failed"}`);return r.data;}
function bitgetInterval(interval){const key=String(interval||"1h").toLowerCase();return BITGET_INTERVALS[key]||"1H";}
function normalizeBitgetCandles(rows){
  if(!Array.isArray(rows))return [];
  return rows.map(k=>({ts:Number(k[0]),open:Number(k[1]),high:Number(k[2]),low:Number(k[3]),close:Number(k[4]),volume:Number(k[5])}))
    .filter(k=>Number.isFinite(k.ts)&&Number.isFinite(k.close)&&Number.isFinite(k.volume))
    .sort((a,b)=>a.ts-b.ts);
}

function isCryptoFuturesSymbol(symbol){
  const base=String(symbol).replace(/USDT$/,"").replace(/^\d+/,"").toUpperCase();
  if(!base || TRADFI_BASE_DENYLIST.has(base))return false;
  if(/^(USD|USDT|USDC|EUR|GBP|JPY|CHF|CAD|AUD|CNY|HKD|SGD|TRY|RUB|BRL|INR|MXN|ZAR)$/.test(base))return false;
  return true;
}
async function discoverBinanceUniverse(){
  const info=await getBinanceJson("/fapi/v1/exchangeInfo");
  const tickers=await getBinanceJson("/fapi/v1/ticker/24hr");
  const volume=new Map((Array.isArray(tickers)?tickers:[]).map(t=>[t.symbol,Number(t.quoteVolume)||0]));
  return (info.symbols||[]).filter(s=>s.status==="TRADING"&&s.contractType==="PERPETUAL"&&s.quoteAsset==="USDT"&&isCryptoFuturesSymbol(s.symbol))
    .map(s=>({symbol:s.symbol,volume:volume.get(s.symbol)||0})).filter(x=>x.volume>=CFG.minVolume).sort((a,b)=>b.volume-a.volume).slice(0,CFG.universe).map(x=>x.symbol);
}
async function discoverBitgetUniverse(){
  const [contracts,tickers]=await Promise.all([
    getBitgetJson(`/api/v2/mix/market/contracts?productType=${BITGET_PRODUCT_TYPE}`),
    getBitgetJson(`/api/v2/mix/market/tickers?productType=${BITGET_PRODUCT_TYPE}`)
  ]);
  const volume=new Map((Array.isArray(tickers)?tickers:[]).map(t=>[t.symbol,Number(t.usdtVolume||t.quoteVolume)||0]));
  return (Array.isArray(contracts)?contracts:[]).filter(s=>s.symbolStatus==="normal"&&s.symbolType==="perpetual"&&String(s.quoteCoin).toUpperCase()==="USDT"&&isCryptoFuturesSymbol(s.symbol))
    .map(s=>({symbol:s.symbol,volume:volume.get(s.symbol)||0})).filter(x=>x.volume>=CFG.minVolume).sort((a,b)=>b.volume-a.volume).slice(0,CFG.universe).map(x=>x.symbol);
}
async function discoverUniverse(){
  if(CFG.symbols.length)return CFG.symbols.filter(isCryptoFuturesSymbol).slice(0,CFG.universe);
  if(CFG.provider==="bitget")return discoverBitgetUniverse();
  if(CFG.provider==="binance")return discoverBinanceUniverse();
  try{return await discoverBinanceUniverse();}catch(e){console.log("Universe Binance unavailable -> Bitget:",e.message);return discoverBitgetUniverse();}
}
async function fetchBinanceSymbol(symbol){
  const rows=await getBinanceJson(`/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(CFG.interval)}&limit=${CFG.limit}`);
  if(!Array.isArray(rows)||rows.length<40)throw new Error("data tidak cukup");
  const ticker=await getBinanceJson(`/fapi/v1/ticker/price?symbol=${encodeURIComponent(symbol)}`).catch(()=>null);
  const r=analyze(symbol,rows.map(k=>+k[4]),rows.map(k=>+k[5]),ticker?.price);
  return {...r,source:"BINANCE_FUTURES"};
}
async function fetchBitgetSymbol(symbol){
  const rows=await getBitgetJson(`/api/v2/mix/market/candles?symbol=${encodeURIComponent(symbol)}&productType=${encodeURIComponent(BITGET_PRODUCT_TYPE)}&granularity=${encodeURIComponent(bitgetInterval(CFG.interval))}&limit=${CFG.limit}`);
  const candles=normalizeBitgetCandles(rows);
  if(candles.length<40)throw new Error("data tidak cukup");
  const ticker=await getBitgetJson(`/api/v2/mix/market/ticker?symbol=${encodeURIComponent(symbol)}&productType=${encodeURIComponent(BITGET_PRODUCT_TYPE)}`).catch(()=>null);
  const last=ticker?.[0]?.lastPr ?? ticker?.[0]?.markPrice ?? candles.at(-1)?.close;
  const r=analyze(symbol,candles.map(k=>k.close),candles.map(k=>k.volume),last);
  return {...r,source:"BITGET_USDT_FUTURES"};
}
async function fetchSymbol(symbol){
  if(CFG.provider==="bitget")return fetchBitgetSymbol(symbol);
  if(CFG.provider==="binance")return fetchBinanceSymbol(symbol);
  try{return await fetchBinanceSymbol(symbol);}
  catch(binanceError){
    console.log(`Fallback Binance -> Bitget: ${symbol} (${binanceError.message})`);
    try{return await fetchBitgetSymbol(symbol);}
    catch(bitgetError){throw new Error(`Binance: ${binanceError.message}; Bitget: ${bitgetError.message}`);}
  }
}
async function mapLimit(items,limit,fn){
  const out=new Array(items.length);let idx=0;
  async function worker(){while(true){const i=idx++;if(i>=items.length)return;try{out[i]=await fn(items[i]);}catch(e){out[i]={symbol:items[i],na:true,reason:"Gagal: "+e.message};}}}
  await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));return out;
}
async function runLiveScanner(){
  console.log(`=== Crypto-Signal v5.1 | LIVE BINANCE -> BITGET FALLBACK | ${CFG.interval} ===`);
  const universe=await discoverUniverse();
  console.log("Universe:",universe.length,"crypto perpetuals");
  console.log("Symbols:",universe.join(", "));
  const results=await mapLimit(universe,CFG.concurrency,fetchSymbol);
  const valid=results.filter(x=>x&&!x.na).sort((a,b)=>Math.abs(b.strength)-Math.abs(a.strength));
  const candidates=valid.slice(0,Math.max(CFG.candidates,Number(process.env.QWEN_MAX_CANDIDATES||20)));
  console.log("LIVE VALID:",candidates.length);
  for(const s of candidates)console.log(` ${s.symbol} [${s.source}] ${s.direction} strength=${s.strength} conf=${s.confidence} entry=${s.entry} SL=${s.sl} TP1=${s.tp1} TP2=${s.tp2}`);
  return candidates;
}
module.exports={runLiveScanner,analyze,ema,rsiArr,macdHistArr,volAtr,percentile,normalizeBitgetCandles,bitgetInterval,CFG,BINANCE_BASES,BITGET_BASE,isCryptoFuturesSymbol,discoverBinanceUniverse,discoverBitgetUniverse};
