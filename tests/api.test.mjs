import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../api/index.js';
const owner='11111111-1111-4111-8111-111111111111';
const env={APP_ORIGIN:'http://localhost:3000',SUPABASE_URL:'https://unit.example',SUPABASE_ANON_KEY:'public-key',OWNER_USER_ID:owner};
const token=aal=>`x.${Buffer.from(JSON.stringify({aal})).toString('base64url')}.x`;
async function request({route='dashboard',method='GET',body={},aal='aal2',cookie=true,origin=env.APP_ORIGIN,fetcher,config=env}={}){
  const headers={};let payload;
  const res={setHeader:(k,v)=>headers[k.toLowerCase()]=v,end:v=>payload=JSON.parse(v)};
  const req={url:'/api/'+route,method,body,headers:{origin,...(cookie?{cookie:`trade_access=${token(aal)}`}:{})}};
  await createHandler(config,fetcher??(async url=>{
    if(url.endsWith('/user'))return Response.json({id:owner,email:'owner@example.com',factors:[]});
    return Response.json([]);
  }))(req,res);
  return {status:res.statusCode,body:payload,headers};
}
test('no configuration or session never returns private data',async()=>{
  assert.equal((await request({config:{}})).status,503);
  assert.equal((await request({cookie:false})).status,401);
});
test('cross-origin writes are rejected before auth or database calls',async()=>{
  const r=await request({method:'PUT',route:'settings',origin:'https://evil.example',fetcher:()=>{throw Error('must not call');}});
  assert.equal(r.status,403);
});
test('aal1 owner cannot read dashboard or change settings',async()=>{
  assert.equal((await request({aal:'aal1'})).status,403);
  assert.equal((await request({aal:'aal1',method:'PUT',route:'settings'})).status,403);
});
test('valid login for a different account is denied and gets no cookies',async()=>{
  const r=await request({route:'login',method:'POST',body:{email:'other@example.com',password:'password'},fetcher:async()=>Response.json({user:{id:'other'},access_token:'secret'})});
  assert.equal(r.status,403);assert.equal(r.headers['set-cookie'],undefined);
});
test('forged local aal2 claim is not trusted without upstream verification',async()=>{
  const r=await request({fetcher:async()=>Response.json({},{status:401})});assert.equal(r.status,401);
});
test('login tokens use HttpOnly secure same-site cookies, never response JSON',async()=>{
  const origin='https://console.example';const r=await request({route:'login',method:'POST',origin,config:{...env,APP_ORIGIN:origin},body:{email:'owner@example.com',password:'secret'},fetcher:async()=>Response.json({user:{id:owner},access_token:'ACCESS',refresh_token:'REFRESH',expires_in:3600})});
  assert.equal(r.status,200);assert.deepEqual(r.body,{ok:true});assert.match(r.headers['set-cookie'][0],/HttpOnly; SameSite=Strict; Secure/);
});
test('unsupported combinations rejected even with owner MFA',async()=>{
  const r=await request({route:'settings',method:'PUT',body:{task_key:'kr_trade',model:'gpt-6-sol',effort:'high',enabled:true,version:1},fetcher:async url=>{
    if(url.endsWith('/user'))return Response.json({id:owner});
    return Response.json([{models_at:new Date().toISOString(),models:[{id:'gpt-6-sol',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}]}]);
  }});assert.equal(r.status,400);
});
test('settings conflict maps to 409 and request sends the expected revision',async()=>{
  const r=await request({route:'settings',method:'PUT',body:{task_key:'kr_trade',model:'gpt-6-sol',effort:'medium',enabled:true,version:4},fetcher:async(url,options)=>{
    if(url.endsWith('/user'))return Response.json({id:owner});
    if(url.includes('worker_status'))return Response.json([{models_at:new Date().toISOString(),models:[{id:'gpt-6-sol',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}]}]);
    assert.equal(JSON.parse(options.body).p_version,4);return Response.json({code:'40001'},{status:400});
  }});assert.equal(r.status,409);
});
test('MFA verification requires a factor belonging to the verified owner',async()=>{
  const r=await request({route:'mfa/verify',method:'POST',aal:'aal1',body:{factor_id:'someone-else',code:'123456'}});assert.equal(r.status,400);
});
