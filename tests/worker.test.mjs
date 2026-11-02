import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';

test('PC worker freezes one revision for paired jobs, publishes usage, and persists the local queue', {timeout:30000},async()=>{
  const root=await fs.mkdtemp(path.resolve('.runtime/tests/worker-'));
  const now=new Date().toISOString();
  const job={id:'paired-job',task_key:'kr_trade',expires_at:new Date(Date.now()+60000).toISOString(),snapshot:{as_of:now,symbols:['A']},portfolios:{A:{cash:100},B:{cash:100}},feedback:['A_ONLY']};
  await fs.mkdir(path.join(root,'pending'),{recursive:true});await fs.writeFile(path.join(root,'pending','paired-job.json'),JSON.stringify(job));
  const runs=new Map();let status;
  const config={task_key:'kr_trade',model:'gpt-6-sol',effort:'high',enabled:true,version:7};
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const c of req)raw+=c;
    let reply=[];
    if(req.url.startsWith('/rest/v1/task_settings'))reply=[config];
    else if(req.url.startsWith('/rest/v1/worker_status'))status=JSON.parse(raw);
    else if(req.url.startsWith('/rest/v1/task_runs')){const value=JSON.parse(raw);runs.set(value.id,value);}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(reply));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const child=spawn(process.execPath,['worker/main.mjs'],{env:{...process.env,WORKER_ROOT:root,WORKER_POLL_SECONDS:'5',
    SUPABASE_URL:`http://127.0.0.1:${server.address().port}`,SUPABASE_SERVICE_ROLE_KEY:'fixture',
    CODEX_JS_PATH:path.resolve('tests/fixtures/codex.mjs')},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',x=>stderr+=x);child.stdout.resume();
  try{
    const deadline=Date.now()+20000;
    while([...runs.values()].filter(r=>r.status==='completed').length<2){
      if(Date.now()>deadline)throw Error('worker timeout: '+stderr);
      await new Promise(r=>setTimeout(r,100));
    }
    const results=[...runs.values()];assert.deepEqual(results.map(x=>x.cohort).sort(),['A','B']);
    for(const run of results){assert.equal(run.config_version,7);assert.equal(run.total_tokens,140);assert.equal(run.status,'completed');}
    assert.equal(status.settings_versions.kr_trade,7);
    assert.ok(status.models.some(m=>m.id==='gpt-6-sol'));
    assert.equal(status.rate_limits.codex.primary.usedPercent,10);
    assert.ok(await fs.stat(path.join(root,'archive','paired-job.json')));
    const a=results.find(r=>r.cohort==='A'),b=results.find(r=>r.cohort==='B');
    assert.ok((await fs.readFile(path.join(root,'results',a.id,'input.txt'),'utf8')).includes('A_ONLY'));
    assert.ok(!(await fs.readFile(path.join(root,'results',b.id,'input.txt'),'utf8')).includes('A_ONLY'));
  }finally{
    child.kill('SIGKILL');await new Promise(r=>child.once('close',r));
    await new Promise(r=>server.close(r));
  }
});
