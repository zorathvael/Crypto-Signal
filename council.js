/**
 * Crypto-Signal Council Engine
 * Source model: scanner-council.html
 *
 * Purpose:
 *   Candidate discovery before TraderSpy validation.
 *   Eight deterministic agents vote on each liquid Binance Futures symbol:
 *   Wyckoff, OrderFlow, Exhaustion, SmartMoney, Structure, Whale, MTF, Pullback.
 *
 * This module is deliberately a DISCOVERY layer. It does not publish signals,
 * calculate production leverage, or replace TraderSpy validation.
 */

const BINANCE = "https://fapi.binance.com";
const CFG = {
  tf: "5m",
  candleLimit: 60,
  minVolumeUsdt: Number(process.env.COUNCIL_MIN_VOLUME_USDT || 15_000_000),
  topSymbols: Math.min(50, Math.max(10, Number(process.env.COUNCIL_TOP_SYMBOLS || 30))),
  candidateLimit: Math.min(20, Math.max(5, Number(process.env.COUNCIL_CANDIDATES || 12))),
  requestBatch: Math.min(8, Math.max(2, Number(process.env.COUNCIL_BATCH || 6))),
  minConsensus: Math.min(90, Math.max(25, Number(process.env.COUNCIL_MIN_CONSENSUS || 45))),
};

const clamp=(v,a,b)=>Math.min(Math.max(v,a),b);
const mean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;

async function json(url,retries=2){
  let last;
  for(let i=0;i<=retries;i++){
    try{
      const r=await fetch(url,{headers:{Accept:"application/json","User-Agent":"Crypto-Signal-Council/1.0"}});
      if(r.status===429){ await new Promise(x=>setTimeout(x,350*(i+1))); last=new Error("Binance 429"); continue; }
      if(!r.ok) throw new Error("Binance HTTP "+r.status);
      return await r.json();
    }catch(e){
      last=e;
      if(i<retries) await new Promise(x=>setTimeout(x,250*(i+1)));
    }
  }
  throw last||new Error("Binance request failed");
}

function ema(a,p){
  if(a.length<p)return a.at(-1)||0;
  let e=mean(a.slice(0,p)),k=2/(p+1);
  for(let i=p;i<a.length;i++)e=a[i]*k+e*(1-k);
  return e;
}
function rsi(a,p=14){
  if(a.length<p+1)return 50;
  let g=0,l=0;
  for(let i=a.length-p;i<a.length;i++){const d=a[i]-a[i-1];if(d>=0)g+=d;else l-=d;}
  if(l===0)return 100;
  const rs=(g/p)/(l/p);
  return 100-100/(1+rs);
}
function atr(h,l,c,p=14){
  if(c.length<p+1)return c.at(-1)*.02;
  const tr=[];
  for(let i=1;i<c.length;i++)tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));
  return mean(tr.slice(-p));
}
function candles(raw){
  return (Array.isArray(raw)?raw:[]).map(x=>({
    t:+x[0],open:+x[1],high:+x[2],low:+x[3],close:+x[4],volume:+x[5],buy:+x[9],sell:+x[10]
  })).filter(x=>[x.open,x.high,x.low,x.close,x.volume].every(Number.isFinite));
}
function trend(c){
  if(c.length<50)return "neutral";
  const cl=c.map(x=>x.close),e21=ema(cl,21),e50=ema(cl,50);
  const a=cl.at(-1), slope=(a-cl.at(-12))/cl.at(-12)*100;
  if(a>e21&&e21>e50&&slope>.15)return "bullish";
  if(a<e21&&e21<e50&&slope<-.15)return "bearish";
  return "neutral";
}
function regime(c){
  const cl=c.map(x=>x.close),h=c.map(x=>x.high),l=c.map(x=>x.low),v=c.map(x=>x.volume);
  const a=atr(h,l,cl),p=cl.at(-1),atrPct=a/p*100;
  const e20=ema(cl,20),e50=ema(cl,50),emaDiff=Math.abs(e20-e50)/p*100;
  const range=(Math.max(...h.slice(-30))-Math.min(...l.slice(-30)))/p*100;
  const vr=(mean(v.slice(-10))||1)/(mean(v.slice(-30))||1);
  if(emaDiff>.5&&range>1.5&&atrPct>.3)return {type:"trending",atrPct,emaDiff,vr};
  if(atrPct>.8||vr>1.8)return {type:"volatile",atrPct,emaDiff,vr};
  return {type:"ranging",atrPct,emaDiff,vr};
}
function mtfVote(frames,price){
  const ts=["15m","1h","4h"].map(tf=>{
    const c=frames[tf]||[];
    if(c.length<40)return "neutral";
    const cl=c.map(x=>x.close),e=ema(cl,50);
    return price>e?"bullish":"bearish";
  });
  const bull=ts.filter(x=>x==="bullish").length,bear=ts.filter(x=>x==="bearish").length;
  return {trend15:ts[0],trend1h:ts[1],trend4h:ts[2],bullCount:bull,bearCount:bear};
}
function agent(id,name,signal,score,reason,conf=50){return{id,name,signal,score,reason,conf};}

function analyze(symbol,ticker,frames,deep={}){
  const c=frames["5m"],cl=c.map(x=>x.close),op=c.map(x=>x.open),hi=c.map(x=>x.high),lo=c.map(x=>x.low),vol=c.map(x=>x.volume);
  const price=Number(ticker.lastPrice),atrV=atr(hi,lo,cl),r=rsi(cl),n=c.length;
  const last=c.at(-1),rLow=Math.min(...lo.slice(-20,-1)),rHigh=Math.max(...hi.slice(-20,-1));
  const body=Math.abs(last.close-last.open),lw=Math.min(last.close,last.open)-last.low,uw=last.high-Math.max(last.close,last.open),range=Math.max(last.high-last.low,1e-12);
  const deltas=c.map(x=>x.buy-x.sell),dR=deltas.slice(-5).reduce((a,b)=>a+b,0);
  const cvd=[];let cum=0;for(const d of deltas){cum+=d;cvd.push(cum);}
  const cvd10=cvd.slice(-10),cvdRange=price?((Math.max(...cvd10)-Math.min(...cvd10))/(price*100))*100:0;
  const pM=(cl.at(-1)-cl.at(-6))/cl.at(-6)*100;
  const avgAbs=mean(deltas.slice(-20).map(Math.abs))||1,decay=Math.abs(deltas.at(-1))/avgAbs;
  const e21=ema(cl,21),e50=ema(cl,50);
  const pos=(price-Math.min(...lo.slice(-100)))/Math.max(Math.max(...hi.slice(-100))-Math.min(...lo.slice(-100)),1e-12);
  const mtf=mtfVote(frames,price),reg=regime(c),agents=[];
  const topPos=Number(deep.topLongShortPositionRatio||1),globalLS=Number(deep.globalLongShortAccountRatio||1);
  const whale=deep.whale||{buy:0,sell:0,buyUsd:0,sellUsd:0};

  // 1 Wyckoff
  let s="NEUTRAL",sc=0,rs="Tidak ada pola",cf=50;
  if(last.low<rLow*.997&&last.close>rLow&&lw>body&&lw>range*.3){s="LONG";sc=22;rs="Spring terdeteksi";cf=80;}
  else if(last.high>rHigh*1.003&&last.close<rHigh&&uw>body&&uw>range*.3){s="SHORT";sc=22;rs="Upthrust terdeteksi";cf=80;}
  else if(price<e21&&price<e50&&r<35){s="LONG";sc=12;rs="Oversold RSI "+r.toFixed(1);cf=55;}
  else if(price>e21&&price>e50&&r>65){s="SHORT";sc=12;rs="Overbought RSI "+r.toFixed(1);cf=55;}
  agents.push(agent("wyckoff","Wyckoff",s,sc,rs,cf));

  // 2 OrderFlow
  s="NEUTRAL";sc=0;rs="Delta seimbang";cf=50;
  if(dR>0&&price<rLow*1.01){s="LONG";sc=22;rs="Delta positif di area bawah";cf=75;}
  else if(dR<0&&price>rHigh*.99){s="SHORT";sc=22;rs="Delta negatif di area atas";cf=75;}
  else if(dR>0){s="LONG";sc=12;rs="Delta positif dominan";cf=55;}
  else if(dR<0){s="SHORT";sc=12;rs="Delta negatif dominan";cf=55;}
  agents.push(agent("of","OrderFlow",s,sc,rs,cf));

  // 3 Exhaustion
  s="NEUTRAL";sc=0;rs="Tidak ada exhaustion";cf=50;
  if(deltas.at(-1)<0&&decay<.7&&cvdRange<1&&pM<-.15){s="LONG";sc=25;rs="Seller decay + CVD flat";cf=80;}
  else if(deltas.at(-1)>0&&decay<.7&&cvdRange<1&&pM>.15){s="SHORT";sc=25;rs="Buyer decay + CVD flat";cf=80;}
  else if(cvdRange<1){s=pM<0?"LONG":pM>0?"SHORT":"NEUTRAL";sc=10;rs="CVD flat";cf=55;}
  agents.push(agent("exh","Exhaustion",s,sc,rs,cf));

  // 4 SmartMoney / positioning
  s="NEUTRAL";sc=0;rs="Posisi netral";cf=50;
  if(globalLS<=.6&&topPos>=1.2){s="LONG";sc=25;rs="Crowd SHORT vs top traders LONG";cf=85;}
  else if(globalLS>=1.8&&topPos<=.85){s="SHORT";sc=25;rs="Crowd LONG vs top traders SHORT";cf=85;}
  else if(topPos>=1.2){s="LONG";sc=12;rs="Top trader LONG";cf=60;}
  else if(topPos<=.85){s="SHORT";sc=12;rs="Top trader SHORT";cf=60;}
  agents.push(agent("sm","SmartMoney",s,sc,rs,cf));

  // 5 Structure
  s="NEUTRAL";sc=0;rs="Mid-range";cf=50;
  if(pos<.2){s="LONG";sc=20;rs="Discount zone";cf=75;}
  else if(pos>.8){s="SHORT";sc=20;rs="Premium zone";cf=75;}
  else if(pos<.35){s="LONG";sc=10;rs="Lower range";cf=55;}
  else if(pos>.65){s="SHORT";sc=10;rs="Upper range";cf=55;}
  agents.push(agent("struct","Structure",s,sc,rs,cf));

  // 6 Whale
  s="NEUTRAL";sc=0;rs="Tidak ada aktivitas whale";cf=40;
  const wt=whale.buy+whale.sell;
  if(wt>=2){
    const br=whale.buyUsd/Math.max(whale.buyUsd+whale.sellUsd,1);
    if(br>=.6){s="LONG";sc=22;rs="Whale BUY dominan";cf=80;}
    else if(br<=.4){s="SHORT";sc=22;rs="Whale SELL dominan";cf=80;}
  }
  agents.push(agent("whale","Whale",s,sc,rs,cf));

  // 7 MTF
  s="NEUTRAL";sc=0;rs="MTF tidak selaras";cf=50;
  if(mtf.bullCount===3){s="LONG";sc=22;rs="4H+1H+15m bull";cf=85;}
  else if(mtf.bearCount===3){s="SHORT";sc=22;rs="4H+1H+15m bear";cf=85;}
  else if(mtf.bullCount===2){s="LONG";sc=12;rs="2/3 TF bull";cf=60;}
  else if(mtf.bearCount===2){s="SHORT";sc=12;rs="2/3 TF bear";cf=60;}
  agents.push(agent("mtf","MTF",s,sc,rs,cf));

  // 8 Pullback
  const retr=(Math.max(...hi.slice(-20))-price)/Math.max(Math.max(...hi.slice(-20))-Math.min(...lo.slice(-20)),1e-12);
  s="NEUTRAL";sc=0;rs="Tidak ada pullback";cf=50;
  if(mtf.trend4h==="bullish"&&retr>=.382&&retr<.618){s="LONG";sc=20;rs="Pullback zona emas 38.2-61.8%";cf=80;}
  else if(mtf.trend4h==="bearish"&&retr>=.382&&retr<.618){s="SHORT";sc=20;rs="Rally zona emas 38.2-61.8%";cf=80;}
  agents.push(agent("pb","Pullback",s,sc,rs,cf));

  const weights=reg.type==="trending"
    ?{wyckoff:1,of:1.3,exh:1,sm:1.5,struct:.8,whale:1.8,mtf:2,pb:1.2}
    :reg.type==="volatile"
    ?{wyckoff:1.5,of:1.5,exh:1.8,sm:1.2,struct:1,whale:1.5,mtf:.8,pb:1.5}
    :{wyckoff:1.2,of:1,exh:1,sm:1.2,struct:1.5,whale:1,mtf:.8,pb:1.2};
  let L=0,S=0,LW=0,SW=0,total=0;
  for(const a of agents){
    a.weight=weights[a.id]||1;
    total+=a.weight;
    if(a.signal==="LONG"){L+=a.score*a.weight;LW+=a.weight;}
    if(a.signal==="SHORT"){S+=a.score*a.weight;SW+=a.weight;}
  }
  const direction=L>S?"LONG":S>L?"SHORT":null;
  if(!direction)return null;
  const win=direction==="LONG"?L:S,opp=direction==="LONG"?S:L,w=direction==="LONG"?LW:SW;
  const consensus=clamp(Math.round(((win-opp*.5)/(120*total))*100),0,100);
  if(consensus<CFG.minConsensus||w<2)return null;
  return {
    symbol,base:symbol.replace("USDT",""),score:consensus,consensus,direction,bias:direction==="LONG"?"bullish":"bearish",
    trend:direction==="LONG"?"up":"down",price,chg24:Number(ticker.priceChangePercent)||0,
    regime:reg,mtf,pullback:{retracement:+(retr*100).toFixed(1)},agents,
    longScore:+L.toFixed(1),shortScore:+S.toFixed(1),rsi:+r.toFixed(1),atr:+atrV,
    rangePosition:+(pos*100).toFixed(1),timestamp:Date.now()
  };
}

async function getCouncilCandidates(){
  const info=await json(BINANCE+"/fapi/v1/exchangeInfo");
  const symbols=(info.symbols||[]).filter(s=>s.contractType==="PERPETUAL"&&s.quoteAsset==="USDT"&&s.status==="TRADING").map(s=>s.symbol);
  const tickers=await json(BINANCE+"/fapi/v1/ticker/24hr");
  const map=new Map((Array.isArray(tickers)?tickers:[]).map(t=>[t.symbol,t]));
  const universe=symbols.filter(s=>map.has(s)&&Number(map.get(s).quoteVolume)>CFG.minVolumeUsdt)
    .sort((a,b)=>Number(map.get(b).quoteVolume)-Number(map.get(a).quoteVolume)).slice(0,CFG.topSymbols);
  const candidates=[];
  for(let i=0;i<universe.length;i+=CFG.requestBatch){
    const batch=universe.slice(i,i+CFG.requestBatch);
    const rows=await Promise.all(batch.map(async symbol=>{
      try{
        const [k5,k15,k1,k4]=await Promise.all(["5m","15m","1h","4h"].map(tf=>
          json(BINANCE+"/fapi/v1/klines?symbol="+symbol+"&interval="+tf+"&limit="+CFG.candleLimit)
            .then(candles).catch(()=>[])));
        if(k5.length<40||k15.length<40||k1.length<40||k4.length<40)return null;
        const result=analyze(symbol,map.get(symbol),{"5m":k5,"15m":k15,"1h":k1,"4h":k4});
        if(result) result._frames={"5m":k5,"15m":k15,"1h":k1,"4h":k4};
        return result;
      }catch(e){return null;}
    }));
    for(const r of rows)if(r)candidates.push(r);
  }

  // Deepen only the council winners. This mirrors the HTML's whale/order-flow
  // layer without multiplying Binance calls across the entire universe.
  candidates.sort((a,b)=>b.consensus-a.consensus);
  const deepTargets=candidates.slice(0,Math.min(8,candidates.length));
  for(const c of deepTargets){
    try{
      const [tp,gp,agg]=await Promise.all([
        json(BINANCE+"/futures/data/topLongShortPositionRatio?symbol="+c.symbol+"&period=5m&limit=1").catch(()=>[]),
        json(BINANCE+"/futures/data/globalLongShortAccountRatio?symbol="+c.symbol+"&period=5m&limit=1").catch(()=>[]),
        json(BINANCE+"/fapi/v1/aggTrades?symbol="+c.symbol+"&limit=100").catch(()=>[])
      ]);
      const top=Array.isArray(tp)&&tp[0]?Number(tp[0].longShortRatio):1;
      const global=Array.isArray(gp)&&gp[0]?Number(gp[0].longShortRatio):1;
      let buy=0,sell=0,buyUsd=0,sellUsd=0;
      for(const x of Array.isArray(agg)?agg:[]){
        const usd=Number(x.p)*Number(x.q);
        if(usd<30000)continue;
        if(x.m===false){buy++;buyUsd+=usd;}else{sell++;sellUsd+=usd;}
      }
      c.deep={topLongShortPositionRatio:top,globalLongShortAccountRatio:global,whale:{buy,sell,buyUsd,sellUsd}};
      // Re-run the same eight-agent council with deep positioning/order-flow
      // evidence. This is the actual final council vote, not a cosmetic field.
      const upgraded=analyze(c.symbol,{lastPrice:c.price,priceChangePercent:c.chg24},c._frames,c.deep);
      if(upgraded){
        Object.assign(c,upgraded);
        c.deepConsensus=upgraded.consensus;
      }
    }catch{}
  }
  candidates.sort((a,b)=>(b.deepConsensus??b.consensus)-(a.deepConsensus??a.consensus));
  for(const c of candidates) delete c._frames;
  return candidates.slice(0,CFG.candidateLimit);
}

module.exports={getCouncilCandidates,analyze,CFG};
