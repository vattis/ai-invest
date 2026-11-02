const $=s=>document.querySelector(s);
const titles={kr_trade:'국내 매매 판단 A/B',us_trade:'미국 매매 판단 A/B',kr_feedback:'국내 피드백',us_feedback:'미국 피드백'};
const states={running:'실행 중',completed:'완료',failed:'실패',timed_out:'시간 초과',expired:'만료',skipped:'건너뜀'};
const preview=new URLSearchParams(location.search).get('preview')==='1';
const fmt=n=>n===null||n===undefined?'미수집':Number(n).toLocaleString('ko-KR');
const time=s=>s?new Date(s).toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'확인 불가';
let session=null,factorId=null,timer=null,busy=false,current=null,toastTimer;
function node(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
function toast(text){$('#notice').textContent=text;$('#notice').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#notice').hidden=true,5000);}
let refreshing;
async function api(route,options={},retry=true){
  const r=await fetch(`/api/${route}`,{credentials:'same-origin',...options,headers:{'Content-Type':'application/json',...options.headers}});
  if(r.status===401&&retry&&!['login','refresh','logout'].includes(route)){
    refreshing??=api('refresh',{method:'POST',body:'{}'},false).finally(()=>refreshing=null);
    await refreshing;return api(route,options,false);
  }
  let data;try{data=await r.json();}catch{throw new Error('서버 응답을 읽을 수 없습니다.');}
  if(!r.ok){const error=new Error(data.error??'요청 실패');error.status=r.status;throw error;}return data;
}
function showAuth(message=''){
  clearInterval(timer);session=null;$('#console').hidden=true;$('#auth').hidden=false;
  $('#login-form').hidden=false;$('#mfa-form').hidden=true;$('#enrollment').hidden=true;
  $('#totp-secret').textContent='';$('#auth-title').textContent='실험실 로그인';$('#auth-error').textContent=message;
}
async function authenticate(){
  session=await api('session');
  if(session.aal==='aal2')return openConsole();
  $('#auth').hidden=false;$('#console').hidden=true;$('#login-form').hidden=true;$('#mfa-form').hidden=false;
  $('#auth-title').textContent='2단계 인증';$('#auth-description').textContent='인증 앱의 6자리 코드를 입력하세요.';
  const verified=session.factors.find(x=>x.status==='verified');
  if(verified){factorId=verified.id;$('#enrollment').hidden=true;}
  else{
    const enrollment=await api('mfa/enroll',{method:'POST',body:'{}'});factorId=enrollment.id;
    $('#enrollment').hidden=false;$('#totp-secret').textContent=enrollment.secret;
    $('#auth-description').textContent='처음 접속했습니다. 휴대폰 인증 앱을 등록하세요.';
  }
  $('#mfa-form [name=code]').focus();
}
$('#login-form').addEventListener('submit',async e=>{
  e.preventDefault();const button=e.submitter;button.disabled=true;$('#auth-error').textContent='';
  try{const form=new FormData(e.target);await api('login',{method:'POST',body:JSON.stringify(Object.fromEntries(form))});e.target.reset();await authenticate();}
  catch(error){$('#auth-error').textContent=error.message;}finally{button.disabled=false;}
});
$('#mfa-form').addEventListener('submit',async e=>{
  e.preventDefault();e.submitter.disabled=true;$('#auth-error').textContent='';
  try{await api('mfa/verify',{method:'POST',body:JSON.stringify({factor_id:factorId,code:new FormData(e.target).get('code')})});e.target.reset();$('#totp-secret').textContent='';await authenticate();}
  catch(error){$('#auth-error').textContent=error.message;}finally{e.submitter.disabled=false;}
});
$('#copy-secret').onclick=()=>navigator.clipboard.writeText($('#totp-secret').textContent).then(()=>toast('설정 키를 복사했습니다.'),()=>toast('설정 키를 직접 복사하세요.'));
async function logout(){if(preview){location.href='/';return;}await api('logout',{method:'POST',body:'{}'}).catch(()=>{});showAuth();}
$('#logout').onclick=logout;$('#back-login').onclick=logout;
function openConsole(){
  $('#auth').hidden=true;$('#console').hidden=false;$('#identity').textContent=preview?'샘플 미리보기':session.email;
  $('#preview-banner').hidden=!preview;clearInterval(timer);void refresh();
  if(!preview)timer=setInterval(()=>{if(!document.hidden)void refresh();},10000);
}
function renderSettings(data){
  if(document.querySelector('.setting-card[data-dirty=true]'))return;
  const container=$('#settings-list');container.replaceChildren();
  const models=data.worker?.models??[];
  const catalogValid=!!data.worker?.models_at&&Date.now()-Date.parse(data.worker.models_at)<86400000;
  for(const setting of data.settings){
    const form=node('form',undefined,'setting-card');form.dataset.dirty='false';
    const heading=node('div',undefined,'setting-title');heading.append(node('strong',titles[setting.task_key]),node('small',`v${setting.version}`));
    const fields=node('div',undefined,'setting-fields');
    const modelLabel=node('label','모델'),effortLabel=node('label','추론 수준');
    const model=node('select'),effort=node('select');model.name='model';effort.name='effort';
    const choices=models.length?models:[{id:setting.model,displayName:setting.model,supportedReasoningEfforts:[]}];
    for(const m of choices){const o=node('option',m.displayName??m.id);o.value=m.id;model.append(o);}
    if(!choices.some(m=>m.id===setting.model)){const o=node('option',`${setting.model} (현재 계정 미확인)`);o.value=setting.model;model.append(o);}
    model.value=setting.model;
    const updateEffort=()=>{
      effort.replaceChildren();const options=models.find(m=>m.id===model.value)?.supportedReasoningEfforts??[];
      for(const e of options.length?options:[{reasoningEffort:setting.effort}]){const o=node('option',e.reasoningEffort);o.value=e.reasoningEffort;effort.append(o);}
      if([...effort.options].some(o=>o.value===setting.effort))effort.value=setting.effort;
    };updateEffort();model.onchange=updateEffort;
    modelLabel.append(model);effortLabel.append(effort);fields.append(modelLabel,effortLabel);
    const bottom=node('div',undefined,'setting-bottom'),enabledLabel=node('label',undefined,'toggle-label'),enabled=node('input');enabled.type='checkbox';enabled.checked=setting.enabled;
    enabledLabel.append(enabled,document.createTextNode('작업 활성화'));
    const save=node('button','설정 저장','primary');save.type='submit';save.disabled=preview||!catalogValid;
    model.disabled=effort.disabled=enabled.disabled=preview||!catalogValid;
    bottom.append(enabledLabel,save);
    const acknowledged=data.worker?.settings_versions?.[setting.task_key];
    const applied=data.runs.find(r=>r.task_key===setting.task_key&&r.config_version===setting.version);
    const state=node('p',applied?'이 버전으로 실행된 작업 있음':acknowledged===setting.version?'PC 수신 완료 · 다음 작업부터 사용':'설정 저장됨 · PC 수신 대기','setting-state');
    form.append(heading,fields,bottom,state);form.oninput=()=>{form.dataset.dirty='true';state.textContent='저장하지 않은 변경';};
    form.onsubmit=async e=>{
      e.preventDefault();save.disabled=true;
      try{await api('settings',{method:'PUT',body:JSON.stringify({task_key:setting.task_key,version:setting.version,model:model.value,effort:effort.value,enabled:enabled.checked})});form.dataset.dirty='false';toast('저장했습니다. 다음 작업부터 적용됩니다.');await refresh();}
      catch(error){toast(error.message);if(error.status===409){form.dataset.dirty='false';await refresh();}}
      finally{save.disabled=preview||!catalogValid;}
    };
    container.append(form);
  }
  $('#model-status').textContent=catalogValid?`모델 목록 확인: ${time(data.worker.models_at)} · 계정에서 지원하는 조합만 선택 가능`:'PC 실행기를 연결하면 사용 가능한 모델을 선택할 수 있습니다.';
}
function render(data){
  current=data;const worker=data.worker,online=worker&&Date.now()-Date.parse(worker.updated_at)<45000;
  const accounts=$('#accounts');accounts.replaceChildren();
  for(const account of data.accounts??[]){
    const card=node('article',undefined,'account-card');
    const initial=account.market==='kr'?10000000:10000,change=(Number(account.equity)/initial-1)*100;
    card.append(node('strong',`${account.market==='kr'?'국내 · KRW':'미국 · USD'} / ${account.cohort}`),node('span',`평가액 ${fmt(account.equity)}`),node('small',`초기 대비 ${Number.isFinite(change)?`${change>=0?'+':''}${change.toFixed(2)}%`:'확인 불가'} · 현금 ${fmt(account.cash)} · 보유 ${account.positions?.length??0}종목 · ${time(account.updated_at)}`));
    accounts.append(card);
  }
  if(!accounts.children.length)accounts.append(node('p','시세 수집기 연결 후 가상 계좌가 표시됩니다.','empty'));
  const trades=$('#trades');trades.replaceChildren();
  for(const trade of data.trades??[]){const row=node('tr');for(const label of [time(trade.as_of),`${trade.market==='kr'?'국내':'미국'} ${trade.cohort}`,trade.symbol,trade.side==='BUY'?'매수':'매도',fmt(trade.quantity),fmt(trade.price)])row.append(node('td',label));trades.append(row);}
  if(!trades.children.length){const row=node('tr'),cell=node('td','아직 가상 체결이 없습니다.','empty');cell.colSpan=6;row.append(cell);trades.append(row);}
  $('#connection').classList.toggle('offline',!online||!!worker?.error);
  $('#connection strong').textContent=online?(worker.error?'PC 연결됨 · Codex 인증 확인 필요':worker.state==='running'?'PC 실행 중':'PC 연결됨 · 작업 대기'):'PC 연결 확인 불가';
  $('#last-sync').textContent=`마지막 수신 ${time(worker?.updated_at)}`;
  const totals=data.totals??{},unknown=totals.jobs>0&&!totals.known_jobs;
  $('#total-tokens').textContent=fmt(unknown?null:totals.total_tokens);$('#job-count').textContent=fmt(totals.jobs);
  $('#usage-coverage').textContent=`사용량 확인 ${totals.known_jobs??0} / ${totals.jobs??0}개 작업`;
  $('#in-out').textContent=`${fmt(unknown?null:totals.input_tokens)} / ${fmt(unknown?null:totals.output_tokens)}`;
  $('#cache-tokens').textContent=`캐시 입력 ${fmt(totals.cached_input_tokens)} · 입력에 포함`;
  const quota=$('#quota');quota.replaceChildren();
  const limits=worker?.rate_limits;let hasQuota=false;
  for(const [key,bucket] of Object.entries(limits??{}))for(const [name,window] of [['기본',bucket.primary],['추가',bucket.secondary]]){
    if(!window||typeof window.usedPercent!=='number')continue;hasQuota=true;
    const row=node('div',undefined,'quota-row'),title=node('div');title.append(node('span',`${bucket.limitName??key} · ${name}`),node('span',`${window.usedPercent}% 사용`));
    const progress=node('progress');progress.max=100;progress.value=window.usedPercent;progress.setAttribute('aria-label',`${key} ${name} 사용률`);
    row.append(title,progress,node('small',`초기화 ${time(window.resetsAt?window.resetsAt*1000:null)}`));quota.append(row);
  }
  if(!hasQuota)quota.textContent='확인 불가';
  $('#quota-time').textContent=`계정 전체 · 확인 ${time(worker?.rate_limits_at)}${!worker?.rate_limits_at||Date.now()-Date.parse(worker.rate_limits_at)>120000?' · 오래된 정보':''}`;
  renderSettings(data);
  const tbody=$('#runs');tbody.replaceChildren();
  for(const run of data.runs){
    const tr=node('tr'),when=node('td',time(run.created_at)),task=node('td',titles[run.task_key]);task.append(node('small',`${run.cohort} · v${run.config_version}`));
    const model=node('td',run.model);model.append(node('small',run.effort));const state=node('td');state.append(node('span',states[run.status]??run.status,`badge ${run.status}`));
    if(run.error)state.title=run.error;
    const tokens=node('td',fmt(run.total_tokens));tokens.title=`입력 ${fmt(run.input_tokens)} / 캐시 ${fmt(run.cached_input_tokens)} / 출력 ${fmt(run.output_tokens)} / 추론 ${fmt(run.reasoning_output_tokens)} (부분 항목은 중복 합산하지 않음)`;
    tr.append(when,task,model,state,tokens,node('td',run.duration_ms==null?'—':`${(run.duration_ms/1000).toFixed(1)}초`));tbody.append(tr);
  }
  if(!data.runs.length){const tr=node('tr'),td=node('td','아직 실행한 작업이 없습니다. PC 실행기를 연결하고 작업을 등록하세요.','empty');td.colSpan=6;tr.append(td);tbody.append(tr);}
  const audit=$('#audit');audit.replaceChildren();
  for(const item of data.audit){const row=node('div',undefined,'audit-row'),text=node('div',titles[item.task_key]);text.append(node('small',`${item.before_value.model} ${item.before_value.effort} → ${item.after_value.model} ${item.after_value.effort} · v${item.after_value.version} · ${item.after_value.enabled?'활성':'중지'}`));row.append(text,node('small',time(item.created_at)));audit.append(row);}
  if(!data.audit.length)audit.append(node('p','설정 변경 이력이 없습니다.','empty'));
}
async function refresh(){
  if(busy)return;busy=true;
  try{render(preview?sample():await api(`dashboard?period=${$('#period').value}`));}
  catch(error){if(error.status===401||error.status===403)showAuth(error.message);else{toast(error.message);$('#connection').classList.add('offline');$('#connection strong').textContent='새로고침 실패 · 마지막 수신 정보 표시';}}
  finally{busy=false;}
}
$('#refresh').onclick=()=>void refresh();$('#period').onchange=()=>void refresh();
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!$('#console').hidden)void refresh();});
function sample(){
  const now=new Date().toISOString(),models=['gpt-6-sol','gpt-6-astra','gpt-6-luna'].map(id=>({id,displayName:id,supportedReasoningEfforts:['low','medium','high'].map(reasoningEffort=>({reasoningEffort}))}));
  const settings=Object.keys(titles).map(task_key=>({task_key,model:task_key.endsWith('feedback')?'gpt-6-astra':'gpt-6-sol',effort:'medium',enabled:true,version:1}));
  return {settings,worker:{updated_at:now,models,models_at:now,rate_limits_at:now,state:'idle',settings_versions:Object.fromEntries(settings.map(s=>[s.task_key,1])),rate_limits:{codex:{primary:{usedPercent:24,resetsAt:Date.now()/1000+7200},secondary:{usedPercent:38,resetsAt:Date.now()/1000+172800}}}},
    accounts:[{market:'kr',cohort:'A',cash:8200000,equity:10230000,positions:[{symbol:'005930',quantity:20}],updated_at:now},{market:'kr',cohort:'B',cash:8500000,equity:10080000,positions:[{symbol:'005930',quantity:18}],updated_at:now},{market:'us',cohort:'A',cash:7800,equity:10250,positions:[{symbol:'AAPL',quantity:3}],updated_at:now},{market:'us',cohort:'B',cash:8100,equity:10020,positions:[{symbol:'AAPL',quantity:2}],updated_at:now}],trades:[{as_of:now,market:'kr',cohort:'A',symbol:'005930',side:'BUY',quantity:20,price:101500}],
    totals:{jobs:48,known_jobs:48,input_tokens:144000,output_tokens:24000,cached_input_tokens:62000,total_tokens:168000},
    runs:Array.from({length:6},(_,i)=>({created_at:new Date(Date.now()-i*300000).toISOString(),task_key:i<4?'kr_trade':'us_trade',cohort:i%2?'B':'A',config_version:1,model:'gpt-6-sol',effort:'medium',status:'completed',input_tokens:3000,output_tokens:500,cached_input_tokens:1200,total_tokens:3500,duration_ms:32000+i*3100})),audit:[]};
}
if(preview)openConsole();else authenticate().catch(e=>showAuth(e.status===401?'':e.message));
