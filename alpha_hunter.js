/**
 * Crypto-Signal Alpha Hunter v3
 * Empirical edge-selection layer using live validation + sample-gated historical evidence.
 *
 * This is a selection model, not a calibrated probability model. Historical evidence
 * is filtered to the active crypto-signal era and is never treated as proof of future
 * returns. Small samples are reported but do not veto a setup.
 */
const clamp=(v,lo,hi)=>Math.min(Math.max(v,lo),hi);
const { calculateTradePlan } = require("./trade_plan");
const n=v=>{const x=Number(v);return Number.isFinite(x)?x:null;};

const HISTORY_AFTER_TS=Date.parse(process.env.ALPHA_HISTORY_AFTER_TS||"2026-09-18T00:00:00Z");
const NON_CRYPTO_BASES=new Set([
  "AAPL","AMZN","AMD","COIN","GOOG","GOOGL","META","MSFT","MSTR","NFLX",
  "NVDA","PLTR","TSLA","SOXL","CRCL","XAU","XAG","DJT","SKHYNIX","CL","MU","CP"
]);

function direction(s){
  const a=String(s?.action||"").toUpperCase();
  return a==="LONG"?1:a==="SHORT"?-1:0;
}
function tfDirection(tf){
  const b=String(tf?.summary?.bias||"").toLowerCase();
  const t=String(tf?.summary?.trend?.direction||"").toLowerCase();
  const e=String(tf?.summary?.trend?.emaStack||tf?.indicators?.ema?.stack||"").toLowerCase();
  const st=String(tf?.indicators?.supertrend?.trend||"").toLowerCase();
  const up=(b==="bullish"?1:0)+(t==="up"?1:0)+(e==="bullish"?1:0)+(st==="up"?1:0);
  const dn=(b==="bearish"?1:0)+(t==="down"?1:0)+(e==="bearish"?1:0)+(st==="down"?1:0);
  return up>dn?1:dn>up?-1:0;
}
function timeframeFeatures(payload){
  const rows=Array.isArray(payload?.timeframes)?payload.timeframes:[];
  const by=new Map(rows.map(x=>[String(x?.interval||"").toLowerCase(),x]));
  return ["15m","1h","4h"].map(k=>({interval:k,tf:by.get(k)||null,direction:tfDirection(by.get(k))}));
}
function closedRows(history){
  return Array.isArray(history?.closed)?history.closed.filter(x=>{
    const base=String(x?.base||"").toUpperCase();
    const ts=n(x?.ts);
    return x&&ts!=null&&ts>=HISTORY_AFTER_TS&&!NON_CRYPTO_BASES.has(base)&&(
      String(x.outcome||"").startsWith("WIN")||x.outcome==="LOSS_SL"
    );
  }):[];
}
function summarize(rows){
  const rs=rows.map(x=>n(x.rMultiple)).filter(Number.isFinite);
  const h15=rows.map(x=>n(x?.horizons?.h15?.r)).filter(Number.isFinite);
  const wins=rows.filter(x=>String(x.outcome||"").startsWith("WIN")).length;
  return {
    sampleSize:rows.length,
    winRate:rows.length?+(wins/rows.length*100).toFixed(1):null,
    avgR:rs.length?+((rs.reduce((a,b)=>a+b,0)/rs.length)).toFixed(2):null,
    avgH15:h15.length?+((h15.reduce((a,b)=>a+b,0)/h15.length)).toFixed(2):null
  };
}
function qualityBucket(score){
  const q=n(score);
  if(q==null)return "unknown";
  if(q<80)return "lt80";
  if(q<90)return "80_89";
  return "90_plus";
}
function empiricalEvidence(history,signal){
  const rows=closedRows(history);
  const action=String(signal?.action||"").toUpperCase();
  const setup=String(signal?.setup||"");
  const base=String(signal?.base||signal?.instId||"").toUpperCase().replace(/USDT$/,"");
  const bucket=qualityBucket(signal?.qualityScore??signal?.probability);
  const actionRows=rows.filter(x=>String(x.action||"").toUpperCase()===action);
  const setupRows=setup?rows.filter(x=>String(x.setup||"")===setup&&String(x.action||"").toUpperCase()===action):[];
  const symbolRows=base?rows.filter(x=>String(x.base||"").toUpperCase()===base&&String(x.action||"").toUpperCase()===action):[];
  const bucketRows=bucket!=="unknown"?rows.filter(x=>qualityBucket(x.probability??x.qualityScore)===bucket&&String(x.action||"").toUpperCase()===action):[];

  // Prefer the most specific stable cohort, then fall back to the action cohort.
  // The thresholds are deliberately conservative to avoid overfitting a tiny symbol sample.
  let sample=actionRows, source="action";
  if(setupRows.length>=12){sample=setupRows;source="setup";}
  else if(symbolRows.length>=8){sample=symbolRows;source="symbol_action";}
  else if(bucketRows.length>=8){sample=bucketRows;source="quality_bucket_action";}

  const minAction=12;
  if(sample.length<minAction){
    return {
      sampleSize:sample.length,winRate:null,avgR:null,avgH15:null,
      source:"insufficient",edge:"insufficient",scoreDelta:0,
      cohort:source,bucket,actionSample:actionRows.length,setupSample:setupRows.length,
      symbolActionSample:symbolRows.length,qualityBucketSample:bucketRows.length
    };
  }

  const s=summarize(sample);
  let scoreDelta=0,edge="neutral";
  if(s.avgR!=null&&s.avgR>0.10&&s.winRate>=52){scoreDelta=6;edge="positive";}
  else if(s.avgR!=null&&s.avgR<-0.10&&s.winRate<48){scoreDelta=-8;edge="negative";}

  // For 15m scalping, early follow-through is a secondary edge signal. It can
  // strengthen a validated setup but never overturns a materially negative R edge.
  let flowDelta=0;
  if(s.avgH15!=null&&s.avgH15>=0.20)flowDelta=3;
  else if(s.avgH15!=null&&s.avgH15<=-0.20)flowDelta=-3;

  return {
    sampleSize:s.sampleSize,winRate:s.winRate,avgR:s.avgR,avgH15:s.avgH15,
    source,edge,scoreDelta:scoreDelta+flowDelta,
    baseScoreDelta:scoreDelta,flowDelta,cohort:source,bucket,
    actionSample:actionRows.length,setupSample:setupRows.length,
    symbolActionSample:symbolRows.length,qualityBucketSample:bucketRows.length
  };
}

function calculateAlpha(signal,technicalPayload,derivativesPayload,now=Date.now(),history=null){
  const side=direction(signal);
  if(!side)return{pass:false,alphaScore:0,reasons:["invalid direction"],factors:{},hardReject:["invalid direction"]};
  const entry=n(signal.entry),sl=n(signal.sl),tp1=n(signal.tp1),tp2=n(signal.tp2),tp3=n(signal.tp3);
  if(![entry,sl,tp1,tp2,tp3].every(Number.isFinite))return{pass:false,alphaScore:0,reasons:["incomplete entry/SL/TP"],factors:{},hardReject:["incomplete entry/SL/TP"]};

  const risk=Math.abs(entry-sl);
  const slPricePct=entry?risk/entry*100:0;
  let plan;
  try { plan=calculateTradePlan({action:signal.action,entry,sl}); }
  catch { return {pass:false,alphaScore:0,reasons:["trade geometry rejected"],factors:{},hardReject:["trade geometry rejected"]}; }
  const leverage=plan.leverage;
  const marginRiskPct=plan.riskMarginPercent;
  const reward1=plan.rewardMarginPcts[0];
  const reward2=plan.rewardMarginPcts[1];
  const reward3=plan.rewardMarginPcts[2];
  const rewardR=[tp1,tp2,tp3].map((p,i)=>Math.abs(p-entry)/(Math.abs(entry-plan.sl)||1));
  const features=timeframeFeatures(technicalPayload);
  const aligned=features.filter(x=>x.direction===side).length;
  const opposing=features.filter(x=>x.direction===-side).length;
  let score=aligned*8-opposing*6;
  const reasons=[];

  if(aligned>=3)reasons.push("MTF 3/3 aligned");
  else if(aligned>=2)reasons.push("MTF 2/3 aligned");
  else reasons.push("MTF alignment weak");

  for(const {interval,tf,direction:td} of features){
    if(!tf)continue;
    const ind=tf.indicators||{};
    const adx=n(ind?.adx?.value??tf?.summary?.trend?.adx);
    const rsi=n(ind?.rsi?.value??tf?.summary?.momentum?.rsi);
    const macd=n(ind?.macd?.histogram??tf?.summary?.momentum?.macdHistogram);
    if(adx!=null)score+=adx>=25?3:adx>=20?1:0;
    if(macd!=null&&((side>0&&macd>0)||(side<0&&macd<0)))score+=2;
    if(rsi!=null&&((side>0&&rsi>=45&&rsi<=68)||(side<0&&rsi>=32&&rsi<=55)))score+=2;
    if(td===side&&adx!=null&&adx>=25)reasons.push(interval+" trend strength");
  }

  const h1=features.find(x=>x.interval==="1h")?.tf;
  const h1Atr=n(h1?.indicators?.atr?.value),live=n(technicalPayload?.price);
  let entryAtrDistance=null;
  if(h1Atr>0&&live!=null){
    entryAtrDistance=Math.abs(live-entry)/h1Atr;
    if(entryAtrDistance<=.5){score+=8;reasons.push("entry close to live price");}
    else if(entryAtrDistance<=1){score+=4;reasons.push("entry within 1 ATR");}
    else if(entryAtrDistance>2){score-=10;reasons.push("entry >2 ATR from live price");}
  }

  if(marginRiskPct<=10)score+=4;else score-=20;
  if(reward1>=30)score+=4;else score-=8;
  if(reward2>=60)score+=4;else score-=6;
  if(reward3>=120)score+=4;else score-=6;
  reasons.push("geometry fixed: 5 USDT / 25x / SL 10% margin / TP 30-60-120% margin");

  const row=derivativesPayload instanceof Map
    ? derivativesPayload.get(String(signal.instId||"").toUpperCase())
    : Array.isArray(derivativesPayload?.data)
      ? derivativesPayload.data.find(x=>String(x?.symbol||"").toUpperCase()===String(signal.instId||"").toUpperCase())
      : null;
  if(row&&!row.error){
    const funding=n(row?.funding?.ratePct),longPct=n(row?.positioning?.globalLongPct);
    const taker=n(row?.positioning?.takerBuySellRatio);
    const oi=String(row?.openInterest?.regime||"").toLowerCase();
    if(side>0&&taker!=null&&taker>=1.05)score+=4;
    if(side<0&&taker!=null&&taker<=.95)score+=4;
    if(side>0&&["new_longs","short_covering"].includes(oi))score+=4;
    if(side<0&&["new_shorts","long_liquidation"].includes(oi))score+=4;
    if(longPct!=null){if(side>0&&longPct>72)score-=5;if(side<0&&longPct<28)score-=5;}
    if(funding!=null){if(side>0&&funding>.05)score-=5;if(side<0&&funding<-.05)score-=5;}
    reasons.push("derivatives confirmed");
  }else{score-=8;reasons.push("derivatives unavailable");}

  const ageMin=Math.max(0,(now-Number(signal.ts||now))/60000);
  if(ageMin<=15)score+=6;else if(ageMin<=30)score+=3;else if(ageMin>90)score-=8;

  const evidence=empiricalEvidence(history,signal);
  score+=evidence.scoreDelta;
  if(evidence.edge==="positive")reasons.push("historical conditional edge positive");
  if(evidence.edge==="negative")reasons.push("historical conditional edge negative");
  if(evidence.flowDelta>0)reasons.push("historical H15 follow-through positive");
  if(evidence.flowDelta<0)reasons.push("historical H15 follow-through weak");
  if(evidence.source==="insufficient")reasons.push("historical evidence insufficient");

  const hardReject=[];
  const geometryTolerance = Math.max(entry * 1e-6, 1e-8);
  if (Math.abs(sl - plan.sl) > geometryTolerance ||
      Math.abs(tp1 - plan.tp1) > geometryTolerance ||
      Math.abs(tp2 - plan.tp2) > geometryTolerance ||
      Math.abs(tp3 - plan.tp3) > geometryTolerance) {
    hardReject.push("signal levels do not match fixed 25x geometry");
  }
  if(aligned<2)hardReject.push("MTF alignment <2/3");
  if(leverage!==25)hardReject.push("leverage is not fixed at 25x");
  if(marginRiskPct>10)hardReject.push("SL risk exceeds 10% of margin");
  if(reward1<30)hardReject.push("TP1 reward below 30% margin");
  if(reward2<60)hardReject.push("TP2 reward below 60% margin");
  if(reward3<120)hardReject.push("TP3 reward below 120% margin");
  if(Math.abs(entry-plan.sl)/entry>0.004000001)hardReject.push("SL exceeds fixed 0.4% price geometry");
  if(entryAtrDistance!=null&&entryAtrDistance>2)hardReject.push("entry chase >2 ATR");
  if(ageMin>120)hardReject.push("signal stale");

  // Materially negative conditional evidence is a veto once the cohort is stable.
  // This is intentionally stricter than the positive-edge gate.
  if(evidence.sampleSize>=20&&evidence.edge==="negative")
    hardReject.push("historical edge negative with >=20 outcomes");

  const alphaScore=clamp(Math.round(50+score),0,99);
  const threshold=Number(process.env.ALPHA_MIN_SCORE||72);
  const pass=hardReject.length===0&&alphaScore>=threshold;
  if(hardReject.length)reasons.push(...hardReject.map(x=>"VETO: "+x));
  return {
    pass,alphaScore,threshold,ageMin:+ageMin.toFixed(1),
    factors:{
      mtfAligned:aligned,mtfOpposing:opposing,
      entryAtrDistance:entryAtrDistance==null?null:+entryAtrDistance.toFixed(3),
      slPricePct:+slPricePct.toFixed(3),leverage,marginRiskPct:+marginRiskPct.toFixed(2),reward1:+reward1.toFixed(2),reward2:+reward2.toFixed(2),reward3:+reward3.toFixed(2),
      historical:evidence
    },
    reasons,hardReject
  };
}
module.exports={calculateAlpha,timeframeFeatures,empiricalEvidence,closedRows,summarize};
