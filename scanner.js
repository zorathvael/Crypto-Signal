/** Crypto-Signal v5.1 — Live Binance scanner + local Qwen intelligence + existing delivery. */
const fs=require("fs"),path=require("path");
const {runLiveScanner}=require("./scanner_engine");
const {scanUniverse}=require("./qwen_ai");
const {sendDiscord,sendTelegram,sendBinanceSquare,sendWatchDiscord}=require("./delivery");
const OUTCOME_FILE=path.join(__dirname,"signals-log.json"),DEDUP_WINDOW_MS=90*60*1000,SIGNAL_VALID_MS=15*60*1000;
function loadOutcomeLog(){try{if(!fs.existsSync(OUTCOME_FILE))return{open:[],closed:[],stats:{}};const r=JSON.parse(fs.readFileSync(OUTCOME_FILE,"utf8"));return{open:Array.isArray(r.open)?r.open:[],closed:Array.isArray(r.closed)?r.closed:[],stats:r.stats&&typeof r.stats==="object"?r.stats:{}};}catch{return{open:[],closed:[],stats:{}};}}
function saveOutcomeLog(log){try{fs.writeFileSync(OUTCOME_FILE,JSON.stringify(log,null,2));}catch(e){console.warn("Outcome log save failed:",e.message);}}
function signalFingerprint(s){const entry=Number(s?.entry),rel=v=>{const n=Number(v);return Number.isFinite(n)&&Number.isFinite(entry)&&entry!==0?((n-entry)/entry*100).toFixed(2):"na";};return[String(s?.base||s?.symbol||"").toUpperCase(),String(s?.action||s?.direction||"").toUpperCase(),String(s?.setup||"").toUpperCase(),rel(s?.sl),rel(s?.tp1),rel(s?.tp2),rel(s?.tp3)].join("|");}
function isDuplicateSignal(log,s,now=Date.now()){const fp=signalFingerprint(s),hit=x=>x&&String(x.base).toUpperCase()===String(s.base).toUpperCase()&&x.action===s.action&&((x.fingerprint&&x.fingerprint===fp)||now-(x.ts||0)<DEDUP_WINDOW_MS);return(log.open||[]).some(hit)||(log.closed||[]).some(hit);}
function filterNewSignals(signals,log){const now=Date.now();return signals.filter(s=>{if(isDuplicateSignal(log,s,now)){console.log("Skip duplicate:",s.base,s.action);return false;}return true;});}
function registerSignals(log,signals){const now=Date.now();for(const s of signals){if(isDuplicateSignal(log,s,now))continue;log.open.push({id:s.base+"_"+s.action+"_"+now,ts:now,base:s.base,instId:s.instId,action:s.action,fingerprint:signalFingerprint(s),setup:s.setup,probability:s.probability,entry:s.entry,sl:s.sl,tp1:s.tp1,tp2:s.tp2,tp3:s.tp3,rr:s.rr,leverage:s.leverage,marginUsdt:s.marginUsdt,validUntil:new Date(now+SIGNAL_VALID_MS).toISOString(),ai:s.ai||null,calibration:s.calibration||null});}return log;}
async function safeDelivery(name,fn){try{await fn();console.log(name+" delivery completed");}catch(e){console.error(name+" delivery error (scanner continues):",e.message);}}
async function main(){
  console.log("=== Crypto-Signal v5.1 | LIVE BINANCE -> BITGET + QWEN3 ===");
  console.log(new Date().toISOString());
  const log=loadOutcomeLog();
  let signals=await runLiveScanner();
  signals=signals.map(s=>({...s,base:s.symbol,instId:s.symbol,action:s.direction,probability:Math.abs(Number(s.strength)||0),rr:1,riskR:1,marginUsdt:5,leverage:20,geometry:"LIVE_BINANCE_CALIBRATED_120C",riskMarginPercent:(Math.abs(s.entry-s.sl)/s.entry)*20*100,m5:{rsi:s.rsi,volume:{side:s.relativeVolume>1.3?"BUY":s.relativeVolume<.7?"SELL":"BALANCED",spike:s.relativeVolume>1.3}}}));
  // Qwen is the active scanner: it scores the entire quantitative universe, not only preselected candidates.
  const ai=await scanUniverse(signals);
  signals=ai.candidates.map(s=>{
    const technicalScore=Math.max(0,Math.min(100,Math.abs(Number(s.strength)||0)));
    const aiScore=Number(s.ai?.score)||0;
    const aiGate=s.ai?.verdict==="VALID" || s.ai?.verdict==="UNAVAILABLE";
    const finalScore=technicalScore;
    return {...s,technicalScore,aiScore,aiGate,probability:finalScore,score:finalScore};
  });
  for(const s of signals)console.log(`Qwen ${s.base}: ${s.ai.verdict} ${s.ai.score}/100 · ${s.ai.reasons.join(" | ")}`);
  signals=signals.filter(s=>s.probability>=90 && s.aiGate);
  console.log("SCORE >= 90:",signals.length);
  signals=filterNewSignals(signals,log);
  console.log("NEW VALID:",signals.length);
  for(const s of signals)console.log(`  ${s.base} [${s.source||"UNKNOWN"}] ${s.action} strength=${s.strength} confidence=${s.confidence}% entry=${s.entry} SL=${s.sl} TP1=${s.tp1} TP2=${s.tp2} TP3=${s.tp3}`);
  const dry=String(process.env.TRADERSPY_DRY_RUN||process.env.SCANNER_DRY_RUN||"false").toLowerCase()==="true";
  if(dry){console.log("Delivery dry-run: no external posts and no outcome registration.");return;}
  await safeDelivery("Discord",()=>sendDiscord(signals));
  await safeDelivery("Telegram",()=>sendTelegram(signals));
  await safeDelivery("Binance Square",()=>sendBinanceSquare(signals));
  if(typeof sendWatchDiscord==="function")await sendWatchDiscord([]);
  saveOutcomeLog(registerSignals(log,signals));
  console.log("Done.");
}
main().catch(e=>{console.error("Scanner failed:",e);process.exit(1);});
