create table if not exists app_owner (
  singleton boolean primary key default true check (singleton),
  user_id text not null unique,
  email text not null unique,
  password_salt text not null,
  password_hash text not null,
  totp_secret text,
  totp_verified boolean not null default false
);

create table if not exists app_sessions (
  token_hash text primary key,
  user_id text not null references app_owner(user_id),
  aal smallint not null check (aal in (1, 2)),
  expires_at timestamptz not null
);
create index if not exists app_sessions_expiry on app_sessions(expires_at);

create table if not exists task_settings (
  task_key text primary key check (task_key in ('kr_trade','us_trade','kr_feedback','us_feedback')),
  model text not null,
  effort text not null,
  enabled boolean not null default false,
  version integer not null default 1,
  updated_at timestamptz not null default now()
);
insert into task_settings(task_key,model,effort) values
  ('kr_trade','gpt-6-sol','medium'),
  ('us_trade','gpt-6-sol','medium'),
  ('kr_feedback','gpt-6-astra','medium'),
  ('us_feedback','gpt-6-astra','medium')
on conflict (task_key) do nothing;

create table if not exists settings_audit (
  id bigint generated always as identity primary key,
  task_key text not null,
  actor text not null,
  before_value jsonb not null,
  after_value jsonb not null,
  created_at timestamptz not null default now()
);
create table if not exists worker_status (
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
create table if not exists task_runs (
  id text primary key,
  job_id text not null,
  task_key text not null references task_settings(task_key),
  cohort text not null check (cohort in ('A','B','feedback')),
  config_version integer not null,
  model text not null,
  effort text not null,
  status text not null check (status in ('running','completed','failed','timed_out','expired','skipped')),
  input_tokens bigint,
  cached_input_tokens bigint,
  output_tokens bigint,
  reasoning_output_tokens bigint,
  total_tokens bigint,
  duration_ms bigint,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists task_runs_created on task_runs(created_at desc);

create table if not exists paper_accounts (
  market text not null check (market in ('kr','us')),
  cohort text not null check (cohort in ('A','B')),
  cash numeric not null,
  equity numeric not null,
  positions jsonb not null default '[]',
  updated_at timestamptz not null,
  primary key(market,cohort)
);
create table if not exists paper_trades (
  id text primary key,
  job_id text not null,
  market text not null check (market in ('kr','us')),
  cohort text not null check (cohort in ('A','B')),
  symbol text not null,
  side text not null check (side in ('BUY','SELL')),
  quantity numeric not null,
  price numeric not null,
  fee numeric not null,
  as_of timestamptz not null,
  source text not null,
  reason text not null
);
create index if not exists paper_trades_as_of on paper_trades(as_of desc);
