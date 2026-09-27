/**
 * Entry calibration is deliberately independent from margin risk/reward.
 * It decides only the executable entry anchor.
 */
function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function calibrateEntry(input = {}) {
  const action = String(input.action || "").toUpperCase();
  if (action !== "LONG" && action !== "SHORT") return { pass:false, entry:null, score:0, reasons:["invalid direction"] };
  const livePrice=finitePositive(input.livePrice), technicalPrice=finitePositive(input.technicalPrice), atr=finitePositive(input.atr);
  if (!livePrice || !technicalPrice || !atr) return { pass:false, entry:null, score:0, reasons:["entry calibration data unavailable"] };
  const supports=Array.isArray(input.supports)?input.supports.map(finitePositive).filter(Boolean).sort((a,b)=>b-a):[];
  const resistances=Array.isArray(input.resistances)?input.resistances.map(finitePositive).filter(Boolean).sort((a,b)=>a-b):[];
  const distanceAtr=Math.abs(technicalPrice-livePrice)/atr;
  if(distanceAtr>1.5) return {pass:false,entry:technicalPrice,score:0,distanceAtr:+distanceAtr.toFixed(3),mode:"REJECT_CHASE",reasons:["technical entry >1.5 ATR from live price"]};
  let entry=technicalPrice, mode="TECHNICAL_ANCHOR"; const reasons=[];
  if(action==="LONG"){
    const support=supports.find(x=>x<=livePrice&&livePrice-x<=atr*0.75);
    if(support!=null&&distanceAtr<=0.75){
      const calibrated=support+Math.min(atr*0.10,(livePrice-support)*0.35);
      if(calibrated>0&&calibrated<=livePrice*1.0025){entry=Math.min(livePrice,calibrated);mode="SUPPORT_CALIBRATED";reasons.push("entry anchored to nearby support");}
    }
  }else{
    const resistance=resistances.find(x=>x>=livePrice&&x-livePrice<=atr*0.75);
    if(resistance!=null&&distanceAtr<=0.75){
      const calibrated=resistance-Math.min(atr*0.10,(resistance-livePrice)*0.35);
      if(calibrated>0&&calibrated>=livePrice*0.9975){entry=Math.max(livePrice,calibrated);mode="RESISTANCE_CALIBRATED";reasons.push("entry anchored to nearby resistance");}
    }
  }
  const finalDistanceAtr=Math.abs(entry-livePrice)/atr;
  let score=60;
  if(finalDistanceAtr<=0.25){score+=20;reasons.push("entry within 0.25 ATR of live price");}
  else if(finalDistanceAtr<=0.5){score+=12;reasons.push("entry within 0.5 ATR of live price");}
  else if(finalDistanceAtr<=1){score+=5;reasons.push("entry within 1 ATR of live price");}
  else {score-=10;reasons.push("entry >1 ATR from live price");}
  if(mode!=="TECHNICAL_ANCHOR")score+=8;
  score=Math.max(0,Math.min(99,Math.round(score)));
  return {pass:score>=60,entry:+entry,score,mode,distanceAtr:+finalDistanceAtr.toFixed(3),reasons};
}
module.exports={calibrateEntry};
