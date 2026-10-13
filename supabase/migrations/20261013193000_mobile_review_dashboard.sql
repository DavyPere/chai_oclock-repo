-- Chai O'Clock v1: mobile review dashboard sessions.

create table if not exists public.dashboard_setup_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists dashboard_setup_tokens_expiry_idx
  on public.dashboard_setup_tokens(expires_at);

alter table public.dashboard_setup_tokens enable row level security;

create table if not exists public.dashboard_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  actor text not null default 'review-dashboard',
  expires_at timestamptz not null,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists dashboard_sessions_expiry_idx
  on public.dashboard_sessions(expires_at);

alter table public.dashboard_sessions enable row level security;

revoke all on table public.dashboard_setup_tokens from public, anon, authenticated;
revoke all on table public.dashboard_sessions from public, anon, authenticated;
