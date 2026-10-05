/**
 * Crypto-Signal v5.0 — Live Binance Futures calibrated scanner.
 * Ported directly from the supplied scanner_live_binance.html methodology.
 * No Bitget fallback and no mock market data: Binance public market data only.
 */
const BINANCE_BASES = String(process.env.BINANCE_FAPI_URLS || "https://fapi.binance.com,https://fapi1.binance.com,https://fapi2.binance.com,https://fapi3.binance.com,https://fapi4.binance.com").split(",").map(s=>s.trim().replace(/\/$/,"")).filter(Boolean);
const DEFAULT_SYMBOLS = "NEARUSDT,PUMPUSDT,SOLUSDT,FARTCOINUSDT,PENGUUSDT,WIFUSDT,DOGEUSDT,1000PEPEUSDT,1000BONKUSDT,WLDUSDT,ENAUSDT,ONDOUSDT,SEIUSDT,GRASSUSDT,VIRTUALUSDT,TRUMPUSDT";
const CFG = {
  symbols: (process.env.SCANNER_SYMBOLS || DEFAULT_SYMBOLS).split(",").map(s=>s.trim().toUpperCase()).filter(Boolean),
  interval: process.env.SCANNER_INTERVAL || "1h",
  limit: Math.min(Math.max(Number(process.env.SCANNER_CANDLES || 150), 120), 500),
  candidates: Math.min(Math.max(Number(process.env.SCANNER_CANDIDATES || 10), 1), 20),
  concurrency: Math.min(Math.max(Number(process.env.SCANNER_CONCURRENCY || 4), 1), 8)
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
async function getBinanceJson(path){let last;for(const base of BINANCE_BASES){try{return await getJson(base+path,1);}catch(e){last=e;console.log("Binance endpoint failed",base,e.message);}}throw last||new Error("Binance unavailable");}
async function fetchSymbol(symbol){
  const rows=await getBinanceJson(`/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(CFG.interval)}&limit=${CFG.limit}`);
  if(!Array.isArray(rows)||rows.length<40)throw new Error("data tidak cukup");
  const ticker=await getBinanceJson(`/fapi/v1/ticker/price?symbol=${encodeURIComponent(symbol)}`).catch(()=>null);
  return analyze(symbol,rows.map(k=>+k[4]),rows.map(k=>+k[5]),ticker?.price);
}
async function mapLimit(items,limit,fn){
  const out=new Array(items.length);let idx=0;
  async function worker(){while(true){const i=idx++;if(i>=items.length)return;try{out[i]=await fn(items[i]);}catch(e){out[i]={symbol:items[i],na:true,reason:"Gagal: "+e.message};}}}
  await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));return out;
}
async function runLiveScanner(){
  console.log(`=== Crypto-Signal v5.0 | LIVE BINANCE | ${CFG.interval} ===`);
  console.log("Symbols:",CFG.symbols.join(", "));
  const results=await mapLimit(CFG.symbols,CFG.concurrency,fetchSymbol);
  const valid=results.filter(x=>x&&!x.na).sort((a,b)=>Math.abs(b.strength)-Math.abs(a.strength));
  const candidates=valid.slice(0,CFG.candidates);
  console.log("LIVE VALID:",candidates.length);
  for(const s of candidates)console.log(` ${s.symbol} ${s.direction} strength=${s.strength} conf=${s.confidence} entry=${s.entry} SL=${s.sl} TP1=${s.tp1} TP2=${s.tp2}`);
  return candidates;
}
module.exports={runLiveScanner,analyze,ema,rsiArr,macdHistArr,volAtr,percentile,CFG,BINANCE_BASES};
