/**
 * Crypto-Signal Alpha Hunter v1
 * Deterministic alpha-selection layer; no statistical probability claims.
 */
const clamp=(v,lo,hi)=>Math.min(Math.max(v,lo),hi);
const n=v=>{const x=Number(v);return Number.isFinite(x)?x:null;};
function direction(s){return String(s?.action||"").toUpperCase()==="LONG"?1:String(s?.action||"").toUpperCase()==="SHORT"?-1:0;}
function tfDirection(tf){
  const b=String(tf?.summary?.bias||"").toLowerCase(),t=String(tf?.summary?.trend?.direction||"").toLowerCase();
  const e=String(tf?.summary?.trend?.emaStack||tf?.indicators?.ema?.stack||"").toLowerCase(),st=String(tf?.indicators?.supertrend?.trend||"").toLowerCase();
  const v=(b==="bullish"||t==="up"||e==="bullish"||st==="up"?1:0)-(b==="bearish"||t==="down"||e==="bearish"||st==="down"?1:0);
  return v>0?1:v<0?-1:0;
}
function timeframeFeatures(payload){
  const rows=Array.isArray(payload?.timeframes)?payload.timeframes:[],by=new Map(rows.map(x=>[String(x?.interval||"").toLowerCase(),x]));
  return ["15m","1h","4h"].map(k=>({interval:k,tf:by.get(k)||null,direction:tfDirection(by.get(k))}));
}
function calculateAlpha(signal,technicalPayload,derivativesPayload,now=Date.now()){
  const side=direction(signal);
  if(!side)return{pass:false,alphaScore:0,reasons:["invalid direction"],factors:{}};
  const entry=n(signal.entry),sl=n(signal.sl),tp1=n(signal.tp1),tp2=n(signal.tp2),tp3=n(signal.tp3);
  if(![entry,sl,tp1,tp2,tp3].every(Number.isFinite))return{pass:false,alphaScore:0,reasons:["incomplete entry/SL/TP"],factors:{}};
  const risk=Math.abs(entry-sl),rr1=risk?Math.abs(tp1-entry)/risk:0,rr2=risk?Math.abs(tp2-entry)/risk:0,rr3=risk?Math.abs(tp3-entry)/risk:0;
  const features=timeframeFeatures(technicalPayload),aligned=features.filter(x=>x.direction===side).length,opposing=features.filter(x=>x.direction===-side).length;
  let score=aligned*8-opposing*6;const reasons=[];
  if(aligned>=3)reasons.push("MTF 3/3 aligned");else if(aligned>=2)reasons.push("MTF 2/3 aligned");else reasons.push("MTF alignment weak");
  for(const {interval,tf,direction:td} of features){
    if(!tf)continue;
    const ind=tf.indicators||{},adx=n(ind?.adx?.value??tf?.summary?.trend?.adx),rsi=n(ind?.rsi?.value??tf?.summary?.momentum?.rsi),macd=n(ind?.macd?.histogram??tf?.summary?.momentum?.macdHistogram);
    if(adx!=null)score+=adx>=25?3:adx>=20?1:0;
    if(macd!=null&&((side>0&&macd>0)||(side<0&&macd<0)))score+=2;
    if(rsi!=null&&((side>0&&rsi>=45&&rsi<=68)||(side<0&&rsi>=32&&rsi<=55)))score+=2;
    if(td===side&&adx!=null&&adx>=25)reasons.push(interval+" trend strength");
  }
  const h1=(Array.isArray(technicalPayload?.timeframes)?technicalPayload.timeframes:[]).find(x=>String(x?.interval).toLowerCase()==="1h");
  const h1Atr=n(h1?.indicators?.atr?.value),live=n(technicalPayload?.price);let entryAtrDistance=null;
  if(h1Atr>0&&live!=null){entryAtrDistance=Math.abs(live-entry)/h1Atr;if(entryAtrDistance<=.5){score+=8;reasons.push("entry close to live price");}else if(entryAtrDistance<=1){score+=4;reasons.push("entry within 1 ATR");}else if(entryAtrDistance>2){score-=10;reasons.push("entry >2 ATR from live price");}}
  if(rr1>=2&&rr1<=6)score+=8;else score-=12;
  if(rr2>=3.5&&rr2<=4.5)score+=4;else score-=4;
  if(rr3>=5&&rr3<=6.5)score+=4;else score-=4;
  reasons.push("R geometry "+rr1.toFixed(2)+"/"+rr2.toFixed(2)+"/"+rr3.toFixed(2));
  const row=derivativesPayload instanceof Map?derivativesPayload.get(String(signal.instId||"").toUpperCase()):Array.isArray(derivativesPayload?.data)?derivativesPayload.data.find(x=>String(x?.symbol||"").toUpperCase()===String(signal.instId||"").toUpperCase()):null;
  if(row&&!row.error){
    const funding=n(row?.funding?.ratePct),longPct=n(row?.positioning?.globalLongPct),taker=n(row?.positioning?.takerBuySellRatio),oi=String(row?.openInterest?.regime||"").toLowerCase();
    if(side>0&&taker!=null&&taker>=1.05)score+=4;if(side<0&&taker!=null&&taker<=.95)score+=4;
    if(side>0&&["new_longs","short_covering"].includes(oi))score+=4;if(side<0&&["new_shorts","long_liquidation"].includes(oi))score+=4;
    if(longPct!=null){if(side>0&&longPct>72)score-=5;if(side<0&&longPct<28)score-=5;}
    if(funding!=null){if(side>0&&funding>.05)score-=5;if(side<0&&funding<-.05)score-=5;}
    reasons.push("derivatives confirmed");
  }else{score-=8;reasons.push("derivatives unavailable");}
  const ageMin=Math.max(0,(now-Number(signal.ts||now))/60000);if(ageMin<=15)score+=6;else if(ageMin<=30)score+=3;else if(ageMin>90)score-=8;
  const hardReject=[];
  if(aligned<2)hardReject.push("MTF alignment <2/3");
  if(rr1<2||rr1>6)hardReject.push("TP1 R:R outside 2R-6R");
  if(rr2<3.5||rr2>4.5)hardReject.push("TP2 not approximately 4R");
  if(rr3<5||rr3>6.5)hardReject.push("TP3 not approximately 6R");
  if(entryAtrDistance!=null&&entryAtrDistance>2)hardReject.push("entry chase >2 ATR");
  if(ageMin>120)hardReject.push("signal stale");
  const alphaScore=clamp(Math.round(50+score),0,99),threshold=Number(process.env.ALPHA_MIN_SCORE||72),pass=hardReject.length===0&&alphaScore>=threshold;
  if(hardReject.length)reasons.push(...hardReject.map(x=>"VETO: "+x));
  return{pass,alphaScore,threshold,ageMin:+ageMin.toFixed(1),factors:{mtfAligned:aligned,mtfOpposing:opposing,entryAtrDistance:entryAtrDistance==null?null:+entryAtrDistance.toFixed(3),rr1:+rr1.toFixed(2),rr2:+rr2.toFixed(2),rr3:+rr3.toFixed(2)},reasons,hardReject};
}
module.exports={calculateAlpha,timeframeFeatures};
