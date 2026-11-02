import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeUsage,summarizeUsage,validateSettings,supported} from '../lib/domain.mjs';
import {validateJob,makePrompt,validateDecision} from '../worker/jobs.mjs';

test('cached input and reasoning are subsets, not additional billed tokens',()=>{
  const u=normalizeUsage({input_tokens:100,cached_input_tokens:80,output_tokens:50,reasoning_output_tokens:30});
  assert.equal(u.total_tokens,150);
  assert.equal(summarizeUsage([u,normalizeUsage()]).total_tokens,150);
  assert.equal(summarizeUsage([u,normalizeUsage()]).known_jobs,1);
  assert.equal(normalizeUsage().total_tokens,null);
});
test('settings reject executable model strings and require revision',()=>{
  const good={task_key:'kr_trade',model:'gpt-6-sol',effort:'high',enabled:true,version:1};
  assert.deepEqual(validateSettings(good),good);
  assert.throws(()=>validateSettings({...good,model:'sol; rm -rf /'}));
  assert.throws(()=>validateSettings({...good,version:0}));
  assert.throws(()=>validateSettings({...good,effort:'made-up'}));
  assert.equal(supported([{id:'gpt-6-sol',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}],'gpt-6-sol','high'),false);
});
const job=()=>({id:'kr-001',task_key:'kr_trade',expires_at:new Date(Date.now()+120000).toISOString(),snapshot:{as_of:new Date().toISOString(),symbols:['005930']},portfolios:{A:{cash:100},B:{cash:100}},feedback:['PRIVATE_A_LESSON']});
test('B receives no A feedback and paired jobs share the same market snapshot',()=>{
  const j=validateJob(job());assert.ok(makePrompt(j,'A').includes('PRIVATE_A_LESSON'));assert.ok(!makePrompt(j,'B').includes('PRIVATE_A_LESSON'));
  assert.ok(makePrompt(j,'A').includes(j.snapshot.as_of));assert.ok(makePrompt(j,'B').includes(j.snapshot.as_of));
});
test('expired or malformed snapshots never reach an agent',()=>{
  assert.throws(()=>validateJob({...job(),expires_at:'2000-01-01'}));
  assert.throws(()=>validateJob({...job(),id:'../../file'}));
  assert.throws(()=>validateJob({...job(),snapshot:{symbols:Array(21).fill('A')}}));
});
test('proposals reject unknown symbols, duplicate symbols and excessive weights',()=>{
  const result={summary:'example',orders:[{symbol:'A',action:'BUY',target_weight:.8,reason:'r'}],lessons:[]};
  assert.equal(validateDecision(result,['A']),result);
  assert.throws(()=>validateDecision(result,['B']));
  assert.throws(()=>validateDecision(result,['A'],true));
  assert.throws(()=>validateDecision({...result,orders:[...result.orders,{symbol:'B',action:'BUY',target_weight:.5,reason:'r'}]},['A','B']));
});
