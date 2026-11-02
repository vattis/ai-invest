import { spawn } from 'node:child_process';
import { normalizeUsage } from '../lib/domain.mjs';

export function command(env = process.env) {
  if (env.CODEX_JS_PATH) return {bin:process.execPath, prefix:[env.CODEX_JS_PATH]};
  if (env.CODEX_BIN) return {bin:env.CODEX_BIN, prefix:[]};
  if (process.platform === 'win32') throw new Error('Windows에서는 CODEX_JS_PATH 또는 native CODEX_BIN을 지정하세요.');
  return {bin:'codex',prefix:[]};
}
function terminate(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer=spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
    killer.on('error',()=>child.kill('SIGKILL'));
    killer.on('exit',code=>{if(code!==0)child.kill('SIGKILL');});
    // A restricted shell can prevent taskkill. Do not leave the direct child alive.
    const fallback=setTimeout(()=>child.kill('SIGKILL'),1000);fallback.unref();
  }
  else { try { process.kill(-child.pid,'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}
export function launch(args, env = process.env, cwd) {
  const c = command(env);
  // Secrets for the broker/database never enter the agent process environment.
  const childEnv = {...env};
  for (const name of Object.keys(childEnv)) if (/SUPABASE|BROKER|KIS_|ALPACA|WORKER_SECRET|^(OPENAI_API_KEY|CODEX_API_KEY)$/.test(name)) delete childEnv[name];
  return spawn(c.bin,[...c.prefix,...args],{
    cwd,env:childEnv,windowsHide:true,shell:false,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']
  });
}
export function runDecision({prompt, model, effort, schema, output, cwd, timeoutMs = 120000}, env = process.env) {
  return new Promise((resolve,reject) => {
    const child = launch(['exec','--skip-git-repo-check','--ignore-user-config','--sandbox','read-only','--ephemeral',
      '--disable','shell_tool','--disable','unified_exec','--disable','apps','--disable','plugins',
      '--disable','browser_use','--disable','computer_use','--disable','multi_agent','--disable','hooks',
      '-c','web_search="disabled"',
      '-m',model,'-c',`model_reasoning_effort="${effort}"`,'--output-schema',schema,'--output-last-message',output,'--json','-'],env,cwd);
    let buffer='', size=0, timedOut=false, streamFailed=false, known=false;
    let totals={input_tokens:0,cached_input_tokens:0,output_tokens:0,reasoning_output_tokens:null,total_tokens:0};
    const timer=setTimeout(()=>{timedOut=true;terminate(child);},timeoutMs);
    const consume = line => {
      try {
        const e=JSON.parse(line);
        if (e.type==='turn.failed'||e.type==='error') streamFailed=true;
        if(e.type==='turn.completed' && e.usage){
          const u=normalizeUsage(e.usage); if(u.total_tokens===null)return; known=true;
          for(const k of ['input_tokens','cached_input_tokens','output_tokens','total_tokens'])totals[k]+=u[k]??0;
          if(u.reasoning_output_tokens!==null)totals.reasoning_output_tokens=(totals.reasoning_output_tokens??0)+u.reasoning_output_tokens;
        }
      } catch { /* Progress may include non-JSON lines; never interpret them as decisions. */ }
    };
    child.stdout.on('data',data=>{
      size+=data.length;if(size>8*1024*1024){streamFailed=true;terminate(child);return;}
      buffer+=data.toString();let i;while((i=buffer.indexOf('\n'))>=0){consume(buffer.slice(0,i));buffer=buffer.slice(i+1);}
    });
    child.stderr.resume(); // Never upload stderr: it may contain sensitive local paths or inputs.
    child.stdin.on('error',()=>{});
    child.on('error',e=>{clearTimeout(timer);reject(new Error(`Codex 실행 실패: ${e.code ?? 'spawn'}`));});
    child.on('close',code=>{
      clearTimeout(timer);if(buffer.trim())consume(buffer);
      resolve({ok:code===0&&!timedOut&&!streamFailed,timedOut,exitCode:code,usage:known?totals:normalizeUsage()});
    });
    child.stdin.end(prompt);
  });
}

export function readAccount(env = process.env) {
  return new Promise((resolve,reject)=>{
    const child=launch(['app-server'],env);
    let buffer='',next=0,finished=false;const pending=new Map();
    const timer=setTimeout(()=>finish(new Error('Codex 계정 조회 시간 초과')),20000);
    function finish(error,value){if(finished)return;finished=true;clearTimeout(timer);child.stdin.end();terminate(child);error?reject(error):resolve(value);}
    function call(method,params){return new Promise((ok,fail)=>{const id=++next;pending.set(id,{ok,fail});child.stdin.write(JSON.stringify({id,method,...(params?{params}:{})})+'\n');});}
    child.stdout.on('data',chunk=>{buffer+=chunk.toString();if(buffer.length>4*1024*1024)return finish(new Error('Codex 응답 크기 초과'));
      let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);try{const e=JSON.parse(line);const p=pending.get(e.id);if(p){pending.delete(e.id);e.error?p.fail(new Error('Codex 요청 실패')):p.ok(e.result);}}catch{}}
    });
    child.stderr.resume();child.stdin.on('error',()=>{});
    child.on('error',()=>finish(new Error('Codex CLI를 실행할 수 없습니다.')));
    child.on('close',()=>{if(!finished)finish(new Error('Codex 계정 조회가 종료되었습니다.'));});
    (async()=>{
      await call('initialize',{clientInfo:{name:'trading_control',version:'0.1.0'},capabilities:{experimentalApi:true}});
      child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
      const auth=await call('account/read',{});
      if(!auth?.account || auth.account.type!=='chatgpt')throw new Error('codex login으로 ChatGPT 계정 로그인이 필요합니다.');
      const models=[];let cursor;
      do {const page=await call('model/list',{limit:100,includeHidden:false,...(cursor?{cursor}:{})});models.push(...page.data);cursor=page.nextCursor;}while(cursor);
      const limits=await call('account/rateLimits/read');
      finish(null,{models:models.map(m=>({id:m.id,model:m.model,displayName:m.displayName,
        supportedReasoningEfforts:m.supportedReasoningEfforts,defaultReasoningEffort:m.defaultReasoningEffort})),
        rate_limits:limits.rateLimitsByLimitId??(limits.rateLimits?{codex:limits.rateLimits}:null)});
    })().catch(e=>finish(e));
  });
}
