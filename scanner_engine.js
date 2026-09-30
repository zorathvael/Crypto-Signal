/**
 * Crypto-Signal v4.0.0 — 8-Agent Council Engine
 *
 * The legacy scanner/TraderSpy decision stack is intentionally replaced here.
 * This module is a bounded, deterministic market-discovery engine modeled on
 * the supplied Scanner Council - 8 Agent Discussion:
 * Wyckoff, OrderFlow, Exhaustion, SmartMoney, Structure, Whale, MTF, Pullback.
 *
 * It returns the existing signal contract consumed by delivery.js.
 * It does NOT own public formatting or channel delivery.
 */

const BITGET = "https://api.bitget.com";
const PRODUCT = "USDT-FUTURES";
const CFG = {
  interval: process.env.SCANNER_INTERVAL || "5m",
  candleLimit: Math.min(Math.max(Number(process.env.SCANNER_CANDLES || 120), 80), 240),
  universe: Math.min(Math.max(Number(process.env.SCANNER_UNIVERSE || 30), 10), 60),
  candidates: Math.min(Math.max(Number(process.env.SCANNER_CANDIDATES || 10), 3), 20),
  minQuoteVolume: Math.max(Number(process.env.SCANNER_MIN_VOLUME || 15000000), 0),
  batch: Math.min(Math.max(Number(process.env.SCANNER_BATCH || 6), 2), 10),
  minConsensus: Math.min(Math.max(Number(process.env.SCANNER_MIN_CONSENSUS || 52), 25), 90),
  deepCandidates: Math.min(Math.max(Number(process.env.SCANNER_DEEP_CANDIDATES || 10), 3), 15),
};

const mean = a => a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0;
const clamp = (v,a,b) => Math.min(b,Math.max(a,v));
const last = a => a?.[a.length-1];

async function getJson(url, retries=2) {
  let err;
  for (let i=0;i<=retries;i++) {
    try {
      const res = await fetch(url,{headers:{Accept:"application/json", "User-Agent":"Crypto-Signal/4.0.0-bitget"}});
      if (!res.ok) throw new Error("Bitget HTTP "+res.status);
      const json=await res.json();
      if (json && json.code && json.code !== "00000") throw new Error("Bitget API "+json.code+": "+(json.msg||"request failed"));
      return json;
    } catch(e) {
      err=e;
      if (i<retries) await new Promise(r=>setTimeout(r,250*(i+1)));
    }
  }
  throw err;
}


function klinesToCandles(rows) {
  return (rows||[]).map(k=>({
    ts:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4],
    volume:+k[5], closeTs:+k[6], quoteVolume:+k[7],
    trades:+k[8], takerBuyBase:+k[9], takerBuyQuote:+k[10]
  })).filter(c=>[c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite));
}

function ema(v,p) {
  if(v.length<p) return null;
  let e=mean(v.slice(0,p)), k=2/(p+1);
  for(let i=p;i<v.length;i++) e=(v[i]-e)*k+e;
  return e;
}
function rsi(v,p=14) {
  if(v.length<=p) return 50;
  let g=0,l=0;
  for(let i=1;i<=p;i++){const d=v[i]-v[i-1];g+=Math.max(d,0);l+=Math.max(-d,0);}
  let ag=g/p, al=l/p;
  for(let i=p+1;i<v.length;i++){const d=v[i]-v[i-1];ag=(ag*(p-1)+Math.max(d,0))/p;al=(al*(p-1)+Math.max(-d,0))/p;}
  return al===0?100:100-100/(1+ag/al);
}
function atr(cs,p=14) {
  if(cs.length<p+1) return null;
  const tr=cs.map((c,i)=>i===0?c.high-c.low:Math.max(c.high-c.low,Math.abs(c.high-cs[i-1].close),Math.abs(c.low-cs[i-1].close)));
  let a=mean(tr.slice(0,p));
  for(let i=p;i<tr.length;i++) a=(a*(p-1)+tr[i])/p;
  return a;
}
function bollinger(v,p=20,m=2) {
  if(v.length<p) return null;
  const w=v.slice(-p), mid=mean(w), sd=Math.sqrt(mean(w.map(x=>(x-mid)**2)));
  return {mid,upper:mid+m*sd,lower:mid-m*sd,width:mid?2*m*sd/mid:0};
}
function slope(v,n=10){if(v.length<=n)return 0;const a=v[v.length-1-n],b=v.at(-1);return a?((b-a)/a)*100:0;}
function structure(cs) {
  if(cs.length<30) return {trend:"neutral",support:null,resistance:null,hh:false,hl:false,lh:false,ll:false};
  const highs=[],lows=[];
  for(let i=2;i<cs.length-2;i++){
    if(cs[i].high>=cs[i-1].high&&cs[i].high>=cs[i-2].high&&cs[i].high>=cs[i+1].high&&cs[i].high>=cs[i+2].high) highs.push(cs[i].high);
    if(cs[i].low<=cs[i-1].low&&cs[i].low<=cs[i-2].low&&cs[i].low<=cs[i+1].low&&cs[i].low<=cs[i+2].low) lows.push(cs[i].low);
  }
  const h1=highs.at(-2),h2=highs.at(-1),l1=lows.at(-2),l2=lows.at(-1);
  const hh=Number.isFinite(h1)&&Number.isFinite(h2)&&h2>h1, lh=Number.isFinite(h1)&&Number.isFinite(h2)&&h2<h1;
  const hl=Number.isFinite(l1)&&Number.isFinite(l2)&&l2>l1, ll=Number.isFinite(l1)&&Number.isFinite(l2)&&l2<l1;
  let trend="neutral";
  if((hh&&hl)||(hh&&!ll))trend="up";
  else if((lh&&ll)||(ll&&!hh))trend="down";
  else {
    const a=cs.slice(-20,-10),b=cs.slice(-10);
    if(Math.max(...b.map(x=>x.high))>Math.max(...a.map(x=>x.high))&&Math.min(...b.map(x=>x.low))>Math.min(...a.map(x=>x.low)))trend="up";
    if(Math.max(...b.map(x=>x.high))<Math.max(...a.map(x=>x.high))&&Math.min(...b.map(x=>x.low))<Math.min(...a.map(x=>x.low)))trend="down";
  }
  return {trend,support:Number.isFinite(l2)?l2:null,resistance:Number.isFinite(h2)?h2:null,hh,hl,lh,ll};
}
function trend(cs) {
  const c=last(cs), closes=cs.map(x=>x.close), e9=ema(closes,9),e21=ema(closes,21),e50=ema(closes,50),st=structure(cs);
  let v=0;
  if(e9>e21)v+=1; else if(e9<e21)v-=1;
  if(e21>e50)v+=1; else if(e21<e50)v-=1;
  if(st.trend==="up")v+=2; if(st.trend==="down")v-=2;
  if(c.close>e21)v+=1; if(c.close<e21)v-=1;
  const s=slope(closes,12); if(s>0.12)v+=1;if(s<-0.12)v-=1;
  return {dir:v>=2?"bullish":v<=-2?"bearish":"neutral",score:clamp(v/7*100,-100,100),ema9:e9,ema21:e21,ema50:e50,structure:st,slope:s};
}
function regime(cs) {
  const c=last(cs), a=atr(cs), pct=a&&c.close?a/c.close*100:0, bb=bollinger(cs.map(x=>x.close));
  if(pct>1.8)return "volatile";
  if(bb&&bb.width<0.012)return "ranging";
  return "trending";
}
function fibPullback(cs,side) {
  const win=cs.slice(-40), hi=Math.max(...win.map(c=>c.high)),lo=Math.min(...win.map(c=>c.low)),range=hi-lo||1;
  const levels=side==="LONG" ? [hi-range*.382,hi-range*.5,hi-range*.618] : [lo+range*.382,lo+range*.5,lo+range*.618];
  return {hi,lo,levels};
}
function candlePressure(cs) {
  const recent=cs.slice(-12), buy=recent.reduce((s,c)=>s+(c.close>c.open?c.volume:0),0),sell=recent.reduce((s,c)=>s+(c.close<=c.open?c.volume:0),0);
  const p=(buy-sell)/(buy+sell||1)*100;
  const taker=recent.reduce((s,c)=>s+(c.quoteVolume?((2*c.takerBuyQuote-c.quoteVolume)):0),0);
  return {pressure:p,takerPressure:taker/(recent.reduce((s,c)=>s+c.quoteVolume,0)||1)*100,spike:last(cs).volume>=mean(cs.slice(-30,-1).map(c=>c.volume))*1.35};
}
function reversal(cs,side) {
  const c=last(cs),p=cs.at(-2),body=Math.abs(c.close-c.open),range=Math.max(c.high-c.low,1e-12),lw=Math.min(c.open,c.close)-c.low,uw=c.high-Math.max(c.open,c.close);
  if(side==="LONG") {
    if(p?.close<p?.open&&c.close>c.open&&c.open<=p.close&&c.close>=p.open)return .95;
    if(lw>=body*2&&lw/range>.45)return .82;
    if(c.close>c.open&&lw/range>.55)return .76;
  } else {
    if(p?.close>p?.open&&c.close<c.open&&c.open>=p.close&&c.close<=p.open)return .95;
    if(uw>=body*2&&uw/range>.45)return .82;
    if(c.close<c.open&&uw/range>.55)return .76;
  }
  return 0;
}

function scoreAgents(ctx) {
  const sides=["LONG","SHORT"];
  const out={};
  const weights={
    trending:{Wyckoff:1.0,OrderFlow:1.25,Exhaustion:.8,SmartMoney:1.2,Structure:1.3,Whale:1.0,MTF:1.35,Pullback:1.15},
    ranging:{Wyckoff:1.15,OrderFlow:1.0,Exhaustion:1.25,SmartMoney:1.0,Structure:.9,Whale:1.0,MTF:.8,Pullback:1.3},
    volatile:{Wyckoff:.9,OrderFlow:1.35,Exhaustion:1.3,SmartMoney:1.15,Structure:1.0,Whale:1.25,MTF:1.0,Pullback:.85},
  }[ctx.regime];
  for(const side of sides){
    const sg=side==="LONG"?1:-1;
    const t5=ctx.tf5,t15=ctx.tf15,t1=ctx.tf1,t4=ctx.tf4,p=ctx.pressure;
    const fib=ctx.fib[side],price=ctx.price;
    const location=side==="LONG"?clamp((fib.hi-price)/(fib.hi-fib.lo||1),0,1):clamp((price-fib.lo)/(fib.hi-fib.lo||1),0,1);
    const agents={};
    agents.Wyckoff=clamp(50+sg*((t15.structure.trend==="up"?18:t15.structure.trend==="down"?-18:0)+(p.pressure*0.45)+reversal(ctx.c5,side)*18),0,100);
    agents.OrderFlow=clamp(50+sg*(p.pressure*.9+p.takerPressure*.6+(p.spike?8:0)),0,100);
    const rsi5=ctx.rsi5, ext=side==="LONG"?clamp((42-rsi5)*3.2,0,28):clamp((rsi5-58)*3.2,0,28);
    agents.Exhaustion=clamp(50+ext+reversal(ctx.c5,side)*22,0,100);
    agents.SmartMoney=clamp(50+sg*((t1.structure.trend==="up"?15:t1.structure.trend==="down"?-15:0)+(t15.structure.trend==="up"?10:t15.structure.trend==="down"?-10:0)),0,100);
    agents.Structure=clamp(50+sg*((t1.structure.trend==="up"?25:t1.structure.trend==="down"?-25:0)+(t15.structure.trend==="up"?15:t15.structure.trend==="down"?-15:0)),0,100);
    agents.Whale=clamp(50+sg*(p.takerPressure*.7),0,100);
    const mtf=(t4.score*.35+t1.score*.35+t15.score*.2+t5.score*.1);
    agents.MTF=clamp(50+sg*mtf*.5,0,100);
    const pb=location>.35&&location<.78?18:location>=.78?8:0;
    agents.Pullback=clamp(50+pb+sg*(p.pressure*.35),0,100);
    const total=Object.entries(agents).reduce((s,[k,v])=>s+(v*weights[k]),0);
    const max=Object.values(weights).reduce((a,b)=>a+b,0)*100;
    out[side]={agents,consensus:total/max*100,weight:weights};
  }
  return out;
}

async function deepData(symbol) {
  const q=encodeURIComponent(symbol);
  const [depth, fills, oi, funding] = await Promise.allSettled([
    getJson(BITGET+"/api/v3/market/orderbook?category="+PRODUCT+"&symbol="+q+"&limit=50"),
    getJson(BITGET+"/api/v3/market/fills?category="+PRODUCT+"&symbol="+q+"&limit=100"),
    getJson(BITGET+"/api/v2/mix/market/open-interest?productType="+PRODUCT+"&symbol="+q),
    getJson(BITGET+"/api/v2/mix/market/current-fund-rate?productType="+PRODUCT+"&symbol="+q)
  ]);
  const d=depth.status==="fulfilled"?depth.value?.data:null;
  const trades=fills.status==="fulfilled"?(fills.value?.data||[]):[];
  const bids=(d?.b||[]).reduce((s,x)=>s+Number(x[0])*Number(x[1]),0);
  const asks=(d?.a||[]).reduce((s,x)=>s+Number(x[0])*Number(x[1]),0);
  const imbalance=(bids+asks)?(bids-asks)/(bids+asks)*100:0;
  let buy=0,sell=0;
  for(const t of trades){const usd=Number(t.price)*Number(t.size); if(String(t.side).toLowerCase()==="sell")sell+=usd;else buy+=usd;}
  const flow=(buy+sell)?(buy-sell)/(buy+sell)*100:0;
  const oiRows=oi.status==="fulfilled"?(oi.value?.data?.openInterestList||[]):[];
  const oiVal=Number(oiRows.find(x=>x.symbol===symbol)?.size||oiRows[0]?.size);
  const fr= funding.status==="fulfilled" ? (funding.value?.data||[])[0] : null;
  return {imbalance,flow,buy,sell,oi:Number.isFinite(oiVal)?oiVal:null,funding:Number(fr?.fundingRate||0)*100};
}

function applyDeep(v,side) {
  if(!v)return 50;
  const sg=side==="LONG"?1:-1;
  let s=50+sg*(v.imbalance*.22+v.flow*.32);
  if(Number.isFinite(v.funding))s+=sg*(-clamp(v.funding*18,-8,8));
  if(v.topLongShort>0)s+=sg*clamp((v.topLongShort-1)*10,-10,10);
  return clamp(s,0,100);
}

async function fetchFrames(symbol) {
  const map={5m:"5m",15m:"15m",1h:"1H",4h:"4H"};
  const rows=await Promise.all(["5m","15m","1h","4h"].map(k=>
    getJson(BITGET+"/api/v2/mix/market/candles?symbol="+symbol+"&productType="+PRODUCT+"&granularity="+map[k]+"&limit="+CFG.candleLimit)
  ));
  return {c5:klinesToCandles(rows[0].data),c15:klinesToCandles(rows[1].data),c1:klinesToCandles(rows[2].data),c4:klinesToCandles(rows[3].data)};
}

function makeContext(symbol,frames) {
  const c5=frames.c5,c15=frames.c15,c1=frames.c1,c4=frames.c4,price=last(c5)?.close;
  const t5=trend(c5),t15=trend(c15),t1=trend(c1),t4=trend(c4);
  const rs=regime(c15),pressure=candlePressure(c5);
  const rsi5=rsi(c5.map(c=>c.close));
  return {symbol,price,c5,c15,c1,c4,tf5:t5,tf15:t15,tf1:t1,tf4:t4,regime:rs,pressure,rsi5,
    fib:{LONG:fibPullback(c15,"LONG"),SHORT:fibPullback(c15,"SHORT")}};
}

function candidateSignal(ctx,votes,deep) {
  const long=clamp(votes.LONG.consensus+(deep?applyDeep(deep,"LONG")-50:0)*.25,0,100);
  const short=clamp(votes.SHORT.consensus+(deep?applyDeep(deep,"SHORT")-50:0)*.25,0,100);
  const side=long>=short?"LONG":"SHORT";
  const consensus=Math.max(long,short),opposite=Math.min(long,short);
  if(consensus<CFG.minConsensus || consensus-opposite<7)return null;
  const sg=side==="LONG"?1:-1;
  const s=ctx.tf15.structure;
  const atrv=atr(ctx.c15)||atr(ctx.c5)||ctx.price*.005;
  let structural=side==="LONG"?(s.support||ctx.price-atrv):(s.resistance||ctx.price+atrv);
  const maxRisk=ctx.price*.005;
  if(side==="LONG") structural=clamp(structural,ctx.price-maxRisk*.90,ctx.price-maxRisk*.35);
  else structural=clamp(structural,ctx.price+maxRisk*.35,ctx.price+maxRisk*.90);
  const validUntil=new Date(Date.now()+15*60*1000).toISOString();
  const agents=votes[side].agents;
  return {
    strategyId:"zorath-core-v4.0",
    base:ctx.symbol.replace(/USDT$/,""),instId:ctx.symbol,action:side,
    probability:Math.round(consensus),qualityScore:Math.round(consensus),
    rawQualityScore:Math.round(consensus),setup:"SCALP_MTF",validUntil,
    entry:ctx.price,sl:structural,
    h1:{bias:ctx.tf1.dir==="bullish"?"bullish":ctx.tf1.dir==="bearish"?"bearish":"neutral",position:50,rsi:rsi(ctx.c1.map(c=>c.close)),volume:{side:ctx.pressure.pressure>0?"BUY":"SELL"}},
    m15:{bias:ctx.tf15.dir==="bullish"?"bullish":ctx.tf15.dir==="bearish"?"bearish":"neutral",position:50,rsi:rsi(ctx.c15.map(c=>c.close)),volume:{side:ctx.pressure.pressure>0?"BUY":"SELL"}},
    m5:{bias:ctx.tf5.dir==="bullish"?"bullish":ctx.tf5.dir==="bearish"?"bearish":"neutral",position:50,rsi:ctx.rsi5,volume:{side:ctx.pressure.pressure>8?"BUY":ctx.pressure.pressure<-8?"SELL":"BALANCED",spike:ctx.pressure.spike}},
    h4:{bias:ctx.tf4.dir==="bullish"?"bullish":ctx.tf4.dir==="bearish"?"bearish":"neutral"},
    trends:{h4:ctx.tf4.dir,m15:ctx.tf15.dir,h1:ctx.tf1.dir},
    regime:{regime:ctx.regime,atrPct:+((atr(ctx.c15)||0)/ctx.price*100).toFixed(3)},
    book:deep?{side:deep.imbalance>8?"BUY":deep.imbalance<-8?"SELL":"FLAT",imbalance:+deep.imbalance.toFixed(2),quality:Math.abs(deep.imbalance)>18?"STRONG":"NORMAL"}:null,
    volConfirm:ctx.pressure.spike,pillars:Object.entries(agents).sort((a,b)=>b[1]-a[1]).slice(0,4).map(x=>x[0]),
    confluence:Object.values(agents).filter(x=>x>=65).length,
    council:{regime:ctx.regime,agents,votes:{long:+long.toFixed(2),short:+short.toFixed(2)},deep:deep||null},
    riskPct:.5,
  };
}

async function getUniverse() {
  const [contracts,tickers]=await Promise.all([
    getJson(BITGET+"/api/v2/mix/market/contracts?productType="+PRODUCT),
    getJson(BITGET+"/api/v2/mix/market/tickers?productType="+PRODUCT)
  ]);
  const active=new Set((contracts.data||[]).filter(s=>String(s.symbolType||"").toLowerCase()!=="delivery" && String(s.symbolStatus||"normal").toLowerCase()==="normal").map(s=>s.symbol));
  return (tickers.data||[]).filter(t=>active.has(t.symbol))
    .map(t=>({symbol:t.symbol,volume:Number(t.quoteVolume)||Number(t.usdtVolume)||0,price:Number(t.lastPr)||Number(t.lastPrice)||0,change:Number(t.change24h)||0}))
    .filter(x=>x.price>0&&x.volume>=CFG.minQuoteVolume)
    .sort((a,b)=>b.volume-a.volume)
    .slice(0,CFG.universe);
}

async function mapLimit(items,limit,fn) {
  const out=[]; let idx=0;
  async function worker(){while(true){const i=idx++;if(i>=items.length)return;try{out[i]=await fn(items[i],i);}catch(e){out[i]={error:e};}}}
  await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));
  return out;
}

async function runCouncilEngine() {
  console.log("=== Crypto-Signal v4.0 | 8-Agent Council Engine ===");
  console.log(new Date().toISOString());
  console.log("Engine: Bitget USDT Futures → liquid universe → 8 agents → regime weighting → deep validation");
  const universe=await getUniverse();
  console.log("Universe:",universe.length,universe.map(x=>x.symbol.replace("USDT","")).join(", "));
  const scanned=await mapLimit(universe,CFG.batch,async u=>{
    const frames=await fetchFrames(u.symbol);
    if(frames.c5.length<60||frames.c15.length<60||frames.c1.length<60)return null;
    const ctx=makeContext(u.symbol,frames);
    const votes=scoreAgents(ctx);
    return {u,ctx,votes,top:Math.max(votes.LONG.consensus,votes.SHORT.consensus)};
  });
  const viable=scanned.filter(x=>x&&!x.error).sort((a,b)=>b.top-a.top).slice(0,CFG.deepCandidates);
  console.log("Council shortlist:",viable.map(x=>x.u.symbol.replace("USDT","")+":"+x.top.toFixed(1)).join(", ")||"none");
  const deep=await mapLimit(viable,Math.min(CFG.batch,4),async x=>({x,d:await deepData(x.u.symbol)}));
  const bySymbol=new Map(deep.map(x=>[x.x.u.symbol,x.d]));
  const signals=[];
  for(const x of viable){
    const s=candidateSignal(x.ctx,x.votes,bySymbol.get(x.u.symbol));
    if(s)signals.push(s);
  }
  signals.sort((a,b)=>b.probability-a.probability||b.confluence-a.confluence);
  console.log("Council VALID candidates:",signals.length);
  for(const s of signals)console.log(" ",s.base,s.action,"score="+s.probability,"agents="+s.confluence);
  return signals;
}

module.exports={runCouncilEngine,CFG};
