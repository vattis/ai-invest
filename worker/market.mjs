import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {supabase} from '../lib/supabase.mjs';
import {validateJob} from './jobs.mjs';
import {marketTime,fetchUs,KisClient} from './quotes.mjs';
import {initialState,applyPair,view} from './paper.mjs';

const root=path.resolve(process.env.WORKER_ROOT??'.runtime'),stateFile=path.join(root,'paper-state.json');
const universe=JSON.parse(await fs.readFile(new URL('../config/universe.json',import.meta.url),'utf8'));
for(const [market,pattern] of [['kr',/^\d{6}$/],['us',/^[A-Z.]{1,8}$/]]){
  if(universe[market]?.length!==20||new Set(universe[market]).size!==20||universe[market].some(x=>!pattern.test(x)))throw new Error(`${market} 종목은 중복 없이 정확히 20개여야 합니다.`);
}
for(const dir of ['pending','active','archive','ids','results'])await fs.mkdir(path.join(root,dir),{recursive:true});
const api=supabase(process.env,fetch,true),kis=new KisClient();
let state=await fs.readFile(stateFile,'utf8').then(JSON.parse,()=>initialState()),stopping=false;
const lock=path.join(root,'market.lock');
try{
  const pid=Number(await fs.readFile(lock,'utf8'));
  if(Number.isInteger(pid)&&pid>0){try{process.kill(pid,0);throw new Error('이미 실행 중인 시세 수집기가 있습니다.');}catch(e){if(e.message.startsWith('이미 실행')||e.code==='EPERM')throw e;}}
  await fs.unlink(lock);
}catch(e){if(e.code!=='ENOENT')throw e;}
await fs.writeFile(lock,String(process.pid),{flag:'wx',mode:0o600});
async function save(){const temp=`${stateFile}.${randomUUID()}.tmp`;await fs.writeFile(temp,JSON.stringify(state),{mode:0o600});await fs.rename(temp,stateFile);}
async function enqueue(job){
  validateJob(job);const idFile=path.join(root,'ids',job.id);
  try{await fs.writeFile(idFile,'reserved',{flag:'wx',mode:0o600});}catch(e){if(e.code==='EEXIST')return false;throw e;}
  const file=path.join(root,'pending',`${job.id}.json`),tmp=`${file}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp,JSON.stringify(job),{mode:0o600});await fs.rename(tmp,file);return true;
}
async function proposals(){
  const byJob=new Map();
  for(const folder of await fs.readdir(path.join(root,'results'))){
    const file=path.join(root,'results',folder,'validated-proposal.json');
    let p;try{p=JSON.parse(await fs.readFile(file,'utf8'));}catch{continue;}
    if(p.cohort==='feedback'){
      if(!state.processedFeedback.includes(p.run_id)){
        const market=p.job_id.startsWith('kr-')?'kr':'us';state.lessons[market]=p.decision.lessons.slice(0,5);state.processedFeedback.push(p.run_id);
      }
      continue;
    }
    if(!byJob.has(p.job_id))byJob.set(p.job_id,{});byJob.get(p.job_id)[p.cohort]=p;
  }
  return byJob;
}
async function sync(){
  const accounts=Object.entries(state.accounts).flatMap(([market,cohorts])=>['A','B'].map(cohort=>({market,cohort,...view(cohorts[cohort],state.quotes[market]),updated_at:new Date().toISOString()})));
  for(const account of accounts)await api('/rest/v1/paper_accounts?on_conflict=market,cohort',{method:'POST',headers:{Prefer:'resolution=merge-duplicates'},body:account});
  for(const trade of state.trades.filter(x=>!state.syncedTrades?.includes(x.id))){
    await api('/rest/v1/paper_trades?on_conflict=id',{method:'POST',headers:{Prefer:'resolution=merge-duplicates'},body:trade});
    (state.syncedTrades??=[]).push(trade.id);await save();
  }
}
async function tick(market){
  const clock=marketTime(market),daily=state.daily[market];
  if(daily.day!==clock.day)Object.assign(daily,{day:clock.day,rounds:0,feedbackQueued:false,lastBucket:null});
  if(clock.open){
    const quotes=market==='kr'?await kis.fetch(universe.kr):await fetchUs(universe.us);
    // Partial data never creates a new decision. Existing quotes may still mark positions.
    state.quotes[market]={...state.quotes[market],...quotes};
    const snapshot={as_of:new Date().toISOString(),symbols:universe[market],data:universe[market].map(symbol=>({symbol,...quotes[symbol]})),recent:state.recent[market].slice(-11)};
    state.recent[market].push({as_of:snapshot.as_of,prices:Object.fromEntries(Object.entries(quotes).map(([s,q])=>[s,q.price]))});
    state.recent[market]=state.recent[market].slice(-12);
    const pairs=await proposals();for(const [id,pair] of pairs)if(id.startsWith(`${market}-trade-`))applyPair(state,market,id,pair,quotes,Date.now(),{feeRate:Number(process.env.PAPER_FEE_RATE??0.0005),slippage:Number(process.env.PAPER_SLIPPAGE??0.0005)});
    const bucket=Math.floor(clock.minute/15),maxRounds=Math.min(26,Math.max(1,Number(process.env.MAX_ROUNDS_PER_DAY)||20));
    const slot=bucket-(market==='kr'?36:38);
    const scheduled=Math.floor((slot+1)*maxRounds/26)>Math.floor(slot*maxRounds/26);
    if(Object.keys(quotes).length===20&&daily.rounds<maxRounds&&bucket!==daily.lastBucket&&scheduled){
      const id=`${market}-trade-${clock.day}-${bucket}`;
      const job={id,task_key:`${market}_trade`,expires_at:new Date(Date.now()+12*60000).toISOString(),snapshot,
        portfolios:{A:view(state.accounts[market].A,state.quotes[market]),B:view(state.accounts[market].B,state.quotes[market])},feedback:state.lessons[market]};
      if(await enqueue(job)){daily.rounds++;daily.lastBucket=bucket;}
    }
  }else if(clock.closed&&!daily.feedbackQueued&&state.recent[market].length&&marketTime(market,new Date(state.recent[market].at(-1).as_of)).day===clock.day){
    const id=`${market}-feedback-${clock.day}`;
    const job={id,task_key:`${market}_feedback`,expires_at:new Date(Date.now()+3600000).toISOString(),
      snapshot:{as_of:new Date().toISOString(),symbols:universe[market],data:state.recent[market].at(-1),recent:state.recent[market]},
      history:state.trades.filter(t=>t.market===market&&marketTime(market,new Date(t.as_of)).day===clock.day).slice(-100),feedback:state.lessons[market]};
    if(await enqueue(job))daily.feedbackQueued=true;
  }
  await save();await sync();
}
process.on('SIGINT',()=>stopping=true);process.on('SIGTERM',()=>stopping=true);
console.log('시세·가상 체결기 시작. 실주문 기능 없음.');
try{
  while(!stopping){
    for(const market of ['kr','us']){
      try{await tick(market);}catch(e){console.error(`${market} 시세/동기화 실패: ${e.message}`);}
    }
    await new Promise(r=>setTimeout(r,Math.max(30,Number(process.env.MARKET_POLL_SECONDS)||60)*1000));
  }
}finally{await fs.unlink(lock).catch(()=>{});}
