/**
 * Crypto-Signal v4.1 — empirical calibration engine.
 *
 * Live features are snapshotted before publication and closed outcomes are
 * used as the target variable. Sparse cohorts are shrunk toward the global
 * prior. Legacy records without feature snapshots remain usable through
 * action/setup/quality history; new records progressively unlock
 * trend/order-flow/OI/volatility/timing calibration.
 */
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const finite = (v) => Number.isFinite(Number(v)) ? Number(v) : null;
const win = (row) => String(row?.outcome || "").startsWith("WIN");
const resolved = (row) => win(row) || row?.outcome === "LOSS_SL";

function bucketNumber(value, cuts, labels) {
  const n = finite(value);
  if (n == null) return "unknown";
  for (let i = 0; i < cuts.length; i++) if (n < cuts[i]) return labels[i];
  return labels[labels.length - 1];
}
function qualityBucket(score) { return bucketNumber(score,[80,90,95],["lt80","80_89","90_94","95_plus"]); }
function orderFlowBucket(taker) {
  const n=finite(taker); if(n==null)return "unknown";
  if(n>=1.08)return "buy_pressure"; if(n<=0.92)return "sell_pressure"; return "balanced";
}
function fundingBucket(funding, action) {
  const n=finite(funding); if(n==null)return "unknown";
  const side=String(action||"").toUpperCase();
  if(side==="LONG") return n>0.05?"long_crowded":n<-0.05?"short_crowded":"neutral";
  return n<-0.05?"short_crowded":n>0.05?"long_crowded":"neutral";
}
function crowdingBucket(longPct) {
  const n=finite(longPct); if(n==null)return "unknown";
  if(n>=72)return "long_extreme"; if(n<=28)return "short_extreme"; return "balanced";
}
function trendBucket(aligned, opposing) {
  const a=finite(aligned),o=finite(opposing); if(a==null)return "unknown";
  if(a>=3&&(o==null||o===0))return "aligned_3";
  if(a>=2&&(o==null||o<=1))return "aligned_2";
  return "mixed";
}
function volatilityBucket(atrPct) {
  const n=finite(atrPct); if(n==null)return "unknown";
  if(n<0.35)return "low"; if(n<0.9)return "normal"; if(n<1.8)return "high"; return "extreme";
}
function entryTimingBucket(score,distanceAtr) {
  const s=finite(score),d=finite(distanceAtr);
  if(s!=null){if(s>=90)return "excellent";if(s>=75)return "good";if(s>=60)return "fair";return "weak";}
  if(d!=null)return d<=0.5?"excellent":d<=1?"good":d<=2?"fair":"weak";
  return "unknown";
}

function featureSnapshot(input={}) {
  const signal=input.signal||{}, technical=input.technical||{}, derivatives=input.derivatives||{};
  const tfs=Array.isArray(technical?.timeframes)?technical.timeframes:[];
  const action=String(signal.action||"").toUpperCase();
  const dirs=tfs.map(tf=>{
    const summary=tf?.summary||{},ind=tf?.indicators||{};
    const bias=String(summary.bias||"").toLowerCase();
    const trend=String(summary?.trend?.direction||"").toLowerCase();
    const wanted=action==="LONG"?"bullish":"bearish";
    const dir=(bias===wanted||(wanted==="bullish"&&trend==="up")||(wanted==="bearish"&&trend==="down"))?1:0;
    const opposite=(bias===(wanted==="bullish"?"bearish":"bullish")||(wanted==="bullish"&&trend==="down")||(wanted==="bearish"&&trend==="up"))?1:0;
    return {interval:String(tf.interval||""),dir,opposite};
  });
  const aligned=dirs.reduce((n,x)=>n+x.dir,0), opposing=dirs.reduce((n,x)=>n+x.opposite,0);
  const h1=tfs.find(x=>String(x.interval).toLowerCase()==="1h")||{};
  const atr=finite(h1?.indicators?.atr?.value),price=finite(technical?.price);
  const atrPct=atr!=null&&price>0?atr/price*100:null;
  const row=derivatives?.row||derivatives||{},pos=row?.positioning||{};
  const funding=finite(row?.funding?.ratePct),taker=finite(pos?.takerBuySellRatio),longPct=finite(pos?.globalLongPct);
  return {
    version:1, action, setup:String(signal.setup||"unknown"),
    qualityBucket:qualityBucket(signal.qualityScore??signal.probability),
    trend:trendBucket(aligned,opposing), mtfAligned:aligned, mtfOpposing:opposing,
    orderFlow:orderFlowBucket(taker), funding:fundingBucket(funding,action),
    crowding:crowdingBucket(longPct),
    oiRegime:String(row?.openInterest?.regime||"unknown").toLowerCase(),
    volatility:volatilityBucket(atrPct),
    atrPct:atrPct==null?null:+atrPct.toFixed(4),
    entryTiming:entryTimingBucket(signal.entryCalibrationScore??signal.entryCalibration?.score,
      signal.entryCalibrationDistanceAtr??signal.entryCalibration?.distanceAtr),
    entryDistanceAtr:finite(signal.entryCalibrationDistanceAtr??signal.entryCalibration?.distanceAtr)
  };
}

function outcomeStats(rows) {
  const valid=rows.filter(resolved),n=valid.length,wins=valid.filter(win).length;
  const sumR=valid.reduce((s,r)=>s+(finite(r.rMultiple)??(win(r)?0:-1)),0);
  return {n,wins,losses:n-wins,p:(wins+1)/(n+2),avgR:n?sumR/n:0};
}
function cohortRows(closed,field,value) {
  if(value==null||value==="unknown")return [];
  return closed.filter(r=>r?.calibrationFeatures&&r.calibrationFeatures[field]===value&&resolved(r));
}
function buildCohort(closed,field,value,minN=8) {
  const rows=cohortRows(closed,field,value); return rows.length<minN?null:{field,value,...outcomeStats(rows)};
}
function globalStats(closed){return outcomeStats(closed);}

function calibrateSignal(history,snapshot,rawScore=50) {
  const all=Array.isArray(history?.closed)?history.closed.filter(r=>{
    const ts=finite(r.ts); return resolved(r)&&(ts==null||ts>=Date.parse("2026-09-18T00:00:00Z"));
  }):[];
  const global=globalStats(all);
  const cohorts=[
    [global,1], [buildCohort(all,"action",snapshot?.action),3],
    [buildCohort(all,"setup",snapshot?.setup),2], [buildCohort(all,"trend",snapshot?.trend),2],
    [buildCohort(all,"orderFlow",snapshot?.orderFlow),2], [buildCohort(all,"oiRegime",snapshot?.oiRegime),1.5],
    [buildCohort(all,"volatility",snapshot?.volatility),1.5],
    [buildCohort(all,"entryTiming",snapshot?.entryTiming),2],
    [buildCohort(all,"qualityBucket",snapshot?.qualityBucket),1]
  ];
  let weightedP=0,weightedR=0,weight=0;
  for(const [c,w] of cohorts){if(!c)continue;const reliability=clamp(c.n/30,0.25,1),ww=w*reliability;weightedP+=c.p*ww;weightedR+=c.avgR*ww;weight+=ww;}
  const p=weight?weightedP/weight:0.5,avgR=weight?weightedR/weight:0;
  const score=clamp(Math.round(p*100),1,99),raw=finite(rawScore)??50;
  const rawRank=clamp((raw-50)/50,-1,1);
  const rankingScore=clamp(Math.round(score+clamp(avgR*4,-8,8)+rawRank*4),1,99);
  return {
    probability:score,rankingScore,expectedR:+avgR.toFixed(3),sampleSize:global.n,
    effectiveSampleSize:+weight.toFixed(2),
    confidence:clamp(Math.round(35+Math.min(global.n,100)*0.55),35,90),
    source:weight?"empirical_hierarchical":"cold_start",rawScore:raw,
    cohorts:{
      global:global.n,action:cohorts[1][0]?.n||0,setup:cohorts[2][0]?.n||0,
      trend:cohorts[3][0]?.n||0,orderFlow:cohorts[4][0]?.n||0,oi:cohorts[5][0]?.n||0,
      volatility:cohorts[6][0]?.n||0,timing:cohorts[7][0]?.n||0,quality:cohorts[8][0]?.n||0
    }
  };
}
function summarizeCalibration(history={}) {
  const closed=Array.isArray(history.closed)?history.closed.filter(resolved):[];
  return {resolved:closed.length,withFeatureSnapshots:closed.filter(x=>x.calibrationFeatures).length,global:outcomeStats(closed)};
}
module.exports={featureSnapshot,calibrateSignal,summarizeCalibration,outcomeStats,qualityBucket,orderFlowBucket,fundingBucket,crowdingBucket,volatilityBucket,trendBucket,entryTimingBucket};
