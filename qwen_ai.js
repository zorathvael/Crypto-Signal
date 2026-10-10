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
const GEMINI_MODEL=process.env.GEMINI_MODEL||"gemini-3.5-flash-lite";
const GEMINI_TIMEOUT=Number(process.env.GEMINI_TIMEOUT_MS||12000);

async function ask(messages,maxTokens=512){
  let lastError;
  for(let attempt=0;attempt<=RETRIES;attempt++){
    const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),TIMEOUT);
    try{
      const r=await fetch(BASE+"/chat/completions",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+(process.env.QWEN_API_KEY||"sk-no-key-required")},
        body:JSON.stringify({model:MODEL,messages,temperature:.1,max_tokens:maxTokens}),signal:ctl.signal});
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
function validateScores(parsed,batch,provider,model){
  if(!Array.isArray(parsed.scores))throw new Error(provider+" scores array missing");
  const expected=new Set(batch.map(s=>String(s.symbol||"").toUpperCase()));
  const seen=new Set();
  if(parsed.scores.length!==batch.length)throw new Error(provider+" returned incomplete score set");
  for(const x of parsed.scores){
    const symbol=String(x?.symbol||"").toUpperCase();
    const score=Number(x?.score),confidence=Number(x?.confidence);
    const verdict=String(x?.verdict||"").toUpperCase();
    if(!expected.has(symbol)||seen.has(symbol))throw new Error(provider+" returned invalid/duplicate symbol");
    if(!Number.isFinite(score)||score<0||score>100||!Number.isFinite(confidence)||confidence<0||confidence>100)throw new Error(provider+" returned invalid score/confidence");
    if(!["VALID","CAUTION","REJECT"].includes(verdict))throw new Error(provider+" returned invalid verdict");
    seen.add(symbol);
  }
  if(seen.size!==expected.size)throw new Error(provider+" omitted one or more symbols");
  return parsed.scores;
}
async function scanBatch(batch,index,total){
  const messages=[
    {role:"system",content:"/no_think\\nFast market classifier. Do not show reasoning or explanations. Evaluate EVERY symbol using only supplied quantitative metrics. Do not invent data. Do not alter Entry/SL/TP. Return compact JSON only: {scores:[{symbol,score,confidence,verdict}]}. score/confidence 0-100. verdict VALID, CAUTION or REJECT. Include every symbol exactly once."},
    {role:"user",content:JSON.stringify(batch.map(compact))}
  ];
  const parsed=extractJson(await ask(messages,512));
  return validateScores(parsed,batch,"Qwen3",MODEL);
}
async function askGemini(batch){
  const apiKey=process.env.GEMINI_API_KEY;
  if(!apiKey)throw new Error("Gemini API key missing");
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),GEMINI_TIMEOUT);
  const prompt=[
    "You are a backup market classifier. Use only the quantitative metrics provided; do not invent market data or change entry, stop-loss, or take-profit levels.",
    "Evaluate every symbol. Return JSON only: {scores:[{symbol,score,confidence,verdict}]}. score/confidence must be 0-100. verdict must be VALID, CAUTION, or REJECT. Include every symbol exactly once.",
    JSON.stringify(batch.map(compact))
  ].join("\\n\\n");
  try{
    const r=await fetch("https://generativelanguage.googleapis.com/v1beta/models/"+encodeURIComponent(GEMINI_MODEL)+":generateContent",{
      method:"POST",
      headers:{"Content-Type":"application/json","x-goog-api-key":apiKey},
      body:JSON.stringify({contents:[{role:"user",parts:[{text:prompt}]}],generationConfig:{temperature:0.1,maxOutputTokens:512,responseMimeType:"application/json"}}),
      signal:controller.signal
    });
    if(!r.ok){
      // In particular, do not retry 429: daily quota may be exhausted. The scanner
      // will mark AI unavailable and preserve deterministic scoring instead.
      throw new Error("Gemini HTTP "+r.status);
    }
    const j=await r.json();
    const text=j?.candidates?.[0]?.content?.parts?.map(p=>p.text||"").join("")||"";
    if(!text)throw new Error("Gemini returned empty response");
    return validateScores(extractJson(text),batch,"Gemini",GEMINI_MODEL);
  }finally{clearTimeout(timer);}
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
      errors.push({batch:Math.floor(i/BATCH_SIZE)+1,error:"Qwen: "+e.message});
      console.warn(`Qwen batch ${Math.floor(i/BATCH_SIZE)+1} unavailable: ${e.message}`);
      try{
        const scores=await askGemini(batch);
        for(const x of scores){
          const symbol=String(x.symbol||"").toUpperCase();
          map.set(symbol,{provider:"Gemini",model:GEMINI_MODEL,verdict:String(x.verdict||"CAUTION").toUpperCase(),score:Math.max(0,Math.min(100,Number(x.score)||0)),confidence:Math.max(0,Math.min(100,Number(x.confidence)||0)),reasons:["Backup classifier after local Qwen failure"],riskFlags:[]});
        }
        console.log(`Gemini fallback batch ${Math.floor(i/BATCH_SIZE)+1} succeeded`);
      }catch(geminiError){
        errors.push({batch:Math.floor(i/BATCH_SIZE)+1,error:"Gemini: "+geminiError.message});
        console.warn(`Gemini fallback unavailable for batch ${Math.floor(i/BATCH_SIZE)+1}: ${geminiError.message}`);
        for(const s of batch)map.set(s.symbol,{provider:"Qwen3-local",model:MODEL,verdict:"UNAVAILABLE",score:0,confidence:0,reasons:[e.name==="AbortError"?"Qwen timeout":e.message,"Gemini fallback: "+geminiError.message],riskFlags:["AI_UNAVAILABLE"]});
      }
    }
  }
  return {candidates:all.map(s=>({...s,ai:map.get(s.symbol)||{provider:"Qwen3-local",model:MODEL,verdict:"UNAVAILABLE",score:0,confidence:0,reasons:["Qwen did not score symbol"],riskFlags:["AI_NO_SCORE"]}})),available:Array.from(map.values()).some(x=>x.verdict!=="UNAVAILABLE"),errors};
}
module.exports={scanUniverse,ask,askGemini,extractJson,BASE,MODEL,BATCH_SIZE,GEMINI_MODEL};
