begin;
create table public.paper_accounts (
  market text not null check(market in ('kr','us')),
  cohort text not null check(cohort in ('A','B')),
  cash numeric not null check(cash>=0),
  equity numeric not null check(equity>=0),
  positions jsonb not null default '[]',
  updated_at timestamptz not null,
  primary key(market,cohort)
);
create table public.paper_trades (
  id uuid primary key,
  job_id text not null,
  market text not null check(market in ('kr','us')),
  cohort text not null check(cohort in ('A','B')),
  symbol text not null,
  side text not null check(side in ('BUY','SELL')),
  quantity numeric not null check(quantity>0),
  price numeric not null check(price>0),
  fee numeric not null check(fee>=0),
  as_of timestamptz not null,
  source text not null,
  reason text not null
);
create index paper_trades_as_of on public.paper_trades(as_of desc);
alter table public.paper_accounts enable row level security;
alter table public.paper_trades enable row level security;
create policy owner_read on public.paper_accounts for select to authenticated using(public.is_app_owner());
create policy owner_read on public.paper_trades for select to authenticated using(public.is_app_owner());
revoke all on public.paper_accounts,public.paper_trades from anon,authenticated;
grant select on public.paper_accounts,public.paper_trades to authenticated;
grant all on public.paper_accounts,public.paper_trades to service_role;
commit;
