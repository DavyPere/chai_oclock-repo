-- Chai O'Clock v1: Researcher + Editor engine.

create table if not exists public.research_runs (
  id uuid primary key default gen_random_uuid(),
  trigger_type text not null default 'schedule',
  status text not null default 'running',
  model text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  candidate_count integer not null default 0,
  submitted_count integer not null default 0,
  held_count integer not null default 0,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint research_runs_status_check
    check (status = any(array['running','completed','failed','skipped']::text[]))
);

create table if not exists public.research_candidates (
  id uuid primary key default gen_random_uuid(),
  research_run_id uuid references public.research_runs(id) on delete set null,
  fingerprint text not null unique,
  title text not null,
  summary text not null,
  why_it_matters text,
  category text not null default 'general',
  location text,
  published_at timestamptz,
  locality_score integer not null default 0,
  importance_score integer not null default 0,
  freshness_score integer not null default 0,
  sensitive_topic boolean not null default false,
  requires_corroboration boolean not null default false,
  status text not null default 'candidate',
  sources jsonb not null default '[]'::jsonb,
  editor_payload jsonb,
  editorial_notes text,
  content_package_id uuid references public.content_packages(id) on delete set null,
  model_metadata jsonb not null default '{}'::jsonb,
  discovered_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint research_candidates_status_check
    check (status = any(array['candidate','editor_ready','held','submitted','discarded']::text[])),
  constraint research_candidates_score_check
    check (
      locality_score between 0 and 100
      and importance_score between 0 and 100
      and freshness_score between 0 and 100
    ),
  constraint research_candidates_sources_check
    check (jsonb_typeof(sources) = 'array' and jsonb_array_length(sources) >= 1)
);

create index if not exists research_candidates_run_idx
  on public.research_candidates(research_run_id, discovered_at desc);

create index if not exists research_candidates_status_idx
  on public.research_candidates(status, discovered_at desc);

create index if not exists research_candidates_content_package_idx
  on public.research_candidates(content_package_id)
  where content_package_id is not null;

alter table public.research_runs enable row level security;
alter table public.research_candidates enable row level security;

revoke all on table public.research_runs from public, anon, authenticated;
revoke all on table public.research_candidates from public, anon, authenticated;

create or replace function public.claim_research_candidate_for_editing(
  p_candidate_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated integer;
begin
  update public.research_candidates
  set status = 'editor_ready',
      updated_at = now()
  where id = p_candidate_id
    and status = 'candidate';

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

revoke all on function public.claim_research_candidate_for_editing(uuid)
  from public, anon, authenticated;
grant execute on function public.claim_research_candidate_for_editing(uuid)
  to service_role;
