#!/usr/bin/env node
/*
 * Entry Outcome Research
 * Measures actual price path after scanner entry using Bitget 1m futures candles.
 */
const fs=require("fs");
const path=require("path");

const BASE=String(process.env.BITGET_API_BASE||"https://api.bitget.com").replace(/\/$/,"");
const PRODUCT="USDT-FUTURES";
const LOG=path.join(__dirname,"signals-log.json");
const MAX_SIGNALS=Math.max(1,Number(process.env.RESEARCH_MAX_SIGNALS||100));

async function getCandles(symbol,startTime,endTime){
  const out=[];
  let end=Number(endTime);
  const start=Number(startTime);
  while(end>start){
    const u=new URL(BASE+"/api/v2/mix/market/history-candles");
    u.searchParams.set("symbol",symbol);
    u.searchParams.set("productType",PRODUCT);
    u.searchParams.set("granularity","1m");
    u.searchParams.set("startTime",String(start));
    u.searchParams.set("endTime",String(end));
    u.searchParams.set("limit","200");
    const r=await fetch(u,{headers:{Accept:"application/json","User-Agent":"Crypto-Signal/entry-research"}});
    if(!r.ok)throw new Error(`Bitget HTTP ${r.status}`);
    const j=await r.json();
    const rows=Array.isArray(j.data)?j.data:[];
    if(!rows.length)break;
    for(const row of rows){
      const ts=Number(row[0]);
      if(ts>=start && ts<=Number(endTime)) out.push({
        ts,open:Number(row[1]),high:Number(row[2]),low:Number(row[3]),close:Number(row[4])
      });
    }
    const oldest=Math.min(...rows.map(x=>Number(x[0])));
    if(!Number.isFinite(oldest)||oldest>=end)break;
    end=oldest-1;
    if(rows.length<2)break;
    await new Promise(r=>setTimeout(r,60));
  }
  const seen=new Set();
  return out.filter(x=>!seen.has(x.ts)&&seen.add(x.ts)).sort((a,b)=>a.ts-b.ts);
}

function favorablePct(s,p){
  return s.action==="LONG" ? ((p-s.entry)/s.entry)*100 : ((s.entry-p)/s.entry)*100;
}
function adversePct(s,p){
  return s.action==="LONG" ? ((p-s.entry)/s.entry)*100 : ((s.entry-p)/s.entry)*100;
}

(async()=>{
  const log=JSON.parse(fs.readFileSync(LOG,"utf8"));
  const closed=(log.closed||[]).filter(x=>x.outcome==="LOSS_SL" && x.entry && x.sl && x.tp1 && x.ts && x.closedAt)
    .sort((a,b)=>b.closedAt-a.closedAt).slice(0,MAX_SIGNALS);
  const results=[];
  for(const s of closed){
    try{
      const candles=await getCandles(s.instId||s.base+"USDT",s.ts,s.closedAt+60000);
      let entryIdx=-1,slIdx=-1,tp1Idx=-1;
      for(let i=0;i<candles.length;i++){
        const c=candles[i];
        const entryHit=s.action==="LONG"?c.high>=s.entry:c.low<=s.entry;
        if(entryIdx<0 && entryHit) entryIdx=i;
        if(entryIdx>=0){
          const slHit=s.action==="LONG"?c.low<=s.sl:c.high>=s.sl;
          const tpHit=s.action==="LONG"?c.high>=s.tp1:c.low<=s.tp1;
          if(slIdx<0 && slHit) slIdx=i;
          if(tp1Idx<0 && tpHit) tp1Idx=i;
          if(slIdx>=0||tp1Idx>=0)break;
        }
      }
      if(entryIdx<0){results.push({id:s.id,status:"ENTRY_NOT_FOUND"});continue;}
      const terminal=Math.min(
        slIdx>=0?slIdx:candles.length-1,
        tp1Idx>=0?tp1Idx:candles.length-1
      );
      const path=candles.slice(entryIdx,terminal+1);
      const mfe=Math.max(0,...path.map(c=>favorablePct(s,c.high)),...path.map(c=>favorablePct(s,c.low)));
      const beforeSl=slIdx>=0?candles.slice(entryIdx,slIdx+1):path;
      const mfeBeforeSl=Math.max(0,...beforeSl.map(c=>favorablePct(s,c.high)),...beforeSl.map(c=>favorablePct(s,c.low)));
      const slBeforeTp1=slIdx>=0 && (tp1Idx<0 || slIdx<tp1Idx);
      const firstAfterEntry=path[0];
      const sameCandleAmbiguous=entryIdx===slIdx;
      const directSl=!sameCandleAmbiguous && slBeforeTp1 && mfeBeforeSl<=1e-9;
      results.push({
        id:s.id,base:s.base,action:s.action,entry:s.entry,sl:s.sl,tp1:s.tp1,
        entryCandleAt:candles[entryIdx].ts,slCandleAt:slIdx>=0?candles[slIdx].ts:null,
        tp1CandleAt:tp1Idx>=0?candles[tp1Idx].ts:null,
        mfeBeforeSlPct:Number(mfeBeforeSl.toFixed(4)),
        slBeforeTp1, directSl,sameCandleAmbiguous
      });
    }catch(e){results.push({id:s.id,status:"ERROR",error:String(e.message||e)});}
  }
  const measured=results.filter(x=>x.slBeforeTp1);
  const direct=measured.filter(x=>x.directSl);
  const ambiguous=measured.filter(x=>x.sameCandleAmbiguous);
  const withPriorRise=measured.filter(x=>x.mfeBeforeSlPct>0);
  const summary={
    generatedAt:new Date().toISOString(),
    source:"Bitget USDT-FUTURES 1m historical candles",
    sampleLossSL:closed.length,
    measuredSLBeforeTP1:measured.length,
    slBeforeTp1Pct:measured.length?Number((measured.length/closed.length*100).toFixed(2)):null,
    priorRiseBeforeSL:withPriorRise.length,
    priorRiseBeforeSLPct:measured.length?Number((withPriorRise.length/measured.length*100).toFixed(2)):null,
    directSLNoPriorRise:direct.length,
    directSLNoPriorRisePct:measured.length?Number((direct.length/measured.length*100).toFixed(2)):null,
    sameCandleAmbiguous:ambiguous.length,
    errors:results.filter(x=>x.status==="ERROR").length,
    entryNotFound:results.filter(x=>x.status==="ENTRY_NOT_FOUND").length
  };
  fs.writeFileSync(path.join(__dirname,"entry-outcome-research.json"),JSON.stringify({summary,results},null,2));
  console.log("ENTRY OUTCOME RESEARCH");
  console.log(JSON.stringify(summary,null,2));
})();
