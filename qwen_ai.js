/**
 * Crypto-Signal Qwen3 AI scanner.
 * Qwen scans/ranks the supplied crypto-futures universe in batches.
 * Quantitative analysis supplies factual market measurements and execution geometry.
 */
const BASE=String(process.env.QWEN_BASE_URL||process.env.QWEN_URL||"http://127.0.0.1:11434/v1").replace(/\/$/,"");
const MODEL=process.env.QWEN_MODEL||"default";
const TIMEOUT=Number(process.env.QWEN_TIMEOUT_MS||45000);
const BATCH_SIZE=Math.max(5,Number(process.env.QWEN_SCAN_BATCH_SIZE||10));
const RETRIES=Math.max(0,Math.min(2,Number(process.env.QWEN_RETRIES||1)));

async function ask(messages,maxTokens=512){
  let lastError;
  for(let attempt=0;attempt<=RETRIES;attempt++){
    const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),TIMEOUT);
    try{
      const r=await fetch(BASE+"/chat/completions",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+(process.env.QWEN_API_KEY||"sk-no-key-required")},
        body:JSON.stringify({model:MODEL,messages,temperature:.1,max_tokens:maxTokens,response_format:{type:"json_object"}}),signal:ctl.signal});
      if(!r.ok)throw new Error("Qwen HTTP "+r.status);
      const j=await r.json(),text=j?.choices?.[0]?.message?.content||"";
      if(!text)throw new Error("Qwen returned empty response");
      return text;
    }catch(e){
      lastError=e;
      if(attempt<RETRIES)await new Promise(r=>setTimeout(r,500));
    }finally{clearTimeout(timer);}
  }
  throw lastError;
}
function extractJson(text){
  const fenced=text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const raw=(fenced?fenced[1]:text).trim();
  const start=raw.indexOf("{"),end=raw.lastIndexOf("}");
  if(start<0||end<=start)throw new Error("Qwen JSON not found");
  return JSON.parse(raw.slice(start,end+1));
}
function compact(s){
  return {symbol:s.symbol,direction:s.direction,strength:s.strength,confidence:s.confidence,rsi:Number(s.rsi?.toFixed?.(2)??s.rsi),rv:Number(s.relativeVolume?.toFixed?.(2)??s.relativeVolume),atr:s.atr,fillP:Number(s.fillP?.toFixed?.(1)??s.fillP),reachP:Number(s.reachP?.toFixed?.(1)??s.reachP),components:s.components};
}
async function scanBatch(batch,index,total){
  const messages=[
    {role:"system",content:"/no_think\nFast market classifier. Do not show reasoning or explanations. Evaluate EVERY symbol using only supplied quantitative metrics. Do not invent data. Do not alter Entry/SL/TP. Return compact JSON only: {scores:[{symbol,score,confidence,verdict}]}. score/confidence 0-100. verdict VALID, CAUTION or REJECT. Include every symbol exactly once."},
    {role:"user",content:JSON.stringify(batch.map(compact))}
  ];
  const parsed=extractJson(await ask(messages,512));
  if(!Array.isArray(parsed.scores))throw new Error("Qwen scores array missing");
  const expected=new Set(batch.map(s=>String(s.symbol||"").toUpperCase()));
  const seen=new Set();
  if(parsed.scores.length!==batch.length)throw new Error("Qwen returned incomplete score set");
  for(const x of parsed.scores){
    const symbol=String(x?.symbol||"").toUpperCase();
    const score=Number(x?.score),confidence=Number(x?.confidence);
    const verdict=String(x?.verdict||"").toUpperCase();
    if(!expected.has(symbol)||seen.has(symbol))throw new Error("Qwen returned invalid/duplicate symbol");
    if(!Number.isFinite(score)||score<0||score>100||!Number.isFinite(confidence)||confidence<0||confidence>100)throw new Error("Qwen returned invalid score/confidence");
    if(!["VALID","CAUTION","REJECT"].includes(verdict))throw new Error("Qwen returned invalid verdict");
    seen.add(symbol);
  }
  if(seen.size!==expected.size)throw new Error("Qwen omitted one or more symbols");
  return parsed.scores;
}
async function scanUniverse(signals){
  const all=signals||[],map=new Map(),errors=[];
  for(let i=0;i<all.length;i+=BATCH_SIZE){
    const batch=all.slice(i,i+BATCH_SIZE);
    try{
      const scores=await scanBatch(batch,Math.floor(i/BATCH_SIZE)+1,Math.ceil(all.length/BATCH_SIZE));
      for(const x of scores){
        const symbol=String(x.symbol||"").toUpperCase();
        if(symbol)map.set(symbol,{provider:"Qwen3-local",model:MODEL,verdict:String(x.verdict||"CAUTION").toUpperCase(),score:Math.max(0,Math.min(100,Number(x.score)||0)),confidence:Math.max(0,Math.min(100,Number(x.confidence)||0)),reasons:Array.isArray(x.reasons)?x.reasons.slice(0,2):[],riskFlags:Array.isArray(x.riskFlags)?x.riskFlags.slice(0,3):[]});
      }
    }catch(e){
      errors.push({batch:Math.floor(i/BATCH_SIZE)+1,error:e.message}); console.warn(`Qwen batch ${Math.floor(i/BATCH_SIZE)+1} unavailable: ${e.message}`);
      for(const s of batch)map.set(s.symbol,{provider:"Qwen3-local",model:MODEL,verdict:"UNAVAILABLE",score:0,confidence:0,reasons:[e.name==="AbortError"?"Qwen timeout":e.message],riskFlags:["AI_UNAVAILABLE"]});
    }
  }
  return {candidates:all.map(s=>({...s,ai:map.get(s.symbol)||{provider:"Qwen3-local",model:MODEL,verdict:"UNAVAILABLE",score:0,confidence:0,reasons:["Qwen did not score symbol"],riskFlags:["AI_NO_SCORE"]}})),available:Array.from(map.values()).some(x=>x.verdict!=="UNAVAILABLE"),errors};
}
module.exports={scanUniverse,ask,extractJson,BASE,MODEL,BATCH_SIZE};
