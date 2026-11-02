import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {runDecision} from '../worker/codex.mjs';
const base=path.resolve('.runtime/tests');await fs.mkdir(base,{recursive:true});
const env={...process.env,CODEX_JS_PATH:path.resolve('tests/fixtures/codex.mjs')};
const opts=name=>({prompt:'test',model:'gpt-6-sol',effort:'high',schema:path.resolve('worker/decision-schema.json'),output:path.join(base,name+'.json'),cwd:base,timeoutMs:5000});
test('runner captures actual usage events without counting cache and reasoning twice',async()=>{
  const r=await runDecision(opts('normal'),env);assert.equal(r.ok,true);assert.equal(r.usage.total_tokens,140);assert.equal(r.usage.reasoning_output_tokens,20);
});
test('failed runs retain measured usage and never appear successful',async()=>{
  const r=await runDecision(opts('fail'),{...env,TEST_CODEX_MODE:'fail'});assert.equal(r.ok,false);assert.equal(r.usage.total_tokens,140);
});
test('hung subprocess is terminated at deadline; missing usage stays unknown',async()=>{
  const r=await runDecision({...opts('hang'),timeoutMs:700},{...env,TEST_CODEX_MODE:'hang'});assert.equal(r.timedOut,true);assert.equal(r.usage.total_tokens,null);
});
