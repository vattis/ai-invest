import {chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import assert from 'node:assert/strict';

const server=spawn(process.execPath,['scripts/dev.mjs'],{env:{...process.env,PORT:'3300'},windowsHide:true,stdio:['ignore','pipe','pipe']});
await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.on('error',reject);setTimeout(()=>reject(Error('server timeout')),10000).unref();});
let browser;
try{
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://localhost:3300/?preview=1');
  await page.getByRole('heading',{name:'오늘의 실험실'}).waitFor();
  assert.equal(await page.locator('.setting-card').count(),4);
  assert.equal(await page.getByRole('button',{name:'설정 저장',exact:true}).first().isDisabled(),true);
  await fs.mkdir('.runtime/screenshots',{recursive:true});
  await page.screenshot({path:'.runtime/screenshots/desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'.runtime/screenshots/mobile.png',fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'mobile page overflows viewport');

  let logged=false,mfa=false,version=1,saved;
  const modelList=['gpt-6-sol','gpt-6-luna'].map(id=>({id,supportedReasoningEfforts:[{reasoningEffort:'medium'},{reasoningEffort:'high'}]}));
  await page.route('**/api/**',async route=>{
    const request=route.request(),url=new URL(request.url()),name=url.pathname.slice(5);
    let status=200,data={};
    if(name==='session'){
      if(!logged){status=401;data={error:'로그인이 필요합니다.'};}
      else data={email:'owner@example.com',aal:mfa?'aal2':'aal1',factors:[{id:'factor',status:'verified'}]};
    }else if(name==='refresh'){status=401;data={error:'로그인이 필요합니다.'};}
    else if(name==='login'){logged=true;data={ok:true};}
    else if(name==='mfa/verify'){mfa=true;data={ok:true};}
    else if(name==='settings'){saved=request.postDataJSON();version++;data={version};}
    else if(name==='dashboard')data={
      settings:[{task_key:'kr_trade',model:saved?.model??'gpt-6-sol',effort:saved?.effort??'medium',enabled:true,version}],
      worker:{models:modelList,models_at:new Date().toISOString(),updated_at:new Date().toISOString(),settings_versions:{kr_trade:version},state:'idle'},
      runs:[],audit:[],totals:{jobs:0,known_jobs:0,input_tokens:0,output_tokens:0,cached_input_tokens:0,total_tokens:0}
    };
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
  });
  await page.goto('http://localhost:3300/');
  await page.locator('#login-form input[name=email]').fill('owner@example.com');
  await page.locator('#login-form input[name=password]').fill('test-password');
  await page.getByRole('button',{name:'로그인 →',exact:true}).click();
  await page.locator('#mfa-form input').fill('123456');
  await page.getByRole('button',{name:'인증하고 접속'}).click();
  await page.getByRole('heading',{name:'오늘의 실험실'}).waitFor();
  await page.locator('.setting-card select[name=model]').selectOption('gpt-6-luna');
  await page.locator('.setting-card select[name=effort]').selectOption('high');
  await page.getByRole('button',{name:'설정 저장',exact:true}).click();
  await page.getByText('v2',{exact:true}).waitFor();
  assert.equal(saved.model,'gpt-6-luna');assert.equal(saved.effort,'high');assert.equal(saved.version,1);
  assert.equal(errors.length,0,errors.join('\n'));
  console.log('Browser checks passed: desktop/mobile layouts, sample read-only, login + MFA flow, model save/version update.');
}finally{await browser?.close();server.kill('SIGKILL');}
