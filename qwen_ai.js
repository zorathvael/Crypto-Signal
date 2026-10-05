/**
 * Qwen3 local intelligence layer.
 * Uses an OpenAI-compatible llama.cpp/Ollama endpoint.
 * The supplied Qwen3-0.6B-Q4_K_M GGUF is intended to be served by llama.cpp.
 */
const BASE=String(process.env.QWEN_BASE_URL||process.env.QWEN_URL||"http://127.0.0.1:11434/v1").replace(/\/$/,"");
const MODEL=process.env.QWEN_MODEL||"default";
const TIMEOUT=Number(process.env.QWEN_TIMEOUT_MS||20000);
const MAX=Number(process.env.QWEN_MAX_CANDIDATES||3);
async function ask(messages){
  const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),TIMEOUT);
  try{
    const r=await fetch(BASE+"/chat/completions",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+(process.env.QWEN_API_KEY||"sk-no-key-required")},body:JSON.stringify({model:MODEL,messages,temperature:.1,max_tokens:420}),signal:ctl.signal});
    if(!r.ok)throw new Error("Qwen HTTP "+r.status);
    const j=await r.json(),text=j?.choices?.[0]?.message?.content||"";
    if(!text)throw new Error("Qwen returned empty response");
    return text;
  }finally{clearTimeout(timer);}
}
function extractJson(text){
  const fenced=text.match(/\`\`\`(?:json)?\s*([\s\S]*?)\s*\`\`\`/i);
  const raw=(fenced?fenced[1]:text).trim();
  const start=raw.indexOf("{"),end=raw.lastIndexOf("}");
  if(start<0||end<=start)throw new Error("Qwen JSON not found");
  return JSON.parse(raw.slice(start,end+1));
}
function buildPrompt(s){
  return [
    {role:"system",content:"You are Qwen, a conservative crypto-futures market-analysis validator. Use ONLY the supplied live Binance metrics. Do not invent price, news, order flow, or indicators. Do not change the deterministic scanner's entry/SL/TP. Return JSON only with verdict (VALID|CAUTION|REJECT), score (0-100), confidence (0-100), reasons (array of max 3 short strings), riskFlags (array)."},
    {role:"user",content:JSON.stringify({symbol:s.symbol,direction:s.direction,strength:s.strength,scannerConfidence:s.confidence,livePrice:s.livePrice,candleClose:s.candleClose,entry:s.entry,sl:s.sl,tp1:s.tp1,tp2:s.tp2,tp3:s.tp3,fillProbability:s.fillP,historicalTp1Reach:s.reachP,rsi:s.rsi,relativeVolume:s.relativeVolume,atr:s.atr,components:s.components,calibration:s.calibration})}
  ];
}
async function validateSignals(signals){
  const out=[];
  for(const s of (signals||[]).slice(0,MAX)){
    try{const j=extractJson(await ask(buildPrompt(s)));out.push({...s,ai:{provider:"Qwen3-local",model:MODEL,verdict:String(j.verdict||"CAUTION").toUpperCase(),score:Number(j.score)||0,confidence:Number(j.confidence)||0,reasons:Array.isArray(j.reasons)?j.reasons.slice(0,3):[],riskFlags:Array.isArray(j.riskFlags)?j.riskFlags.slice(0,5):[]}});}
    catch(e){out.push({...s,ai:{provider:"Qwen3-local",model:MODEL,verdict:"UNAVAILABLE",score:0,confidence:0,reasons:[e.name==="AbortError"?"Qwen timeout":e.message],riskFlags:["AI_UNAVAILABLE"]}});}
  }
  return {candidates:out,available:out.some(x=>x.ai?.verdict!=="UNAVAILABLE")};
}
module.exports={validateSignals,ask,extractJson,BASE,MODEL};
