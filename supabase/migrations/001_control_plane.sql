-- Run in the Supabase SQL editor. Then provision exactly one owner (see README).
begin;
create table public.app_owner (
  singleton boolean primary key default true check(singleton),
  user_id uuid not null unique references auth.users(id)
);
alter table public.app_owner enable row level security;
revoke all on public.app_owner from anon, authenticated;

create function public.is_app_owner() returns boolean language sql stable security definer
set search_path = '' as $$
  select exists(select 1 from public.app_owner where user_id = auth.uid())
    and coalesce(auth.jwt()->>'aal','') = 'aal2';
$$;
revoke all on function public.is_app_owner() from public;
grant execute on function public.is_app_owner() to authenticated;

create table public.task_settings (
  task_key text primary key check(task_key in ('kr_trade','us_trade','kr_feedback','us_feedback')),
  model text not null check(model ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,99}$'),
  effort text not null check(effort in ('low','medium','high','xhigh','max','ultra')),
  enabled boolean not null default false,
  version integer not null default 1 check(version > 0),
  updated_at timestamptz not null default now()
);
insert into public.task_settings(task_key, model, effort) values
('kr_trade','gpt-6-sol','medium'),('us_trade','gpt-6-sol','medium'),
('kr_feedback','gpt-6-astra','medium'),('us_feedback','gpt-6-astra','medium');

create table public.settings_audit (
  id bigint generated always as identity primary key,
  task_key text not null,
  actor uuid not null,
  before_value jsonb not null,
  after_value jsonb not null,
  created_at timestamptz not null default now()
);
create table public.worker_status (
  worker_id text primary key,
  updated_at timestamptz not null default now(),
  settings_versions jsonb not null default '{}',
  models jsonb not null default '[]',
  models_at timestamptz,
  rate_limits jsonb,
  rate_limits_at timestamptz,
  state text not null default 'idle',
  current_job text,
  error text
);
create table public.task_runs (
  id uuid primary key,
  job_id text not null,
  task_key text not null references public.task_settings,
  cohort text not null check(cohort in ('A','B','feedback')),
  config_version integer not null,
  model text not null,
  effort text not null,
  status text not null check(status in ('running','completed','failed','timed_out','expired','skipped')),
  input_tokens bigint check(input_tokens >= 0),
  cached_input_tokens bigint check(cached_input_tokens >= 0),
  output_tokens bigint check(output_tokens >= 0),
  reasoning_output_tokens bigint check(reasoning_output_tokens >= 0),
  total_tokens bigint check(total_tokens >= 0),
  duration_ms bigint,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index task_runs_created on public.task_runs(created_at desc);
create index task_runs_job on public.task_runs(job_id);

alter table public.task_settings enable row level security;
alter table public.settings_audit enable row level security;
alter table public.worker_status enable row level security;
alter table public.task_runs enable row level security;
create policy owner_read on public.task_settings for select to authenticated using(public.is_app_owner());
create policy owner_read on public.settings_audit for select to authenticated using(public.is_app_owner());
create policy owner_read on public.worker_status for select to authenticated using(public.is_app_owner());
create policy owner_read on public.task_runs for select to authenticated using(public.is_app_owner());
revoke all on public.task_settings,public.settings_audit,public.worker_status,public.task_runs from anon,authenticated;
grant select on public.task_settings,public.settings_audit,public.worker_status,public.task_runs to authenticated;
grant all on public.task_settings,public.settings_audit,public.worker_status,public.task_runs to service_role;

create function public.update_task_setting(p_task_key text,p_model text,p_effort text,p_enabled boolean,p_version integer)
returns public.task_settings language plpgsql security definer set search_path = '' as $$
declare old_row public.task_settings; new_row public.task_settings;
begin
  if not public.is_app_owner() then raise insufficient_privilege; end if;
  select * into old_row from public.task_settings where task_key = p_task_key for update;
  if not found or old_row.version <> p_version then
    raise exception 'Version conflict' using errcode='40001';
  end if;
  if not exists (
    select 1 from public.worker_status w, jsonb_array_elements(w.models) m,
      jsonb_array_elements(m->'supportedReasoningEfforts') e
    where w.models_at > now()-interval '1 day'
      and (m->>'id'=p_model or m->>'model'=p_model) and e->>'reasoningEffort'=p_effort
  ) then raise exception 'Unsupported model or reasoning effort' using errcode='22023'; end if;
  update public.task_settings set model=p_model,effort=p_effort,enabled=p_enabled,
    version=version+1,updated_at=now() where task_key=p_task_key returning * into new_row;
  insert into public.settings_audit(task_key,actor,before_value,after_value)
    values(p_task_key,auth.uid(),to_jsonb(old_row),to_jsonb(new_row));
  return new_row;
end;
$$;
revoke all on function public.update_task_setting(text,text,text,boolean,integer) from public;
grant execute on function public.update_task_setting(text,text,text,boolean,integer) to authenticated;

create function public.usage_summary(p_since timestamptz) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'jobs',count(*),'known_jobs',count(total_tokens),
    'input_tokens',coalesce(sum(input_tokens),0),
    'cached_input_tokens',coalesce(sum(cached_input_tokens),0),
    'output_tokens',coalesce(sum(output_tokens),0),
    'total_tokens',coalesce(sum(total_tokens),0)
  ) from public.task_runs where created_at >= greatest(p_since,now()-interval '31 days');
$$;
revoke all on function public.usage_summary(timestamptz) from public;
grant execute on function public.usage_summary(timestamptz) to authenticated;
commit;
