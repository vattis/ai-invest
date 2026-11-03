import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { supabase } from '../lib/supabase.mjs';
import { supported } from '../lib/domain.mjs';
import { readAccount, runDecision } from './codex.mjs';
import { validateJob, makePrompt, validateDecision } from './jobs.mjs';

const root=path.resolve(process.env.WORKER_ROOT??'.runtime');
const dirs=Object.fromEntries(['pending','active','archive','outbox','results','ids'].map(k=>[k,path.join(root,k)]));
await Promise.all(Object.values(dirs).map(p=>fs.mkdir(p,{recursive:true})));
async function atomic(file,value){const temp=`${file}.${randomUUID()}.tmp`;await fs.writeFile(temp,JSON.stringify(value,null,2),{mode:0o600});await fs.rename(temp,file);}
async function exists(file){return fs.access(file).then(()=>true,()=>false);}

if(process.argv[2]==='enqueue'){
  if(!process.argv[3])throw new Error('사용법: npm run worker -- enqueue path/to/job.json');
  const job=validateJob(JSON.parse(await fs.readFile(process.argv[3],'utf8')));
  for(const d of ['pending','active','archive'])if(await exists(path.join(dirs[d],`${job.id}.json`)))throw new Error('이미 등록한 작업 ID입니다.');
  // Reserve the ID exclusively; publish a complete file atomically to the consumer.
  await fs.writeFile(path.join(dirs.ids,job.id),'reserved',{flag:'wx',mode:0o600});
  await atomic(path.join(dirs.pending,`${job.id}.json`),job);
  console.log(`작업 등록: ${job.id}`);
  process.exit(0);
}

const api=supabase(process.env,fetch,true);
const lockFile=path.join(root,'worker.lock');
if(await exists(lockFile)){
  const pid=Number(await fs.readFile(lockFile,'utf8'));let alive=false;
  if(Number.isInteger(pid)&&pid>0){try{process.kill(pid,0);alive=true;}catch(e){if(e.code==='EPERM')alive=true;}}
  if(alive)throw new Error('이미 실행 중인 worker가 있습니다.');
  await fs.unlink(lockFile);
}
await fs.writeFile(lockFile,String(process.pid),{flag:'wx',mode:0o600});
let stopping=false,heartbeatBusy=false,lastAccount=0,currentJob=null,settings=[],models=[],modelsAt=null,limits=null,limitsAt=null,lastError=null;
const workerId=process.env.WORKER_ID??'home-pc';
const poll=Math.max(5,Number(process.env.WORKER_POLL_SECONDS)||10)*1000;
let outboxQueue=Promise.resolve();
function withOutbox(operation){const next=outboxQueue.then(operation);outboxQueue=next.catch(()=>{});return next;}
async function record(run){return withOutbox(()=>atomic(path.join(dirs.outbox,`${run.id}.json`),run));}
async function flush(){return withOutbox(async()=>{
  for(const name of await fs.readdir(dirs.outbox)){
    if(!name.endsWith('.json'))continue;
    const file=path.join(dirs.outbox,name);const raw=await fs.readFile(file,'utf8');
    await api('/rest/v1/task_runs?on_conflict=id',{method:'POST',body:JSON.parse(raw),headers:{Prefer:'resolution=merge-duplicates'}});
    if(await fs.readFile(file,'utf8').catch(()=>null)===raw)await fs.unlink(file);
  }
});}
async function heartbeat(){
  if(heartbeatBusy)return;heartbeatBusy=true;
  try{
    settings=await api('/rest/v1/task_settings?select=*');
    if(Date.now()-lastAccount>60000){
      lastAccount=Date.now();
      try{const a=await readAccount();models=a.models;modelsAt=new Date().toISOString();limits=a.rate_limits;limitsAt=modelsAt;lastError=null;}
      catch{lastError='Codex 계정 정보를 확인하지 못했습니다. PC에서 codex login status를 확인하세요.';}
    }
    await flush();
    await api('/rest/v1/worker_status?on_conflict=worker_id',{method:'POST',headers:{Prefer:'resolution=merge-duplicates'},body:{
      worker_id:workerId,updated_at:new Date().toISOString(),settings_versions:Object.fromEntries(settings.map(s=>[s.task_key,s.version])),
      models,models_at:modelsAt,rate_limits:limits,rate_limits_at:limitsAt,state:currentJob?'running':'idle',current_job:currentJob,error:lastError
    }});
  }catch{console.error('제어 서버 동기화 실패. 결과는 로컬 outbox에 보관됩니다.');}
  finally{heartbeatBusy=false;}
}
const schema=fileURLToPath(new URL('./decision-schema.json',import.meta.url));
async function execute(job,config,cohort){
  const id=randomUUID(),cwd=path.join(dirs.results,id);await fs.mkdir(cwd,{recursive:true});
  const output=path.join(cwd,'decision.json'), started=Date.now();
  let run={id,job_id:job.id,task_key:job.task_key,cohort,config_version:config.version,model:config.model,effort:config.effort,
    status:'running',created_at:new Date().toISOString(),input_tokens:null,cached_input_tokens:null,output_tokens:null,
    reasoning_output_tokens:null,total_tokens:null,duration_ms:null,error:null,finished_at:null};
  await atomic(path.join(cwd,'run.json'),run);await record(run);
  try{
    const timeout=Math.min(Math.max(1000,(Number(process.env.CODEX_TIMEOUT_SECONDS)||120)*1000),Date.parse(job.expires_at)-Date.now());
    if(timeout<=0)throw new Error('expired');
    const prompt=makePrompt(job,cohort);
    await fs.writeFile(path.join(cwd,'input.txt'),prompt,{mode:0o600});
    const result=await runDecision({prompt,model:config.model,effort:config.effort,schema,output,cwd,timeoutMs:timeout});
    Object.assign(run,result.usage);
    if(result.timedOut){run.status='timed_out';run.error='판단 유효시간을 초과했습니다.';}
    else if(!result.ok){run.status='failed';run.error='Codex 실행 실패. 로그인·사용량·모델 설정을 확인하세요.';}
    else if(Date.now()>Date.parse(job.expires_at)){run.status='expired';run.error='완료 시점에 만료된 판단입니다.';}
    else{
      const decision=validateDecision(JSON.parse(await fs.readFile(output,'utf8')),job.snapshot.symbols,cohort==='feedback');
      run.status='completed';
      // This is an output contract for a future simulator, not a broker order.
      await atomic(path.join(cwd,'validated-proposal.json'),{job_id:job.id,run_id:id,cohort,config_version:config.version,
        data_as_of:job.snapshot.as_of,completed_at:new Date().toISOString(),expires_at:job.expires_at,decision});
    }
  }catch(e){run.status=e.message==='expired'?'expired':'failed';run.error='작업 입력 또는 결과 검증에 실패했습니다.';}
  run.finished_at=new Date().toISOString();run.duration_ms=Date.now()-started;
  await atomic(path.join(cwd,'run.json'),run);await record(run);
}
async function step(){
  const files=(await fs.readdir(dirs.pending)).filter(x=>x.endsWith('.json')).sort();
  for(const file of files){
    const source=path.join(dirs.pending,file);let job;
    try{job=validateJob(JSON.parse(await fs.readFile(source,'utf8')));}catch{
      await fs.rename(source,path.join(dirs.archive,file));console.error('유효하지 않거나 만료된 작업을 archive로 이동했습니다.');continue;
    }
    // Read fresh settings at dispatch, then freeze one revision for both cohorts.
    const rows=await api(`/rest/v1/task_settings?task_key=eq.${job.task_key}&select=*`);const config=rows[0];
    if(!config?.enabled)continue;
    if(!modelsAt||Date.now()-Date.parse(modelsAt)>120000||lastError||!supported(models,config.model,config.effort))continue;
    currentJob=job.id;
    await fs.rename(source,path.join(dirs.active,file));
    await atomic(path.join(dirs.active,file),{...job,claimed_config:config});
    try{
      await Promise.all((job.task_key.endsWith('feedback')?['feedback']:['A','B']).map(cohort=>execute(job,config,cohort)));
    }finally{await fs.rename(path.join(dirs.active,file),path.join(dirs.archive,file));currentJob=null;}
    break;
  }
}
// Never replay a job that may have completed before a crash.
for(const file of await fs.readdir(dirs.active))if(file.endsWith('.json')){
  await fs.rename(path.join(dirs.active,file),path.join(dirs.archive,file));
  console.error('이전 실행에서 중단된 작업을 보관했습니다. 자동 재실행하지 않습니다.');
}
for(const id of await fs.readdir(dirs.results)){
  const file=path.join(dirs.results,id,'run.json');
  try{const run=JSON.parse(await fs.readFile(file,'utf8'));if(run.status==='running'){
    Object.assign(run,{status:'failed',error:'PC 실행기 중단으로 결과·사용량이 불완전할 수 있습니다.',finished_at:new Date().toISOString()});await atomic(file,run);
  }
    // Also recover a crash between writing the final run.json and its outbox entry.
    // Upsert by UUID makes retransmission of previously uploaded records idempotent.
    await record(run);
  }catch{/* Ignore folders without a run record. */}
}
process.on('SIGINT',()=>{stopping=true;});process.on('SIGTERM',()=>{stopping=true;});
console.log('PC 실행기 시작. 실주문 기능 없음. Ctrl+C로 현재 작업 종료 후 중지합니다.');
await heartbeat();
const timer=setInterval(()=>void heartbeat(),poll);
try{
  while(!stopping){try{await step();}catch{console.error('작업 큐 처리 실패. 다음 점검에서 다시 확인합니다.');}await new Promise(r=>setTimeout(r,poll));}
}finally{
  clearInterval(timer);while(heartbeatBusy)await new Promise(r=>setTimeout(r,100));
  await flush().catch(()=>{});await fs.unlink(lockFile).catch(()=>{});
}
