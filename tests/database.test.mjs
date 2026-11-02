import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

test('SQL migration enforces owner + MFA, audited version changes and usage accounting',async()=>{
  const db=new PGlite();
  try{
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.jwt() returns jsonb language sql stable as
        $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
      grant usage on schema auth to authenticated;
      grant execute on function auth.jwt(),auth.uid() to authenticated;
    `);
    await db.exec(await readFile('supabase/migrations/001_control_plane.sql','utf8'));
    await db.exec(await readFile('supabase/migrations/002_paper_accounts.sql','utf8'));
    const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
    await db.query('insert into auth.users values ($1),($2)',[owner,other]);
    await db.query('insert into public.app_owner(user_id) values($1)',[owner]);
    async function asUser(user,aal,action){
      await db.exec('begin; set local role authenticated;');
      await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:user,aal})]);
      try{const r=await action();await db.exec('commit');return r;}catch(e){await db.exec('rollback');throw e;}
    }
    assert.equal((await asUser(owner,'aal1',()=>db.query('select * from public.task_settings'))).rows.length,0);
    assert.equal((await asUser(other,'aal2',()=>db.query('select * from public.task_settings'))).rows.length,0);
    assert.equal((await asUser(owner,'aal2',()=>db.query('select * from public.task_settings'))).rows.length,4);
    await db.query("insert into public.paper_accounts(market,cohort,cash,equity,positions,updated_at) values('kr','A',10000000,10000000,'[]',now())");
    assert.equal((await asUser(owner,'aal2',()=>db.query('select * from public.paper_accounts'))).rows.length,1);
    assert.equal((await asUser(other,'aal2',()=>db.query('select * from public.paper_accounts'))).rows.length,0);
    assert.equal((await asUser(owner,'aal1',()=>db.query('select * from public.paper_accounts'))).rows.length,0);
    await assert.rejects(()=>asUser(owner,'aal2',()=>db.query("update public.task_settings set model='bad'")));
    await assert.rejects(()=>asUser(other,'aal2',()=>db.query("select public.update_task_setting('kr_trade','gpt-6-sol','high',true,1)")));
    await db.query('insert into public.worker_status(worker_id,models_at,models) values($1,now(),$2)',[
      'test',JSON.stringify([{id:'gpt-6-sol',supportedReasoningEfforts:[{reasoningEffort:'high'}]}])]);
    await asUser(owner,'aal2',()=>db.query("select public.update_task_setting('kr_trade','gpt-6-sol','high',true,1)"));
    const rows=(await db.query("select * from public.task_settings where task_key='kr_trade'")).rows;
    assert.equal(rows[0].version,2);assert.equal(rows[0].effort,'high');
    assert.equal((await db.query('select * from public.settings_audit')).rows.length,1);
    await assert.rejects(()=>asUser(owner,'aal2',()=>db.query("select public.update_task_setting('kr_trade','gpt-6-sol','high',true,1)")),/Version conflict/);
    await db.exec("begin; set local role anon;");
    await assert.rejects(()=>db.query('select * from public.task_settings'));await db.exec('rollback');
    await db.query(`insert into public.task_runs(id,job_id,task_key,cohort,config_version,model,effort,status,input_tokens,cached_input_tokens,output_tokens,total_tokens)
      values('33333333-3333-4333-8333-333333333333','test','kr_trade','A',2,'gpt-6-sol','high','completed',100,80,40,140)`);
    const summary=await asUser(owner,'aal2',()=>db.query("select public.usage_summary(now()-interval '1 day') as total"));
    assert.equal(summary.rows[0].total.total_tokens,140);
  }finally{await db.close();}
});
